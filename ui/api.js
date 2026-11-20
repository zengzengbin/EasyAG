export async function request(route, { body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('请求超时，请检查本地代理或网络连接')), timeoutMs);
  try {
    const response = await fetch(route, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw Object.assign(new Error(data?.error || `请求失败 (${response.status})`), { code: data?.code, suggestion: data?.suggestion });
    }
    return data;
  } finally { clearTimeout(timeout); }
}

export const api = {
  status: () => request('/api/status'),
  logs: () => request('/api/logs?limit=200'),
  configure: body => request('/api/config', { body }),
  browseExe: target => request('/api/browse-exe', { body: { target } }),
  setTargetPath: ({ target, path }) => request('/api/set-target-path', { body: { target, path } }),
  launch: () => request('/api/launch', { method: 'POST' }),
  cleanAndLaunch: () => request('/api/clean-and-launch', { method: 'POST', timeoutMs: 60000 }),
  setTheme: theme => request('/api/theme', { body: { theme }, method: 'POST' }),
  hide: () => request('/api/hide', { method: 'POST' }),
  accounts: () => request('/api/accounts', { timeoutMs: 60000 }),
  captureAccount: email => request('/api/accounts/capture', { body: email ? { email } : {}, timeoutMs: 60000 }),
  setAccountMeta: (id, meta) => request('/api/accounts/meta', { body: { id, ...meta }, timeoutMs: 60000 }),
  switchAccount: id => request('/api/accounts/switch', { body: { id }, method: 'POST', timeoutMs: 120000 }),
  removeAccount: id => request('/api/accounts/remove', { body: { id }, method: 'POST', timeoutMs: 60000 }),
  importAccount: path => request('/api/accounts/import', { body: { path }, method: 'POST', timeoutMs: 60000 }),
  exportAccount: (id, path) => request('/api/accounts/export', { body: { id, path }, method: 'POST', timeoutMs: 60000 })
};
