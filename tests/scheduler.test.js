/**
 * 定时任务（每周一 00:00:01 结算）测试。
 *
 * 之前的测试都是直接调接口触发结算，这一组测的是**真正的定时路径**：
 * 注入假时钟到 startScheduler，验证
 *   1. 周一 00:00:01 刚过 → 自动跑结算，把「上周最终点赞数」写成新基线；
 *   2. 同一周再 tick → 不重复结算；
 *   3. 没到周一（宽限窗口外）→ 不结算；
 *   4. 服务器停机错过窗口后再启动（同一周内）→ 补跑一次；
 *   5. 数据落库后，下一周的基线就是上一周记录下来的点赞数。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { createApp } from '../server/index.js';
import { startScheduler } from '../server/lib/jobs/weekly.js';
import { getWeekStart, zonedTimeToTimestamp } from '../shared/week.js';

const TZ = 'Asia/Shanghai';
let app;
let dbFile;
let baseUrl;
let clock; // 可控制的假时钟

/** 把某个时间点变成「该周周一 00:00:0X」 */
function weekStartAt(weekKey, secondsAfter = 2) {
  const base = getWeekStart(new Date(`${weekKey}T12:00:00+08:00`), TZ);
  return new Date(
    zonedTimeToTimestamp(base.year, base.month, base.day, 0, 0, secondsAfter, TZ),
  );
}

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
    `kimuzhi-sched-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

  // createApp 内部已经起了一个用真实时间的调度器，这里停掉，换成假时钟的
  app.scheduler.stop();
  clock = { now: new Date() };
  app.scheduler = startScheduler({
    service: app.service,
    config: app.config,
    logger: { log() {}, warn() {}, error() {} },
    now: () => clock.now,
  });
});

after(async () => {
  app?.scheduler?.stop();
  if (app?.server) await new Promise((resolve) => app.server.close(resolve));
  app?.db?.close?.();
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbFile}${suffix}`, { force: true });
  }
});

let userSeq = 0;
/** 造一个带账号的注册用户，返回 { token, roleId, userId } */
async function makeAccount(nickname) {
  userSeq += 1;
  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { username: `sched${Date.now().toString().slice(-5)}${userSeq}`, password: 'pw123456' },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const token = registered.json.data.token;
  const created = await call('/api/accounts', {
    method: 'POST',
    token,
    body: { nickname, region: 'qq', lastWeekLikes: 1000 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return {
    token,
    roleId: created.json.data.account.roleId,
    userId: registered.json.data.user.id,
  };
}

test('周一 00:00:02 的 tick 会自动结算并推进基线', async () => {
  const account = await makeAccount('定时任务测试甲');
  const before = app.repo.roles.getRole(account.roleId);
  const likesBefore = before.currentLikes;

  // 把时钟拨到「下一周的周一 00:00:02」
  const currentWeek = getWeekStart(new Date(), TZ);
  const nextWeek = getWeekStart(new Date(currentWeek.startMs + 8 * 86400000), TZ);
  clock.now = weekStartAt(nextWeek.key, 2);

  await app.scheduler.runNow();

  const role = app.repo.roles.getRole(account.roleId);
  assert.equal(role.baselineWeekKey, nextWeek.key, '基线要推进到新的一周');
  assert.equal(role.baselineSource, 'cron');
  assert.equal(role.baseline, likesBefore, '新基线 = 结算时查到的点赞数');

  assert.equal(app.repo.settings.get('lastCronWeekKey'), nextWeek.key);
  assert.equal(app.repo.settings.get('lastCronPrevWeekKey'), currentWeek.key);

  account.currentWeekKey = currentWeek.key;
  account.nextWeekKey = nextWeek.key;
  globalThis.__schedA = account;
});

test('同一周再 tick 不会重复结算（幂等）', async () => {
  const account = globalThis.__schedA;
  const before = app.repo.roles.getRole(account.roleId);

  clock.now = weekStartAt(account.nextWeekKey, 30); // 还是这一周，只是晚一点
  await app.scheduler.runNow();
  await app.scheduler.runNow();

  const after = app.repo.roles.getRole(account.roleId);
  assert.equal(after.baseline, before.baseline, '基线不该被再次改动');
  assert.equal(after.baselineWeekKey, before.baselineWeekKey);
  assert.equal(after.updatedAt, before.updatedAt, '不该重复写库');
  assert.equal(app.repo.settings.get('lastCronWeekKey'), account.nextWeekKey);
});

test('还没到周一（宽限窗口外）时不会结算', async () => {
  const account = await makeAccount('定时任务测试乙');
  const week = getWeekStart(new Date(), TZ);

  // 周二中午：离周起点已经远超 10 分钟宽限窗口
  clock.now = new Date(zonedTimeToTimestamp(week.year, week.month, week.day + 1, 12, 0, 0, TZ));
  app.repo.settings.set('lastCronWeekKey', '');

  const before = app.repo.roles.getRole(account.roleId);
  await app.scheduler.runNow();
  const after = app.repo.roles.getRole(account.roleId);

  assert.equal(after.baselineWeekKey, before.baselineWeekKey, '不该推进基线');
  assert.equal(after.baseline, before.baseline);
  assert.equal(app.repo.settings.get('lastCronWeekKey'), '', '没结算就不该打标记');
});

test('服务器停机错过窗口、同一周内重启后补跑一次', async () => {
  const account = await makeAccount('定时任务测试丙');
  const week = getWeekStart(new Date(), TZ);
  const likesBefore = app.repo.roles.getRole(account.roleId).currentLikes;

  // 模拟「上周一错过了」：把标记清掉，时钟放在本周一 00:05（宽限窗口 10 分钟内）
  app.repo.settings.set('lastCronWeekKey', '');
  clock.now = weekStartAt(week.key, 300);

  await app.scheduler.runNow();

  const after = app.repo.roles.getRole(account.roleId);
  assert.equal(app.repo.settings.get('lastCronWeekKey'), week.key);
  assert.equal(after.baseline, likesBefore, '补跑时要把基线设成结算时查到的点赞数');
  assert.equal(after.baselineWeekKey, week.key);
  assert.equal(after.baselineSource, 'cron');
});

test('结算后用户看到的「本周已刷」归零，且基线来源是 cron', async () => {
  // 用独立账号，避免被前面「时钟回拨」的用例影响
  const account = await makeAccount('定时任务测试丁');
  const currentWeek = getWeekStart(new Date(), TZ);
  const nextWeek = getWeekStart(new Date(currentWeek.startMs + 8 * 86400000), TZ);
  const likesBefore = app.repo.roles.getRole(account.roleId).currentLikes;

  clock.now = weekStartAt(nextWeek.key, 2);
  await app.scheduler.runNow();

  // HTTP 层用的是真实时钟（此时假时钟在未来），所以这里直接用同一个假时钟取视图
  const accounts = await app.service.listAccounts(account.userId, clock.now);
  const view = accounts.find((item) => item.roleId === account.roleId);
  assert.ok(view);
  assert.equal(view.baselineSource, 'cron');
  assert.equal(view.baseline, likesBefore);
  assert.equal(view.weekLikes, 0, '刚进入新的一周，本周已刷应该是 0');
  assert.equal(view.baselineWeekKey, nextWeek.key);
  assert.equal(view.full, false);

  globalThis.__schedD = account;
  globalThis.__schedRealWeek = getWeekStart(new Date(), TZ).key;
});

test('假时钟在未来时，接口层会用真实时钟把基线拉回当前周（时钟回拨保护）', async () => {
  const account = globalThis.__schedD;
  const list = await call('/api/accounts', { token: account.token });
  const view = list.json.data.accounts.find((item) => item.roleId === account.roleId);
  assert.ok(view);
  assert.equal(
    view.baselineWeekKey,
    globalThis.__schedRealWeek,
    '不该把基线停在未来那一周',
  );
});
