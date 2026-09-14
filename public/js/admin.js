/**
 * 管理后台前端。
 *
 * 能力：用户管理（提升/降级管理员、重置密码、删除）、
 * 游戏账号管理（改名/大区/基线、改 roleId、改归属、删除）、
 * 云端点赞记录管理（增删改）、操作日志、修改自己的密码。
 */

import * as api from './api.js';
import { escapeHtml, formatDateTime, formatNumber, formatRelative } from './format.js';

const THEME_KEY = 'hpjy.likes.theme';

const dom = {
  gate: document.getElementById('gate'),
  gateTitle: document.getElementById('gateTitle'),
  gateText: document.getElementById('gateText'),
  loginForm: document.getElementById('loginForm'),
  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  loginSubmit: document.getElementById('loginSubmit'),
  panel: document.getElementById('panel'),
  defaultPasswordNotice: document.getElementById('defaultPasswordNotice'),
  errorNotice: document.getElementById('errorNotice'),
  statUsers: document.getElementById('statUsers'),
  statRoles: document.getElementById('statRoles'),
  statWeek: document.getElementById('statWeek'),
  userTable: document.getElementById('userTable').querySelector('tbody'),
  roleTable: document.getElementById('roleTable').querySelector('tbody'),
  logTable: document.getElementById('logTable').querySelector('tbody'),
  userFilter: document.getElementById('userFilter'),
  roleFilter: document.getElementById('roleFilter'),
  reloadUsers: document.getElementById('reloadUsers'),
  runSettleBtn: document.getElementById('runSettleBtn'),
  reloadRoles: document.getElementById('reloadRoles'),
  reloadLogs: document.getElementById('reloadLogs'),
  themeToggle: document.getElementById('themeToggle'),
  logoutBtn: document.getElementById('logoutBtn'),
  editDialog: document.getElementById('editDialog'),
  editForm: document.getElementById('editForm'),
  editTitle: document.getElementById('editTitle'),
  editFields: document.getElementById('editFields'),
  editError: document.getElementById('editError'),
  editSubmit: document.getElementById('editSubmit'),
  passwordForm: document.getElementById('passwordForm'),
  oldPassword: document.getElementById('oldPassword'),
  newPassword: document.getElementById('newPassword'),
  passwordError: document.getElementById('passwordError'),
  passwordSubmit: document.getElementById('passwordSubmit'),
  announceForm: document.getElementById('announceForm'),
  announceInput: document.getElementById('announceInput'),
  announceError: document.getElementById('announceError'),
  announceSubmit: document.getElementById('announceSubmit'),
  toasts: document.getElementById('toasts'),
};

const state = {
  me: null,
  overview: null,
  users: [],
  roles: [],
  tab: 'users',
  editSubmitHandler: null,
};

/* ------------------------------------------------------------------ 工具 */

function toast(message, type = 'info', duration = 3200) {
  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  node.textContent = message;
  dom.toasts.appendChild(node);
  setTimeout(() => node.remove(), duration);
}

function showError(message) {
  dom.errorNotice.textContent = message ?? '';
  dom.errorNotice.hidden = !message;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0f1a' : '#f2f5fb');
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function emptyRow(columns, text) {
  return `<tr class="empty-row"><td colspan="${columns}">${escapeHtml(text)}</td></tr>`;
}

function userTag(user) {
  if (user.isSuper) return '<span class="tag tag-super">超级管理员</span>';
  if (user.isAdmin) return '<span class="tag tag-admin">管理员</span>';
  return '<span class="tag tag-user">注册用户</span>';
}

/* ------------------------------------------------------------- 登录 / 门禁 */

async function checkAccess() {
  try {
    const me = await api.getMe();
    if (!me.user) {
      showGate('需要管理员身份', '请用管理员账号登录。');
      return false;
    }
    state.me = me;
    if (!me.user.isAdmin) {
      showGate('这个账号不是管理员', `当前登录的是「${me.user.username ?? `游客#${me.user.id}`}」，没有后台权限。`);
      return false;
    }
    showPanel();
    return true;
  } catch {
    showGate('需要管理员身份', '请用管理员账号登录。');
    return false;
  }
}

function showGate(title, text) {
  dom.gateTitle.textContent = title;
  dom.gateText.textContent = text;
  dom.gate.hidden = false;
  dom.panel.hidden = true;
}

function showPanel() {
  dom.gate.hidden = true;
  dom.panel.hidden = false;
}

dom.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.loginError.hidden = true;
  dom.loginSubmit.disabled = true;
  dom.loginSubmit.textContent = '登录中…';
  try {
    const data = await api.login(dom.loginUsername.value.trim(), dom.loginPassword.value);
    api.setToken(data.token);
    if (!data.user.isAdmin) {
      showGate('这个账号不是管理员', `「${data.user.username}」没有后台权限，请换管理员账号。`);
      return;
    }
    dom.loginPassword.value = '';
    // 走一遍 checkAccess：它会设置 state.me（决定能不能管理管理员）并切到面板
    const ok = await checkAccess();
    if (ok) await refreshAll();
  } catch (error) {
    dom.loginError.textContent = error.message;
    dom.loginError.hidden = false;
  } finally {
    dom.loginSubmit.disabled = false;
    dom.loginSubmit.textContent = '登录';
  }
});

dom.logoutBtn.addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    /* 忽略 */
  }
  api.clearToken();
  location.reload();
});

/* ------------------------------------------------------------------ 加载 */

async function loadOverview() {
  const data = await api.adminOverview();
  state.overview = data;
  dom.statUsers.textContent = formatNumber(data.stats.users);
  dom.statRoles.textContent = formatNumber(data.stats.roles);
  const lastCron = data.settings.lastCronAt
    ? `上次结算 ${formatRelative(data.settings.lastCronAt)}`
    : '还没跑过结算任务';
  dom.statWeek.textContent = `${data.week.key} 起 · ${lastCron}`;
  dom.defaultPasswordNotice.hidden = !data.defaultAdminPassword;
}

async function loadUsers() {
  const data = await api.adminUsers();
  state.users = data.users;
  renderUsers();
}

async function loadRoles() {
  const data = await api.adminRoles();
  state.roles = data.roles;
  renderRoles();
}

async function loadLogs() {
  const data = await api.adminAuditLogs(80);
  dom.logTable.innerHTML =
    data.records.length === 0
      ? emptyRow(5, '还没有日志')
      : data.records
          .map(
            (item) => `
        <tr>
          <td class="mono">${escapeHtml(formatDateTime(item.createdAt))}</td>
          <td class="mono">${escapeHtml(item.actor)}</td>
          <td>${escapeHtml(item.action)}</td>
          <td class="mono">${escapeHtml(item.target ?? '')}</td>
          <td class="mono" style="white-space:normal;max-width:420px">${escapeHtml(
            item.detail ? JSON.stringify(item.detail) : '',
          )}</td>
        </tr>`,
          )
          .join('');
}

/** 首页公告（存在 settings 表里，key = announcement） */
async function loadAnnouncement() {
  const data = await api.adminGetSettings();
  dom.announceInput.value = data.announcement ?? '';
  return data;
}

/* ------------------------------------------------------------------ 渲染 */

function renderUsers() {
  const keyword = dom.userFilter.value.trim().toLowerCase();
  const users = state.users.filter((user) => {
    if (!keyword) return true;
    return (
      String(user.id) === keyword ||
      String(user.username ?? '').toLowerCase().includes(keyword) ||
      String(user.username ?? '') === keyword
    );
  });

  const meIsSuper = Boolean(state.me?.user?.isSuper);

  dom.userTable.innerHTML =
    users.length === 0
      ? emptyRow(8, '没有匹配的用户')
      : users
          .map((user) => {
            const isSelf = state.me?.user?.id === user.id;
            const actions = [`<button class="btn btn-sm btn-ghost" data-user-roles="${user.id}">查看账号</button>`];

            if (user.isSuper) {
              // 超级管理员全站唯一：既不能降级也不能删，改密码请用「修改我的密码」
              actions.push('<span class="tag tag-super">全站唯一</span>');
            } else if (!meIsSuper) {
              // 普通管理员只能看，不能动管理员层级
              actions.push('<span class="tag">仅超级管理员可管理</span>');
            } else {
              actions.push(
                `<button class="btn btn-sm btn-ghost" data-user-admin="${user.id}" data-value="${
                  user.isAdmin ? 0 : 1
                }">${user.isAdmin ? '取消管理员' : '设为管理员'}</button>`,
                `<button class="btn btn-sm btn-ghost" data-user-password="${user.id}">改密码</button>`,
                `<button class="btn btn-sm btn-danger" data-user-delete="${user.id}">删除</button>`,
              );
            }

            return `
        <tr>
          <td class="mono">${user.id}</td>
          <td>${escapeHtml(user.username ?? '（无）')}${isSelf ? ' <span class="tag">我</span>' : ''}</td>
          <td>${userTag(user)}</td>
          <td class="num">${user.roleCount}</td>
          <td class="num">${formatNumber(user.weekLikesTotal)}</td>
          <td class="num">${user.sessionCount}</td>
          <td class="mono">${escapeHtml(formatDateTime(user.createdAt))}</td>
          <td><div class="row-actions">${actions.join('')}</div></td>
        </tr>`;
          })
          .join('');
}

function renderRoles() {
  const keyword = dom.roleFilter.value.trim().toLowerCase();
  const roles = state.roles.filter((role) => {
    if (!keyword) return true;
    return (
      role.roleId.includes(keyword) ||
      String(role.nickname ?? '').toLowerCase().includes(keyword) ||
      String(role.ownerLabel ?? '').toLowerCase().includes(keyword)
    );
  });

  dom.roleTable.innerHTML =
    roles.length === 0
      ? emptyRow(8, '没有匹配的游戏账号')
      : roles
          .map(
            (role) => `
        <tr>
          <td class="mono">${escapeHtml(role.roleId)}</td>
          <td>${escapeHtml(role.nickname ?? '（未命名）')}</td>
          <td>${role.region === 'qq' ? 'QQ区' : '微信区'}</td>
          <td>${escapeHtml(role.ownerLabel ?? '')}</td>
          <td class="num">${formatNumber(role.baseline)}</td>
          <td class="num">${role.hasData ? formatNumber(role.currentLikes) : '--'}</td>
          <td class="num">${formatNumber(role.weekLikes)}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-role-edit="${escapeHtml(role.roleId)}">编辑</button>
              <button class="btn btn-sm btn-ghost" data-role-id="${escapeHtml(role.roleId)}">改 roleId</button>
              <button class="btn btn-sm btn-ghost" data-role-owner="${escapeHtml(role.roleId)}">改归属</button>
              <button class="btn btn-sm btn-danger" data-role-delete="${escapeHtml(role.roleId)}">删除</button>
            </div>
          </td>
        </tr>`,
          )
          .join('');
}

/* -------------------------------------------------------------- 编辑弹窗 */

function openEdit(title, fields, onSubmit, hint) {
  dom.editTitle.textContent = title;
  dom.editError.hidden = true;
  dom.editFields.innerHTML =
    (hint ? `<p class="edit-hint">${hint}</p>` : '') +
    fields
      .map(
        (field) => `
      <div class="field">
        <label for="edit-${field.name}">${escapeHtml(field.label)}</label>
        ${
          field.type === 'select'
            ? `<select id="edit-${field.name}" class="toolbar-input" data-edit-field="${field.name}">
                 ${field.options
                   .map(
                     (option) =>
                       `<option value="${escapeHtml(option.value)}"${
                         String(option.value) === String(field.value) ? ' selected' : ''
                       }>${escapeHtml(option.label)}</option>`,
                   )
                   .join('')}
               </select>`
            : `<input id="edit-${field.name}" data-edit-field="${field.name}" type="${field.type ?? 'text'}"
                     value="${escapeHtml(field.value ?? '')}" ${field.readonly ? 'readonly' : ''} />`
        }
        ${field.hint ? `<p class="hint">${escapeHtml(field.hint)}</p>` : ''}
      </div>`,
      )
      .join('');
  state.editSubmitHandler = onSubmit;
  dom.editDialog.showModal();
}

function readEditFields() {
  const values = {};
  for (const node of dom.editFields.querySelectorAll('[data-edit-field]')) {
    values[node.dataset.editField] = node.value;
  }
  return values;
}

dom.editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.editSubmitHandler) return;
  dom.editError.hidden = true;
  dom.editSubmit.disabled = true;
  try {
    await state.editSubmitHandler(readEditFields());
    dom.editDialog.close();
  } catch (error) {
    dom.editError.textContent = error.message;
    dom.editError.hidden = false;
  } finally {
    dom.editSubmit.disabled = false;
  }
});

/* ------------------------------------------------------------ 表格操作 */

const userOptions = () =>
  state.users.map((user) => ({
    value: user.id,
    label: `${user.username ?? `（游客#${user.id}）`} · ${user.roleCount} 个账号`,
  }));

dom.userTable.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { userRoles, userAdmin, userPassword, userDelete } = button.dataset;

  try {
    if (userRoles) {
      const id = Number(userRoles);
      const detail = await api.adminUserDetail(id);
      switchTab('roles');
      state.roles = detail.accounts.map((account) => ({
        ...account,
        ownerLabel: detail.user.username ?? `游客#${detail.user.id}`,
      }));
      renderRoles();
      toast(`只看「${detail.user.username ?? `游客#${id}`}」的 ${state.roles.length} 个账号`, 'info');
      return;
    }

    if (userAdmin) {
      const id = Number(userAdmin);
      const isAdmin = button.dataset.value === '1';
      await api.adminSetAdmin(id, isAdmin);
      await Promise.all([loadUsers(), loadOverview()]);
      toast(isAdmin ? '已设为管理员' : '已取消管理员', 'ok');
      return;
    }

    if (userPassword) {
      const id = Number(userPassword);
      const user = state.users.find((item) => item.id === id);
      openEdit(
        `重置「${user?.username ?? `游客#${id}`}」的密码`,
        [{ name: 'newPassword', label: '新密码', type: 'text', hint: '重置后该用户已登录的设备会被踢下线。' }],
        async (values) => {
          await api.adminResetPassword(id, values.newPassword);
          await loadUsers();
          toast('密码已重置', 'ok');
        },
      );
      return;
    }

    if (userDelete) {
      const id = Number(userDelete);
      const user = state.users.find((item) => item.id === id);
      if (!window.confirm(`删除「${user?.username ?? `游客#${id}`}」？\n名下 ${user?.roleCount ?? 0} 个游戏账号和它们的点赞记录都会一起删掉，不可恢复。`)) return;
      const result = await api.adminDeleteUser(id);
      await Promise.all([loadUsers(), loadRoles(), loadOverview()]);
      toast(`已删除用户，连带 ${result.roleCount} 个游戏账号`, 'ok');
    }
  } catch (error) {
    toast(error.message, 'error', 5000);
  }
});

dom.roleTable.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { roleEdit, roleId, roleOwner, roleDelete } = button.dataset;

  try {
    if (roleEdit) {
      const role = state.roles.find((item) => item.roleId === roleEdit);
      if (!role) return;
      openEdit(`编辑 ${roleEdit}`, [
        { name: 'displayName', label: '名字（只存在角色映射表里）', value: role.nickname ?? '' },
        {
          name: 'region',
          label: '大区',
          type: 'select',
          value: role.region,
          options: [
            { value: 'wechat', label: '微信区（接口 zone=2）' },
            { value: 'qq', label: 'QQ区（接口 zone=1）' },
          ],
        },
        {
          name: 'baseline',
          label: '上周点赞数（基线）',
          type: 'number',
          value: role.baseline,
          hint: '本周已刷 = 当前总点赞 − 这个值',
        },
        {
          name: 'currentLikes',
          label: '当前总点赞（留空表示未知）',
          type: 'number',
          value: role.currentLikes ?? '',
          hint: '改这个不会去查接口，只改数据库里记录的值。',
        },
      ], async (values) => {
        const patch = {
          displayName: values.displayName,
          region: values.region,
          baseline: Number(values.baseline),
        };
        patch.currentLikes = values.currentLikes === '' ? null : Number(values.currentLikes);
        await api.adminUpdateRole(roleEdit, patch);
        await Promise.all([loadRoles(), loadLogs()]);
        toast('已保存', 'ok');
      });
      return;
    }

    if (roleId) {
      const role = state.roles.find((item) => item.roleId === roleId);
      openEdit(
        `改 roleId`,
        [{ name: 'roleId', label: '新的 roleId', value: roleId, hint: '必须是纯数字，游戏内角色 ID；它的点赞记录会一起迁移。' }],
        async (values) => {
          await api.adminChangeRoleId(roleId, values.roleId.trim());
          await Promise.all([loadRoles(), loadLogs()]);
          toast('roleId 已更新', 'ok');
        },
      );
      void role;
      return;
    }

    if (roleOwner) {
      const role = state.roles.find((item) => item.roleId === roleOwner);
      if (!role) return;
      openEdit(
        '改归属',
        [
          {
            name: 'userId',
            label: '转给哪个用户',
            type: 'select',
            value: role.userId,
            options: userOptions(),
            hint: '旧数据导入后挂在 legacy-import 名下，这里可以转给真正的用户。',
          },
        ],
        async (values) => {
          await api.adminTransferRole(roleOwner, Number(values.userId));
          await Promise.all([loadRoles(), loadUsers(), loadLogs()]);
          toast('归属已修改', 'ok');
        },
      );
      return;
    }

    if (roleDelete) {
      const role = state.roles.find((item) => item.roleId === roleDelete);
      if (!window.confirm(`删除 roleId ${roleDelete}？\n它的所有云端点赞记录会一起删掉，不可恢复。`)) return;
      const result = await api.adminDeleteRole(roleDelete);
      await Promise.all([loadRoles(), loadUsers(), loadOverview(), loadLogs()]);
      toast('已删除', 'ok');
      void role;
    }
  } catch (error) {
    toast(error.message, 'error', 5000);
  }
});

/* ------------------------------------------------------------------ 标签页 */

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  }
  for (const block of document.querySelectorAll('[data-panel]')) {
    block.hidden = block.dataset.panel !== tab;
  }
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (button) switchTab(button.dataset.tab);
});

dom.userFilter.addEventListener('input', renderUsers);
dom.roleFilter.addEventListener('input', renderRoles);
dom.runSettleBtn.addEventListener('click', async () => {
  if (
    !window.confirm(
      '手动跑一次每周结算？\n会用接口 B 查一遍所有 roleId 的点赞数，\n把它们记成「上一周」的点赞记录，并把新一周的基线设成这个值。',
    )
  ) {
    return;
  }
  dom.runSettleBtn.disabled = true;
  dom.runSettleBtn.textContent = '结算中…';
  try {
    const result = await api.adminRunWeeklySettle({ refresh: true, force: true });
    await Promise.all([loadOverview(), loadRoles(), loadLogs()]);
    toast(
      `结算完成：上一周 ${result.prevWeekKey} 记了 ${result.refreshed} 条，失败 ${result.refreshedFailed} 条`,
      result.refreshedFailed > 0 ? 'warn' : 'ok',
      5000,
    );
  } catch (error) {
    toast(error.message, 'error', 5000);
  } finally {
    dom.runSettleBtn.disabled = false;
    dom.runSettleBtn.textContent = '手动结算一次';
  }
});

dom.reloadUsers.addEventListener('click', () => loadUsers().catch((error) => toast(error.message, 'error')));
dom.reloadRoles.addEventListener('click', () => loadRoles().catch((error) => toast(error.message, 'error')));
dom.reloadLogs.addEventListener('click', () => loadLogs().catch((error) => toast(error.message, 'error')));

for (const node of document.querySelectorAll('[data-close-dialog]')) {
  node.addEventListener('click', () => node.closest('dialog')?.close());
}

dom.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 忽略 */
  }
});

/* -------------------------------------------------------------------- 公告 */

dom.announceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.announceError.hidden = true;
  dom.announceSubmit.disabled = true;
  dom.announceSubmit.textContent = '保存中…';
  try {
    const data = await api.adminSaveSettings({ announcement: dom.announceInput.value });
    dom.announceInput.value = data.announcement ?? '';
    toast(data.announcement ? '公告已保存，统计页底部会显示' : '公告已清空，统计页不再显示公告卡片', 'ok', 4200);
    await loadLogs();
  } catch (error) {
    dom.announceError.textContent = error.message;
    dom.announceError.hidden = false;
  } finally {
    dom.announceSubmit.disabled = false;
    dom.announceSubmit.textContent = '保存公告';
  }
});

/* ------------------------------------------------------------ 修改自己密码 */

dom.passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.passwordError.hidden = true;
  dom.passwordSubmit.disabled = true;
  try {
    await api.changeMyPassword(dom.oldPassword.value, dom.newPassword.value);
    dom.passwordForm.reset();
    toast('密码已修改', 'ok');
    await loadOverview();
  } catch (error) {
    dom.passwordError.textContent = error.message;
    dom.passwordError.hidden = false;
  } finally {
    dom.passwordSubmit.disabled = false;
  }
});

/* ------------------------------------------------------------------ 启动 */

async function refreshAll() {
  showError('');
  try {
    await loadOverview();
    await Promise.all([loadUsers(), loadRoles(), loadLogs(), loadAnnouncement()]);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      showGate('需要管理员身份', error.message);
      return;
    }
    showError(`加载失败：${error.message}`);
  }
}

async function main() {
  applyTheme(loadTheme());
  const ok = await checkAccess();
  if (ok) await refreshAll();
}

main().catch((error) => {
  console.error(error);
  showGate('后台加载失败', error.message);
});
