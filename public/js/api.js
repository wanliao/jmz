/**
 * 后端 API 客户端。
 * 所有请求统一走 { ok, data } / { ok, error } 信封；
 * 登录态放在 localStorage 的 token 里，请求自动带 Authorization: Bearer。
 */

const TOKEN_KEY = 'hpjy.token';

export class ApiError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', status = 0, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearToken() {
  setToken(null);
}

async function request(path, { method = 'GET', body, token } = {}) {
  const authToken = token ?? getToken();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('连不上服务器，请确认服务已启动', { code: 'NETWORK_ERROR', status: 0 });
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok !== true) {
    const info = payload?.error ?? {};
    throw new ApiError(info.message || `请求失败（HTTP ${response.status}）`, {
      code: info.code ?? 'REQUEST_FAILED',
      status: response.status,
      details: info.details,
    });
  }

  return payload.data;
}

/* ------------------------------------------------------------------ 基础 */

export const getConfig = () => request('/api/config');

/* ------------------------------------------------------------------ 认证 */

export const register = (username, password) =>
  request('/api/auth/register', { method: 'POST', body: { username, password } });
export const login = (username, password) =>
  request('/api/auth/login', { method: 'POST', body: { username, password } });
export const logout = () => request('/api/auth/logout', { method: 'POST' });
export const getMe = () => request('/api/auth/me');
export const changeMyPassword = (oldPassword, newPassword) =>
  request('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } });

/**
 * 读取当前身份。未登录时 user 为 null——这不影响使用：
 * 主页不需要登录就能添加/查看本机列表里的账号。
 */
export async function loadIdentity() {
  try {
    const me = await getMe();
    return me ?? { user: null, loggedIn: false, isAdmin: false, roleCount: 0 };
  } catch (error) {
    if (error.status === 401) return { user: null, loggedIn: false, isAdmin: false, roleCount: 0 };
    throw error;
  }
}

/* ------------------------------------------------------------- 游戏账号 */
/*
 * 一个 roleId 全站只有一条记录、不绑定用户；但「看哪些账号」是每台设备自己决定的：
 * 主页把本机添加过的 roleIds 发上来，服务端只返回/刷新这一批（不会下发全库列表）。
 */

export const addAccount = (payload) => request('/api/accounts', { method: 'POST', body: payload });
export const queryAccounts = (roleIds) =>
  request('/api/accounts/query', { method: 'POST', body: { roleIds } });
export const refreshAccount = (roleId) =>
  request(`/api/accounts/${encodeURIComponent(roleId)}/refresh`, { method: 'POST' });
export const refreshAll = (roleIds) =>
  request('/api/accounts/refresh', { method: 'POST', body: { roleIds } });
export const updateBaseline = (roleId, lastWeekLikes) =>
  request(`/api/accounts/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    body: { lastWeekLikes },
  });

/* --------------------------------------------------------------- 管理端 */

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const adminOverview = () => request('/api/admin/overview');
export const adminUsers = () => request('/api/admin/users');
export const adminSetAdmin = (id, isAdmin) =>
  request(`/api/admin/users/${id}`, { method: 'PATCH', body: { isAdmin } });
export const adminResetPassword = (id, newPassword) =>
  request(`/api/admin/users/${id}/password`, { method: 'POST', body: { newPassword } });
export const adminDeleteUser = (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' });

export const adminRoles = (params) => request(`/api/admin/roles${qs(params)}`);
export const adminUpdateRole = (roleId, patch) =>
  request(`/api/admin/roles/${encodeURIComponent(roleId)}`, { method: 'PATCH', body: patch });
export const adminChangeRoleId = (roleId, newRoleId) =>
  request(`/api/admin/roles/${encodeURIComponent(roleId)}/role-id`, {
    method: 'POST',
    body: { roleId: newRoleId },
  });
export const adminDeleteRole = (roleId) =>
  request(`/api/admin/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });

export const adminAuditLogs = (limit = 60) => request(`/api/admin/audit-logs?limit=${limit}`);
export const adminGetSettings = () => request('/api/admin/settings');
export const adminSaveSettings = (patch) =>
  request('/api/admin/settings', { method: 'PATCH', body: patch });
export const adminRunWeeklySettle = (payload = {}) =>
  request('/api/admin/jobs/weekly-settle', { method: 'POST', body: payload });
