// Real browser regression for launcher initialization, actions and fallback paths.
// All API responses are synthetic; no installed Antigravity is launched or changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CdpConnection } = require('../adapters/desktop/cdp');
const { waitForBrowserPage } = require('./browser-ready.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const executable = process.argv[2];
  assert.ok(executable && fs.existsSync(executable), 'Supply an installed Chromium executable');
  const root = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-launcher-browser-'));
  const calls = [];
  const status = {
    activeTarget: 'hub', phase: 'idle', port: 7890, enableProxy: true,
    enableI18n: true, enableContextMonitor: true, clientRunning: false,
    targets: {
      hub: { exists: true, appExe: 'C:\\Synthetic\\Antigravity.exe' },
      ide: { exists: false, appExe: '' }
    }
  };
  let failLaunch = false;
  let conflict = false;
  let cleanupFails = false;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (!route.startsWith('/api/')) {
      const files = { '/': 'index.html', '/ui/launcher.js': 'ui/launcher.js', '/ui/api.js': 'ui/api.js', '/ui/launcher.css': 'ui/launcher.css' };
      if (!files[route]) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', route.endsWith('.js') ? 'text/javascript' : route.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(root, files[route])));
      return;
    }
    if (route === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    calls.push({ route, input });
    let result = { ok: true };
    if (route === '/api/status') result = status;
    if (route === '/api/logs') result = [];
    if (route === '/api/config' && input.targetApp) status.activeTarget = input.targetApp;
    if (route === '/api/set-target-path' || route === '/api/browse-exe') {
      const exe = route === '/api/browse-exe' ? 'D:\\Synthetic\\Browsed.exe' : input.path;
      if (exe === 'invalid.exe') { res.statusCode = 400; result = { ok: false, error: '指定的文件路径不存在' }; }
      else {
        status.targets[input.target] = { exists: Boolean(exe), appExe: exe, isCustom: Boolean(exe) };
        result = { ok: true, path: exe, status };
      }
    }
    if (route === '/api/launch' && failLaunch) { res.statusCode = 409; result = { ok: false, error: 'Synthetic launch failure', code: 'TARGET_NOT_FOUND' }; }
    if (route === '/api/launch' && conflict) { res.statusCode = 409; result = { ok: false, code: 'PROCESS_CONFLICT', error: '已有 AG 进程' }; }
    if (route === '/api/clean-and-launch' && cleanupFails) { res.statusCode = 409; result = { ok: false, code: 'CLEANUP_FAILED', error: '进程未退出' }; }
    if (route === '/api/accounts') result = {
      supported: true,
      current: { email: 'active@gmail.com', authMethod: 'consumer', scope: 'u-1' },
      currentQuota: {
        sampledAt: new Date().toISOString(),
        description: '',
        buckets: [
          { id: 'pro', name: 'Gemini Pro', remainingFraction: 0.72, resetAt: new Date(Date.now() + 3600000).toISOString(), disabled: false },
          { id: 'claude', name: 'Claude', remainingFraction: 0.12, resetAt: new Date(Date.now() + 7200000).toISOString(), disabled: false }
        ],
        groups: []
      },
      accounts: [
        {
          id: 'active', email: 'active@gmail.com', authMethod: 'consumer', alias: null, note: null,
          capturedAt: 't1', updatedAt: 't2', lastUsedAt: 't3', active: true,
          quota: {
            sampledAt: new Date().toISOString(),
            description: '',
            buckets: [
              { id: 'pro', name: 'Gemini Pro', remainingFraction: 0.72, resetAt: new Date(Date.now() + 3600000).toISOString(), disabled: false },
              { id: 'claude', name: 'Claude', remainingFraction: 0.12, resetAt: new Date(Date.now() + 7200000).toISOString(), disabled: false }
            ],
            groups: []
          }
        },
        { id: 'second', email: 'second@gmail.com', authMethod: 'consumer', alias: '备用号', note: '测试备注', capturedAt: 't1', updatedAt: 't2', lastUsedAt: null, active: false, quota: null }
      ],
      errors: []
    };
    if (route === '/api/accounts/switch') result = { ok: true, email: 'second@gmail.com' };
    if (route === '/api/accounts/capture') result = { ok: true, id: 'second', email: 'second@gmail.com', created: true };
    if (route === '/api/accounts/meta') result = { ok: true, id: input.id, email: 'second@gmail.com', alias: input.alias, note: input.note };
    if (route === '/api/quota/refresh') result = {
      ok: true, state: 'live', email: 'active@gmail.com', sampledAt: new Date().toISOString(),
      description: '', groups: [],
      buckets: [{ id: 'pro', name: 'Gemini Pro', remainingFraction: 0.5, resetAt: null, disabled: false }]
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--no-proxy-server', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch {}
      if (!port) await sleep(100);
    }
    assert.ok(port, 'Browser starts');
    const page = await waitForBrowserPage(port, browser);
    socket = await new CdpConnection(page.webSocketDebuggerUrl).open();
    const evaluate = async expression => {
      const result = await socket.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).catch(error => { throw new Error(`Evaluate ${expression}: ${error.message}`); });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
      assert.fail(`Timed out: ${expression}`);
    };
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const visible = "document.getElementById('pathModal').style.display === 'flex'";
    await socket.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await waitFor("document.body.dataset.uiState === 'idle'");
    assert.equal(await evaluate("document.getElementById('launchBtn').disabled"), false);
    const theme = await evaluate('document.documentElement.dataset.theme');
    await click('themeToggleBtn');
    await waitFor(`document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`);
    await click('targetIdeBtn');
    await waitFor(visible);
    await evaluate(`document.getElementById('customPathInput').value = ${JSON.stringify('D:\\Typing.exe')}`);
    await sleep(3300); // Cross the normal status poll: editing must survive it.
    assert.equal(await evaluate("document.getElementById('customPathInput').value"), 'D:\\Typing.exe');
    await click('modalCancelBtn');
    await waitFor(`!(${visible})`);
    await click('launchBtn'); // Missing target must remain actionable after dismissal.
    await waitFor(visible);
    await evaluate("document.getElementById('customPathInput').value = 'invalid.exe'");
    await click('savePathBtn');
    await waitFor("document.getElementById('pathEditTip').style.display === 'flex'");
    await evaluate(`document.getElementById('customPathInput').value = ${JSON.stringify('D:\\Synthetic\\IDE.exe')}`);
    await click('savePathBtn');
    await waitFor(`!(${visible})`);
    assert.ok(calls.some(call => call.route === '/api/set-target-path' && call.input.target === 'ide' && call.input.path === 'D:\\Synthetic\\IDE.exe'));
    await click('targetHubBtn');
    await click('launchBtn');
    await waitFor("document.body.dataset.uiState === 'running'");
    assert.ok(calls.some(call => call.route === '/api/launch'));
    assert.equal(await evaluate("document.getElementById('targetIdeBtn').disabled"), true);
    await waitFor("document.body.dataset.uiState === 'idle'");
    conflict = true;
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    assert.equal(await evaluate("document.getElementById('pathModal').style.display"), 'none');
    await click('processCancelBtn');
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    cleanupFails = true;
    await click('processCleanBtn');
    await waitFor("document.getElementById('processError').textContent.includes('进程未退出')");
    assert.equal(await evaluate("document.getElementById('processCleanBtn').disabled"), false);
    cleanupFails = false;
    await click('processCleanBtn');
    await waitFor("document.body.dataset.uiState === 'running'");
    await click('launchBtn');
    await waitFor("document.getElementById('processModal').style.display === 'flex'");
    await click('processCancelBtn');
    await waitFor("document.body.dataset.uiState === 'idle'");
    conflict = false;
    failLaunch = true;
    await click('launchBtn');
    await waitFor(visible);
    assert.match(await evaluate("document.getElementById('pathTipText').textContent"), /Synthetic launch failure/);
    await click('browseExeBtn');
    await waitFor(`!(${visible})`);
    assert.ok(calls.some(call => call.route === '/api/browse-exe' && call.input.target === 'hub'));
    status.targets.ide.exists = false;
    await click('targetIdeBtn');
    await waitFor(visible);
    await click('resetPathBtn');
    await waitFor("document.getElementById('customPathInput').value === ''");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await waitFor(`!(${visible})`);
    await click('launchBtn'); await waitFor(visible);
    await click('modalCloseBtn'); await waitFor(`!(${visible})`);
    await click('launchBtn'); await waitFor(visible);
    await click('pathModal'); await waitFor(`!(${visible})`);
    // Account panel: list rendering, active badge, capture and switch flows.
    await waitFor("document.getElementById('accountsCard').style.display === ''");
    assert.equal(await evaluate("document.getElementById('currentAccountEmail').textContent"), 'active@gmail.com');
    assert.equal(await evaluate("document.querySelectorAll('#accountList .account-item').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#accountList .account-item.active').length"), 1);
    assert.equal(await evaluate("document.getElementById('quotaCard').style.display"), '');
    assert.equal(await evaluate("document.querySelectorAll('#quotaList .quota-row').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#quotaOverview .quota-stat').length"), 3);
    assert.equal(await evaluate("document.querySelector('#accountList .account-item:not(.active) .account-name').textContent"), '备用号');
    await evaluate("window.prompt = message => message.includes('显示名称') ? '工作号' : '新的备注'");
    await evaluate("document.querySelectorAll('#accountList .account-item:not(.active) .account-btn')[1].click()");
    await sleep(300);
    assert.ok(calls.some(call => call.route === '/api/accounts/meta' && call.input.id === 'second' && call.input.alias === '工作号' && call.input.note === '新的备注'));
    calls.length = 0;
    await click('refreshQuotaBtn');
    await waitFor("[...document.querySelectorAll('#consoleBox .log-line')].some(l => l.textContent.includes('额度已更新'))");
    assert.ok(calls.some(call => call.route === '/api/quota/refresh'));
    calls.length = 0;
    await evaluate("window.confirm = () => true");
    await evaluate("[...document.querySelectorAll('#accountList .account-item:not(.active) .account-btn')][0].click()");
    await waitFor("[...document.querySelectorAll('#consoleBox .log-line')].some(l => l.textContent.includes('已切换到账号'))");
    assert.ok(calls.some(call => call.route === '/api/accounts/switch' && call.input.id === 'second'));
    calls.length = 0;
    await evaluate("document.querySelector('.account-actions [data-action=capture-account]').click()");
    await waitFor("[...document.querySelectorAll('#consoleBox .log-line')].some(l => l.textContent.includes('已保存账号'))");
    assert.ok(calls.some(call => call.route === '/api/accounts/capture'));
    calls.length = 0;
    await evaluate("document.querySelector('.account-actions [data-action=add-account]').click()");
    await waitFor("document.getElementById('accountModal').style.display === 'flex'");
    await click('finishAddAccountBtn');
    await waitFor("document.getElementById('accountModal').style.display === 'none'");
    assert.ok(calls.some(call => call.route === '/api/accounts/capture'));
    console.log('PASS: launcher initialization, theme, target switching, launch, running lock, failure recovery, modal save/browse/reset/dismiss, polling preserves input, accounts panel');
  } finally {
    if (socket) { try { await socket.command('Browser.close'); } catch {} socket.close(); }
    if (browser.exitCode === null) browser.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(profile).startsWith(tempRoot) && path.basename(profile).startsWith('easyag-launcher-browser-')) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still own its temporary files. */ }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
