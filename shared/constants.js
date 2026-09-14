/**
 * 前后端共享常量。
 * 服务端用 ESM 直接 import；前端通过 /shared/constants.js 以 module 方式加载。
 */

/** 每周最多可获得的点赞数 */
export const WEEKLY_LIKE_CAP = 350;

/**
 * 游戏周从「周一 00:00:01」开始。
 * 注意：00:00:00 这一秒仍算上一周，00:00:01 起才是新的一周。
 */
export const WEEK_RESET_WEEKDAY = 1; // 1 = 周一（0 = 周日）
export const WEEK_RESET_HOUR = 0;
export const WEEK_RESET_MINUTE = 0;
export const WEEK_RESET_SECOND = 1;

/** 周一 00:00:01 对应的「当天已过秒数」，用于比较时间边界 */
export const WEEK_RESET_SECONDS_OF_DAY =
  WEEK_RESET_HOUR * 3600 + WEEK_RESET_MINUTE * 60 + WEEK_RESET_SECOND;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 大区：微信区 / QQ区 是两套完全独立的数据 */
export const REGIONS = [
  { id: 'wechat', label: '微信区', short: '微信', accent: '#07c160' },
  { id: 'qq', label: 'QQ区', short: 'QQ', accent: '#12b7f5' },
];

export const REGION_IDS = REGIONS.map((r) => r.id);

export function isRegionId(value) {
  return REGION_IDS.includes(value);
}

export function regionLabel(id) {
  const region = REGIONS.find((r) => r.id === id);
  return region ? region.label : String(id ?? '');
}

export function regionShort(id) {
  const region = REGIONS.find((r) => r.id === id);
  return region ? region.short : String(id ?? '');
}

export function regionAccent(id) {
  const region = REGIONS.find((r) => r.id === id);
  return region ? region.accent : '#8b93a7';
}

/** 昵称长度等基础校验规则（前后端共用） */
export const NICKNAME_MAX_LENGTH = 32;
export const LIKES_MAX_VALUE = 100_000_000;
