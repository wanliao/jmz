/**
 * 跨周结算 / 基线推进单元测试（需求 6.3、6.4）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WEEKLY_LIKE_CAP } from '../shared/constants.js';
import { BASELINE_SOURCE, buildAccountView, normalizeLikes, settleAccount } from '../server/lib/settlement.js';

const TZ = 'Asia/Shanghai';
const WEEK_A = '2025-06-09'; // 周一 05:00 (+08:00) 起
const WEEK_B = '2025-06-16';

function makeAccount(overrides = {}) {
  return {
    roleId: '1000000001',
    nickname: '测试玩家',
    region: 'wechat',
    createdAt: '2025-06-09T05:10:00.000Z',
    updatedAt: '2025-06-09T05:10:00.000Z',
    baseline: 1000,
    baselineWeekKey: WEEK_A,
    baselineSource: BASELINE_SOURCE.USER,
    baselineEstimated: false,
    baselineUpdatedAt: '2025-06-09T05:10:00.000Z',
    currentLikes: 1000,
    lastQueriedAt: '2025-06-09T05:10:00.000Z',
    lastSnapshot: { likes: 1000, at: '2025-06-09T05:10:00.000Z', weekKey: WEEK_A },
    lastError: null,
    ...overrides,
  };
}

const view = (account, when) =>
  buildAccountView(account, new Date(when), { timeZone: TZ, weeklyCap: WEEKLY_LIKE_CAP });

test('同一周内不结算，基线保持不变', () => {
  const account = makeAccount();
  const result = settleAccount(account, new Date('2025-06-12T20:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'same-week');
  assert.equal(account.baseline, 1000);
});

test('需求 6.3：跨周时新基线取「刷新之前」的点赞数，而不是刚查到的最新值', () => {
  // 上周（WEEK_A）最后一次查询到 1300
  const account = makeAccount({
    baseline: 1000,
    currentLikes: 1300,
    lastSnapshot: { likes: 1300, at: '2025-06-15T23:00:00+08:00', weekKey: WEEK_A },
  });

  // 进入新的一周后，第一步必须先结算
  const result = settleAccount(account, new Date(`${WEEK_B}T05:30:00+08:00`), { timeZone: TZ });
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'weekly-rollover');
  assert.equal(account.baseline, 1300, '新基线必须是上周结束时的快照值');
  assert.equal(account.baselineSource, BASELINE_SOURCE.SETTLED);
  assert.equal(account.baselineEstimated, false);

  // 第二步才去查最新点赞（本周已经刷了 10 个）
  account.currentLikes = 1310;
  account.lastSnapshot = { likes: 1310, at: `${WEEK_B}T05:31:00+08:00`, weekKey: WEEK_B };

  const built = view(account, `${WEEK_B}T05:31:00+08:00`);
  assert.equal(built.weekLikes, 10);
  assert.equal(built.remaining, WEEKLY_LIKE_CAP - 10);
});

test('反例：如果先刷新再结算（顺序写反），本周已刷会被算成 0', () => {
  const account = makeAccount({
    baseline: 1000,
    currentLikes: 1300,
    lastSnapshot: { likes: 1300, at: '2025-06-15T23:00:00+08:00', weekKey: WEEK_A },
  });

  // 错误顺序：先查到了本周的 1310，并且把快照覆盖成本周的值
  account.currentLikes = 1310;
  account.lastSnapshot = { likes: 1310, at: `${WEEK_B}T05:31:00+08:00`, weekKey: WEEK_B };
  settleAccount(account, new Date(`${WEEK_B}T05:31:00+08:00`), { timeZone: TZ });

  assert.equal(account.baseline, 1310, '错误顺序会把本周新刷的点赞算进基线');
  assert.equal(view(account, `${WEEK_B}T05:31:00+08:00`).weekLikes, 0, '结果偏小，这正是 6.3 要避免的');
});

test('周边界：周一 00:00:00 不结算，00:00:01 才结算', () => {
  const early = makeAccount({ lastSnapshot: { likes: 1300, at: 'x', weekKey: WEEK_A } });
  const earlyResult = settleAccount(early, new Date(`${WEEK_B}T00:00:00+08:00`), { timeZone: TZ });
  assert.equal(earlyResult.changed, false);
  assert.equal(early.baseline, 1000);

  const onTime = makeAccount({ lastSnapshot: { likes: 1300, at: 'x', weekKey: WEEK_A } });
  const onTimeResult = settleAccount(onTime, new Date(`${WEEK_B}T00:00:01+08:00`), { timeZone: TZ });
  assert.equal(onTimeResult.changed, true);
  assert.equal(onTime.baseline, 1300);
});

test('隔了好几周没打开：用最近一次快照作为新基线，并标记为估算', () => {
  const account = makeAccount({
    baseline: 900,
    currentLikes: 1300,
    lastSnapshot: { likes: 1300, at: '2025-06-14T10:00:00+08:00', weekKey: WEEK_A },
  });
  const result = settleAccount(account, new Date('2025-06-30T09:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.changed, true);
  assert.equal(result.detail.weeks, 3);
  assert.equal(account.baseline, 1300);
  assert.equal(account.baselineWeekKey, '2025-06-30');
  assert.equal(account.baselineEstimated, true, '不是紧邻上一周的快照，只能算估算');

  const built = view(account, '2025-06-30T09:00:00+08:00');
  assert.equal(built.weekLikes, 0);
  assert.equal(built.weeksSinceQuery, 3);
});

test('没有任何快照可参考时，沿用旧基线并标记估算', () => {
  const account = makeAccount({ currentLikes: null, lastSnapshot: null, baseline: 888 });
  const result = settleAccount(account, new Date(`${WEEK_B}T06:00:00+08:00`), { timeZone: TZ });
  assert.equal(result.changed, true);
  assert.equal(account.baseline, 888);
  assert.equal(account.baselineSource, BASELINE_SOURCE.CARRY);
  assert.equal(account.baselineEstimated, true);
});

test('需求 6.4：当前点赞 < 上周点赞时，已刷数不能是负数，并给出异常标记', () => {
  const account = makeAccount({ baseline: 5000, currentLikes: 1234 });
  const built = view(account, '2025-06-12T12:00:00+08:00');
  assert.equal(built.anomaly, true);
  assert.equal(built.weekLikes, 0, '不能显示负数');
  assert.equal(built.remaining, WEEKLY_LIKE_CAP);
  assert.equal(built.progress, 0);
});

test('刷满与超过上限的处理', () => {
  const full = view(makeAccount({ baseline: 1000, currentLikes: 1350 }), '2025-06-12T12:00:00+08:00');
  assert.equal(full.weekLikes, 350);
  assert.equal(full.full, true);
  assert.equal(full.remaining, 0);
  assert.equal(full.progress, 1);

  const over = view(makeAccount({ baseline: 1000, currentLikes: 1500 }), '2025-06-12T12:00:00+08:00');
  assert.equal(over.weekLikes, 500, '真实数字照实显示');
  assert.equal(over.full, true);
  assert.equal(over.progress, 1, '进度条封顶 100%');
  assert.equal(over.remaining, 0);
});

test('还没查到数据时不报异常，只标记 hasData=false', () => {
  const built = view(makeAccount({ currentLikes: null, lastQueriedAt: null }), '2025-06-12T12:00:00+08:00');
  assert.equal(built.hasData, false);
  assert.equal(built.anomaly, false);
  assert.equal(built.weekLikes, 0);
  assert.equal(built.currentLikes, null);
});

test('首次结算：缺 baselineWeekKey 时初始化为当前周', () => {
  const account = makeAccount({ baselineWeekKey: null, baselineSource: null });
  const result = settleAccount(account, new Date('2025-06-12T12:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'initialized');
  assert.equal(account.baselineWeekKey, WEEK_A);
});

test('基线里的周标识完全不是日期时，重新初始化到当前周', () => {
  const account = makeAccount({ baselineWeekKey: '不是日期' });
  const result = settleAccount(account, new Date('2025-06-12T12:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.reason, 'initialized');
  assert.equal(account.baselineWeekKey, WEEK_A);
});

test('基线里的周标识离谱（能过格式校验但不是真实周）时也不该抛错', () => {
  const account = makeAccount({ baselineWeekKey: '0000-01-01', currentLikes: 1300 });
  const result = settleAccount(account, new Date('2025-06-12T12:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.changed, true);
  assert.equal(account.baselineWeekKey, WEEK_A);
  assert.equal(account.baseline, 1300);
});

test('服务器时间被回拨时以当前周为准', () => {
  const account = makeAccount({ baselineWeekKey: '2025-07-07' });
  const result = settleAccount(account, new Date('2025-06-12T12:00:00+08:00'), { timeZone: TZ });
  assert.equal(result.reason, 'clock-backwards');
  assert.equal(account.baselineWeekKey, WEEK_A);
});

test('normalizeLikes 只接受非负数字', () => {
  assert.equal(normalizeLikes('123'), 123);
  assert.equal(normalizeLikes(12.9), 12);
  assert.equal(normalizeLikes(-1), null);
  assert.equal(normalizeLikes('abc'), null);
  assert.equal(normalizeLikes(null), null);
  assert.equal(normalizeLikes(''), null);
});
