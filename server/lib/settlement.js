/**
 * 跨周结算引擎 —— 产品的核心逻辑，需求文档第三节 + 第六节。
 *
 * 三个必须守住的规则：
 *  1. 游戏周从周一 05:00 开始（周计算在 shared/week.js，已单测覆盖边界）；
 *  2. 跨周时，新基线取「刷新之前记录的点赞数」（上周结束时的快照），
 *     绝不能用刚查回来的最新值当基线 —— 否则本周新刷的点赞会被算进基线，结果偏小；
 *  3. 「当前点赞 < 上周点赞」时，已刷数不能是负数，要给出异常标记让用户手动改基线。
 */

import { WEEKLY_LIKE_CAP } from '../../shared/constants.js';
import { getWeekStart, weekKeyToWeek, weeksBetweenKeys } from '../../shared/week.js';

/** 基线是怎么来的 */
export const BASELINE_SOURCE = {
  USER: 'user', // 首次添加账号时用户手填
  MANUAL: 'manual', // 用户事后手动修正
  SETTLED: 'settled', // 跨周结算：取上一周最后一次快照
  SETTLED_CRON: 'cron', // 周一 05:00 定时任务：基线取上周结束时的值
  CARRY: 'carried', // 没有任何快照可用，只能沿用旧基线（并标记为估算）
};

const WEEK_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidWeekKey(key) {
  return typeof key === 'string' && WEEK_KEY_PATTERN.test(key);
}

function isFiniteLikes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeLikes(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * 求 `date` 所在周的前一周的周标识。
 * 用在每周一的结算任务：00:00:01 触发时，「上一周」就是刚刚结束的那一周。
 */
export function previousWeekKey(date = new Date(), timeZone) {
  const week = getWeekStart(date, timeZone);
  return getWeekStart(new Date(week.startMs - 1), timeZone).key;
}

/**
 * 求某个时刻所属游戏周的起点。
 * （内部实现放在 shared/week.js，这里只做 re-export，方便服务端统一从本文件引入）
 */
export { getWeekStart, weekKeyToWeek };

/**
 * 推进账号基线到 `now` 所在的游戏周。
 *
 * 直接在传入的 account 对象上原地修改（调用方负责落库）。
 * @returns {{ changed: boolean, reason: string, detail?: object }}
 */
export function settleAccount(account, now = new Date(), { timeZone } = {}) {
  const week = getWeekStart(now, timeZone);
  const currentKey = week.key;

  // 首次：用户手填的「上周点赞数」就是当前这一周的基线
  if (!isValidWeekKey(account.baselineWeekKey)) {
    account.baselineWeekKey = currentKey;
    account.baselineSource = account.baselineSource ?? BASELINE_SOURCE.USER;
    account.baselineUpdatedAt = account.baselineUpdatedAt ?? new Date(now).toISOString();
    return { changed: true, reason: 'initialized', detail: { weekKey: currentKey } };
  }

  if (account.baselineWeekKey === currentKey) {
    return { changed: false, reason: 'same-week' };
  }

  const weeks = weeksBetweenKeys(account.baselineWeekKey, currentKey, timeZone);

  if (weeks === null) {
    // 基线里的周标识是脏数据，直接重置到当前周，不让服务卡死
    account.baselineWeekKey = currentKey;
    account.baselineSource = BASELINE_SOURCE.CARRY;
    account.baselineEstimated = true;
    account.baselineUpdatedAt = new Date(now).toISOString();
    return { changed: true, reason: 'reset-invalid-baseline-key' };
  }

  if (weeks < 0) {
    // 服务器时间被回拨：以当前周为准，避免基线永远停在未来
    const from = account.baselineWeekKey;
    account.baselineWeekKey = currentKey;
    account.baselineUpdatedAt = new Date(now).toISOString();
    return { changed: true, reason: 'clock-backwards', detail: { from, to: currentKey } };
  }

  const fromKey = account.baselineWeekKey;
  const snapshot = account.lastSnapshot;

  let baseline;
  let source;
  let estimated = false;

  if (
    snapshot &&
    isFiniteLikes(snapshot.likes) &&
    isValidWeekKey(snapshot.weekKey) &&
    snapshot.weekKey !== currentKey &&
    (weeksBetweenKeys(snapshot.weekKey, currentKey, timeZone) ?? 0) > 0
  ) {
    // 规则 2：用「刷新之前记录的点赞数」= 上一周最后一次快照
    baseline = snapshot.likes;
    source = BASELINE_SOURCE.SETTLED;
    // 快照必须是「紧邻的上一周」才算精确；中间隔了好几周只能算估算
    estimated = weeksBetweenKeys(snapshot.weekKey, currentKey, timeZone) !== 1;
  } else if (isFiniteLikes(account.currentLikes)) {
    baseline = account.currentLikes;
    source = BASELINE_SOURCE.SETTLED;
    estimated = true;
  } else {
    baseline = isFiniteLikes(account.baseline) ? account.baseline : 0;
    source = BASELINE_SOURCE.CARRY;
    estimated = true;
  }

  account.baseline = baseline;
  account.baselineWeekKey = currentKey;
  account.baselineSource = source;
  account.baselineEstimated = estimated;
  account.baselineUpdatedAt = new Date(now).toISOString();
  account.baselineFromWeekKey = fromKey;

  return {
    changed: true,
    reason: 'weekly-rollover',
    detail: { from: fromKey, to: currentKey, weeks, baseline, source, estimated },
  };
}

/**
 * 组装给前端的账号视图：本周已刷、剩余、进度、异常标记。
 * 需求 6.4：当前点赞 < 上周点赞 时不显示负数，而是给出异常提示。
 */
export function buildAccountView(account, now = new Date(), options = {}) {
  const { timeZone, weeklyCap = WEEKLY_LIKE_CAP } = options;
  const week = getWeekStart(now, timeZone);

  const baseline = isFiniteLikes(account.baseline) ? account.baseline : 0;
  const currentLikes = isFiniteLikes(account.currentLikes) ? account.currentLikes : null;
  const rawWeekLikes = currentLikes === null ? 0 : currentLikes - baseline;
  const weekLikes = Math.max(0, rawWeekLikes);

  const anomaly = currentLikes !== null && currentLikes < baseline;
  const full = weekLikes >= weeklyCap;
  const progress = Math.min(1, weeklyCap > 0 ? weekLikes / weeklyCap : 0);

  const lastQueriedAt = account.lastQueriedAt ?? null;
  const weeksSinceQuery =
    lastQueriedAt && account.lastSnapshot?.weekKey
      ? Math.max(0, weeksBetweenKeys(account.lastSnapshot.weekKey, week.key, timeZone) ?? 0)
      : null;

  return {
    roleId: String(account.roleId),
    nickname: account.nickname ?? '',
    region: account.region ?? '',
    profile: account.profile ?? null,
    createdAt: account.createdAt ?? null,
    updatedAt: account.updatedAt ?? null,

    baseline,
    baselineWeekKey: account.baselineWeekKey ?? week.key,
    baselineSource: account.baselineSource ?? BASELINE_SOURCE.USER,
    baselineEstimated: Boolean(account.baselineEstimated),
    baselineUpdatedAt: account.baselineUpdatedAt ?? null,
    baselineFromWeekKey: account.baselineFromWeekKey ?? null,

    currentLikes,
    lastQueriedAt,
    lastSnapshot: account.lastSnapshot ?? null,
    lastError: account.lastError ?? null,

    weekKey: week.key,
    weeksSinceQuery,

    weekLikes,
    remaining: Math.max(0, weeklyCap - weekLikes),
    progress,
    weeklyCap,
    full,
    anomaly,
    // 没有任何一次成功查询时，前端要提示「先刷新一次」
    hasData: currentLikes !== null,
  };
}

export { normalizeLikes };
