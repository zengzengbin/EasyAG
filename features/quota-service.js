// Read-only quota snapshots from the Antigravity language service.
//
// AG 2.33 exposes RetrieveUserQuotaSummary on the same loopback RPC the
// context monitor already uses. Everything here stays local: no Google API
// calls, no token handling, and the active account's credential never leaves
// AG. Inactive accounts only ever show the last snapshot taken while they
// were active.
const path = require('node:path');
const { readJson, writeJson } = require('../core/storage');

const CACHE_VERSION = 1;
const CACHE_FILE = 'quota-cache.json';
const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000];

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Keep a real zero distinct from "the host did not tell us".
function finiteFraction(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(1, Math.max(0, number));
}

function timestampIso(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  if (typeof value === 'object') {
    const seconds = finiteNumber(value.seconds ?? value.sec);
    if (seconds === null) return null;
    const nanos = finiteNumber(value.nanos ?? 0);
    const ms = seconds * 1000 + (nanos === null ? 0 : Math.floor(nanos / 1e6));
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeBucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.bucketId, 80);
  const name = text(raw.displayName, 80) || id;
  if (!id && !name) return null;
  return {
    id: id || name,
    name,
    description: text(raw.description, 200),
    window: text(raw.window, 40),
    remainingFraction: finiteFraction(raw.remainingFraction),
    remainingAmount: finiteNumber(raw.remainingAmount),
    disabled: raw.disabled === true,
    resetAt: timestampIso(raw.resetTime)
  };
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.displayName, 80);
  const buckets = Array.isArray(raw.buckets) ? raw.buckets.map(normalizeBucket).filter(Boolean) : [];
  if (!name && !buckets.length) return null;
  return { name, description: text(raw.description, 200), buckets };
}

function responsePayload(value) {
  return value && typeof value === 'object' && value.response && typeof value.response === 'object'
    ? value.response : value;
}

function normalizeQuotaSummary(raw) {
  const payload = responsePayload(raw);
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets.map(normalizeBucket).filter(Boolean) : [];
  const groups = Array.isArray(payload?.groups) ? payload.groups.map(normalizeGroup).filter(Boolean) : [];
  return { description: text(payload?.description, 200), buckets, groups };
}

function projectFromLoadCodeAssist(info) {
  const payload = responsePayload(info);
  if (!payload || typeof payload !== 'object') return null;
  for (const value of [payload.cloudaicompanionProject, payload.cloudAiCompanionProject, payload.project]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) return value.id.trim();
  }
  return null;
}

async function fetchQuota(client, signal) {
  try {
    return await client.call('RetrieveUserQuotaSummary', {}, signal);
  } catch (firstError) {
    // Some builds require the Cloud AI Companion project explicitly. Resolve it
    // from the same read-only service instead of guessing a project id.
    let project = null;
    try { project = projectFromLoadCodeAssist(await client.call('GetLoadCodeAssist', {}, signal)); }
    catch { /* keep the original failure */ }
    if (!project) throw firstError;
    return client.call('RetrieveUserQuotaSummary', { project }, signal);
  }
}

function emailFromStatus(status) {
  const email = normalizeEmail(status?.userStatus?.email);
  return email || null;
}

function sameServer(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.port === right.port && left.csrf === right.csrf);
}

class QuotaService {
  constructor({
    client,
    accounts = null,
    dataDir,
    events = null,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    retryDelays = DEFAULT_RETRY_DELAYS,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay))
  }) {
    Object.assign(this, { client, accounts, dataDir, events, now, ttlMs, retryDelays, wait });
    this.generation = 0;
    this.pending = null;
    this.kicking = null;
    this.lastEmail = null;
  }

  file() {
    return path.join(this.dataDir, CACHE_FILE);
  }

  readCache() {
    const document = readJson(this.file(), { version: CACHE_VERSION, accounts: {} });
    if (!document || typeof document !== 'object' || typeof document.accounts !== 'object' || !document.accounts) {
      return { version: CACHE_VERSION, accounts: {} };
    }
    return { version: CACHE_VERSION, accounts: document.accounts };
  }

  writeCache(document) {
    try { writeJson(this.file(), { version: CACHE_VERSION, accounts: document.accounts }); }
    catch { /* A cache write must never break the live read. */ }
  }

  cached(email) {
    const key = normalizeEmail(email);
    if (!key) return null;
    const snapshot = this.readCache().accounts[key];
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.sampledAt !== 'string') return null;
    return {
      sampledAt: snapshot.sampledAt,
      description: typeof snapshot.description === 'string' ? snapshot.description : '',
      buckets: Array.isArray(snapshot.buckets) ? snapshot.buckets : [],
      groups: Array.isArray(snapshot.groups) ? snapshot.groups : []
    };
  }

  // Attach cached snapshots to an /api/accounts payload without touching DPAPI.
  decorate(state) {
    const accounts = Array.isArray(state?.accounts)
      ? state.accounts.map(account => ({ ...account, quota: this.cached(account.email) }))
      : [];
    return { ...state, currentQuota: state?.current?.email ? this.cached(state.current.email) : null, accounts };
  }

  forget(email) {
    const key = normalizeEmail(email);
    if (!key) return;
    const document = this.readCache();
    if (!(key in document.accounts)) return;
    delete document.accounts[key];
    this.writeCache(document);
  }

  isFresh(snapshot) {
    if (!snapshot?.sampledAt) return false;
    const sampledAt = Date.parse(snapshot.sampledAt);
    return Number.isFinite(sampledAt) && this.now() - sampledAt < this.ttlMs;
  }

  // Live read for the currently active account. Expected failures resolve to a
  // state instead of throwing so an idle launcher never spams warning logs.
  refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const task = this.collect({ force, generation });
    this.pending = task;
    task.finally(() => { if (this.pending === task) this.pending = null; });
    return task;
  }

  async collect({ force, generation }) {
    let email = null;
    let server = null;
    try {
      server = await this.client.discover();
      const before = await this.client.call('GetUserStatus', {}, AbortSignal.timeout(8000));
      email = emailFromStatus(before);
      if (!email) return { ok: true, state: 'unavailable' };
      if (generation !== this.generation) return { ok: true, state: 'unavailable', email };

      const previous = this.cached(email);
      if (!force && this.isFresh(previous)) return { ok: true, state: 'live', email, cached: true, ...previous };

      const raw = await fetchQuota(this.client, AbortSignal.timeout(10000));
      const after = await this.client.call('GetUserStatus', {}, AbortSignal.timeout(8000));
      const currentServer = await this.client.discover();
      if (generation !== this.generation || email !== emailFromStatus(after) || !sameServer(server, currentServer)) {
        return { ok: true, state: 'unavailable', email };
      }

      const summary = normalizeQuotaSummary(raw);
      const snapshot = { sampledAt: new Date(this.now()).toISOString(), ...summary };
      this.lastEmail = email;
      const document = this.readCache();
      document.accounts[email] = snapshot;
      this.writeCache(document);
      try { this.accounts?.touch(email); } catch { /* metadata is best-effort */ }
      try { this.events?.publish({ quotaUpdated: true, quotaEmail: email }); } catch { /* UI may be gone */ }
      return { ok: true, state: 'live', email, ...snapshot };
    } catch {
      const fallbackEmail = email || this.lastEmail;
      const cached = fallbackEmail ? this.cached(fallbackEmail) : null;
      return cached
        ? { ok: true, state: 'stale', email: fallbackEmail, ...cached }
        : { ok: true, state: 'unavailable', email: fallbackEmail };
    }
  }

  // Retry after a launch: the language server often binds its port a few
  // seconds after the app process starts.
  async kick() {
    if (this.kicking) return this.kicking;
    const generation = this.generation;
    this.kicking = (async () => {
      for (const delay of this.retryDelays) {
        await this.wait(delay);
        if (generation !== this.generation) return null;
        const result = await this.refresh();
        if (result?.state === 'live') return result;
      }
      return null;
    })();
    try { return await this.kicking; } finally { this.kicking = null; }
  }

  reset() {
    this.generation++;
    this.pending = null;
  }
}

module.exports = {
  QuotaService,
  normalizeQuotaSummary,
  normalizeBucket,
  normalizeGroup,
  projectFromLoadCodeAssist,
  finiteFraction,
  timestampIso
};
