/**
 * 端到端接口测试（注册用户 / 云端版）：
 * 注册 → 添加账号（入云端数据库）→ 跨设备登录同步 → 用户之间互相隔离 →
 * 注册后把本地模式攒的账号搬上云 → 每周结算（只推进基线，不再有点赞记录表）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createApp } from '../server/index.js';

const TZ = 'Asia/Shanghai';
let app;
let baseUrl;
let dbFile;

async function call(pathname, { method = 'GET', body, token, raw } = {}) {
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
  return raw ? { status: response.status, text, json } : { status: response.status, json };
}

let seq = 0;
/** 注册一个全新用户，返回 { token, user } */
async function newUser(prefix = 'user') {
  seq += 1;
  const username = `${prefix}${Date.now().toString().slice(-6)}${seq}`;
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'pw123456' },
  });
  assert.equal(res.status, 201, `注册失败：${JSON.stringify(res.json)}`);
  return { token: res.json.data.token, user: res.json.data.user, username };
}

const state = {};

before(async () => {
  dbFile = path.join(
    os.tmpdir(),
    `kimuzhi-cloud-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  app = await createApp({
    env: {
      ADAPTER: 'mock',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_FILE: dbFile,
      DATA_FILE: path.join(os.tmpdir(), 'kimuzhi-nonexistent-legacy.json'),
      TIME_ZONE: TZ,
      SETTLE_GRACE_MS: '600000',
      ADMIN_USERNAME: 'rootadmin',
      ADMIN_PASSWORD: 'rootpass123',
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app?.scheduler?.stop();
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  app?.db?.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbFile}${suffix}`, { force: true });
  }
});

test('健康检查与运行配置', async () => {
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.data.status, 'up');
  assert.equal(typeof health.json.data.users, 'number');
  assert.equal(health.json.data.weeklyLikes, undefined, '点赞记录表已经去掉了');

  const config = await call('/api/config');
  assert.equal(config.json.data.weeklyCap, 350);
  assert.equal(config.json.data.timeZone, TZ);
  assert.equal(config.json.data.allowLocalMode, true);
  assert.ok(config.json.data.week.startMs < config.json.data.week.endMs);
});

test('数据库里不再有 weekly_likes 表', async () => {
  const tables = app.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes('roles'), 'roles 表要在');
  assert.ok(!tables.includes('weekly_likes'), `weekly_likes 应该已经被删掉，实际表：${tables.join(',')}`);
});

test('静态资源与目录穿越防护', async () => {
  const home = await call('/', { raw: true });
  assert.equal(home.status, 200);
  assert.match(home.text, /金拇指/);

  const adminPage = await call('/admin.html', { raw: true });
  assert.equal(adminPage.status, 200);

  const shared = await call('/shared/constants.js', { raw: true });
  assert.match(shared.text, /WEEKLY_LIKE_CAP/);

  const { port } = app.server.address();
  const rawResponse = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('GET /shared/../server/lib/config.js HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.ok(!rawResponse.includes('loadConfig'), '不能读到 shared 目录之外的文件');
});

test('没有 token 时访问账号接口返回 401，且不再有游客接口', async () => {
  const res = await call('/api/accounts');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');

  const guest = await call('/api/auth/guest', { method: 'POST' });
  assert.equal(guest.status, 404, '游客接口已经移除');
});

test('未登录时 /api/auth/me 返回 user: null', async () => {
  const me = await call('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user, null);
  assert.equal(me.json.data.loggedIn, false);
});

test('注册 / 登录 / 重复注册 / 空账号密码', async () => {
  const user = await newUser('laoban');
  state.owner = user;
  assert.equal(user.user.username.startsWith('laoban'), true);
  assert.equal(user.user.isAdmin, false);

  const me = await call('/api/auth/me', { token: user.token });
  assert.equal(me.json.data.user.id, user.user.id);
  assert.equal(me.json.data.loggedIn, true);

  const duplicate = await call('/api/auth/register', {
    method: 'POST',
    body: { username: user.username, password: 'x' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'USERNAME_TAKEN');

  const empty = await call('/api/auth/register', { method: 'POST', body: { username: '  ', password: 'x' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'INVALID_CREDENTIALS');

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: user.username, password: 'pw123456' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.data.user.id, user.user.id);

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: { username: user.username, password: 'nope' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'BAD_CREDENTIALS');
});

test('登录用户添加账号：入云端数据库，字段完整', async () => {
  const created = await call('/api/accounts', {
    method: 'POST',
    token: state.owner.token,
    body: { nickname: '云端玩家甲', region: 'wechat', lastWeekLikes: 1000 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const account = created.json.data.account;
  assert.match(account.roleId, /^\d{10}$/);
  assert.equal(account.nickname, '云端玩家甲');
  assert.equal(account.baseline, 1000);
  assert.equal(account.hasData, true);
  // 档案只保留「不会过期」的字段 + 头像（段位/印记/K-D/注册时间已不再抓取）
  assert.ok(account.profile, '接口A 带回的档案要保留');
  assert.equal(account.profile.highestDivName !== undefined, true, '最高段位要保留');
  assert.equal(account.profile.currentDivName, undefined, '当前段位不再抓取');
  assert.equal(typeof account.profile.avatar, 'string', '头像要抓回来（卡片上要显示）');
  assert.equal(account.profile.registerTime, undefined, '注册时间不再抓取');
  assert.equal(account.weekLikes, Math.max(0, account.currentLikes - 1000));

  state.roleId = account.roleId;
  assert.ok(app.repo.roles.getRole(account.roleId), '登录用户的账号要真的落库');
});

test('同一用户重复添加同一个角色会被拒绝', async () => {
  const again = await call('/api/accounts', {
    method: 'POST',
    token: state.owner.token,
    body: { nickname: '云端玩家甲', region: 'wechat', lastWeekLikes: 1000 },
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'DUPLICATE_ACCOUNT');
  assert.equal(again.json.error.details.mine, true);
});

test('用户之间互相隔离', async () => {
  const stranger = await newUser('stranger');

  const list = await call('/api/accounts', { token: stranger.token });
  assert.equal(list.json.data.accounts.length, 0);

  for (const [method, path, body] of [
    ['POST', `/api/accounts/${state.roleId}/refresh`, undefined],
    ['PATCH', `/api/accounts/${state.roleId}`, { lastWeekLikes: 1 }],
    ['DELETE', `/api/accounts/${state.roleId}`, undefined],
  ]) {
    const res = await call(path, { method, token: stranger.token, body });
    assert.equal(res.status, 404, `${method} ${path} 应该看不到别人的账号`);
  }

  const duplicate = await call('/api/accounts', {
    method: 'POST',
    token: stranger.token,
    body: { nickname: '云端玩家甲', region: 'wechat', lastWeekLikes: 10 },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.details.mine, false);
  assert.equal(duplicate.json.error.details.existing, null, '不能把别人的账号信息泄露出去');
});

test('跨设备登录：换一个身份登录后能看到同样的账号（云端同步）', async () => {
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: state.owner.username, password: 'pw123456' },
  });
  const list = await call('/api/accounts', { token: login.json.data.token });
  assert.equal(list.json.data.accounts.length, 1);
  assert.equal(list.json.data.accounts[0].roleId, state.roleId);
  state.ownerSecondToken = login.json.data.token;
});

test('刷新 / 改基线 / 删除', async () => {
  const { token } = state.owner;

  const one = await call(`/api/accounts/${state.roleId}/refresh`, { method: 'POST', token });
  assert.equal(one.status, 200);
  assert.equal(one.json.data.warning, null);

  const all = await call('/api/accounts/refresh', { method: 'POST', token });
  assert.equal(all.json.data.total, 1);
  assert.equal(all.json.data.failed, 0);

  const fixed = await call(`/api/accounts/${state.roleId}`, {
    method: 'PATCH',
    token,
    body: { lastWeekLikes: 0 },
  });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.data.account.baseline, 0);
  assert.ok(fixed.json.data.account.weekLikes > 0);

  const invalid = await call(`/api/accounts/${state.roleId}`, {
    method: 'PATCH',
    token,
    body: { lastWeekLikes: -1 },
  });
  assert.equal(invalid.status, 400);
});

test('注册后把本地模式的账号搬上云（/api/accounts/import）', async () => {
  // 先以“未登录”身份在本地模式加两个账号
  const localA = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地搬云端甲', region: 'qq', lastWeekLikes: 800 },
  });
  const localB = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地搬云端乙', region: 'wechat', lastWeekLikes: 300 },
  });
  assert.equal(localA.status, 201);
  assert.equal(localB.status, 201);

  const locals = [localA.json.data.account, localB.json.data.account];
  const before = app.repo.roles.countRoles();

  const fresh = await newUser('mover');
  const imported = await call('/api/accounts/import', {
    method: 'POST',
    token: fresh.token,
    body: { accounts: locals },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.data.imported, 2);
  assert.equal(imported.json.data.skipped, 0);
  assert.equal(app.repo.roles.countRoles(), before + 2);

  const list = await call('/api/accounts', { token: fresh.token });
  assert.equal(list.json.data.accounts.length, 2);
  // 基线要原样保留，而不是被重置
  const moved = list.json.data.accounts.find((item) => item.nickname === '本地搬云端甲');
  assert.equal(moved.baseline, 800);

  // 再导一次：已经在库里了，应该跳过而不是报错
  const again = await call('/api/accounts/import', {
    method: 'POST',
    token: fresh.token,
    body: { accounts: locals },
  });
  assert.equal(again.json.data.imported, 0);
  assert.equal(again.json.data.skipped, 2);
  assert.equal(again.json.data.skippedDetail[0].reason, 'ALREADY_EXISTS');
});

test('退出登录后原 token 失效', async () => {
  const user = await newUser('bye');
  const out = await call('/api/auth/logout', { method: 'POST', token: user.token });
  assert.equal(out.status, 200);

  const me = await call('/api/auth/me', { token: user.token });
  assert.equal(me.json.data.user, null);

  const list = await call('/api/accounts', { token: user.token });
  assert.equal(list.status, 401);
});

test('每周结算：周一 00:00:01 触发后基线推进、来源是 cron、不再有点赞记录表', async () => {
  const adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'rootadmin', password: 'rootpass123' },
  });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
  const adminToken = adminLogin.json.data.token;

  const roleBefore = app.repo.roles.getRole(state.roleId);
  const likesBefore = roleBefore.currentLikes;

  const { getWeekStart, zonedTimeToTimestamp } = await import('../shared/week.js');
  const nextWeek = getWeekStart(new Date(Date.now() + 7 * 86400000), TZ);
  const at = new Date(zonedTimeToTimestamp(nextWeek.year, nextWeek.month, nextWeek.day, 0, 0, 1, TZ));

  const settled = await call('/api/admin/jobs/weekly-settle', {
    method: 'POST',
    token: adminToken,
    body: { at: at.toISOString(), refresh: true },
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.json));
  assert.equal(settled.json.data.withinGrace, true);
  assert.equal(settled.json.data.week.key, nextWeek.key);

  const roleAfter = app.repo.roles.getRole(state.roleId);
  assert.equal(roleAfter.baselineWeekKey, nextWeek.key);
  assert.equal(roleAfter.baselineSource, 'cron');
  assert.equal(roleAfter.baseline, likesBefore, '新基线 = 结算时查到的上周最终点赞数');
});

test('数据落库：重新打开同一个数据库数据还在', async () => {
  const { openDatabase } = await import('../server/lib/db.js');
  const { createRepo } = await import('../server/lib/repo.js');
  const db = openDatabase({ file: dbFile });
  const repo = createRepo(db);
  const role = repo.roles.getRole(state.roleId);
  assert.ok(role, '重新打开数据库应该还能读到角色');
  assert.equal(role.userId, state.owner.user.id);
  db.close();
});
