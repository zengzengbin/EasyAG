// Safe cleanup of Antigravity's log directory.
// Only direct *.log files above the threshold are removed, and only after the
// caller confirms that Antigravity is not running. Never follows links or
// touches subdirectories.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MIN_BYTES = 64 * 1024 * 1024;

function defaultLogDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Antigravity', 'logs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'logs');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Antigravity', 'logs');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[index]}`;
}

class LogCleanup {
  constructor({ logDir = defaultLogDir(), minBytes = DEFAULT_MIN_BYTES, isRunning = async () => false, events = null, fsImpl = fs } = {}) {
    this.dir = logDir;
    this.minBytes = Math.max(1, Number(minBytes) || DEFAULT_MIN_BYTES);
    this.isRunning = isRunning;
    this.events = events;
    this.fs = fsImpl;
    this.pending = null;
  }

  run() {
    if (this.pending) return this.pending;
    this.pending = this._run().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _run() {
    try {
      if (await this.isRunning()) return { ok: true, skipped: 'running', removed: 0, bytes: 0 };
      let entries;
      try {
        entries = await this.fs.promises.readdir(this.dir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return { ok: true, skipped: 'missing', removed: 0, bytes: 0 };
        }
        throw error;
      }
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
        const file = path.join(this.dir, entry.name);
        let stat;
        try {
          stat = await this.fs.promises.lstat(file);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < this.minBytes) continue;
        candidates.push({ file, size: stat.size });
      }
      if (!candidates.length) return { ok: true, skipped: 'threshold', removed: 0, bytes: 0 };
      // Check again right before unlinking: never clean while AG is live.
      if (await this.isRunning()) return { ok: true, skipped: 'running', removed: 0, bytes: 0 };
      let removed = 0;
      let bytes = 0;
      let failed = 0;
      for (const item of candidates) {
        try {
          await this.fs.promises.unlink(item.file);
          removed++;
          bytes += item.size;
        } catch (error) {
          if (error?.code !== 'ENOENT') failed++;
        }
      }
      if (removed && this.events?.log) {
        this.events.log('SYSTEM', `已清理 AG 日志 ${removed} 个（${formatBytes(bytes)}）`, 'tag-proxy');
      }
      return { ok: failed === 0, removed, bytes, failed, skipped: removed ? null : 'failed' };
    } catch (error) {
      if (this.events?.log) this.events.log('SYSTEM', `AG 日志清理失败：${error.message}`, 'tag-warn');
      return { ok: false, removed: 0, bytes: 0, error: error.message };
    }
  }
}

module.exports = { LogCleanup, defaultLogDir, formatBytes, DEFAULT_MIN_BYTES };
