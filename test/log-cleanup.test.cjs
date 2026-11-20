const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LogCleanup, formatBytes } = require('../features/log-cleanup');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-log-cleanup-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  return { dir, logs };
}

function write(file, bytes) {
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
}

test('removes only oversized direct .log files and keeps everything else', async t => {
  const { dir, logs } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(logs, 'language_server.log'), 2048);
  write(path.join(logs, 'small.log'), 128);
  write(path.join(logs, 'notes.txt'), 2048);
  fs.mkdirSync(path.join(logs, 'nested'));
  write(path.join(logs, 'nested', 'old.log'), 2048);
  const events = { messages: [], log(category, message) { this.messages.push({ category, message }); } };
  const cleanup = new LogCleanup({ logDir: logs, minBytes: 1024, isRunning: async () => false, events });

  const result = await cleanup.run();

  assert.deepEqual(result, { ok: true, removed: 1, bytes: 2048, failed: 0, skipped: null });
  assert.equal(fs.existsSync(path.join(logs, 'language_server.log')), false);
  assert.equal(fs.existsSync(path.join(logs, 'small.log')), true);
  assert.equal(fs.existsSync(path.join(logs, 'notes.txt')), true);
  assert.equal(fs.existsSync(path.join(logs, 'nested', 'old.log')), true);
  assert.match(events.messages[0].message, /已清理 AG 日志 1 个（2 KB）/);
});

test('never touches logs while Antigravity is running', async t => {
  const { dir, logs } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(logs, 'language_server.log');
  write(file, 2048);
  const events = { messages: [], log(category, message) { this.messages.push({ category, message }); } };
  const cleanup = new LogCleanup({ logDir: logs, minBytes: 1024, isRunning: async () => true, events });

  const result = await cleanup.run();

  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'running');
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(file), true);
  assert.equal(events.messages.length, 0);
});

test('missing log directory is a no-op', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-log-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cleanup = new LogCleanup({ logDir: path.join(dir, 'missing'), minBytes: 1, isRunning: async () => false });
  const result = await cleanup.run();
  assert.deepEqual(result, { ok: true, skipped: 'missing', removed: 0, bytes: 0 });
});

test('files below the threshold are reported as skipped', async t => {
  const { dir, logs } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(logs, 'language_server.log'), 10);
  const cleanup = new LogCleanup({ logDir: logs, minBytes: 1024, isRunning: async () => false });
  const result = await cleanup.run();
  assert.equal(result.skipped, 'threshold');
  assert.equal(result.removed, 0);
});

test('concurrent calls share one cleanup pass', async t => {
  const { dir, logs } = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(logs, 'language_server.log'), 2048);
  let checks = 0;
  const cleanup = new LogCleanup({
    logDir: logs,
    minBytes: 1024,
    isRunning: async () => { checks++; await new Promise(resolve => setTimeout(resolve, 20)); return false; }
  });
  const first = cleanup.run();
  const second = cleanup.run();
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.removed, 1);
  assert.equal(checks, 2, 'running state is checked before collecting and before unlinking');
});

test('formatBytes keeps values readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(64 * 1024 * 1024), '64 MB');
  assert.equal(formatBytes(1536), '1.5 KB');
});
