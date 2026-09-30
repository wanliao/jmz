/**
 * 管理员后台接口测试：
 * 权限校验、用户管理、游戏账号（roleId / 基线 / 改归属 / 改当前点赞）管理。
 * 注：点赞记录表已按需求移除，相关用例一并删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createApp } from '../server/index.js';

const TZ = 'Asia/Shanghai';
let app;
let baseUrl;
let dbFile;

async function call(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

let seq = 0;
const newGuest = async () => {
  // 新版没有游客身份了，这里直接用注册用户代替（函数名沿用，减少改动）
  seq += 1;
  const username = `player${Date.now().toString().slice(-5)}${seq}`;
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'pw123456' },
  });
  return { token: res.json.data.token, user: res.json.data.user, username };
};

const state = {};

before(async () => {
  dbFile = path.join(
    os.tmpdir(),
    `kimuzhi-admin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  app = await createApp({
    env: {
      ADAPTER: 'mock',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_FILE: dbFile,
      DATA_FILE: path.join(os.tmpdir(), 'kimuzhi-nonexistent-legacy.json'),
      TIME_ZONE: TZ,
      ADMIN_USERNAME: 'rootadmin',
      ADMIN_PASSWORD: 'rootpass123',
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const admin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootpass123' },
  });
  state.adminToken = admin.json.data.token;
  state.adminUser = admin.json.data.user;

  // 普通用户 + 一个游戏账号
  const guest = await newGuest();
  const registered = await call('/api/auth/register', {
    method: 'POST',
    token: guest.token,
    body: { username: 'player1', password: 'pw1' },
  });
  state.playerToken = registered.json.data.token;
  state.playerUser = registered.json.data.user;

  const created = await call('/api/accounts', {
    method: 'POST',
    token: state.playerToken,
    body: { nickname: '后台测试角色', region: 'wechat', lastWeekLikes: 2000 },
  });
  state.roleId = created.json.data.account.roleId;
});

after(async () => {
  app?.scheduler?.stop();
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  app?.db?.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbFile}${suffix}`, { force: true });
  }
});

test('超级管理员：全站唯一，不能被降级 / 删除 / 被别人重置密码', async () => {
  // .env 里配的是 rootadmin，它就是那个唯一的超级管理员
  const me = await call('/api/auth/me', { token: state.adminToken });
  assert.equal(me.json.data.user.isSuper, true, 'rootadmin 应该是超级管理员');
  assert.equal(me.json.data.user.isAdmin, true);
  assert.equal(state.adminUser.isSuper, true);

  const users = (await call('/api/admin/users', { token: state.adminToken })).json.data.users;
  assert.equal(users.filter((user) => user.isSuper).length, 1, '全站只能有一个超级管理员');

  // 不能取消超级管理员的管理员权限
  const demote = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: false },
  });
  assert.equal(demote.status, 400);
  assert.equal(demote.json.error.code, 'SUPER_ADMIN_PROTECTED');

  // 也不能删掉自己
  const remove = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'DELETE',
    token: state.adminToken,
  });
  assert.equal(remove.status, 400);
  assert.equal(remove.json.error.code, 'CANNOT_DELETE_SELF');

  // 也不能通过接口把别人设成超级管理员
  const makeSuper = await call(`/api/admin/users/${state.playerUser.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isSuper: true },
  });
  assert.equal(makeSuper.status, 400);
  assert.equal(makeSuper.json.error.code, 'SUPER_ADMIN_FIXED');
  assert.equal(app.repo.users.getSuper().id, state.adminUser.id, '超级管理员没有被换掉');
});

test('数据库层挡住第二个超级管理员', async () => {
  assert.throws(
    () => app.db.prepare('UPDATE users SET is_super = 1 WHERE id = ?').run(state.playerUser.id),
    /UNIQUE|constraint/i,
    '唯一索引应该拦住第二个超级管理员',
  );
  assert.equal(app.repo.users.listUsers().filter((user) => user.isSuper).length, 1);
});

test('普通管理员：能管游戏账号，但动不了管理员层级', async () => {
  // 让 rootadmin 把 player1 提为普通管理员
  const promote = await call(`/api/admin/users/${state.playerUser.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: true },
  });
  assert.equal(promote.status, 200, JSON.stringify(promote.json));
  assert.equal(promote.json.data.user.isAdmin, true);
  assert.equal(promote.json.data.user.isSuper, false, '提的是普通管理员，不是超级管理员');

  const playerLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'player1', password: 'pw1' },
  });
  const playerToken = playerLogin.json.data.token;

  // 能看后台、能管游戏账号
  assert.equal((await call('/api/admin/overview', { token: playerToken })).status, 200);
  assert.equal((await call('/api/admin/roles', { token: playerToken })).status, 200);

  // 动不了超级管理员
  const touchSuper = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'PATCH',
    token: playerToken,
    body: { isAdmin: false },
  });
  assert.equal(touchSuper.status, 403);
  assert.equal(touchSuper.json.error.code, 'SUPER_ONLY');

  const resetSuper = await call(`/api/admin/users/${state.adminUser.id}/password`, {
    method: 'POST',
    token: playerToken,
    body: { newPassword: 'hacked123' },
  });
  assert.equal(resetSuper.status, 403);
  assert.equal(resetSuper.json.error.code, 'SUPER_ADMIN_PROTECTED');

  const deleteSuper = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'DELETE',
    token: playerToken,
  });
  assert.equal(deleteSuper.status, 403);
  assert.equal(deleteSuper.json.error.code, 'SUPER_ADMIN_PROTECTED');

  // 也不能提升别人（包括自己）当管理员
  const selfPromote = await call(`/api/admin/users/${state.playerUser.id}`, {
    method: 'PATCH',
    token: playerToken,
    body: { isAdmin: false },
  });
  assert.equal(selfPromote.status, 403);
  assert.equal(selfPromote.json.error.code, 'SUPER_ONLY');

  // 收尾：把 player1 降回普通用户，免得影响后面的用例
  await call(`/api/admin/users/${state.playerUser.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: false },
  });
});

test('普通用户 / 未登录访问管理接口会被拒', async () => {
  // 用一个全新的普通用户，避免受别处「提升为管理员」的影响
  const plainUser = await newGuest();
  const byUser = await call('/api/admin/users', { token: plainUser.token });
  assert.equal(byUser.status, 403);
  assert.equal(byUser.json.error.code, 'FORBIDDEN');

  const anonymous = await call('/api/admin/overview');
  assert.equal(anonymous.status, 401);
});

test('后台概览：统计 + 当前周 + 上次结算标记', async () => {
  const res = await call('/api/admin/overview', { token: state.adminToken });
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.ok(data.stats.users >= 2);
  assert.ok(data.stats.roles >= 1);
  assert.equal(data.week.timeZone, TZ);
  assert.equal(data.defaultAdminPassword, false, '用的是 .env 里配的密码，不该报默认密码');
});

test('用户列表：带角色数、本周已刷合计', async () => {
  const res = await call('/api/admin/users', { token: state.adminToken });
  assert.equal(res.status, 200);
  const player = res.json.data.users.find((user) => user.username === 'player1');
  assert.ok(player);
  assert.equal(player.roleCount, 1);
  assert.ok(player.weekLikesTotal >= 0);
  assert.equal(player.isGuest, false);

  assert.ok(res.json.data.users.every((user) => user.isGuest === false), '不再有游客身份');
});

test('用户详情：他的游戏账号', async () => {
  const res = await call(`/api/admin/users/${state.playerUser.id}`, { token: state.adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.accounts.length, 1);
  assert.equal(res.json.data.accounts[0].roleId, state.roleId);
});

test('游戏账号列表：带归属人', async () => {
  const res = await call('/api/admin/roles', { token: state.adminToken });
  assert.equal(res.status, 200);
  const role = res.json.data.roles.find((item) => item.roleId === state.roleId);
  assert.ok(role);
  assert.equal(role.ownerLabel, 'player1');
  assert.equal(role.userId, state.playerUser.id);
});

test('管理员可以改昵称 / 大区 / 上周点赞（基线）', async () => {
  const res = await call(`/api/admin/roles/${state.roleId}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { displayName: '被管理员改名了', region: 'qq', baseline: 123 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const account = res.json.data.account;
  assert.equal(account.nickname, '被管理员改名了');
  assert.equal(account.region, 'qq');
  assert.equal(account.baseline, 123);
  assert.equal(account.baselineSource, 'admin');

  const invalid = await call(`/api/admin/roles/${state.roleId}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { region: 'weibo' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_REGION');
});

test('管理员可以改 roleId（主键）', async () => {
  const newRoleId = '3999888777';

  const res = await call(`/api/admin/roles/${state.roleId}/role-id`, {
    method: 'POST',
    token: state.adminToken,
    body: { roleId: newRoleId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.roleId, newRoleId);
  assert.equal(app.repo.roles.getRole(state.roleId), null, '旧 roleId 应该没了');
  assert.ok(app.repo.roles.getRole(newRoleId), '新 roleId 应该存在');

  const bad = await call(`/api/admin/roles/${newRoleId}/role-id`, {
    method: 'POST',
    token: state.adminToken,
    body: { roleId: 'abc' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_ROLE_ID');

  state.roleId = newRoleId;
});

test('管理员可以把 roleId 改归属给另一个用户', async () => {
  const other = await newGuest();
  const registered = await call('/api/auth/register', {
    method: 'POST',
    token: other.token,
    body: { username: 'player2', password: 'pw2' },
  });
  const targetUserId = registered.json.data.user.id;

  const res = await call(`/api/admin/roles/${state.roleId}/owner`, {
    method: 'POST',
    token: state.adminToken,
    body: { userId: targetUserId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(app.repo.roles.getRole(state.roleId).userId, targetUserId);

  // 现在 player1 看不到了，player2 能看到
  const original = await call('/api/accounts', { token: state.playerToken });
  assert.equal(original.json.data.accounts.length, 0);
  const moved = await call('/api/accounts', { token: registered.json.data.token });
  assert.equal(moved.json.data.accounts.length, 1);
  assert.equal(moved.json.data.accounts[0].roleId, state.roleId);

  state.player2 = { token: registered.json.data.token, user: registered.json.data.user };
});

test('超级管理员不能取消自己的管理员权限，也不能删自己', async () => {
  const demote = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: false },
  });
  assert.equal(demote.status, 400);
  // 超级管理员不能被降级（这条规则优先于「不能改自己」）
  assert.equal(demote.json.error.code, 'SUPER_ADMIN_PROTECTED');

  const remove = await call(`/api/admin/users/${state.adminUser.id}`, {
    method: 'DELETE',
    token: state.adminToken,
  });
  assert.equal(remove.status, 400);
  assert.equal(remove.json.error.code, 'CANNOT_DELETE_SELF');
});

test('把普通用户提升为管理员后，他能访问后台', async () => {
  const promote = await call(`/api/admin/users/${state.player2.user.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: true },
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.json.data.user.isAdmin, true);

  const overview = await call('/api/admin/overview', { token: state.player2.token });
  assert.equal(overview.status, 200);

  // 改回去，避免影响后续用例
  await call(`/api/admin/users/${state.player2.user.id}`, {
    method: 'PATCH',
    token: state.adminToken,
    body: { isAdmin: false },
  });
});

test('重置用户密码后，该用户原来的登录态会被踢掉', async () => {
  const before = await call('/api/auth/me', { token: state.player2.token });
  assert.equal(before.json.data.user.username, 'player2');

  const reset = await call(`/api/admin/users/${state.player2.user.id}/password`, {
    method: 'POST',
    token: state.adminToken,
    body: { newPassword: 'newpw456' },
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));

  const oldToken = await call('/api/auth/me', { token: state.player2.token });
  assert.equal(oldToken.json.data.user, null, '旧会话应该失效');

  const relogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'player2', password: 'newpw456' },
  });
  assert.equal(relogin.status, 200, '新密码能登录');
  state.player2.token = relogin.json.data.token;
});

test('删除 roleId', async () => {
  const res = await call(`/api/admin/roles/${state.roleId}`, {
    method: 'DELETE',
    token: state.adminToken,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(app.repo.roles.getRole(state.roleId), null);
  const again = await call(`/api/admin/roles/${state.roleId}`, {
    method: 'DELETE',
    token: state.adminToken,
  });
  assert.equal(again.status, 404);
});

test('删除用户会连带删掉他的游戏账号', async () => {
  // 给 player2 再建一个账号
  const created = await call('/api/accounts', {
    method: 'POST',
    token: state.player2.token,
    body: { nickname: '待删除角色', region: 'wechat', lastWeekLikes: 50 },
  });
  assert.equal(created.status, 201);
  const roleId = created.json.data.account.roleId;

  const userDetail = await call(`/api/admin/users/${state.player2.user.id}`, {
    token: state.adminToken,
  });
  const rolesBefore = userDetail.json.data.accounts.length;
  assert.equal(rolesBefore, 1);

  const res = await call(`/api/admin/users/${state.player2.user.id}`, {
    method: 'DELETE',
    token: state.adminToken,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.roleCount, 1);

  assert.equal(app.repo.users.getUser(state.player2.user.id), null);
  assert.equal(app.repo.roles.getRole(roleId), null, '角色应该被级联删除');

  // 会话也应该失效（外键级联）
  const me = await call('/api/auth/me', { token: state.player2.token });
  assert.equal(me.json.data.user, null);
});

test('操作日志：管理员的改动都留了痕', async () => {
  const res = await call('/api/admin/audit-logs?limit=100', { token: state.adminToken });
  assert.equal(res.status, 200);
  const actions = res.json.data.records.map((item) => item.action);
  for (const expected of [
    'auth.register',
    'auth.login',
    'role.add',
    'admin.role.update',
    'admin.role.change-id',
    'admin.role.transfer',
    'admin.role.delete',
    'admin.user.delete',
  ]) {
    assert.ok(actions.includes(expected), `审计日志里应该有 ${expected}`);
  }
  assert.ok(res.json.data.records.every((item) => item.actor && item.createdAt));
});

test('公告：只有管理员能改，改完统计页的 /api/config 立刻能看到', async () => {
  // 1) 普通用户不能读写后台设置
  const denied = await call('/api/admin/settings', { token: state.playerToken });
  assert.equal(denied.status, 403);

  const deniedWrite = await call('/api/admin/settings', {
    method: 'PATCH',
    token: state.playerToken,
    body: { announcement: '偷偷改公告' },
  });
  assert.equal(deniedWrite.status, 403);

  // 2) 一开始没有公告：/api/config 里是空字符串
  const before = await call('/api/config');
  assert.equal(before.json.data.announcement, '');

  // 3) 管理员写入（含换行，应该原样保留）
  const saved = await call('/api/admin/settings', {
    method: 'PATCH',
    token: state.adminToken,
    body: { announcement: '本周结算时间调整\n有问题找群主' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.announcement, '本周结算时间调整\n有问题找群主');

  const after = await call('/api/config');
  assert.equal(after.json.data.announcement, '本周结算时间调整\n有问题找群主');

  // 4) 超长公告被拦下
  const tooLong = await call('/api/admin/settings', {
    method: 'PATCH',
    token: state.adminToken,
    body: { announcement: 'x'.repeat(501) },
  });
  assert.equal(tooLong.status, 400, JSON.stringify(tooLong.json));
  assert.equal(tooLong.json.error.code, 'ANNOUNCEMENT_TOO_LONG');

  // 5) 留空 = 清空（前端会整张卡片不显示）
  const cleared = await call('/api/admin/settings', {
    method: 'PATCH',
    token: state.adminToken,
    body: { announcement: '   ' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.announcement, '');

  const clearedConfig = await call('/api/config');
  assert.equal(clearedConfig.json.data.announcement, '');

  // 6) 改公告也留痕
  const logs = await call('/api/admin/audit-logs?limit=20', { token: state.adminToken });
  assert.ok(logs.json.data.records.some((item) => item.action === 'admin.settings.announcement'));
});
