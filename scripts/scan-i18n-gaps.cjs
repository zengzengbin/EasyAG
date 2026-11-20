#!/usr/bin/env node
// 汉化盲区扫描器：直接通过 AG 的 CDP 端口遍历界面，收集词典未命中的英文文案。
// 只读操作，不注入、不修改任何状态。产出 gaps JSON 供补词典。
// 用法：node scripts/scan-i18n-gaps.cjs [--out gaps.json]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CdpConnection } = require('../adapters/desktop/cdp');
const { loadDictionary } = require('../features/i18n');

// 与 installI18n 相同的忽略规则 + 英文 UI 文案判定。
const COLLECT = `(() => {
  const ignored = 'script,style,pre,code,textarea,[contenteditable="true"],[data-testid*="message-content"]';
  const out = [];
  const push = raw => {
    const key = (raw || '').trim();
    if (!key || key.length > 2000) return;
    if (!/[A-Za-z]/.test(key)) return;
    if (!/ /.test(key) && /^[A-Z0-9_.$:-]+$/.test(key)) return;
    out.push(key);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest?.(ignored)) push(node.nodeValue);
  }
  for (const el of document.querySelectorAll('input,textarea,[placeholder],[title],[aria-label]')) {
    if (el.closest?.(ignored)) continue;
    push(el.getAttribute('placeholder'));
    push(el.getAttribute('title'));
    push(el.getAttribute('aria-label'));
  }
  return out;
})()`;

// 深页扫描：打开设置弹窗逐面板遍历（只读展示层，不改配置；结束恢复原状）。
const OPEN_SETTINGS = `(() => {
  const btn = document.querySelector('[data-testid="settings-button"]');
  if (!btn) return 'no-settings-button';
  btn.click();
  return 'opened';
})()`;
const CLOSE_SETTINGS = `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return 'no-dialog';
  for (const el of dialog.querySelectorAll('button[aria-label],button[title]')) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (/close|关闭/i.test(label)) { el.click(); return 'closed'; }
  }
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 'escaped';
})()`;
const CLICK_TAB = tab => `(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  for (const el of dialog.querySelectorAll('[role="tab"],button,[role="menuitem"]')) {
    if ((el.textContent || '').trim() === ${JSON.stringify(tab)}) { el.click(); return true; }
  }
  return false;
})()`;

async function collectPage(socket, tag, gaps, hits, dictionary) {
  const result = await socket.command('Runtime.evaluate', { expression: COLLECT, returnByValue: true });
  if (!Array.isArray(result.result.value)) return;
  for (const key of result.result.value) {
    if (typeof dictionary[key] === 'string') { hits.add(key); continue; }
    const entry = gaps.get(key) || { count: 0, pages: new Set() };
    entry.count++;
    entry.pages.add(tag);
    gaps.set(key, entry);
  }
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const dataDir = process.env.EASYAG_DATA_DIR || path.join(os.homedir(), 'AppData', 'Local', 'com.easyag.launcher.tauri');
  const dictionary = loadDictionary(rootDir, dataDir);
  console.log(`词典载入: ${Object.keys(dictionary).length} 条`);

  // 1. 从 DevToolsActivePort 拿 CDP 端口，列页面
  const profile = process.env.APPDATA ? path.join(process.env.APPDATA, 'Antigravity') : '';
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const pages = list.filter(t => t.type === 'page' && /^https?:/.test(t.url));
  console.log(`AG 页面数: ${pages.length}`);

  const gaps = new Map();
  const hits = new Set();
  let scanned = 0;
  for (const page of pages) {
    let socket;
    try {
      socket = await new CdpConnection(page.webSocketDebuggerUrl).open();
      // 主界面
      await collectPage(socket, 'main', gaps, hits, dictionary);
      scanned++;
      // 设置弹窗（如无按钮则跳过）
      const opened = await socket.command('Runtime.evaluate', { expression: OPEN_SETTINGS, returnByValue: true });
      if (opened.result.value === 'opened') {
        await new Promise(r => setTimeout(r, 800));
        await collectPage(socket, 'settings', gaps, hits, dictionary);
        // 逐设置面板：读当前 tab 列表再逐个点过去
        const tabs = await socket.command('Runtime.evaluate', { expression: `(() => [...document.querySelectorAll('[role="dialog"] [role="tab"]')].map(el => (el.textContent||'').trim()).filter(Boolean).slice(0, 20))()`, returnByValue: true });
        const tabNames = tabs.result.value || [];
        console.log('设置面板 tab:', tabNames.join(' | '));
        for (const tab of tabNames) {
          const clicked = await socket.command('Runtime.evaluate', { expression: CLICK_TAB(tab), returnByValue: true });
          if (clicked.result.value) {
            await new Promise(r => setTimeout(r, 600));
            await collectPage(socket, `settings:${tab}`, gaps, hits, dictionary);
          }
        }
        await socket.command('Runtime.evaluate', { expression: CLOSE_SETTINGS, returnByValue: true });
      }
    } catch (error) {
      console.log(`页面跳过: ${page.title} - ${error.message}`);
    } finally { socket?.close(); }
  }

  const out = {
    scannedAt: new Date().toISOString(),
    pagesScanned: scanned,
    dictionarySize: Object.keys(dictionary).length,
    hitCount: hits.size,
    gaps: [...gaps.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([key, { count, pages }]) => ({ key, count, pages: [...pages] }))
  };
  const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(__dirname, '..', 'i18n-gaps.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`扫描完成: ${scanned} 页, 命中 ${hits.size}, 未命中 ${out.gaps.length}`);
  console.log(`已写入 ${outFile}`);
  console.log('\n=== 未命中 TOP 40（按出现次数） ===');
  for (const g of out.gaps.slice(0, 40)) console.log(`[${g.count}x] ${g.key.slice(0, 110)}`);
}
main().catch(error => { console.error('FAIL:', error.message); process.exit(1); });
