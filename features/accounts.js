// Account profile store for Antigravity multi-account switching.
// Each profile is a JSON file with a plaintext header (email, timestamps) and a
// DPAPI-encrypted payload holding the credential blob and user-scope pointer.
// The split keeps list() fast: every PowerShell/DPAPI call compiles a fresh
// P/Invoke shim (roughly a second), so bulk listing must never decrypt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAntigravityCredential, writeAntigravityCredential, protectData, unprotectData, readUserScope, writeUserScope, readLastLoginEmail } = require('../adapters/desktop/credential');

const PROFILE_VERSION = 1;
const PROFILE_EXT = '.agprofile';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = value => String(value || '').trim().toLowerCase();

// Stable per-account marker stored in the plaintext header. Antigravity 2.33+
// no longer writes id_token_email into the credential blob, so a hash of the
// long-lived refresh token is what ties a live credential back to its profile
// (the token itself never leaves the DPAPI payload).
function refreshTokenHash(json) {
  const token = json?.token?.refresh_token;
  return typeof token === 'string' && token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}


function slugify(email) {
  const slug = String(email || '').toLowerCase().replace(/[^a-z0-9@._-]+/g, '_');
  return slug || `account-${crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 12)}`;
}

// Binary-safe atomic write with the same rename-after-flush contract as core/storage.
function writeBufferAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readHeaderFile(file) {
  const header = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!header?.email || typeof header.payloadB64 !== 'string') throw new Error('账号档案无效或已损坏');
  return header;
}

class Accounts {
  constructor({ dataDir, credential = { readAntigravityCredential, writeAntigravityCredential, protectData, unprotectData, readUserScope, writeUserScope, readLastLoginEmail }, events, platform = process.platform, now = () => new Date().toISOString() }) {
    this.dir = path.join(dataDir, 'accounts');
    this.credential = credential;
    this.events = events;
    this.platform = platform;
    this.now = now;
  }

  log(message, tag = 'tag-proxy') { this.events?.log('ACCOUNT', message, tag); }

  // Live login state. Never exposes the token blob.
  async current() {
    const live = await this.credential.readAntigravityCredential();
    if (!live) return null;
    const json = parseCredentialBlob(live.blobB64);
    return { email: this._resolveLiveEmail(json), authMethod: json.auth_method || null, scope: this.credential.readUserScope() };
  }

  // Email resolution for credentials written by Antigravity 2.33+, which carry
  // no id_token_email: match the refresh token against stored profiles first
  // (exact), then fall back to the app's last-login record.
  _resolveLiveEmail(json) {
    if (json?.id_token_email) return json.id_token_email;
    const hash = refreshTokenHash(json);
    const owner = this._findByRefreshHash(hash);
    if (owner) return owner.email;
    const lastLogin = this.credential.readLastLoginEmail?.() || null;
    return lastLogin && EMAIL_PATTERN.test(lastLogin) ? lastLogin : null;
  }

  _findByRefreshHash(hash) {
    if (!hash || !fs.existsSync(this.dir)) return null;
    for (const entry of fs.readdirSync(this.dir).sort()) {
      if (!entry.endsWith(PROFILE_EXT)) continue;
      try {
        const header = readHeaderFile(path.join(this.dir, entry));
        if (header.refreshHash === hash) return { id: entry.slice(0, -PROFILE_EXT.length), ...header };
      } catch { /* corrupted profiles are surfaced by list() */ }
    }
    return null;
  }

  async list() {
    if (this.platform !== 'win32') return { supported: false, current: null, accounts: [] };
    const current = await this.current();
    const accounts = [];
    const errors = [];
    if (fs.existsSync(this.dir)) {
      for (const entry of fs.readdirSync(this.dir).sort()) {
        if (!entry.endsWith(PROFILE_EXT)) continue;
        try {
          const header = readHeaderFile(path.join(this.dir, entry));
          accounts.push({
            id: entry.slice(0, -PROFILE_EXT.length),
            email: header.email,
            authMethod: header.authMethod || null,
            capturedAt: header.capturedAt || null,
            updatedAt: header.updatedAt || null,
            active: Boolean(current?.email && normalizeEmail(header.email) === normalizeEmail(current.email))
          });
        } catch (error) {
          errors.push({ file: entry, error: error.message });
        }
      }
    }
    return { supported: true, current, accounts, errors };
  }

  // Persist the currently logged-in account as (or as an update to) a profile.
  // `emailOverride` is only needed when the live credential carries no email and
  // no local record can identify the account.
  async capture(emailOverride) {
    const live = await this.credential.readAntigravityCredential();
    if (!live) throw new Error('未检测到 Antigravity 登录凭证，请先在 Antigravity 中登录账号');
    const json = parseCredentialBlob(live.blobB64);
    const requested = typeof emailOverride === 'string' ? normalizeEmail(emailOverride) : '';
    if (requested && !EMAIL_PATTERN.test(requested)) throw new Error('邮箱格式不正确，请重新输入');
    const blobEmail = normalizeEmail(json.id_token_email) || null;
    if (requested && blobEmail && requested !== blobEmail) {
      throw new Error(`登录凭证属于 ${blobEmail}，与你输入的邮箱不一致`);
    }
    const tokenHash = refreshTokenHash(json);
    const owner = this._findByRefreshHash(tokenHash);
    let email = blobEmail || requested || owner?.email || null;
    let inferred = false;
    let candidateRejected = false;
    if (!email) {
      const candidate = normalizeEmail(this.credential.readLastLoginEmail?.());
      if (candidate && EMAIL_PATTERN.test(candidate)) {
        const known = this._readHeader(slugify(candidate));
        if (!known) email = candidate;
        else if (!tokenHash || !known.refreshHash || known.refreshHash === tokenHash) email = candidate;
        else if (await this._profileTokenMatches(slugify(candidate), tokenHash)) email = candidate;
        // Otherwise the app's last-login record points at another profile: stale
        // after a launcher-side switch, so ask instead of overwriting it.
        else candidateRejected = true;
      }
      if (email) inferred = true;
    }
    if (!email) {
      const suggestion = this.credential.readLastLoginEmail?.() || null;
      const error = new Error('当前登录凭证未包含邮箱（Antigravity 2.33 起不再保存该字段），请输入该账号的邮箱后重试');
      error.code = 'ACCOUNT_EMAIL_REQUIRED';
      error.suggestion = !candidateRejected && suggestion && EMAIL_PATTERN.test(suggestion) ? suggestion : null;
      throw error;
    }
    const id = slugify(email);
    const existing = this._readHeader(id);
    const now = this.now();
    await this._saveProfile(path.join(this.dir, `${id}${PROFILE_EXT}`), {
      version: PROFILE_VERSION,
      email,
      authMethod: json.auth_method || null,
      refreshHash: tokenHash,
      capturedAt: existing?.capturedAt || now,
      updatedAt: now,
      credential: { userName: live.userName, type: live.type, persist: live.persist, blobB64: live.blobB64 },
      userScope: this.credential.readUserScope()
    });
    this.log(existing
      ? `账号 ${email} 的凭证已更新`
      : `已保存当前账号: ${email}${inferred && !blobEmail ? '（凭证未含邮箱，已按 AG 最近登录记录识别）' : ''}`);
    return { ok: true, id, email, created: !existing };
  }

  // Decrypt one profile to compare its refresh token with the live one. Only hit
  // for profiles captured before refreshHash existed, and then only once.
  async _profileTokenMatches(id, tokenHash) {
    try {
      const profile = await this._loadProfile(path.join(this.dir, `${id}${PROFILE_EXT}`));
      return refreshTokenHash(parseCredentialBlob(profile.credential.blobB64)) === tokenHash;
    } catch {
      return false;
    }
  }

  // Apply a stored profile to the live credential. Caller must ensure Antigravity
  // is fully stopped; a running daemon would overwrite the token back.
  async switchTo(id) {
    const file = path.join(this.dir, `${id}${PROFILE_EXT}`);
    const profile = await this._loadProfile(file);
    if (!profile.refreshHash) {
      // One-time backfill so later email-less refreshes still map to this profile.
      const hash = refreshTokenHash(parseCredentialBlob(profile.credential.blobB64));
      if (hash) {
        profile.refreshHash = hash;
        await this._saveProfile(file, profile);
      }
    }
    const current = await this.current();
    if (current?.email && current.email === profile.email) {
      return { ok: true, already: true, email: profile.email };
    }
    await this.credential.writeAntigravityCredential(profile.credential);
    if (profile.userScope) this.credential.writeUserScope(profile.userScope);
    this.log(`已切换账号: ${profile.email}，重新启动 Antigravity 后生效`);
    return { ok: true, email: profile.email };
  }

  async remove(id) {
    const file = path.join(this.dir, `${id}${PROFILE_EXT}`);
    const header = readHeaderFile(file);
    fs.unlinkSync(file);
    this.log(`已删除账号档案: ${header.email}`);
    return { ok: true, email: header.email };
  }

  // Import a plaintext profile JSON (produced by exportTo) as a new profile.
  async importFrom(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    let imported;
    try {
      imported = JSON.parse(raw);
    } catch {
      throw new Error('导入文件不是有效的 JSON');
    }
    if (!imported?.credential?.blobB64 || !imported.email) throw new Error('导入文件缺少账号凭证或邮箱字段');
    const json = parseCredentialBlob(imported.credential.blobB64);
    if (json.id_token_email && json.id_token_email !== imported.email) throw new Error('导入文件邮箱与凭证不匹配');
    const id = slugify(imported.email);
    const existing = this._readHeader(id);
    const now = this.now();
    await this._saveProfile(path.join(this.dir, `${id}${PROFILE_EXT}`), {
      version: PROFILE_VERSION,
      email: imported.email,
      authMethod: imported.authMethod || json.auth_method || null,
      refreshHash: refreshTokenHash(json),
      capturedAt: imported.capturedAt || now,
      updatedAt: now,
      credential: {
        userName: imported.credential.userName || 'antigravity',
        type: Number.isFinite(imported.credential.type) ? imported.credential.type : 1,
        persist: Number.isFinite(imported.credential.persist) ? imported.credential.persist : 2,
        blobB64: imported.credential.blobB64
      },
      userScope: imported.userScope || null
    });
    this.log(existing ? `导入并更新账号: ${imported.email}` : `已导入账号: ${imported.email}`);
    return { ok: true, id, email: imported.email, created: !existing };
  }

  // Export a profile as plaintext JSON. Contains refresh tokens: user responsibility.
  async exportTo(id, filePath) {
    const file = path.join(this.dir, `${id}${PROFILE_EXT}`);
    const profile = await this._loadProfile(file);
    const { credential, userScope, ...header } = profile;
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ ...header, credential, userScope }, null, 2) + '\n', 'utf8');
    this.log(`已导出账号 ${profile.email}（明文凭证，注意保管）`);
    return { ok: true, email: profile.email, path: filePath };
  }

  _readHeader(id) {
    try {
      return readHeaderFile(path.join(this.dir, `${id}${PROFILE_EXT}`));
    } catch {
      return null;
    }
  }

  async _loadProfile(file) {
    const header = readHeaderFile(file);
    const payload = JSON.parse((await this.credential.unprotectData(Buffer.from(header.payloadB64, 'base64'))).toString('utf8'));
    if (!payload?.credential?.blobB64) throw new Error('账号档案的加密数据无效');
    return { ...header, credential: payload.credential, userScope: payload.userScope || null };
  }

  async _saveProfile(file, profile) {
    const { credential, userScope, ...header } = profile;
    const cipher = await this.credential.protectData(Buffer.from(JSON.stringify({ credential, userScope }), 'utf8'));
    const document = JSON.stringify({ ...header, payloadB64: cipher.toString('base64') }, null, 2) + '\n';
    writeBufferAtomic(file, Buffer.from(document, 'utf8'));
  }
}

function parseCredentialBlob(blobB64) {
  try {
    return JSON.parse(Buffer.from(blobB64, 'base64').toString('utf8'));
  } catch {
    throw new Error('Antigravity 凭证格式无法识别（可能为新版本格式），请反馈给开发者');
  }
}

module.exports = { Accounts, slugify, parseCredentialBlob, PROFILE_EXT };
