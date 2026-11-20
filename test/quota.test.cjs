const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  QuotaService,
  normalizeQuotaSummary,
  projectFromLoadCodeAssist,
  finiteFraction,
  timestampIso
} = require('../features/quota-service');

const NOW = Date.parse('2026-01-01T00:00:00Z');
const SERVER = { pid: 9, port: 4001, csrf: 'secret' };

function quotaResponse() {
  return {
    description: 'summary',
    secretToken: 'SENSITIVE-MARKER',
    buckets: [
      { bucketId: 'pro', displayName: 'Gemini Pro', window: 'weekly', remainingFraction: 0, resetTime: { seconds: 1760000000, nanos: 0 } },
      { bucketId: 'flash', displayName: 'Gemini Flash', remainingFraction: null },
      { bucketId: 'claude', displayName: 'Claude', remainingFraction: '', disabled: true },
      { bucketId: 'image', displayName: 'Image', remainingFraction: '0.42' }
    ],
    groups: [
      { displayName: 'Claude 组', buckets: [{ bucketId: 'g1', displayName: 'Group 1', remainingFraction: 1.5 }] }
    ]
  };
}

function makeClient({ email = 'a@gmail.com', afterEmail = null, afterServer = null, failDiscover = 0, quota = quotaResponse() } = {}) {
  let statusCalls = 0;
  let discovers = 0;
  const client = {
    calls: [],
    async discover() {
      discovers++;
      if (discovers <= failDiscover) throw new Error('waiting for language service');
      return afterServer && discovers > 1 ? afterServer : SERVER;
    },
    async call(method, body) {
      client.calls.push({ method, body });
      if (method === 'GetUserStatus') {
        statusCalls++;
        return { userStatus: { email: afterEmail && statusCalls > 1 ? afterEmail : email } };
      }
      if (method === 'GetLoadCodeAssist') return { cloudaicompanionProject: 'project-1' };
      if (method === 'RetrieveUserQuotaSummary') {
        if (!body?.project) throw new Error('project required');
        return quota;
      }
      throw new Error(`unexpected RPC ${method}`);
    },
    reset() {}
  };
  return client;
}

function makeService(client, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-quota-'));
  const accounts = { touched: [], touch(email) { this.touched.push(email); } };
  const events = { published: [], publish(message) { this.published.push(message); } };
  const service = new QuotaService({
    client, accounts, dataDir, events,
    now: () => NOW,
    wait: async () => {},
    ...extra
  });
  return { service, dataDir, accounts, events };
}

test('quota normalization keeps real zero distinct from unknown', () => {
  const summary = normalizeQuotaSummary(quotaResponse());
  assert.equal(summary.buckets.length, 4);
  assert.equal(summary.buckets[0].remainingFraction, 0, 'real zero is preserved');
  assert.equal(summary.buckets[1].remainingFraction, null, 'null stays unknown');
  assert.equal(summary.buckets[2].remainingFraction, null, 'empty string stays unknown');
  assert.equal(summary.buckets[2].disabled, true);
  assert.equal(summary.buckets[3].remainingFraction, 0.42, 'numeric strings are parsed');
  assert.equal(summary.groups[0].buckets[0].remainingFraction, 1, 'fractions are clamped');
  assert.equal(summary.buckets[0].resetAt, new Date(1760000000 * 1000).toISOString());
  assert.equal(summary.buckets[0].window, 'weekly');
  assert.equal(JSON.stringify(summary).includes('SENSITIVE-MARKER'), false, 'unknown fields are dropped');
  assert.equal(finiteFraction(null), null);
  assert.equal(finiteFraction(''), null);
  assert.equal(timestampIso({ seconds: 0, nanos: 0 }), '1970-01-01T00:00:00.000Z');
});

test('Connect response wrappers are unwrapped', () => {
  const wrapped = normalizeQuotaSummary({ response: quotaResponse() });
  assert.equal(wrapped.buckets.length, 4);
  assert.equal(wrapped.groups.length, 1);
  assert.equal(projectFromLoadCodeAssist({ response: { cloudaicompanionProject: 'aicode-consumers' } }), 'aicode-consumers');
  assert.equal(projectFromLoadCodeAssist({ response: { cloudaicompanionProject: { id: 'project-x' } } }), 'project-x');
});

test('refresh resolves the project, caches the snapshot and touches the account', async () => {
  const client = makeClient();
  const { service, dataDir, accounts, events } = makeService(client);
  const result = await service.refresh({ force: true });

  assert.equal(result.state, 'live');
  assert.equal(result.email, 'a@gmail.com');
  assert.equal(result.buckets[0].remainingFraction, 0);
  assert.equal(result.sampledAt, new Date(NOW).toISOString());
  assert.ok(client.calls.some(call => call.method === 'GetLoadCodeAssist'), 'project fallback ran');
  assert.ok(client.calls.some(call => call.method === 'RetrieveUserQuotaSummary' && call.body.project === 'project-1'));
  assert.deepEqual(accounts.touched, ['a@gmail.com']);
  assert.equal(events.published[0].quotaUpdated, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'quota-cache.json')));

  assert.equal(service.cached('A@Gmail.com').buckets.length, 4);
  const decorated = service.decorate({
    supported: true,
    current: { email: 'a@gmail.com' },
    accounts: [{ id: 'a@gmail.com', email: 'a@gmail.com', active: true }]
  });
  assert.equal(decorated.accounts[0].quota.buckets.length, 4);
  assert.equal(decorated.currentQuota.buckets.length, 4);
});

test('fresh cache is reused until forced, and forget removes it', async () => {
  const client = makeClient();
  const { service } = makeService(client);
  await service.refresh({ force: true });
  const quotaCalls = client.calls.filter(call => call.method === 'RetrieveUserQuotaSummary').length;

  const cached = await service.refresh();
  assert.equal(cached.cached, true);
  assert.equal(client.calls.filter(call => call.method === 'RetrieveUserQuotaSummary').length, quotaCalls, 'cache hit skips the RPC');

  await service.refresh({ force: true });
  assert.ok(client.calls.filter(call => call.method === 'RetrieveUserQuotaSummary').length > quotaCalls, 'force bypasses the cache');

  service.forget('a@gmail.com');
  assert.equal(service.cached('a@gmail.com'), null);
});

test('concurrent refreshes share one request', async () => {
  const client = makeClient();
  const { service } = makeService(client);
  const first = service.refresh({ force: true });
  const second = service.refresh({ force: true });
  assert.equal(first, second);
  await first;
  const quotaCalls = client.calls.filter(call => call.method === 'RetrieveUserQuotaSummary').length;
  assert.equal(quotaCalls, 2, 'one failed project attempt + one successful retry');
});

test('account switch during a read discards the sample', async () => {
  const client = makeClient({ afterEmail: 'b@gmail.com' });
  const { service } = makeService(client);
  const result = await service.refresh({ force: true });
  assert.equal(result.state, 'unavailable');
  assert.equal(service.cached('a@gmail.com'), null);
});

test('backend restart during a read discards the sample', async () => {
  const client = makeClient({ afterServer: { pid: 10, port: 4002, csrf: 'other' } });
  const { service } = makeService(client);
  const result = await service.refresh({ force: true });
  assert.equal(result.state, 'unavailable');
  assert.equal(service.cached('a@gmail.com'), null);
});

test('kick retries until the language service answers', async () => {
  const client = makeClient({ failDiscover: 2 });
  const { service } = makeService(client, { retryDelays: [0, 0, 0, 0] });
  const result = await service.kick();
  assert.equal(result.state, 'live');
});

test('unavailable reads fall back to the last snapshot without leaking errors', async () => {
  const client = makeClient();
  const { service } = makeService(client);
  await service.refresh({ force: true });
  client.call = async () => { throw new Error('raw backend failure: token'); };
  const result = await service.refresh({ force: true });
  assert.equal(result.state, 'stale');
  assert.equal(result.buckets.length, 4);
  assert.equal(JSON.stringify(result).includes('raw backend failure'), false);
});
