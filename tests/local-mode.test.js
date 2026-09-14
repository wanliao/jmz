/**
 * 本地模式（未登录 / 游客）测试。
 *
 * 核心要求：游客添加的游戏账号**不入库**、后台看不到，只存浏览器；
 * 服务端只借用接口 A/B 帮忙换算，不留下任何数据。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createApp } from '../server/index.js';
import { getWeekStart, zonedTimeToTimestamp } from '../shared/week.js';

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

before(async () => {
  dbFile = path.join(
    os.tmpdir(),
    `kimuzhi-local-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
});

after(async () => {
  app?.scheduler?.stop();
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  app?.db?.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbFile}${suffix}`, { force: true });
  }
});

test('本地模式默认开启，并写进 /api/config', async () => {
  const config = await call('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.data.allowLocalMode, true);
});

test('本地添加账号：返回 roleId 与算命好的「本周已刷」，但数据库里一条都没有', async () => {
  const before = app.repo.roles.countRoles();
  const created = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地玩家甲', region: 'qq', lastWeekLikes: 1000 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const account = created.json.data.account;
  assert.match(account.roleId, /^\d{10}$/);
  assert.equal(account.region, 'qq');
  assert.equal(account.baseline, 1000);
  assert.equal(account.hasData, true);
  assert.equal(account.weekLikes, Math.max(0, account.currentLikes - 1000));
  assert.ok(account.profile?.highestDivName, 'Mock 也应带回账号档案（最高段位）');

  // ★ 关键：库里什么都没留下
  assert.equal(app.repo.roles.countRoles(), before, '本地模式不能往数据库写角色');
  assert.equal(app.repo.users.countUsers(), 1, '只有管理员一个用户，不产生游客');
});

test('本地刷新：返回更新后的对象，依然不入库', async () => {
  const created = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地玩家乙', region: 'wechat', lastWeekLikes: 500 },
  });
  const account = created.json.data.account;
  const before = app.repo.roles.countRoles();

  const synced = await call('/api/local/sync', { method: 'POST', body: { accounts: [account] } });
  assert.equal(synced.status, 200);
  assert.equal(synced.json.data.total, 1);
  assert.equal(synced.json.data.failed, 0);
  assert.equal(synced.json.data.accounts.length, 1);
  assert.equal(synced.json.data.accounts[0].roleId, account.roleId);
  assert.equal(synced.json.data.accounts[0].hasData, true);
  assert.equal(app.repo.roles.countRoles(), before, '刷新也不能写库');
});

test('本地改基线', async () => {
  const created = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地玩家丙', region: 'qq', lastWeekLikes: 0 },
  });
  const account = created.json.data.account;
  const target = Math.max(0, (account.currentLikes ?? 0) - 88);

  const res = await call('/api/local/baseline', {
    method: 'POST',
    body: { account, lastWeekLikes: target },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.account.baseline, target);
  assert.equal(res.json.data.account.weekLikes, 88);
  assert.equal(res.json.data.account.baselineSource, 'manual');
  assert.equal(app.repo.roles.countRoles(), 0);
});

test('本地 settle 只做跨周结算，不查接口；跨周用刷新前的快照当新基线', async () => {
  const created = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '本地玩家丁', region: 'qq', lastWeekLikes: 1000 },
  });
  const account = created.json.data.account;
  const likesNow = account.currentLikes;

  // 当前周内 settle：什么都不变
  const sameWeek = await app.local.settleOnly({ accounts: [account] }, new Date());
  assert.equal(sameWeek.accounts[0].baseline, 1000);
  assert.equal(sameWeek.accounts[0].weekLikes, Math.max(0, likesNow - 1000));

  // 把时钟拨到下周一 00:00:01 → 新基线应该取「刷新前记录的点赞数」
  const week = getWeekStart(new Date(), TZ);
  const nextWeek = getWeekStart(new Date(week.startMs + 8 * 86400000), TZ);
  const at = new Date(zonedTimeToTimestamp(nextWeek.year, nextWeek.month, nextWeek.day, 0, 0, 1, TZ));

  const settled = await app.local.settleOnly({ accounts: [account] }, at);
  const after = settled.accounts[0];
  assert.equal(after.baselineWeekKey, nextWeek.key);
  assert.equal(after.baseline, likesNow, '新基线 = 上周最后一次记录到的点赞数');
  assert.equal(after.weekLikes, 0, '新的一周从 0 开始');
  assert.equal(app.repo.roles.countRoles(), 0);
});

test('本地接口的参数校验与脏数据过滤', async () => {
  const badRegion = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '某人', region: 'weibo', lastWeekLikes: 1 },
  });
  assert.equal(badRegion.status, 400);
  assert.equal(badRegion.json.error.code, 'INVALID_REGION');

  const badBaseline = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '某人', region: 'qq', lastWeekLikes: -1 },
  });
  assert.equal(badBaseline.status, 400);
  assert.equal(badBaseline.json.error.code, 'INVALID_BASELINE');

  const emptyName = await call('/api/local/add', {
    method: 'POST',
    body: { nickname: '   ', region: 'qq', lastWeekLikes: 1 },
  });
  assert.equal(emptyName.status, 400);

  // 脏数据（roleId 不是数字）会被丢掉，而不是报错
  const dirty = await call('/api/local/sync', {
    method: 'POST',
    body: { accounts: [{ roleId: 'abc', region: 'qq' }, { roleId: '1234567890', region: 'qq', baseline: 1 }] },
  });
  assert.equal(dirty.status, 200);
  assert.equal(dirty.json.data.total, 1);
  assert.equal(dirty.json.data.dropped, 1);
});

test('服务端可以关掉本地模式（ALLOW_LOCAL_MODE=0）', async () => {
  const dbFile2 = path.join(os.tmpdir(), `kimuzhi-local-off-${Date.now()}.db`);
  const app2 = await createApp({
    env: {
      ADAPTER: 'mock',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_FILE: dbFile2,
      DATA_FILE: path.join(os.tmpdir(), 'kimuzhi-nonexistent-legacy.json'),
      ALLOW_LOCAL_MODE: '0',
      ADMIN_USERNAME: 'rootadmin',
      ADMIN_PASSWORD: 'rootpass123',
    },
  });
  await new Promise((resolve) => app2.server.listen(0, '127.0.0.1', resolve));
  const port = app2.server.address().port;

  const config = await fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.json());
  assert.equal(config.data.allowLocalMode, false);

  const res = await fetch(`http://127.0.0.1:${port}/api/local/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'x', region: 'qq', lastWeekLikes: 1 }),
  });
  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.error.code, 'LOCAL_MODE_DISABLED');

  app2.scheduler.stop();
  await new Promise((resolve) => app2.server.close(resolve));
  app2.db.close();
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${dbFile2}${suffix}`, { force: true });
});
