const fs = require('node:fs');
const path = require('node:path');
const { createSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { Accounts } = require('../features/accounts');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');
const { LanguageService } = require('../adapters/desktop/language-service');
const { ContextMonitor } = require('../features/context-monitor');
const { LogCleanup } = require('../features/log-cleanup');

function createApplication({ rootDir, dataDir, native = false, testMode = false, fetchBytes, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const desktop = createDesktopAdapter(testMode);
  let dictionary = loadDictionary(rootDir, dataDir);
  const host = createHost({ native, testMode, events });
  const languageService = new LanguageService({ profile: desktop.profile });
  const contextMonitor = new ContextMonitor(languageService);
  const accounts = new Accounts({ dataDir, events });
  const logCleanup = new LogCleanup({
    events,
    isRunning: async () => testMode || session?.phase === 'running' || (await desktop.running('hub')) || (await desktop.running('ide'))
  });
  let session;
  let lastStatus = '';
  const cdp = new CdpHub({
    profile: desktop.profile,
    source: (binding, target) => rendererSource(dictionary, settings.get(), binding, target),
    onMetrics: id => settings.get().enableContextMonitor && session?.phase === 'running' && !testMode
      ? contextMonitor.sample(id) : Promise.resolve({ conversationId: id, state: 'unavailable', context: null, speed: null }),
    onStop: () => { contextMonitor.reset(); },
    onStatus: status => {
      const key = JSON.stringify([status.cdpSockets, status.cdpTargets, status.cdpError]);
      if (key === lastStatus) return;
      lastStatus = key;
      events.publish({ status: status.cdpSockets ? '增强功能已连接' : '等待连接', ...session.snapshot(), ...status });
    }
  });
  session = new Session({ settings, desktop, cdp, events, host, testMode, onStart: ({ target, pid }) => {
    contextMonitor.client.profile = target.profile;
    contextMonitor.client.target = target.id;
    contextMonitor.client.parentPid = pid;
    contextMonitor.reset();
  }, onStop: () => {
    if (!testMode && settings.get().enableLogCleanup) void logCleanup.run();
  } });
  const updater = new Updater({
    rootDir, dataDir, settings, events,
    ...(fetchBytes ? { fetchBytes } : {}),
    onDictionaryUpdated: async () => {
      dictionary = loadDictionary(app.rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count, ...updater.currentState() });
      return count;
    },
    onRuntimeUpdated: async nextRoot => {
      app.rootDir = nextRoot;
    }
  });
  let closing;
  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, contextMonitor, logCleanup, updater, accounts,
    status() {
      const currentSettings = settings.get();
      const allTargets = desktop.discoverAllTargets ? desktop.discoverAllTargets(currentSettings) : {};
      const active = session.activeTarget || (desktop.resolveTarget ? desktop.resolveTarget(currentSettings.targetApp, currentSettings) : { id: 'hub', name: 'Antigravity' });
      const bothInstalled = Boolean(allTargets.hub?.exists && allTargets.ide?.exists);
      return {
        ...currentSettings, ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length,
        capabilities: active.capabilities || desktop.capabilities,
        targets: allTargets,
        activeTarget: active.id,
        targetName: active.name,
        bothInstalled
      };
    },
    async reloadDictionary() {
      dictionary = loadDictionary(rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count });
      return { ok: true, dictEntries: count };
    },
    async configure(input) {
      const previous = settings.get();
      assertLaunchSettingsMutable(input, previous, session.phase);
      const next = settings.update(input);
      if (next.enableContextMonitor !== previous.enableContextMonitor) contextMonitor.reset();
      await cdp.refresh();
      if (next.enableI18n !== previous.enableI18n) events.log('I18N', next.enableI18n ? '汉化已开启' : '汉化已关闭，原文已恢复', 'tag-i18n');
      if (next.enableContextMonitor !== previous.enableContextMonitor) events.log('SYSTEM', next.enableContextMonitor ? '上下文监控已开启（只读）' : '上下文监控已关闭，上下文圆环已移除', 'tag-proxy');
      if (next.enableLogCleanup !== previous.enableLogCleanup) {
        events.log('SYSTEM', next.enableLogCleanup ? 'AG 日志自动清理已开启' : 'AG 日志自动清理已关闭', 'tag-proxy');
        if (next.enableLogCleanup && !testMode) void logCleanup.run();
      }
      if (input.enableProxy !== undefined && input.enableProxy !== previous.enableProxy) {
        events.log('SYSTEM', next.enableProxy ? `免 TUN 代理已开启（127.0.0.1:${next.port}）` : '免 TUN 代理已关闭（直连模式）', 'tag-proxy');
      }
      if (input.targetApp !== undefined && input.targetApp !== previous.targetApp) {
        const target = desktop.resolveTarget ? desktop.resolveTarget(next.targetApp, next) : { name: next.targetApp };
        events.log('SYSTEM', `已切换启动目标为: ${target.fullName || target.name}`, 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customHubPath !== undefined && input.customHubPath !== previous.customHubPath) {
        events.log('SYSTEM', next.customHubPath ? `已更新桌面版路径: ${next.customHubPath}` : '已恢复桌面版默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customIdePath !== undefined && input.customIdePath !== previous.customIdePath) {
        events.log('SYSTEM', next.customIdePath ? `已更新 IDE 路径: ${next.customIdePath}` : '已恢复 IDE 默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      return next;
    },
    // Account switch orchestration: stop Antigravity (a live daemon would
    // overwrite the credential back), apply the profile, relaunch if it ran.
    async switchAccount(id) {
      const state = await accounts.list();
      if (!state.supported) return { ok: false, error: '当前平台不支持账号切换（仅 Windows）', code: 'UNSUPPORTED' };
      const target = state.accounts.find(account => account.id === id);
      if (!target) return { ok: false, error: '账号档案不存在', code: 'NOT_FOUND' };
      if (state.current?.email && state.current.email === target.email) return { ok: true, already: true, email: target.email };
      const wasRunning = session.phase === 'running';
      const stopResult = await session.cleanStop('账号切换');
      if (!stopResult.ok && stopResult.code !== 'TARGET_NOT_FOUND') return stopResult;
      const result = await accounts.switchTo(id);
      if (!result.ok) return result;
      if (wasRunning) {
        const launched = await session.launch();
        if (!launched.ok) return { ...launched, error: `账号已切换为 ${result.email}，但启动 Antigravity 失败: ${launched.error}` };
        return { ...launched, switchedEmail: result.email };
      }
      return { ...result, ok: true };
    },
    async start() {
      const port = await api.listen(native ? 0 : 19823);
      events.log('SYSTEM', `EasyAG 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.EASYAG_READY_FILE) writeJson(process.env.EASYAG_READY_FILE, { port, pid: process.pid });
      if (!native && !testMode) host.open(`http://127.0.0.1:${port}`);
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn')).finally(() => {
        if (!testMode && settings.get().enableLogCleanup) void logCleanup.run();
      });
      return port;
    },
    close(reason) {
      if (closing) return closing;
      closing = (async () => {
        events.log('SYSTEM', '正在退出: ' + reason, 'tag-warn');
        const result = await session.close(reason);
        host.dispose();
        api.close();
        onClose(result);
        return result;
      })();
      return closing;
    }
  };
  const api = createApi(app);
  app.api = api;
  return app;
}

module.exports = { createApplication };
