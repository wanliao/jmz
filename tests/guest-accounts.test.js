/**
 * 账号模型测试（全站唯一 + 本机视图）。
 *
 * 核心要求：
 *   - 一个 roleId 在库里只有一条记录、不绑定任何用户（roles 表没有 user_id）；
 *   - 未登录（游客）也能添加，添加的账号同样入库、后台看得到；
 *   - 但「看哪些账号」是每台设备自己决定的：服务端只按客户端给的 roleIds 返回，
 *     不会把全库列表下发（所以别人打开主页看不到你的账号）；
 *   - 添加别人已经加过的角色 = 认领进自己的列表，不重复入库、不覆盖已有数据；
 *   - 公开接口没有删除能力，真正删账号只能管理员在后台做。
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
let adminToken;

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

const query = (roleIds) => call('/api/accounts/query', { method: 'POST', body: { roleIds } });
const refresh = (roleIds) => call('/api/accounts/refresh', { method: 'POST', body: { roleIds } });

before(async () => {
  dbFile = path.join(
    os.tmpdir(),
    `kimuzhi-guest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootpass123' },
  });
  adminToken = login.json.data.token;
});

after(async () => {
  app?.scheduler?.stop();
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  app?.db?.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbFile}${suffix}`, { force: true });
  }
});

test('数据库里 roles 表已经不绑定用户了（没有 user_id 列）', async () => {
  const columns = app.db
    .prepare('PRAGMA table_info(roles)')
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes('role_id'), 'roles 表要在');
  assert.ok(!columns.includes('user_id'), `roles 不该再有 user_id，实际列：${columns.join(',')}`);
});

test('未登录也拿不到全库列表：必须显式给 roleIds', async () => {
  // 旧的「列出全部」接口已经移除
  const legacyList = await call('/api/accounts');
  assert.equal(legacyList.status, 404);

  const noIds = await call('/api/accounts/query', { method: 'POST', body: {} });
  assert.equal(noIds.status, 400);
  assert.equal(noIds.json.error.code, 'INVALID_ROLE_IDS');

  const empty = await query([]);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.data.accounts, []);
  assert.deepEqual(empty.json.data.missing, []);
});

test('游客添加账号：直接入库，后台「游戏账号」里能看到，标成「游客」添加', async () => {
  const before = app.repo.roles.countRoles();

  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '游客玩家甲', region: 'qq', lastWeekLikes: 1000 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const account = created.json.data.account;
  assert.equal(created.json.data.claimed, false);
  assert.match(account.roleId, /^\d{10}$/);
  assert.equal(account.region, 'qq');
  assert.equal(account.baseline, 1000);
  assert.equal(account.hasData, true);
  assert.equal(account.weekLikes, Math.max(0, account.currentLikes - 1000));
  assert.ok(account.profile?.highestDivName, 'Mock 也应带回账号档案（最高段位）');

  // ★ 关键：真的落库了
  assert.equal(app.repo.roles.countRoles(), before + 1, '游客添加的账号必须入库');
  assert.ok(app.repo.roles.getRole(account.roleId), '按 roleId 能查到');
  assert.equal(app.repo.users.countUsers(), 1, '不需要产生游客用户，只有管理员一个用户');

  // ★ 关键：后台能看到，并且知道是游客加的
  const adminRoles = await call('/api/admin/roles', { token: adminToken });
  assert.equal(adminRoles.status, 200);
  const row = adminRoles.json.data.roles.find((item) => item.roleId === account.roleId);
  assert.ok(row, '后台游戏账号列表里要有游客添加的账号');
  assert.equal(row.addedBy, '游客（未登录）');
  assert.equal(row.nickname, '游客玩家甲');

  // ★ 关键：只按 roleIds 查，别人的列表不会被下发
  const mine = await query([account.roleId]);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.data.accounts.length, 1);
  assert.equal(mine.json.data.accounts[0].roleId, account.roleId);

  const others = await query(['1234567890']);
  assert.equal(others.json.data.accounts.length, 0, '没给过的 roleId 不会出现');
  assert.deepEqual(others.json.data.missing, ['1234567890']);

  globalThis.__firstRoleId = account.roleId;
});

test('添加别人已经加过的角色 = 认领：不重复入库、不覆盖别人填的基线', async () => {
  const roleId = globalThis.__firstRoleId;
  const before = app.repo.roles.countRoles();
  const baselineBefore = app.repo.roles.getRole(roleId).baseline;

  const again = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '游客玩家甲', region: 'qq', lastWeekLikes: 1 },
  });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.data.claimed, true);
  assert.equal(again.json.data.account.roleId, roleId);
  assert.equal(again.json.data.renamed, null, '名字没变就不该有改名记录');
  assert.equal(app.repo.roles.countRoles(), before, '不能重复入库');
  assert.equal(app.repo.roles.getRole(roleId).baseline, baselineBefore, '不能覆盖已有基线');
});

test('玩家在游戏里改名：用新昵称再添加一次，库里的名字自动更正（成绩数据不动）', async () => {
  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '改名之前', region: 'qq', lastWeekLikes: 1234 },
  });
  const roleId = created.json.data.account.roleId;
  const before = app.repo.roles.getRole(roleId);
  const countBefore = app.repo.roles.countRoles();

  // 模拟：玩家改成「改名之后」，接口A 用新昵称查到的还是同一个 roleId，档案里的 roleName 是新名字
  const realResolve = app.adapters.resolveRoleId;
  app.adapters.resolveRoleId = async () => ({
    roleId,
    likes: before.currentLikes,
    profile: { roleName: '改名之后', highestDivName: '无敌战神' },
  });

  let again;
  try {
    again = await call('/api/accounts', {
      method: 'POST',
      body: { nickname: '改名之后', region: 'qq', lastWeekLikes: 1 },
    });
  } finally {
    app.adapters.resolveRoleId = realResolve;
  }

  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.data.claimed, true, '走认领而不是新建');
  assert.deepEqual(again.json.data.renamed, { from: '改名之前', to: '改名之后' });
  assert.equal(again.json.data.account.nickname, '改名之后');

  const after = app.repo.roles.getRole(roleId);
  assert.equal(after.nickname, '改名之后', '库里的名字要更正');
  assert.equal(after.profile.highestDivName, '无敌战神', '档案顺带刷新');
  assert.equal(after.baseline, before.baseline, '基线不能被改');
  assert.equal(after.currentLikes, before.currentLikes, '当前点赞不能被改');
  assert.equal(app.repo.roles.countRoles(), countBefore, '不新增记录');

  // 后台列表里显示的就是新名字
  const adminRoles = await call('/api/admin/roles', { token: adminToken });
  const row = adminRoles.json.data.roles.find((item) => item.roleId === roleId);
  assert.equal(row.nickname, '改名之后');

  // 改名留痕（和「添加者」用的 role.add 分开，添加者不会被覆盖）
  const logs = await call('/api/admin/audit-logs?limit=80', { token: adminToken });
  const renameLog = logs.json.data.records.find(
    (item) => item.action === 'role.rename' && item.target === roleId,
  );
  assert.ok(renameLog, '审计日志里应该有 role.rename');
  assert.equal(renameLog.detail.from, '改名之前');
  assert.equal(renameLog.detail.to, '改名之后');
});

test('新建账号时以游戏里的当前昵称为准（接口A 的 roleName）', async () => {
  const realResolve = app.adapters.resolveRoleId;
  let stubRoleId = null;
  app.adapters.resolveRoleId = async () => ({
    roleId: (stubRoleId = `777${Date.now().toString().slice(-7)}`),
    likes: 100,
    profile: { roleName: '游戏里的真名' },
  });

  let created;
  try {
    created = await call('/api/accounts', {
      method: 'POST',
      body: { nickname: '用户手填的名字', region: 'wechat', lastWeekLikes: 10 },
    });
  } finally {
    app.adapters.resolveRoleId = realResolve;
  }

  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.account.roleId, stubRoleId);
  assert.equal(created.json.data.account.nickname, '游戏里的真名', '存游戏里的真名，避免手填错字');
});

test('刷新只刷给定的 roleIds（游客也能刷）', async () => {
  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '游客玩家乙', region: 'wechat', lastWeekLikes: 500 },
  });
  const account = created.json.data.account;

  const one = await call(`/api/accounts/${account.roleId}/refresh`, { method: 'POST' });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.equal(one.json.data.warning, null);

  const batch = await refresh([account.roleId, '9876543210']);
  assert.equal(batch.status, 200);
  assert.equal(batch.json.data.total, 1, '只刷存在的那一个');
  assert.equal(batch.json.data.failed, 0);
  assert.equal(batch.json.data.accounts.length, 1);
  assert.deepEqual(batch.json.data.missing, ['9876543210']);

  const bad = await call('/api/accounts/refresh', { method: 'POST', body: {} });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_ROLE_IDS');
});

test('未登录也能改「上周点赞」，但公开接口没有删除能力', async () => {
  const roleId = globalThis.__firstRoleId;
  const likesNow = app.repo.roles.getRole(roleId).currentLikes;

  const fixed = await call(`/api/accounts/${roleId}`, {
    method: 'PATCH',
    body: { lastWeekLikes: Math.max(0, likesNow - 88) },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.data.account.weekLikes, 88);
  assert.equal(fixed.json.data.account.baselineSource, 'manual');

  const removed = await call(`/api/accounts/${roleId}`, { method: 'DELETE' });
  assert.equal(removed.status, 404, '公开接口不能删账号');
  assert.ok(app.repo.roles.getRole(roleId), '账号还在');
});

test('管理员能在后台真正删除账号', async () => {
  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '后台删掉的角色', region: 'qq', lastWeekLikes: 0 },
  });
  const roleId = created.json.data.account.roleId;

  const denied = await call(`/api/admin/roles/${roleId}`, { method: 'DELETE' });
  assert.equal(denied.status, 401);

  const res = await call(`/api/admin/roles/${roleId}`, { method: 'DELETE', token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(app.repo.roles.getRole(roleId), null);

  // 删掉之后，本机列表再查它就会落到 missing 里（前端据此清理自己的列表）
  const after = await query([roleId]);
  assert.deepEqual(after.json.data.missing, [roleId]);
});

test('参数校验：昵称 / 大区 / 上周点赞数', async () => {
  const badRegion = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '某人', region: 'weibo', lastWeekLikes: 1 },
  });
  assert.equal(badRegion.status, 400);
  assert.equal(badRegion.json.error.code, 'INVALID_REGION');

  const badBaseline = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '某人', region: 'qq', lastWeekLikes: -1 },
  });
  assert.equal(badBaseline.status, 400);
  assert.equal(badBaseline.json.error.code, 'INVALID_BASELINE');

  const emptyName = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '   ', region: 'qq', lastWeekLikes: 1 },
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.json.error.code, 'INVALID_NICKNAME');
});

test('roleIds 会被清洗：非法值与重复值都丢掉', async () => {
  const roleId = globalThis.__firstRoleId;
  const res = await query([roleId, roleId, 'abc', '', null, '  1234567890  ']);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.accounts.length, 1, '重复的只算一次，非法值丢掉');
  assert.deepEqual(res.json.data.missing, ['1234567890']);
});

test('旧的本地模式 / 游客身份 / 导入接口都已经移除', async () => {
  for (const [pathname, method] of [
    ['/api/local/add', 'POST'],
    ['/api/local/sync', 'POST'],
    ['/api/local/settle', 'POST'],
    ['/api/local/baseline', 'POST'],
    ['/api/accounts/import', 'POST'],
    ['/api/auth/guest', 'POST'],
  ]) {
    const res = await call(pathname, { method, body: {} });
    assert.equal(res.status, 404, `${method} ${pathname} 应该已经不存在`);
  }
});

test('删除用户不会连累游戏账号（账号已经不属于任何用户）', async () => {
  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { username: `someone${Date.now().toString().slice(-6)}`, password: 'pw123456' },
  });
  assert.equal(registered.status, 201);
  const userId = registered.json.data.user.id;

  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: '删用户不删账号', region: 'wechat', lastWeekLikes: 0 },
  });
  const roleId = created.json.data.account.roleId;

  const deleted = await call(`/api/admin/users/${userId}`, { method: 'DELETE', token: adminToken });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(app.repo.users.getUser(userId), null);
  assert.ok(app.repo.roles.getRole(roleId), '游戏账号必须还在');
});

test('管理接口依然需要管理员身份', async () => {
  assert.equal((await call('/api/admin/overview')).status, 401);
  assert.equal((await call('/api/admin/roles')).status, 401);
  assert.equal((await call('/api/admin/overview', { token: adminToken })).status, 200);
});
