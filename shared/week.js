/**
 * 游戏周计算 —— 整个产品的关键逻辑之一，务必看完再改。
 *
 * 规则：游戏周从「周一 00:00:01」开始。
 *   - 周一 00:00:00 仍然属于上一周（就这一秒）；
 *   - 周一 00:00:01 才开始新的一周。
 *
 * 时区：默认 Asia/Shanghai。服务器可能是 UTC，因此所有计算都显式指定时区，
 * 不依赖进程的 TZ，保证本地开发与线上服务器结果完全一致。
 */

import {
  DEFAULT_TIME_ZONE,
  WEEK_MS,
  WEEK_RESET_HOUR,
  WEEK_RESET_MINUTE,
  WEEK_RESET_SECOND,
  WEEK_RESET_SECONDS_OF_DAY,
  WEEK_RESET_WEEKDAY,
} from './constants.js';

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 把毫秒时间戳规整到 Date 实例（容忍 ISO 字符串 / 秒级时间戳） */
export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value.trim() !== '') return new Date(value);
  return new Date();
}

/** 取某个时刻在指定时区下的「墙上时间」各部分 */
export function getZonedParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const instant = toDate(date);
  const parts = formatterFor(timeZone).formatToParts(instant);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // 部分 ICU 版本会把 00:xx 输出成 24:xx
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/** 该时刻的时区偏移（毫秒）：墙上时间 - UTC 时间 */
export function getTimeZoneOffsetMs(date, timeZone = DEFAULT_TIME_ZONE) {
  const instant = toDate(date);
  const ms = instant.getTime();
  const flooredMs = ms - (((ms % 1000) + 1000) % 1000);
  const p = getZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - flooredMs;
}

/**
 * 墙上时间 -> 绝对时间戳。
 * 换算出错只会发生在夏令时切换的那一小时；Asia/Shanghai 无夏令时。
 * 这里仍然做两轮收敛，兼容任意时区。
 */
export function zonedTimeToTimestamp(
  year,
  month,
  day,
  hour,
  minute = 0,
  second = 0,
  timeZone = DEFAULT_TIME_ZONE,
) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = getTimeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  let timestamp = wallAsUtc - offset;
  offset = getTimeZoneOffsetMs(new Date(timestamp), timeZone);
  timestamp = wallAsUtc - offset;
  return timestamp;
}

/** 在「墙上日历」上加天数（与夏令时无关，纯日期运算） */
function addDaysToWall(year, month, day, days) {
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * 求某个时刻所属游戏周的起点。
 *
 * @returns {{
 *   key: string,        // 周标识，形如 "2025-06-09"（该周周一在基准时区的日期）
 *   startMs: number,    // 本周起点（周一 00:00:01）的绝对时间戳
 *   endMs: number,      // 下周起点（下周一 00:00:01）的绝对时间戳
 *   year: number, month: number, day: number,
 *   timeZone: string,
 * }}
 */
export function getWeekStart(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const p = getZonedParts(date, timeZone);

  // 距离「本周日历上的周一」有几天
  let daysBack = (p.weekday - WEEK_RESET_WEEKDAY + 7) % 7;
  // 关键边界：周一 00:00:00 仍算上一周（按「当天已过秒数」比较，支持任意重置时刻）
  const secondsOfDay = p.hour * 3600 + p.minute * 60 + p.second;
  if (p.weekday === WEEK_RESET_WEEKDAY && secondsOfDay < WEEK_RESET_SECONDS_OF_DAY) {
    daysBack = 7;
  }

  const monday = addDaysToWall(p.year, p.month, p.day, -daysBack);
  const nextMonday = addDaysToWall(monday.year, monday.month, monday.day, 7);

  const startMs = zonedTimeToTimestamp(
    monday.year,
    monday.month,
    monday.day,
    WEEK_RESET_HOUR,
    WEEK_RESET_MINUTE,
    WEEK_RESET_SECOND,
    timeZone,
  );
  const endMs = zonedTimeToTimestamp(
    nextMonday.year,
    nextMonday.month,
    nextMonday.day,
    WEEK_RESET_HOUR,
    WEEK_RESET_MINUTE,
    WEEK_RESET_SECOND,
    timeZone,
  );

  return {
    key: `${monday.year}-${pad2(monday.month)}-${pad2(monday.day)}`,
    startMs,
    endMs,
    year: monday.year,
    month: monday.month,
    day: monday.day,
    timeZone,
  };
}

/** 只要周标识 */
export function getWeekKey(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return getWeekStart(date, timeZone).key;
}

/** 两个时刻是否属于同一游戏周 */
export function isSameWeek(a, b, timeZone = DEFAULT_TIME_ZONE) {
  return getWeekKey(a, timeZone) === getWeekKey(b, timeZone);
}

/**
 * 距离下一次「周一 00:00:01 重置」还有多久。
 * @returns {{ ms: number, week: ReturnType<typeof getWeekStart> }}
 */
export function msUntilNextWeek(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const week = getWeekStart(date, timeZone);
  const ms = Math.max(0, week.endMs - toDate(date).getTime());
  return { ms, week };
}

/** 把周标识（"2025-06-09"）解析回该周起点信息；解析失败返回 null */
export function weekKeyToWeek(key, timeZone = DEFAULT_TIME_ZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startMs = zonedTimeToTimestamp(
    year,
    month,
    day,
    WEEK_RESET_HOUR,
    WEEK_RESET_MINUTE,
    WEEK_RESET_SECOND,
    timeZone,
  );
  const nextMonday = addDaysToWall(year, month, day, 7);
  return {
    key: `${year}-${pad2(month)}-${pad2(day)}`,
    startMs,
    endMs: zonedTimeToTimestamp(
      nextMonday.year,
      nextMonday.month,
      nextMonday.day,
      WEEK_RESET_HOUR,
      WEEK_RESET_MINUTE,
      WEEK_RESET_SECOND,
      timeZone,
    ),
    year,
    month,
    day,
    timeZone,
  };
}

/** 两个周标识之间相差几周（b - a） */
export function weeksBetweenKeys(a, b, timeZone = DEFAULT_TIME_ZONE) {
  const startA = weekKeyToWeek(a, timeZone);
  const startB = weekKeyToWeek(b, timeZone);
  if (!startA || !startB) return null;
  return Math.round((startB.startMs - startA.startMs) / WEEK_MS);
}

export { WEEK_MS };
