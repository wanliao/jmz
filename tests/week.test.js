/**
 * 游戏周边界单元测试。
 * 规则：游戏周从「周一 00:00:01」开始，周一 00:00:00 仍算上一周。
 * 全部用带时区偏移的 ISO 字符串，避免受运行机器的本地时区影响。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WEEK_MS } from '../shared/constants.js';
import {
  getWeekKey,
  getWeekStart,
  isSameWeek,
  msUntilNextWeek,
  weekKeyToWeek,
  weeksBetweenKeys,
  zonedTimeToTimestamp,
} from '../shared/week.js';

const TZ = 'Asia/Shanghai';

test('周一 00:00:00 仍属于上一周', () => {
  assert.equal(getWeekKey('2025-06-09T00:00:00+08:00', TZ), '2025-06-02');
});

test('周一 00:00:01 才开始新的一周', () => {
  assert.equal(getWeekKey('2025-06-09T00:00:01+08:00', TZ), '2025-06-09');
});

test('周一 00:00:00.999 属于上一周，00:00:01.000 属于新一周', () => {
  const before = new Date('2025-06-09T00:00:00.999+08:00');
  const after = new Date('2025-06-09T00:00:01.000+08:00');
  assert.equal(getWeekKey(before, TZ), '2025-06-02');
  assert.equal(getWeekKey(after, TZ), '2025-06-09');
  // 两个瞬间只差 1 毫秒，却分属相邻两周
  assert.equal(after.getTime() - before.getTime(), 1);
});

test('周一凌晨之后的任何时刻都属于新一周（原来的 05:00 不再是边界）', () => {
  assert.equal(getWeekKey('2025-06-09T00:30:00+08:00', TZ), '2025-06-09');
  assert.equal(getWeekKey('2025-06-09T04:59:59+08:00', TZ), '2025-06-09');
  assert.equal(getWeekKey('2025-06-09T05:00:00+08:00', TZ), '2025-06-09');
});

test('周日 23:59 属于本周（周一 00:00:01 起算的那一周）', () => {
  assert.equal(getWeekKey('2025-06-08T23:59:00+08:00', TZ), '2025-06-02');
});

test('边界连续性：2025-06-09 00:00:00 与 00:00:01 分属相邻两周', () => {
  const before = getWeekStart('2025-06-09T00:00:00+08:00', TZ);
  const after = getWeekStart('2025-06-09T00:00:01+08:00', TZ);
  assert.equal(before.key, '2025-06-02');
  assert.equal(after.key, '2025-06-09');
  assert.equal(after.startMs - before.startMs, WEEK_MS);
});

test('一周之内 key 保持不变、起止时间相差正好 7 天', () => {
  const week = getWeekStart('2025-06-11T12:00:00+08:00', TZ);
  assert.equal(week.key, '2025-06-09');
  assert.equal(week.endMs - week.startMs, WEEK_MS);
  assert.equal(getWeekKey('2025-06-09T00:00:01+08:00', TZ), '2025-06-09');
  assert.equal(getWeekKey('2025-06-15T23:00:00+08:00', TZ), '2025-06-09');
  assert.equal(getWeekStart(week.startMs, TZ).key, '2025-06-09');
});

test('起点时刻本身（周一 00:00:01.000）落在新一周，往前 1 毫秒是上一周', () => {
  const week = getWeekStart('2025-06-09T00:00:01+08:00', TZ);
  assert.equal(getWeekStart(week.startMs, TZ).key, week.key);
  assert.equal(getWeekStart(week.startMs - 1, TZ).key, '2025-06-02');
});

test('时区参数生效：同一瞬间在 UTC 下归属不同的游戏周', () => {
  const instant = '2025-06-08T16:00:01Z'; // = 2025-06-09 00:00:01 +08:00
  assert.equal(getWeekKey(instant, TZ), '2025-06-09');
  assert.equal(getWeekKey(instant, 'UTC'), '2025-06-02');
});

test('isSameWeek / msUntilNextWeek', () => {
  assert.equal(isSameWeek('2025-06-09T00:00:01+08:00', '2025-06-15T23:00:00+08:00', TZ), true);
  assert.equal(isSameWeek('2025-06-15T23:00:00+08:00', '2025-06-16T00:00:01+08:00', TZ), false);

  // 周五 00:00:01 距离下周一 00:00:01 正好 3 天
  const { ms, week } = msUntilNextWeek('2025-06-13T00:00:01+08:00', TZ);
  assert.equal(week.key, '2025-06-09');
  assert.equal(ms, 3 * 24 * 60 * 60 * 1000);
  assert.equal(ms, week.endMs - new Date('2025-06-13T00:00:01+08:00').getTime());
});

test('weekKeyToWeek 与 zonedTimeToTimestamp 自洽', () => {
  const week = weekKeyToWeek('2025-06-09', TZ);
  assert.ok(week);
  const expected = zonedTimeToTimestamp(2025, 6, 9, 0, 0, 1, TZ);
  assert.equal(week.startMs, expected);
  assert.equal(new Date(week.startMs).toISOString(), '2025-06-08T16:00:01.000Z');
  assert.equal(weekKeyToWeek('不是周标识', TZ), null);
});

test('weeksBetweenKeys 计算跨了几周', () => {
  assert.equal(weeksBetweenKeys('2025-06-09', '2025-06-16', TZ), 1);
  assert.equal(weeksBetweenKeys('2025-06-09', '2025-06-09', TZ), 0);
  assert.equal(weeksBetweenKeys('2025-06-09', '2025-07-07', TZ), 4);
  assert.equal(weeksBetweenKeys('2025-06-16', '2025-06-09', TZ), -1);
  // 跨夏令时地区也应该是整数周（用欧洲时区做一次健壮性检查）
  assert.equal(weeksBetweenKeys('2025-03-24', '2025-03-31', 'Europe/Berlin'), 1);
});
