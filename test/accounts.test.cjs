const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Accounts, slugify, parseCredentialBlob } = require('../features/accounts');

function fakeCredentialBlob(email, { token = 'ya29.fake', refresh = 'rfake', legacy = true } = {}) {
  return Buffer.from(JSON.stringify({
    token: {
      access_token: token, token_type: 'Bearer', refresh_token: refresh, expiry: '2026-01-01T00:00:00Z',
      ...(legacy ? { expires_in: 3599 } : {})
    },
    auth_method: 'consumer',
    ...(legacy ? { writer_id: 'writer-1' } : {}),
    ...(email ? { id_token_email: email } : {})
  }), 'utf8').toString('base64');
}

// In-memory credential + DPAPI double: payload "encryption" is a marker prefix.
function makeCredential(live = {}) {
  const store = { ...live };
  const writes = [];
  return {
    store, writes,
    readAntigravityCredential: async () => store.blobB64
      ? { userName: store.userName || 'antigravity', type: 1, persist: store.persist ?? 2, blobB64: store.blobB64 }
      : null,
    writeAntigravityCredential: async credential => { writes.push(credential); store.blobB64 = credential.blobB64; store.userName = credential.userName; store.persist = credential.persist; },
    readUserScope: () => store.scope ?? null,
    writeUserScope: scope => { store.scope = scope; },
    readLastLoginEmail: () => store.lastLoginEmail ?? null,
    protectData: async buffer => Buffer.concat([Buffer.from('ENC:'), buffer]),
    unprotectData: async buffer => buffer.subarray(4)
  };
}

function makeAccounts({ credential = makeCredential(), platform = 'win32', events = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-accounts-'));
  const accounts = new Accounts({ dataDir, credential, events, platform, now: () => '2026-01-01T00:00:00Z' });
  return { accounts, dataDir, credential };
}

test('slugify keeps stable ids and hashes the empty case', () => {
  assert.equal(slugify('User@Gmail.com'), 'user@gmail.com');
  assert.equal(slugify('weird str!ng+x@gmail.com'), 'weird_str_ng_x@gmail.com');
  assert.match(slugify(''), /^account-[0-9a-f]{12}$/);
});

test('current returns login metadata without exposing the token blob', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com'), scope: 'u-abc' });
  const { accounts } = makeAccounts({ credential });
  const current = await accounts.current();
  assert.equal(current.email, 'a@gmail.com');
  assert.equal(current.authMethod, 'consumer');
  assert.equal(current.scope, 'u-abc');
  assert.equal('blobB64' in current, false);
  assert.equal('token' in current, false);
});

test('capture stores an encrypted profile and list marks the active account', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com'), scope: 'u-abc' });
  const { accounts, dataDir } = makeAccounts({ credential });
  const captured = await accounts.capture();
  assert.deepEqual({ ok: captured.ok, email: captured.email, created: captured.created }, { ok: true, email: 'a@gmail.com', created: true });

  const file = path.join(dataDir, 'accounts', 'a@gmail.com.agprofile');
  assert.ok(fs.existsSync(file), 'profile file written');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.email, 'a@gmail.com');
  assert.equal(Buffer.from(raw.payloadB64, 'base64').toString('utf8').slice(0, 4), 'ENC:', 'payload is encrypted (ENC: prefix), not plaintext');
  assert.equal(JSON.stringify(raw).includes('ya29.fake'), false, 'token never leaks into the header');

  const state = await accounts.list();
  assert.equal(state.supported, true);
  assert.equal(state.current.email, 'a@gmail.com');
  assert.deepEqual(state.accounts, [{
    id: 'a@gmail.com', email: 'a@gmail.com', authMethod: 'consumer',
    alias: null, note: null,
    capturedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-01-01T00:00:00Z', active: true
  }]);
});

test('recapture updates the same profile and keeps the original capture date', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com', { token: 'ya29.old' }), scope: 'u-1' });
  const { accounts } = makeAccounts({ credential });
  await accounts.capture();
  credential.store.blobB64 = fakeCredentialBlob('a@gmail.com', { token: 'ya29.fresh' });
  const second = await accounts.capture();
  assert.equal(second.created, false);
  const state = await accounts.list();
  assert.equal(state.accounts.length, 1);
  const decrypted = await accounts._loadProfile(path.join(accounts.dir, 'a@gmail.com.agprofile'));
  assert.equal(JSON.parse(Buffer.from(decrypted.credential.blobB64, 'base64').toString('utf8')).token.access_token, 'ya29.fresh');
});

test('switchTo writes credential and user scope, and is idempotent per email', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com'), scope: 'u-a' });
  const { accounts } = makeAccounts({ credential });
  await accounts.capture();

  credential.store.blobB64 = fakeCredentialBlob('b@gmail.com');
  credential.store.scope = 'u-b';

  const result = await accounts.switchTo('a@gmail.com');
  assert.equal(result.ok, true);
  assert.equal(result.email, 'a@gmail.com');
  assert.equal(JSON.parse(Buffer.from(credential.writes[0].blobB64, 'base64').toString('utf8')).id_token_email, 'a@gmail.com');
  assert.equal(credential.store.scope, 'u-a', 'user scope restored from the profile');

  // Switching back to the now-live account short-circuits without a write.
  const again = await accounts.switchTo('a@gmail.com');
  assert.equal(again.already, true);
  assert.equal(credential.writes.length, 1);
});

test('switchTo keeps the current scope when the profile has none', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts } = makeAccounts({ credential });
  const file = path.join(accounts.dir, 'a@gmail.com.agprofile');
  fs.mkdirSync(accounts.dir, { recursive: true });
  const profile = {
    version: 1, email: 'a@gmail.com', authMethod: 'consumer',
    capturedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    credential: { userName: 'antigravity', type: 1, persist: 2, blobB64: fakeCredentialBlob('a@gmail.com') },
    userScope: null
  };
  await accounts._saveProfile(file, profile);

  credential.store.blobB64 = fakeCredentialBlob('b@gmail.com');
  credential.store.scope = 'u-live';
  const result = await accounts.switchTo('a@gmail.com');
  assert.equal(result.ok, true);
  assert.equal(credential.store.scope, 'u-live', 'absent profile scope leaves the live pointer untouched');
});

test('remove deletes the profile and unknown ids fail loudly', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts } = makeAccounts({ credential });
  await accounts.capture();
  const removed = await accounts.remove('a@gmail.com');
  assert.equal(removed.ok, true);
  assert.equal((await accounts.list()).accounts.length, 0);
  await assert.rejects(() => accounts.remove('a@gmail.com'));
});

test('importFrom validates payload and exportTo round-trips through plaintext JSON', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com'), scope: 'u-a' });
  const { accounts, dataDir } = makeAccounts({ credential });
  await accounts.capture();
  accounts.setMeta('a@gmail.com', { alias: 'A 号', note: '导出测试' });

  const exportPath = path.join(dataDir, 'exported.json');
  await accounts.exportTo('a@gmail.com', exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exported.email, 'a@gmail.com');
  assert.equal(exported.userScope, 'u-a');
  assert.equal(exported.alias, 'A 号');
  assert.equal(exported.note, '导出测试');
  assert.ok(exported.credential.blobB64);

  const { accounts: other } = makeAccounts({ credential: makeCredential() });
  const imported = await other.importFrom(exportPath);
  assert.deepEqual({ ok: imported.ok, email: imported.email, created: imported.created }, { ok: true, email: 'a@gmail.com', created: true });
  const state = await other.list();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].alias, 'A 号');
  assert.equal(state.accounts[0].note, '导出测试');

  fs.writeFileSync(exportPath, '{"email":"x@gmail.com"}');
  await assert.rejects(() => other.importFrom(exportPath), /缺少账号凭证或邮箱字段/);

  fs.writeFileSync(exportPath, 'not json');
  await assert.rejects(() => other.importFrom(exportPath), /不是有效的 JSON/);
});

test('importFrom rejects email/blob mismatch', async () => {
  const { accounts } = makeAccounts({});
  const file = path.join(os.tmpdir(), 'easyag-mismatch.json');
  fs.writeFileSync(file, JSON.stringify({
    email: 'a@gmail.com',
    credential: { userName: 'antigravity', type: 1, persist: 2, blobB64: fakeCredentialBlob('b@gmail.com') }
  }));
  await assert.rejects(() => accounts.importFrom(file), /邮箱与凭证不匹配/);
});

test('list survives a corrupted profile file and reports it', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts } = makeAccounts({ credential });
  await accounts.capture();
  fs.writeFileSync(path.join(accounts.dir, 'broken.agprofile'), '{oops');
  const state = await accounts.list();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].file, 'broken.agprofile');
});

test('list reports unsupported on non-Windows platforms without touching credentials', async () => {
  let read = 0;
  const credential = makeCredential();
  credential.readAntigravityCredential = async () => { read++; return null; };
  const { accounts } = makeAccounts({ credential, platform: 'darwin' });
  const state = await accounts.list();
  assert.deepEqual([state.supported, state.current, state.accounts, read], [false, null, [], 0]);
});

test('capture identifies a modern email-less credential from the last-login record and the refresh hash', async () => {
  const credential = makeCredential({
    blobB64: fakeCredentialBlob(null, { legacy: false }),
    lastLoginEmail: 'c@gmail.com'
  });
  const { accounts, dataDir } = makeAccounts({ credential });
  const captured = await accounts.capture();
  assert.deepEqual({ email: captured.email, created: captured.created }, { email: 'c@gmail.com', created: true });

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts', 'c@gmail.com.agprofile'), 'utf8'));
  assert.match(raw.refreshHash, /^[0-9a-f]{64}$/);
  const state = await accounts.list();
  assert.equal(state.current.email, 'c@gmail.com');
  assert.equal(state.accounts[0].active, true);

  // Once the app's last-login record is gone, the stored hash still identifies it.
  credential.store.lastLoginEmail = null;
  assert.equal((await accounts.current()).email, 'c@gmail.com');
  const recaptured = await accounts.capture();
  assert.equal(recaptured.created, false);
});

test('capture refuses a stale last-login record and accepts a supplied email instead', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com', { refresh: 'r-a' }) });
  const { accounts } = makeAccounts({ credential });
  await accounts.capture();

  credential.store.blobB64 = fakeCredentialBlob(null, { refresh: 'r-c', legacy: false });
  credential.store.lastLoginEmail = 'a@gmail.com';
  await assert.rejects(() => accounts.capture(), (error) => {
    assert.equal(error.code, 'ACCOUNT_EMAIL_REQUIRED');
    assert.equal(error.suggestion, null, 'stale candidate is not suggested');
    return true;
  });

  const captured = await accounts.capture('c@gmail.com');
  assert.deepEqual({ email: captured.email, created: captured.created }, { email: 'c@gmail.com', created: true });
  assert.equal((await accounts.current()).email, 'c@gmail.com');
  const state = await accounts.list();
  assert.deepEqual(state.accounts.map(account => [account.email, account.active]), [['a@gmail.com', false], ['c@gmail.com', true]]);
});

test('capture validates a supplied email against blob and format', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts } = makeAccounts({ credential });
  await assert.rejects(() => accounts.capture('not-an-email'), /邮箱格式不正确/);
  await assert.rejects(() => accounts.capture('b@gmail.com'), /凭证属于 a@gmail.com/);
  const captured = await accounts.capture('A@gmail.com');
  assert.deepEqual({ id: captured.id, email: captured.email }, { id: 'a@gmail.com', email: 'a@gmail.com' }, 'email is normalised to the blob account');
});

test('switchTo backfills a refresh hash for profiles saved before it existed', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com', { refresh: 'r-a' }) });
  const { accounts } = makeAccounts({ credential });
  const file = path.join(accounts.dir, 'a@gmail.com.agprofile');
  fs.mkdirSync(accounts.dir, { recursive: true });
  await accounts._saveProfile(file, {
    version: 1, email: 'a@gmail.com', authMethod: 'consumer',
    capturedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    credential: { userName: 'antigravity', type: 1, persist: 2, blobB64: fakeCredentialBlob('a@gmail.com', { refresh: 'r-a' }) },
    userScope: null
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshHash, undefined);

  credential.store.blobB64 = fakeCredentialBlob(null, { refresh: 'r-b', legacy: false });
  credential.store.lastLoginEmail = 'b@gmail.com';
  await accounts.switchTo('a@gmail.com');
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).refreshHash, /^[0-9a-f]{64}$/);
});

test('setMeta updates only the plaintext header and validates lengths', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts, dataDir } = makeAccounts({ credential });
  await accounts.capture();
  const file = path.join(dataDir, 'accounts', 'a@gmail.com.agprofile');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));

  const result = accounts.setMeta('a@gmail.com', { alias: '  工作号  ', note: '主力账号' });
  assert.deepEqual({ alias: result.alias, note: result.note }, { alias: '工作号', note: '主力账号' });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.payloadB64, before.payloadB64, 'payload stays byte-identical');
  assert.equal(after.alias, '工作号');
  assert.equal(after.note, '主力账号');

  const state = await accounts.list();
  assert.equal(state.accounts[0].alias, '工作号');
  assert.equal(state.accounts[0].note, '主力账号');

  accounts.setMeta('a@gmail.com', { alias: '' });
  assert.equal((await accounts.list()).accounts[0].alias, null, 'empty alias falls back to the email');
  assert.throws(() => accounts.setMeta('a@gmail.com', { alias: 'x'.repeat(33) }), /别名最多 32/);
  assert.throws(() => accounts.setMeta('a@gmail.com', { note: 'x'.repeat(201) }), /备注最多 200/);
});

test('touch records the last-used time without touching the encrypted payload', async () => {
  const credential = makeCredential({ blobB64: fakeCredentialBlob('a@gmail.com') });
  const { accounts, dataDir } = makeAccounts({ credential });
  await accounts.capture();
  const file = path.join(dataDir, 'accounts', 'a@gmail.com.agprofile');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));

  accounts.now = () => '2026-02-02T00:00:00Z';
  assert.equal(accounts.touch('a@gmail.com'), '2026-02-02T00:00:00Z');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.lastUsedAt, '2026-02-02T00:00:00Z');
  assert.equal(after.payloadB64, before.payloadB64);
  assert.equal((await accounts.list()).accounts[0].lastUsedAt, '2026-02-02T00:00:00Z');
  assert.equal(accounts.touch('missing@gmail.com'), null);
});

test('capture without a live login and blobs without email fail closed', async () => {
  const { accounts } = makeAccounts({ credential: makeCredential() });
  await assert.rejects(() => accounts.capture(), /未检测到 Antigravity 登录凭证/);
  assert.throws(() => parseCredentialBlob(Buffer.from('not-json').toString('base64')), /无法识别/);
});
