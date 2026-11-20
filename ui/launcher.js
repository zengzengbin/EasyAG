import { api } from './api.js';

const element = id => document.getElementById(id);
const consoleBox = element('consoleBox');
let phase = 'idle';
let settingsQueue = Promise.resolve();
let refreshing = false;
let stream;
let pollTimer;
let launchPending = false;
let cleanupPending = false;
let activeTarget = 'hub';
let activeTargetName = 'Antigravity';
let clientRunningState = false;
let currentTargets = {};
let pathModalDismissed = false;
const logKeys = new Set();

// Suppress the embedded browser's default menu in the launcher.
document.addEventListener('contextmenu', event => event.preventDefault());

function appendLog(category, message, cls = '', at) {
  const key = at && `${at}|${category}|${message}`;
  if (key && logKeys.has(key)) return;
  if (key) {
    logKeys.add(key);
    if (logKeys.size > 500) logKeys.delete(logKeys.values().next().value);
  }
  const line = document.createElement('div');
  line.className = 'log-line';
  if (/^tag-[a-z-]+$/.test(cls)) line.classList.add(cls);
  const time = new Date(at || Date.now()).toLocaleTimeString();
  line.textContent = `[${time}] [${category || 'SYSTEM'}] ${message || ''}`;
  consoleBox.appendChild(line);
  while (consoleBox.children.length > 300) consoleBox.firstElementChild.remove();
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function report(error) { appendLog('SYSTEM', error.message || String(error), 'tag-alert'); }

function updateProxyUi(enabled) {
  const row = element('proxyPortRow');
  const badge = element('patchStatusBadge');
  const busyOrRunning = ['preparing', 'launching', 'running', 'cleaning'].includes(phase);
  if (row) row.classList.toggle('disabled', !enabled);
  document.querySelectorAll('[data-port]').forEach(control => {
    control.disabled = !enabled || busyOrRunning;
  });
  if (element('proxyPortInput')) {
    element('proxyPortInput').disabled = !enabled || busyOrRunning;
  }
  if (badge) {
    badge.textContent = enabled ? '· 本地代理就绪' : '· 直连模式（不挂代理）';
    badge.style.color = enabled ? 'var(--green)' : 'var(--text-dark)';
  }
}

function renderPhase(next, targetName = activeTargetName) {
  phase = next;
  document.body.dataset.uiState = next;
  const busy = ['preparing', 'launching', 'cleaning'].includes(next);
  const locked = busy || next === 'running';
  const button = element('launchBtn');
  button.disabled = busy;
  button.title = next === 'running' ? '点击处理已有进程' : '';
  button.classList.toggle('busy', busy);
  if (element('proxyToggle')) element('proxyToggle').disabled = locked;
  document.querySelectorAll('[data-target]').forEach(control => { control.disabled = locked; });
  // 启动序列期间禁用账号切换，避免与进程清理竞争。
  document.querySelectorAll('.account-item .account-btn').forEach(control => { control.disabled = busy; });
  const proxyEnabled = element('proxyToggle') ? element('proxyToggle').checked : true;
  document.querySelectorAll('[data-port]').forEach(control => { control.disabled = locked || !proxyEnabled; });
  element('proxyPortInput').disabled = locked || !proxyEnabled;

  const currentObj = currentTargets[activeTarget] || {};
  const isMissing = !currentObj.exists && next === 'idle';

  if (isMissing) {
    element('launchIcon').textContent = '⚠️';
    element('launchText').textContent = `请先配置 ${targetName} 路径`;
    button.style.background = 'var(--surface-subtle)';
    button.style.color = 'var(--text-dark)';
    return;
  }

  button.style.color = '';
  element('launchIcon').textContent = busy ? '◌' : next === 'running' ? '●' : next === 'error' ? '↻' : '🚀';
  element('launchText').textContent = {
    preparing: proxyEnabled ? '正在准备代理环境…' : '正在准备启动环境…',
    launching: `正在启动 ${targetName}…`,
    cleaning: '正在清理并重新启动…',
    running: `${targetName} 运行中`,
    error: '启动失败，点击重试'
  }[next] || `启动 ${targetName}`;
  button.style.background = next === 'running' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '';
}


function showModalError(msg) {
  const tip = element('pathEditTip');
  const txt = element('pathErrorText') || element('pathTipText');
  if (tip) {
    tip.style.display = 'flex';
  }
  if (txt) txt.textContent = msg || '指定的文件路径不存在';
}

function showPathModal(visible, customTitle, customDesc) {
  const modal = element('pathModal');
  if (!modal) return;
  if (visible && modal.style.display === 'flex') return;
  modal.style.display = visible ? 'flex' : 'none';
  if (visible) {
    const titleEl = element('modalTargetTitle');
    const descEl = element('pathTipText');
    const input = element('customPathInput');
    const resetBtn = element('resetPathBtn');
    const errorTip = element('pathEditTip');
    const activeObj = currentTargets[activeTarget] || {};

    if (titleEl) titleEl.textContent = customTitle || `未找到 ${activeTargetName}`;
    if (descEl) descEl.textContent = customDesc || `未在默认路径检测到 ${activeTargetName}。如安装在非 C 盘，请点击“浏览”指定 .exe 文件路径：`;
    if (input) {
      input.value = activeObj.appExe || '';
      input.focus();
    }
    if (resetBtn) resetBtn.style.display = activeObj.isCustom ? 'inline-flex' : 'none';
    if (errorTip) errorTip.style.display = 'none';
  }
}

function renderTargetsUi(targets, currentActive) {
  const hubTarget = targets.hub || {};
  const ideTarget = targets.ide || {};

  element('targetHubBtn')?.classList.toggle('active', currentActive === 'hub');
  element('targetIdeBtn')?.classList.toggle('active', currentActive === 'ide');

  const hubDot = element('hubDot');
  if (hubDot) {
    hubDot.className = 'pill-dot ' + (hubTarget.isCustom ? 'custom' : (hubTarget.exists ? 'ready' : 'missing'));
    hubDot.title = hubTarget.exists ? (hubTarget.isCustom ? '已配置自定义路径' : '已就绪 (默认路径)') : '未在默认路径检测到，点击配置';
  }
  const ideDot = element('ideDot');
  if (ideDot) {
    ideDot.className = 'pill-dot ' + (ideTarget.isCustom ? 'custom' : (ideTarget.exists ? 'ready' : 'missing'));
    ideDot.title = ideTarget.exists ? (ideTarget.isCustom ? '已配置自定义路径' : '已就绪 (默认路径)') : '未在默认路径检测到，点击配置';
  }

  const activeObj = currentActive === 'ide' ? ideTarget : hubTarget;
  if (!activeObj.exists && !pathModalDismissed) {
    showPathModal(true);
  }
}

function renderStatus(status) {
  if (status.activeTarget) {
    activeTarget = status.activeTarget;
    activeTargetName = status.targetName || (status.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity');
  }
  if (status.targets) {
    currentTargets = status.targets;
    renderTargetsUi(currentTargets, activeTarget);
  }
  if (status.enableProxy !== undefined && element('proxyToggle')) {
    element('proxyToggle').checked = status.enableProxy;
    updateProxyUi(status.enableProxy);
  }
  if (status.phase && !(launchPending && status.phase === 'idle')) renderPhase(status.phase, activeTargetName);
  if (status.dictEntries !== undefined) {
    element('dictCountBadge').textContent = `· 已载入 ${status.dictEntries} 词条`;
  }
  if (status.version) {
    const versionNode = element('versionBadge');
    if (versionNode) {
      versionNode.textContent = `v${status.version}`;
    }
  }
  if (status.clientRunning !== undefined) {
    clientRunningState = Boolean(status.clientRunning);
    const badge = element('clientStatusBadge');
    badge.className = status.clientRunning ? 'status-capsule active' : 'status-capsule';
    badge.querySelector('span').textContent = status.clientRunning
      ? status.cdpSockets ? '增强已连接' : '运行中'
      : '未运行';
    badge.title = status.cdpError || (status.clientRunning ? `${activeTargetName} 正在运行` : `${activeTargetName} 未运行`);
    renderPhase(status.phase || phase, activeTargetName);
  }
}

function loadSettings(status) {
  if (status.activeTarget) {
    activeTarget = status.activeTarget;
    activeTargetName = status.targetName || (status.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity');
  }
  if (status.targets) {
    currentTargets = status.targets;
  }
  element('proxyPortInput').value = status.port;
  if (element('proxyToggle')) element('proxyToggle').checked = status.enableProxy !== false;
  element('i18nToggle').checked = status.enableI18n;
  element('contextMonitorToggle').checked = status.enableContextMonitor;
  updateProxyUi(status.enableProxy !== false);
  renderStatus(status);
}

function persistSettings() {
  const payload = {
    port: Number(element('proxyPortInput').value),
    enableProxy: element('proxyToggle') ? element('proxyToggle').checked : true,
    enableI18n: element('i18nToggle').checked,
    enableContextMonitor: element('contextMonitorToggle').checked,
    targetApp: activeTarget
  };
  settingsQueue = settingsQueue.catch(() => {}).then(() => api.configure(payload));
  return settingsQueue;
}

async function launch() {
  if (phase === 'running') { showProcessModal(); return; }
  if (['preparing', 'launching', 'cleaning'].includes(phase) || cleanupPending) return;
  const currentObj = currentTargets[activeTarget] || {};
  if (!currentObj.exists) {
    pathModalDismissed = false;
    showPathModal(true);
    report(new Error(`未找到 ${activeTargetName}，请先指定 .exe 路径完成配置`));
    return;
  }
  launchPending = true;
  renderPhase('preparing');
  try {
    await persistSettings();
    renderPhase('launching');
    await api.launch();
    renderPhase('running');
  } catch (error) {
    renderPhase('error');
    report(error);
    if (error.code === 'PROCESS_CONFLICT') showProcessModal();
    else if (error.code === 'TARGET_NOT_FOUND') {
      pathModalDismissed = false;
      showPathModal(true, `无法启动 ${activeTargetName}`, error.message);
    }
  }
  finally { launchPending = false; }
}

function showProcessModal() {
  showPathModal(false);
  element('processModalTitle').textContent = `检测到已有 ${activeTargetName} 进程`;
  element('processError').textContent = '';
  element('processModal').style.display = 'flex';
  element('processCancelBtn').focus();
}
function dismissProcessModal() {
  if (!cleanupPending) element('processModal').style.display = 'none';
}
async function cleanProcesses() {
  if (cleanupPending) return;
  cleanupPending = true;
  element('processCleanBtn').disabled = true;
  element('processCancelBtn').disabled = true;
  element('processError').textContent = '正在清理，请稍候…';
  renderPhase('cleaning');
  try {
    await settingsQueue;
    await api.cleanAndLaunch();
    element('processModal').style.display = 'none';
    renderPhase('running');
  } catch (error) {
    report(error);
    element('processError').textContent = error.message;
    renderPhase('error');
  } finally {
    cleanupPending = false;
    element('processCleanBtn').disabled = false;
    element('processCancelBtn').disabled = false;
  }
}

function currentTheme() {
  const root = document.documentElement;
  return root.dataset.theme === 'light' || root.dataset.theme === 'dark'
    ? root.dataset.theme
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme(theme, save = false) {
  document.documentElement.dataset.theme = theme;
  if (save) {
    try { localStorage.setItem('easyag-theme', theme); } catch {}
    void api.setTheme(theme).catch(() => {});
  }
  const btn = element('themeToggleBtn');
  const label = element('themeToggleText');
  if (label) label.textContent = theme === 'dark' ? '🌙' : '☀️';
  if (btn) btn.title = theme === 'dark' ? '当前外观: 深色 (点击切换浅色)' : '当前外观: 浅色 (点击切换深色)';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(consoleBox.innerText);
    appendLog('SYSTEM', '日志已复制', 'tag-proxy');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(consoleBox);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    appendLog('SYSTEM', '已选中日志，可手动复制', 'tag-warn');
  }
}

// 浏览选择可执行文件
async function browseTargetExe() {
  const btn = element('browseExeBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api.browseExe(activeTarget);
    if (res?.ok && res.path) {
      appendLog('SYSTEM', `已配置 ${activeTargetName} 路径: ${res.path}`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 保存手动输入的路径
async function saveCustomPath() {
  const input = element('customPathInput');
  const path = input ? input.value.trim() : '';
  if (!path) {
    showModalError('请输入有效的 .exe 文件路径');
    return;
  }
  try {
    const res = await api.setTargetPath({ target: activeTarget, path });
    if (res?.ok) {
      appendLog('SYSTEM', `已保存 ${activeTargetName} 路径: ${res.path}`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
    showModalError(err.message || '指定的文件路径不存在');
  }
}

// 恢复默认扫描路径
async function resetDefaultPath() {
  try {
    const res = await api.setTargetPath({ target: activeTarget, path: '' });
    if (res?.ok) {
      appendLog('SYSTEM', `已恢复 ${activeTargetName} 默认检测路径`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      const input = element('customPathInput');
      if (input) input.value = '';
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
  }
}

// 账号管理：profile 列表渲染与切换/保存/导入导出操作。
// 列表只在初始化、ACCOUNT 事件和账号操作后刷新，避免高频轮询触发凭据读取。
let accountsBusy = false;

async function loadAccounts() {
  const card = element('accountsCard');
  if (!card || accountsBusy) return;
  try {
    const state = await api.accounts();
    if (!state.supported) { card.style.display = 'none'; return; }
    card.style.display = '';
    renderAccounts(state);
  } catch (error) { report(error); }
}

function renderAccounts(state) {
  const badge = element('accountsStateBadge');
  const emailEl = element('currentAccountEmail');
  const avatar = element('currentAccountAvatar');
  const list = element('accountList');
  if (!list) return;
  if (state.current) {
    emailEl.textContent = state.current.email || '未知账号';
    avatar.textContent = state.current.email ? state.current.email[0].toUpperCase() : '👤';
    badge.textContent = '· 已登录';
    badge.style.color = 'var(--green)';
  } else {
    emailEl.textContent = '未检测到登录（请先启动并登录 Antigravity）';
    avatar.textContent = '👤';
    badge.textContent = '· 未登录';
    badge.style.color = 'var(--text-dark)';
  }
  list.replaceChildren();
  for (const account of state.accounts) {
    const row = document.createElement('div');
    row.className = 'account-item' + (account.active ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'account-email';
    label.title = `捕获于 ${account.capturedAt || '未知'} · 更新于 ${account.updatedAt || '未知'}`;
    label.textContent = account.email + (account.active ? '（当前）' : '');
    const group = document.createElement('div');
    group.className = 'account-item-actions';
    if (!account.active) {
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'account-btn';
      switchBtn.textContent = '⇄ 切换';
      switchBtn.disabled = ['preparing', 'launching', 'cleaning'].includes(phase);
      switchBtn.addEventListener('click', () => switchAccount(account.id, account.email));
      group.appendChild(switchBtn);
    }
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'account-btn';
    exportBtn.textContent = '📤';
    exportBtn.title = '导出为明文 JSON（含登录凭证，注意保管）';
    exportBtn.addEventListener('click', () => exportAccount(account.id, account.email));
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'account-btn danger';
    removeBtn.textContent = '🗑';
    removeBtn.title = '删除此账号档案（不影响当前登录）';
    removeBtn.addEventListener('click', () => removeAccount(account.id, account.email));
    group.appendChild(exportBtn);
    group.appendChild(removeBtn);
    row.appendChild(label);
    row.appendChild(group);
    list.appendChild(row);
  }
  if (state.errors?.length) {
    for (const item of state.errors) appendLog('SYSTEM', `账号档案 ${item.file} 无法读取: ${item.error}`, 'tag-alert');
  }
}

async function switchAccount(id, email) {
  if (accountsBusy) return;
  if (!window.confirm(`切换到账号 ${email}？\n\nAntigravity 将被关闭并使用该账号的登录凭证重新启动，对话记录保留。`)) return;
  accountsBusy = true;
  renderPhase('cleaning');
  try {
    const result = await api.switchAccount(id);
    appendLog('SYSTEM', result.already ? `账号 ${email} 已是当前登录` : `已切换到账号 ${email}，正在重新启动`, 'tag-proxy');
    await loadAccounts();
  } catch (error) {
    report(error);
    renderPhase('error');
  } finally {
    accountsBusy = false;
  }
}

// Antigravity 2.33+ 不再把邮箱写进凭证，后端识别失败时会要求补邮箱。
async function captureCurrentAccount() {
  try {
    return await api.captureAccount();
  } catch (error) {
    if (error.code !== 'ACCOUNT_EMAIL_REQUIRED') throw error;
    const email = window.prompt(
      '新版 Antigravity 不再在登录凭证中保存邮箱，无法自动识别当前账号。\n请输入当前登录的 Google 账号邮箱：',
      error.suggestion || ''
    );
    if (!email || !email.trim()) throw error;
    return api.captureAccount(email.trim());
  }
}

async function captureAccount() {
  if (accountsBusy) return;
  accountsBusy = true;
  try {
    const result = await captureCurrentAccount();
    appendLog('SYSTEM', result.created ? `已保存账号 ${result.email} 的登录档案` : `账号 ${result.email} 的档案已更新`, 'tag-proxy');
    await loadAccounts();
  } catch (error) { report(error); } finally { accountsBusy = false; }
}

async function removeAccount(id, email) {
  // 两步确认：防止与"切换"并排时的误点（第二遍要求输入邮箱首段）。
  if (!window.confirm(`删除账号档案 ${email}？\n\n仅删除本地保存的凭证档案，不影响当前登录状态。删除后将无法一键切换到该账号，除非重新登录并保存。`)) return;
  const hand = window.prompt(`确认删除请输入该邮箱 @ 前的部分（如 ${email.split('@')[0]}）：`, '');
  if (hand === null) return;
  if (hand.trim().toLowerCase() !== email.split('@')[0].toLowerCase()) {
    appendLog('SYSTEM', '输入不匹配，已取消删除', 'tag-warn');
    return;
  }
  try {
    await api.removeAccount(id);
    appendLog('SYSTEM', `已删除账号档案 ${email}`, 'tag-proxy');
    await loadAccounts();
  } catch (error) { report(error); }
}

async function exportAccount(id, email) {
  const path = window.prompt(`导出账号 ${email} 为明文 JSON 文件（包含登录凭证，请妥善保管）。\n请输入导出文件完整路径：`, '');
  if (!path) return;
  try {
    const result = await api.exportAccount(id, path.trim());
    appendLog('SYSTEM', `已导出 ${email} 到 ${result.path}`, 'tag-warn');
  } catch (error) { report(error); }
}

async function importAccount() {
  const path = window.prompt('导入账号档案 JSON 文件。\n请输入文件完整路径：', '');
  if (!path) return;
  try {
    const result = await api.importAccount(path.trim());
    appendLog('SYSTEM', result.created ? `已导入账号 ${result.email}` : `已导入并更新账号 ${result.email}`, 'tag-proxy');
    await loadAccounts();
  } catch (error) { report(error); }
}

async function beginAddAccount() {
  const modal = element('accountModal');
  const desc = element('accountModalDesc');
  const errorEl = element('accountModalError');
  try {
    // 先把当前登录账号留存，再引导用户去 AG 登录新账号。
    const result = await captureCurrentAccount();
    desc.textContent = `1. 当前账号 ${result.email} 已保存。请打开 Antigravity，在设置中退出当前账号并登录另一个 Google 账号；登录完成后回到这里点击“完成添加”。`;
  } catch (error) {
    desc.textContent = '1. 请先启动 Antigravity 并完成 Google 账号登录，然后回到这里点击“完成添加”。';
  }
  errorEl.style.display = 'none';
  errorEl.textContent = '';
  modal.style.display = 'flex';
}

async function finishAddAccount() {
  const btn = element('finishAddAccountBtn');
  const errorEl = element('accountModalError');
  btn.disabled = true;
  try {
    const result = await captureCurrentAccount();
    appendLog('SYSTEM', `添加账号成功: ${result.email}`, 'tag-proxy');
    element('accountModal').style.display = 'none';
    await loadAccounts();
  } catch (error) {
    errorEl.style.display = '';
    errorEl.textContent = error.message;
  } finally { btn.disabled = false; }
}

function dismissAccountModal() {
  element('accountModal').style.display = 'none';
}

const actions = {
  'dismiss-process': dismissProcessModal,
  'clean-process': cleanProcesses,
  launch,
  hide: () => api.hide(),
  'toggle-theme': toggleTheme,
  'copy-logs': copyLogs,
  'clear-logs': () => { consoleBox.replaceChildren(); },
  'capture-account': captureAccount,
  'add-account': beginAddAccount,
  'finish-add-account': finishAddAccount,
  'dismiss-account': dismissAccountModal,
  'import-account': importAccount
};

document.addEventListener('click', event => {
  const targetBtn = event.target.closest('[data-target]');
  if (targetBtn && !targetBtn.disabled) {
    const nextTarget = targetBtn.dataset.target;
    if (nextTarget && nextTarget !== activeTarget) {
      activeTarget = nextTarget;
      activeTargetName = nextTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity';
      pathModalDismissed = false;
      showPathModal(false);
      element('targetHubBtn')?.classList.toggle('active', activeTarget === 'hub');
      element('targetIdeBtn')?.classList.toggle('active', activeTarget === 'ide');
      renderTargetsUi(currentTargets, activeTarget);
      renderPhase(phase, activeTargetName);
      api.configure({ targetApp: nextTarget }).then(res => {
        if (res?.targetName) activeTargetName = res.targetName;
        renderPhase(phase, activeTargetName);
      }).catch(report);
    }
    return;
  }
  const control = event.target.closest('[data-action],[data-port]');
  if (!control || control.disabled) return;
  const action = control.dataset.port !== undefined ? async () => {
    element('proxyPortInput').value = control.dataset.port;
    await persistSettings();
  } : actions[control.dataset.action];
  if (action) Promise.resolve().then(() => action(control)).catch(report);
});

function dismissPathModal() {
  pathModalDismissed = true;
  showPathModal(false);
}

for (const id of ['modalCloseBtn', 'modalCancelBtn']) {
  element(id)?.addEventListener('click', dismissPathModal);
}
element('processModal')?.addEventListener('click', event => {
  if (event.target === element('processModal')) dismissProcessModal();
});
element('pathModal')?.addEventListener('click', event => {
  if (event.target === element('pathModal')) dismissPathModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { dismissPathModal(); dismissProcessModal(); dismissAccountModal(); }
});
element('accountModal')?.addEventListener('click', event => {
  if (event.target === element('accountModal')) dismissAccountModal();
});

element('browseExeBtn')?.addEventListener('click', browseTargetExe);
element('savePathBtn')?.addEventListener('click', saveCustomPath);
element('resetPathBtn')?.addEventListener('click', resetDefaultPath);
element('customPathInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveCustomPath();
  }
});

element('proxyPortInput').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, ''); });
for (const id of ['proxyPortInput', 'proxyToggle', 'i18nToggle', 'contextMonitorToggle']) {
  element(id)?.addEventListener('change', () => {
    if (id === 'proxyToggle') updateProxyUi(element('proxyToggle').checked);
    persistSettings().catch(report);
  });
}

async function init() {
  applyTheme(currentTheme());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', e => {
    try {
      if (!localStorage.getItem('easyag-theme')) applyTheme(e.matches ? 'dark' : 'light');
    } catch {}
  });
  loadSettings(await api.status());
  for (const item of await api.logs()) appendLog(item.category, item.message, item.cls, item.at);
  void loadAccounts();
  stream = new EventSource('/api/events');
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      renderStatus(message);
      if (message.category) appendLog(message.category, message.message, message.cls, message.at);
      if (message.category === 'ACCOUNT') void loadAccounts();
    } catch (error) { report(error); }
  };
  pollTimer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try { renderStatus(await api.status()); }
    catch { /* EventSource and the next poll reconnect without ending the backend session. */ }
    finally { refreshing = false; }
  }, 3000);
}

window.addEventListener('pagehide', () => { clearInterval(pollTimer); stream?.close(); });
init().catch(error => { renderPhase('error'); report(error); });
