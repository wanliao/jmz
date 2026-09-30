/**
 * 前端主逻辑：渲染卡片、增删改查、主题切换、离线缓存。
 *
 * 账号模型：一个 roleId 在服务器上只有一条记录、不绑定任何用户；
 * 但**主页只显示这台设备添加过的账号**——列表（一串 roleId）存在浏览器里，
 * 服务端只按这批 roleId 返回数据，所以别人打开主页看不到你的列表。
 * 添加别人已经加过的角色 = 把它「认领」进自己的列表（不重复入库、不动别人的数据）。
 * 想彻底从数据库删掉，只能管理员在后台删。
 *
 * 注意：所有「本周已刷」「基线」都由服务端算好后返回，
 * 前端只负责展示，避免浏览器时区/时钟与服务端不一致导致算错。
 */

import {
  LIKES_MAX_VALUE,
  NICKNAME_MAX_LENGTH,
  REGIONS,
  WEEKLY_LIKE_CAP,
  regionLabel,
} from '/shared/constants.js';

import * as api from './api.js';
import { escapeHtml, formatDuration, formatNumber, formatRelative } from './format.js';

const CACHE_KEY = 'hpjy.likes.cache.v1';
const THEME_KEY = 'hpjy.likes.theme';
/** 这台设备添加过的 roleId 列表：服务器上人人可见，但**看哪些**由它决定 */
const MY_ROLES_KEY = 'hpjy.my.roles.v1';
const MAX_MY_ROLES = 100;

const dom = {
  accountList: document.getElementById('accountList'),
  emptyState: document.getElementById('emptyState'),
  addDialog: document.getElementById('addDialog'),
  addForm: document.getElementById('addForm'),
  addFormError: document.getElementById('addFormError'),
  addSubmitBtn: document.getElementById('addSubmitBtn'),
  nicknameInput: document.getElementById('nicknameInput'),
  baselineInput: document.getElementById('baselineInput'),
  regionSegmented: document.getElementById('regionSegmented'),
  baselineDialog: document.getElementById('baselineDialog'),
  baselineForm: document.getElementById('baselineForm'),
  baselineDesc: document.getElementById('baselineDesc'),
  baselineEditInput: document.getElementById('baselineEditInput'),
  baselineFormError: document.getElementById('baselineFormError'),
  baselineSubmitBtn: document.getElementById('baselineSubmitBtn'),
  themeToggle: document.getElementById('themeToggle'),
  refreshAllBtn: document.getElementById('refreshAllBtn'),
  addBtn: document.getElementById('addBtn'),
  adapterNotice: document.getElementById('adapterNotice'),
  errorNotice: document.getElementById('errorNotice'),
  footerCountdown: document.getElementById('footerCountdown'),
  announceCard: document.getElementById('announceCard'),
  announceText: document.getElementById('announceText'),
  toasts: document.getElementById('toasts'),

  // 账号相关
  accountBtn: document.getElementById('accountBtn'),
  accountAvatar: document.getElementById('accountAvatar'),
  accountName: document.getElementById('accountName'),
  accountSub: document.getElementById('accountSub'),
  adminEntry: document.getElementById('adminEntry'),
  guestNotice: document.getElementById('guestNotice'),
  accountDialog: document.getElementById('accountDialog'),
  accountDialogTitle: document.getElementById('accountDialogTitle'),
  accountInfo: document.getElementById('accountInfo'),
  accountInfoAvatar: document.getElementById('accountInfoAvatar'),
  accountInfoName: document.getElementById('accountInfoName'),
  accountInfoDesc: document.getElementById('accountInfoDesc'),
  accountSyncHint: document.getElementById('accountSyncHint'),
  authForms: document.getElementById('authForms'),
  registerForm: document.getElementById('registerForm'),
  registerUsername: document.getElementById('registerUsername'),
  registerPassword: document.getElementById('registerPassword'),
  registerError: document.getElementById('registerError'),
  registerSubmit: document.getElementById('registerSubmit'),
  registerHint: document.getElementById('registerHint'),
  loginForm: document.getElementById('loginForm'),
  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  loginSubmit: document.getElementById('loginSubmit'),
  passwordForm: document.getElementById('passwordForm'),
  oldPassword: document.getElementById('oldPassword'),
  newPassword: document.getElementById('newPassword'),
  passwordError: document.getElementById('passwordError'),
  passwordSubmit: document.getElementById('passwordSubmit'),
  changePasswordBtn: document.getElementById('changePasswordBtn'),
  cancelPasswordBtn: document.getElementById('cancelPasswordBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
};

const state = {
  config: null,
  accounts: [],
  offsetMs: 0, // 服务端时间 - 本机时间
  busy: new Set(),
  editingRoleId: null,
  region: REGIONS[0]?.id ?? 'wechat',
  weeklyCap: WEEKLY_LIKE_CAP,
  me: null, // 当前身份；user 为 null 表示未登录（不影响添加账号）
  myRoleIds: [], // 这台设备添加过的 roleId（主页只显示这些）
};

/* --------------------------------------------------- 本机账号列表（roleId） */

/** 清洗 roleId 列表：只留合法、去重，最多 MAX_MY_ROLES 个 */
function normalizeMyRoleIds(roleIds) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(roleIds) ? roleIds : []) {
    const id = String(item ?? '').trim();
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_MY_ROLES) break;
  }
  return out;
}

function readMyRoleIds() {
  try {
    const raw = localStorage.getItem(MY_ROLES_KEY);
    return raw ? normalizeMyRoleIds(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeMyRoleIds(roleIds) {
  const list = normalizeMyRoleIds(roleIds);
  state.myRoleIds = list;
  try {
    if (list.length === 0) localStorage.removeItem(MY_ROLES_KEY);
    else localStorage.setItem(MY_ROLES_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式忽略 */
  }
  return list;
}

function addMyRoleId(roleId) {
  if (state.myRoleIds.includes(roleId)) return state.myRoleIds;
  return writeMyRoleIds([...state.myRoleIds, roleId]);
}

function removeMyRoleId(roleId) {
  return writeMyRoleIds(state.myRoleIds.filter((id) => id !== roleId));
}

/* ------------------------------------------------------------------ 工具 */

function serverNow() {
  return Date.now() + state.offsetMs;
}

let toastSeq = 0;
function toast(message, type = 'info', duration = 3200) {
  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  node.textContent = message;
  node.dataset.toastId = String(++toastSeq);
  dom.toasts.appendChild(node);
  setTimeout(() => node.remove(), duration);
}

function showError(message) {
  dom.errorNotice.textContent = message;
  dom.errorNotice.hidden = !message;
}

function setBusy(roleId, busy) {
  if (busy) state.busy.add(roleId);
  else state.busy.delete(roleId);
}

/* --------------------------------------------------------------- 身份 */

function accountLabel() {
  const me = state.me;
  if (!me?.user) return '未登录';
  return me.user.username ?? `用户#${me.user.id}`;
}

function renderAccount() {
  const me = state.me;
  const user = me?.user ?? null;
  const label = accountLabel();
  dom.accountName.textContent = label;
  dom.accountAvatar.textContent = user ? (label || '我').slice(0, 1).toUpperCase() : '游';
  dom.accountSub.textContent = user
    ? user.isSuper || user.isAdmin
      ? '管理员 · 已登录'
      : '已登录'
    : '未登录 · 也能添加账号';
  dom.adminEntry.hidden = !user?.isAdmin;
  dom.guestNotice.hidden = Boolean(user);

  dom.accountInfoAvatar.textContent = user ? (label || '我').slice(0, 1).toUpperCase() : '游';
  dom.accountInfoName.textContent = label;
  dom.accountInfoDesc.textContent = user
    ? `账号 #${user.id}${user.isSuper ? ' · 超级管理员' : user.isAdmin ? ' · 管理员' : ''} · 全站共 ${
        me.roleCount ?? 0
      } 个游戏账号`
    : '';

  // 未登录：不显示账号信息 / 改密码相关界面，只给注册登录
  dom.accountInfo.hidden = true;
  dom.authForms.hidden = false;
  dom.logoutBtn.hidden = true;
  dom.changePasswordBtn.hidden = true;

  if (user) {
    dom.accountDialogTitle.textContent = '账号';
    dom.accountInfo.hidden = false;
    dom.authForms.hidden = true;
    dom.passwordForm.hidden = true;
    dom.logoutBtn.hidden = false;
    dom.changePasswordBtn.hidden = false;
    dom.accountSyncHint.textContent = '游戏账号是全站共享的，所有设备看到的是同一份数据，不需要同步。';
  } else {
    dom.accountDialogTitle.textContent = '登录 / 注册';
    dom.passwordForm.hidden = true;
    dom.registerHint.textContent = '游戏账号大家一起维护，不注册也能添加。登录只是为了进管理后台（没有后台权限的话不用注册）。';
  }
}

function showAccountDialog() {
  dom.accountDialog.showModal();
  // 未登录时游戏账号照样能用，这个弹窗只用来登录后台 / 注册身份
  if (!state.me?.user) switchAuthTab('login');
  renderAccount();
}

function switchAuthTab(tab) {
  for (const button of dom.accountDialog.querySelectorAll('[data-auth-tab]')) {
    button.classList.toggle('is-active', button.dataset.authTab === tab);
  }
  dom.registerForm.hidden = tab !== 'register';
  dom.loginForm.hidden = tab !== 'login';
}

async function bootstrapIdentity() {
  state.me = await api.loadIdentity();
  state.myRoleIds = readMyRoleIds();
  renderAccount();
  return state.me;
}

/* ------------------------------------------------------- 主题 / 本地缓存 */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1014' : '#f5f6f7');
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function saveCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        weeklyCap: state.weeklyCap,
        accounts: state.accounts,
      }),
    );
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.accounts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- 卡片渲染 */

/**
 * 游戏头像：添加账号时从接口A 抓一次并存在 profile.avatar 里，之后不刷新。
 * 没有头像（老账号 / 抓取失败）或图片加载不出来时，退回首字圆形色块，不留破图。
 */
function avatarHtml(account) {
  const initial = escapeHtml((account.nickname || '游').slice(0, 1));
  const fallback = `<span class="avatar-fallback" aria-hidden="true">${initial}</span>`;
  const url = typeof account.profile?.avatar === 'string' ? account.profile.avatar.trim() : '';
  if (!url) return `<span class="avatar">${fallback}</span>`;
  return `<span class="avatar"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />${fallback}</span>`;
}

function accountCard(account) {
  const roleId = escapeHtml(account.roleId);
  const cap = account.weeklyCap ?? state.weeklyCap;
  const pct = Math.max(0, Math.min(100, Math.round((account.progress ?? 0) * 100)));
  const classes = ['card'];
  if (account.full) classes.push('is-full');
  if (account.anomaly) classes.push('is-anomaly');
  if (state.busy.has(account.roleId)) classes.push('is-busy');

  const alerts = [];

  if (account.anomaly) {
    alerts.push(`
      <div class="card-alert">
        <span>当前总点赞（${formatNumber(account.currentLikes)}）比上周点赞（${formatNumber(account.baseline)}）还少，已刷数按 0 显示，不会出现负数。一般是上周点赞填高了，修正一下即可。</span>
        <button class="btn btn-sm btn-ghost" type="button" data-act="baseline" data-role="${roleId}">修正</button>
      </div>`);
  }

  if (!account.hasData) {
    alerts.push(`
      <div class="card-alert is-warn">
        <span>还没有成功查询到点赞数${account.lastError ? `：${escapeHtml(account.lastError.message)}` : '，点一下刷新试试'}。</span>
        <button class="btn btn-sm btn-ghost" type="button" data-act="refresh" data-role="${roleId}">刷新</button>
      </div>`);
  } else if (account.lastError) {
    alerts.push(`
      <div class="card-alert is-warn">
        <span>上次刷新失败：${escapeHtml(account.lastError.message)}（当前显示的是上一次成功查询的数据）</span>
      </div>`);
  } else if (account.weeksSinceQuery >= 1) {
    alerts.push(`
      <div class="card-alert is-warn">
        <span>距离上次查询已经过去 ${account.weeksSinceQuery} 周，本周的上周点赞是按最近一次快照估算的，建议点刷新确认一下。</span>
      </div>`);
  } else if (account.baselineEstimated) {
    alerts.push(`
      <div class="card-alert is-warn">
        <span>上周点赞是估算值（跨周时没有可用的上周快照），如果数字不对，请手动修正。</span>
      </div>`);
  }

  const profile = account.profile ?? null;
  // 卡片上的档案信息只显示「不会过期」的那些（会变的段位/印记/K/D/注册时间不展示）。
  const profileBits = [];
  if (profile?.campNickname && profile.campNickname !== account.nickname) {
    profileBits.push(`营地昵称 ${escapeHtml(profile.campNickname)}`);
  }
  if (profile?.highestDivName) profileBits.push(`最高段位 ${escapeHtml(profile.highestDivName)}`);
  if (profile?.location) {
    profileBits.push(escapeHtml([profile.location, profile.city].filter(Boolean).join(' ')));
  }

  return `
    <article class="${classes.join(' ')}" data-card="${roleId}">
      <header class="card-head">
        <div class="card-who">
          ${avatarHtml(account)}
          <div class="card-who-text">
            <span class="card-name-row">
              <span class="card-nickname">${escapeHtml(account.nickname)}</span>
              <button class="btn btn-sm btn-ghost card-del" type="button" data-act="delete" data-role="${roleId}" title="删除这个账号">删</button>
            </span>
            <span class="card-sub">
              <span class="badge badge-${escapeHtml(account.region)}">${escapeHtml(regionLabel(account.region))}</span>
            </span>
          </div>
        </div>
      </header>

      <div class="hero">
        <span class="hero-num">${formatNumber(account.weekLikes)}</span>
        <span class="hero-cap">/ ${formatNumber(cap)}</span>
        <span class="hero-label">${account.full ? '✅ 已刷满' : `还差 ${formatNumber(account.remaining)} 个`}</span>
      </div>

      <div class="progress" role="progressbar" aria-label="本周点赞进度" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${account.weekLikes}">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>

      <div class="kv">
        <div class="kv-item">
          <span class="kv-label">当前总点赞</span>
          <span class="kv-value">${account.hasData ? formatNumber(account.currentLikes) : '--'}</span>
        </div>
        <div class="kv-item">
          <span class="kv-label kv-label-row">
            <span>上周点赞</span>
            <button class="btn btn-sm btn-ghost" type="button" data-act="baseline" data-role="${roleId}">改</button>
          </span>
          <span class="kv-value">${formatNumber(account.baseline)}</span>
        </div>
      </div>

      ${profileBits.length > 0 ? `<p class="card-profile">${profileBits.join(' · ')}</p>` : ''}

      ${alerts.join('')}

      <footer class="card-foot">
        <span class="card-time" data-time="${escapeHtml(account.lastQueriedAt ?? '')}">
          最近查询：${formatRelative(account.lastQueriedAt, serverNow())}
        </span>
        <div class="card-actions">
          <button class="btn btn-sm btn-ghost" type="button" data-act="refresh" data-role="${roleId}">刷新</button>
        </div>
      </footer>
    </article>`;
}

function renderCountdown() {
  const endMs = state.config?.week?.endMs;
  if (!endMs) {
    dom.footerCountdown.textContent = '--';
    return;
  }
  dom.footerCountdown.textContent = formatDuration(endMs - serverNow());
}

function renderAdapterNotice() {
  const config = state.config;
  if (!config) {
    dom.adapterNotice.hidden = true;
    return;
  }
  if (config.adapterMode === 'mock') {
    const speed = Number(config.mockSpeed ?? 1);
    const hint =
      speed > 1
        ? `Mock 时间已加速 ${speed} 倍，方便验证跨周结算。`
        : '接口 A / 接口 B 的真实地址还没确定，现在用的是假数据。';
    dom.adapterNotice.innerHTML = `<strong>当前为 Mock 演示数据。</strong>${escapeHtml(hint)}拿到真实接口后，改 <code>config/endpoints.json</code> 并设置 <code>ADAPTER=http</code> 即可切换。`;
    dom.adapterNotice.hidden = false;
    return;
  }
  dom.adapterNotice.hidden = true;
}

/**
 * 底部公告卡：内容来自服务端 settings 表（管理员在后台改）。
 * 留空就整张卡片不显示——不放「暂无公告」这种占位废话。
 */
function renderAnnouncement() {
  const text = String(state.config?.announcement ?? '').trim();
  if (!text) {
    dom.announceCard.hidden = true;
    dom.announceText.textContent = '';
    return;
  }
  dom.announceText.textContent = text;
  dom.announceCard.hidden = false;
}

function render() {
  renderCountdown();
  renderAdapterNotice();
  renderAnnouncement();

  dom.accountList.innerHTML = state.accounts.map(accountCard).join('');
  dom.emptyState.hidden = state.accounts.length > 0;
}

/** 只更新「最近查询」文案，避免整页重绘 */
function refreshTimes() {
  for (const node of dom.accountList.querySelectorAll('[data-time]')) {
    node.textContent = `最近查询：${formatRelative(node.dataset.time, serverNow())}`;
  }
}

/* --------------------------------------------------------------- 数据层 */

function mergeConfig(data) {
  if (!data) return;
  state.config = { ...(state.config ?? {}), ...data };
  if (Number.isFinite(Number(data.weeklyCap))) state.weeklyCap = Number(data.weeklyCap);
  if (Number.isFinite(Number(data.serverNow))) state.offsetMs = Number(data.serverNow) - Date.now();
}

function upsertAccount(account) {
  const index = state.accounts.findIndex((item) => item.roleId === account.roleId);
  if (index === -1) state.accounts.push(account);
  else state.accounts[index] = account;
}

async function loadConfig() {
  try {
    mergeConfig(await api.getConfig());
  } catch (error) {
    showError(`读取服务器配置失败：${error.message}`);
  }
}

/**
 * 拉取本机列表里的账号，返回拿到的那一份。
 *
 * 并发调用会复用同一次请求（而不是直接返回空）——否则「页面加载」和「切回标签页」
 * 同时触发时，其中一方会拿到空列表，进而跳过自动刷新。
 */
let loadPromise = null;

async function loadAccounts({ silent = false } = {}) {
  if (loadPromise) return loadPromise;
  loadPromise = doLoadAccounts({ silent });
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function doLoadAccounts({ silent = false } = {}) {
  state.myRoleIds = readMyRoleIds();
  if (state.myRoleIds.length === 0) {
    state.accounts = [];
    saveCache();
    render();
    return state.accounts;
  }

  try {
    const data = await api.queryAccounts(state.myRoleIds);
    mergeConfig(data);
    state.accounts = data.accounts ?? [];
    // 后台已经把某些账号删掉了：从本机列表里也清掉，免得每次都空查一遍
    if (Array.isArray(data.missing) && data.missing.length > 0) {
      writeMyRoleIds(state.myRoleIds.filter((id) => !data.missing.includes(id)));
    }
    saveCache();
    showError('');
    render();
  } catch (error) {
    // 服务端不可用时先用缓存把界面撑起来
    if (!silent) showError(`读取账号失败：${error.message}`);
    render();
  }
  return state.accounts;
}

/* --------------------------------------------------------------- 交互 */

async function handleRefreshOne(roleId) {
  setBusy(roleId, true);
  render();
  try {
    const data = await api.refreshAccount(roleId);
    upsertAccount(data.account);
    saveCache();
    if (data.warning) toast(`「${data.account.nickname}」查询失败：${data.warning.message}`, 'warn', 5000);
    else toast(`「${data.account.nickname}」本周已刷 ${formatNumber(data.account.weekLikes)}`, 'ok');
  } catch (error) {
    toast(`刷新失败：${error.message}`, 'error', 5000);
  } finally {
    setBusy(roleId, false);
    render();
  }
}

async function handleRefreshAll() {
  if (state.myRoleIds.length === 0) {
    toast('还没有账号可刷新', 'info');
    return;
  }
  dom.refreshAllBtn.disabled = true;
  dom.refreshAllBtn.classList.add('is-busy');
  try {
    const data = await api.refreshAll(state.myRoleIds);
    state.accounts = data.accounts ?? state.accounts;
    if (Array.isArray(data.missing) && data.missing.length > 0) {
      writeMyRoleIds(state.myRoleIds.filter((id) => !data.missing.includes(id)));
    }
    saveCache();
    render();
    if (data.failed > 0) {
      toast(`刷新完成：成功 ${data.succeeded} 个，失败 ${data.failed} 个`, 'warn', 4600);
    } else {
      toast(`已刷新 ${data.succeeded} 个账号`, 'ok');
    }
  } catch (error) {
    toast(`刷新全部失败：${error.message}`, 'error', 5000);
  } finally {
    dom.refreshAllBtn.disabled = false;
    dom.refreshAllBtn.classList.remove('is-busy');
  }
}

function buildRegionSegmented() {
  dom.regionSegmented.innerHTML = REGIONS.map(
    (region) => `<button type="button" role="radio" data-region="${region.id}" aria-checked="${region.id === state.region}">${region.label}</button>`,
  ).join('');
}

function selectRegion(regionId) {
  state.region = regionId;
  for (const button of dom.regionSegmented.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.region === regionId));
  }
}

function openAddDialog() {
  dom.addFormError.hidden = true;
  dom.addForm.reset();
  selectRegion(REGIONS[0]?.id ?? 'wechat');
  dom.addDialog.showModal();
  setTimeout(() => dom.nicknameInput.focus(), 60);
}

function openBaselineDialog(roleId) {
  const account = state.accounts.find((item) => item.roleId === roleId);
  if (!account) return;
  state.editingRoleId = roleId;
  dom.baselineFormError.hidden = true;
  dom.baselineDesc.innerHTML = `账号：<strong>${escapeHtml(account.nickname)}</strong>（${escapeHtml(regionLabel(account.region))}）<br />当前总点赞：<strong>${account.hasData ? formatNumber(account.currentLikes) : '未知'}</strong>，本周已刷：<strong>${formatNumber(account.weekLikes)}</strong>`;
  dom.baselineEditInput.value = String(account.baseline ?? 0);
  dom.baselineDialog.showModal();
  setTimeout(() => dom.baselineEditInput.select(), 60);
}

async function handleAddSubmit(event) {
  event.preventDefault();
  const nickname = dom.nicknameInput.value.trim();
  const lastWeekLikes = Number(dom.baselineInput.value);

  const fail = (message) => {
    dom.addFormError.textContent = message;
    dom.addFormError.hidden = false;
  };

  if (!nickname) return fail('请填写游戏昵称');
  if (nickname.length > NICKNAME_MAX_LENGTH) return fail(`昵称最长 ${NICKNAME_MAX_LENGTH} 个字符`);
  if (!dom.baselineInput.value.trim()) return fail('请填写上周点赞数（仅第一次需要手填）');
  if (!Number.isFinite(lastWeekLikes) || lastWeekLikes < 0 || lastWeekLikes > LIKES_MAX_VALUE) {
    return fail('上周点赞数必须是 0 或正整数，请检查是否填错');
  }

  dom.addFormError.hidden = true;
  dom.addSubmitBtn.disabled = true;
  dom.addSubmitBtn.textContent = '查询中…';

  try {
    const data = await api.addAccount({ nickname, region: state.region, lastWeekLikes });
    addMyRoleId(data.account.roleId);
    upsertAccount(data.account);
    saveCache();
    render();
    dom.addDialog.close();
    if (data.renamed) {
      // 玩家在游戏里改了名：用新昵称再添加一次就会自动更正库里的名字
      toast(
        `「${data.renamed.from}」在游戏里改名了 → 已更新为「${data.renamed.to}」，并加入你的列表`,
        'ok',
        5600,
      );
    } else if (data.claimed) {
      toast(`「${data.account.nickname}」之前已经有人加过了，已加入你的列表`, 'ok', 4600);
    } else {
      toast(`已添加「${data.account.nickname}」`, 'ok');
    }
    if (data.warning) toast(`首次查询失败：${data.warning.message}，可稍后点刷新重试`, 'warn', 5000);
  } catch (error) {
    fail(error.message);
  } finally {
    dom.addSubmitBtn.disabled = false;
    dom.addSubmitBtn.textContent = '添加并查询';
  }
}

async function handleBaselineSubmit(event) {
  event.preventDefault();
  const roleId = state.editingRoleId;
  if (!roleId) return;
  const value = Number(dom.baselineEditInput.value);
  if (!Number.isFinite(value) || value < 0 || value > LIKES_MAX_VALUE) {
    dom.baselineFormError.textContent = '上周点赞数必须是 0 或正整数';
    dom.baselineFormError.hidden = false;
    return;
  }

  dom.baselineSubmitBtn.disabled = true;
  dom.baselineSubmitBtn.textContent = '保存中…';
  try {
    const data = await api.updateBaseline(roleId, value);
    upsertAccount(data.account);
    saveCache();
    render();
    dom.baselineDialog.close();
    toast(`已更新上周点赞，本周已刷 ${formatNumber(data.account.weekLikes)}`, 'ok');
  } catch (error) {
    dom.baselineFormError.textContent = error.message;
    dom.baselineFormError.hidden = false;
  } finally {
    dom.baselineSubmitBtn.disabled = false;
    dom.baselineSubmitBtn.textContent = '保存';
  }
}

async function handleDelete(roleId) {
  const account = state.accounts.find((item) => item.roleId === roleId);
  if (!account) return;
  const hint = '只从这台设备的列表里移除，服务器上的数据还在（后台仍能看到）。';
  if (!window.confirm(`把「${account.nickname}」从你的列表里移除？\n${hint}`)) return;
  removeMyRoleId(roleId);
  state.accounts = state.accounts.filter((item) => item.roleId !== roleId);
  saveCache();
  render();
  toast('已从你的列表移除（后台数据没动）', 'ok');
}

/** 登录/注册成功后：重建身份、重新拉一次本机列表 */
async function afterAuthSwitch(message) {
  state.accounts = [];
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 忽略 */
  }

  await bootstrapIdentity();
  await loadAccounts();
  renderAccount();
  if (message) toast(message, 'ok', 4200);
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  const username = dom.registerUsername.value.trim();
  const password = dom.registerPassword.value;
  const fail = (message) => {
    dom.registerError.textContent = message;
    dom.registerError.hidden = false;
  };
  if (!username) return fail('请输入账号');
  if (!password) return fail('请输入密码');

  dom.registerError.hidden = true;
  dom.registerSubmit.disabled = true;
  dom.registerSubmit.textContent = '注册中…';
  try {
    const data = await api.register(username, password);
    api.setToken(data.token);
    await afterAuthSwitch('注册成功');
    dom.accountDialog.close();
  } catch (error) {
    fail(error.message);
  } finally {
    dom.registerSubmit.disabled = false;
    dom.registerSubmit.textContent = '注册';
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const username = dom.loginUsername.value.trim();
  const password = dom.loginPassword.value;
  const fail = (message) => {
    dom.loginError.textContent = message;
    dom.loginError.hidden = false;
  };
  if (!username || !password) return fail('请输入账号和密码');

  dom.loginError.hidden = true;
  dom.loginSubmit.disabled = true;
  dom.loginSubmit.textContent = '登录中…';
  try {
    const data = await api.login(username, password);
    api.setToken(data.token);
    await afterAuthSwitch(`已登录 ${data.user.username}`);
    dom.accountDialog.close();
  } catch (error) {
    fail(error.message);
  } finally {
    dom.loginSubmit.disabled = false;
    dom.loginSubmit.textContent = '登录';
  }
}

async function handleLogout() {
  if (!window.confirm('退出登录后会回到「未登录」状态（游戏账号是全站共享的，不受影响）。')) return;
  try {
    await api.logout();
  } catch {
    /* 忽略 */
  }
  api.clearToken();
  await afterAuthSwitch('已退出登录');
  dom.accountDialog.close();
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  const oldPassword = dom.oldPassword.value;
  const newPassword = dom.newPassword.value;
  const fail = (message) => {
    dom.passwordError.textContent = message;
    dom.passwordError.hidden = false;
  };
  if (!oldPassword || !newPassword) return fail('请填写原密码和新密码');

  dom.passwordError.hidden = true;
  dom.passwordSubmit.disabled = true;
  try {
    await api.changeMyPassword(oldPassword, newPassword);
    dom.passwordForm.reset();
    dom.passwordForm.hidden = true;
    dom.accountInfo.hidden = false;
    toast('密码已修改', 'ok');
  } catch (error) {
    fail(error.message);
  } finally {
    dom.passwordSubmit.disabled = false;
  }
}

/* --------------------------------------------------------------- 启动 */

function bindEvents() {
  dom.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 忽略 */
    }
  });

  dom.addBtn.addEventListener('click', openAddDialog);
  for (const node of document.querySelectorAll('[data-open-add]')) {
    node.addEventListener('click', openAddDialog);
  }
  for (const node of document.querySelectorAll('[data-close-dialog]')) {
    node.addEventListener('click', () => node.closest('dialog')?.close());
  }

  dom.regionSegmented.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-region]');
    if (button) selectRegion(button.dataset.region);
  });

  dom.refreshAllBtn.addEventListener('click', handleRefreshAll);
  dom.addForm.addEventListener('submit', handleAddSubmit);
  dom.baselineForm.addEventListener('submit', handleBaselineSubmit);

  // 账号入口
  dom.accountBtn.addEventListener('click', showAccountDialog);
  for (const node of document.querySelectorAll('[data-open-account]')) {
    node.addEventListener('click', showAccountDialog);
  }
  for (const button of dom.accountDialog.querySelectorAll('[data-auth-tab]')) {
    button.addEventListener('click', () => switchAuthTab(button.dataset.authTab));
  }
  dom.registerForm.addEventListener('submit', handleRegisterSubmit);
  dom.loginForm.addEventListener('submit', handleLoginSubmit);
  dom.passwordForm.addEventListener('submit', handlePasswordSubmit);
  dom.logoutBtn.addEventListener('click', handleLogout);
  dom.changePasswordBtn.addEventListener('click', () => {
    dom.accountInfo.hidden = true;
    dom.passwordForm.hidden = false;
  });
  dom.cancelPasswordBtn.addEventListener('click', () => {
    dom.passwordForm.hidden = true;
    dom.accountInfo.hidden = false;
  });

  dom.accountList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const roleId = button.dataset.role;
    if (!roleId) return;
    if (button.dataset.act === 'refresh') handleRefreshOne(roleId);
    else if (button.dataset.act === 'baseline') openBaselineDialog(roleId);
    else if (button.dataset.act === 'delete') handleDelete(roleId);
  });
}

/**
 * 自动刷新点赞数。
 *
 * 触发时机：进入页面、手机下拉刷新（会重新加载页面）、切回这个标签页。
 * 只调接口 B 查点赞数（不消耗搜索额度），失败也不打扰用户，只把错误记在卡片上。
 */
let autoRefreshing = false;
let lastAutoRefreshAt = 0;

async function autoRefreshLikes({ force = false } = {}) {
  if (autoRefreshing) return;
  if (state.myRoleIds.length === 0) return;
  // 切标签页会反复触发，1 分钟内不重复刷
  if (!force && Date.now() - lastAutoRefreshAt < 60_000) return;

  autoRefreshing = true;
  lastAutoRefreshAt = Date.now();
  dom.refreshAllBtn.disabled = true;
  dom.refreshAllBtn.classList.add('is-busy');

  try {
    const data = await api.refreshAll(state.myRoleIds);
    state.accounts = data.accounts ?? state.accounts;
    if (Array.isArray(data.missing) && data.missing.length > 0) {
      writeMyRoleIds(state.myRoleIds.filter((id) => !data.missing.includes(id)));
    }
    saveCache();
    render();
  } catch (error) {
    // 自动刷新失败不弹提示（后端已经把错误记在每个账号的 lastError 上）
    console.warn('自动刷新点赞失败：', error.message);
  } finally {
    autoRefreshing = false;
    dom.refreshAllBtn.disabled = false;
    dom.refreshAllBtn.classList.remove('is-busy');
  }
}

async function main() {
  applyTheme(loadTheme());
  buildRegionSegmented();
  bindEvents();
  state.myRoleIds = readMyRoleIds();
  renderAccount();

  // 先用本地缓存把界面渲染出来，再拉服务器数据（只渲染本机列表里的那些）
  const cached = readCache();
  if (cached) {
    state.accounts = (cached.accounts ?? []).filter((item) => state.myRoleIds.includes(item.roleId));
    if (Number.isFinite(Number(cached.weeklyCap))) state.weeklyCap = Number(cached.weeklyCap);
    render();
  } else {
    dom.accountList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  }

  await loadConfig();
  render();
  await bootstrapIdentity();

  // ★ 进入页面/下拉刷新：先拿列表，再自动刷一次点赞数（接口B）
  const accounts = await loadAccounts();
  if (accounts.length > 0) await autoRefreshLikes({ force: true });

  setInterval(renderCountdown, 1000);
  setInterval(refreshTimes, 30_000);
  setInterval(() => autoRefreshLikes(), 5 * 60_000);

  // 从别的标签页/应用切回来时也拉一遍并刷一次（1 分钟内不重复刷）
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadAccounts({ silent: true });
    await autoRefreshLikes();
  });
}

main().catch((error) => {
  console.error(error);
  showError(`初始化失败：${error.message}`);
});
