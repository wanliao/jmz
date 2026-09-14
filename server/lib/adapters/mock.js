/**
 * Mock 适配器 —— 没有真实接口（或想演示）时用它把整个流程跑通。
 *
 * 需求文档第四节的要求：
 *  1. 同一个「昵称 + 大区」永远返回同一个 roleId；
 *  2. 点赞数基于 roleId 生成一个稳定基数，并随本周时间推进而增长；
 *  3. 跨周后重置，方便验证周结算逻辑。
 *
 * 另外提供 MOCK_SPEED 时间加速：默认 1 倍（真实速度），
 * 设成 200 就能在约 50 分钟内走完一整周，用来验证「周一 05:00 结算」。
 *
 * 返回结构与真实适配器保持一致：resolveRoleId 也带回点赞数与账号档案，
 * 这样前端在 mock 模式下也能看到和真实接口一样的卡片效果。
 */

import { createHash } from 'node:crypto';

import { getWeekStart, weekKeyToWeek } from '../../../shared/week.js';

const DIVISIONS = [
  '热血青铜Ⅴ',
  '不屈白银Ⅲ',
  '英勇黄金Ⅱ',
  '坚韧铂金Ⅳ',
  '荣耀皇冠Ⅴ',
  '超级王牌1星',
  '传奇王牌19星',
  '绝世王牌16星',
  '无敌战神',
];

function hash32(text) {
  const digest = createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0);
}

/** 稳定的 10 位 roleId（游戏里不显示的隐藏 ID） */
function roleIdFor(nickname, region) {
  const hash = createHash('sha256').update(`${nickname}\u0000${region}`).digest('hex');
  const big = BigInt(`0x${hash.slice(0, 15)}`);
  return String(1_000_000_000n + (big % 8_000_000_000n));
}

export function createMockAdapter({ config, timeZone = config.timeZone, now = () => new Date() } = {}) {
  const speed = Math.max(0, Number(config?.mock?.speed ?? 1)) || 1;
  const epochWeek = weekKeyToWeek(config?.mock?.epochKey ?? '2024-01-01', timeZone);

  if (!epochWeek) {
    throw new Error(`mock.epochKey 不是合法的周标识：${config?.mock?.epochKey}`);
  }

  /** 该角色每周大致能刷多少（250~350） */
  function weeklyGain(roleId) {
    return 250 + (hash32(`${roleId}:gain`) % 101);
  }

  /** 刷满一周需要的时间比例（0.35~1.0）：越小刷得越快 */
  function fillPace(roleId) {
    return 0.35 + (hash32(`${roleId}:pace`) % 66) / 100;
  }

  /** 当前总点赞（随本周时间增长、跨周累加、跨周重置本周增量） */
  function currentLikes(roleId) {
    const id = String(roleId);
    const base = 1200 + (hash32(`${id}:base`) % 4801); // 1200 ~ 6000

    const realNow = now();
    const realWeek = getWeekStart(realNow, timeZone);
    const accelerated = realWeek.startMs + (realNow.getTime() - realWeek.startMs) * speed;
    const effectiveNow = new Date(accelerated);
    const week = getWeekStart(effectiveNow, timeZone);

    const elapsedWeeks = Math.max(
      0,
      Math.round((week.startMs - epochWeek.startMs) / (7 * 24 * 60 * 60 * 1000)),
    );
    const gain = weeklyGain(id);

    const elapsed = Math.max(0, effectiveNow.getTime() - week.startMs);
    const weekMs = week.endMs - week.startMs;
    const fraction = weekMs > 0 ? Math.min(1, elapsed / weekMs) : 1;
    const pace = fillPace(id);
    const thisWeek = Math.min(gain, Math.floor(Math.min(1, fraction / pace) * gain));

    return {
      likes: base + elapsedWeeks * gain + thisWeek,
      weekKey: week.key,
      elapsedWeeks,
      weeklyGain: gain,
    };
  }

  /** 假档案：字段和真实接口保持一致（头像/段位/印记等会变的字段不再抓） */
  function profileFor(nickname, roleId) {
    const hash = hash32(`${roleId}:profile`);
    return {
      // 演示用头像：和真实接口一样只给一个 URL，加载失败时前端会退回首字母
      avatar: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(roleId)}`,
      roleName: nickname,
      campNickname: `营地${100000 + (hash % 899999)}`,
      uinType: 'QQ区',
      highestDivName: DIVISIONS[Math.min(DIVISIONS.length - 1, hash % DIVISIONS.length)],
      location: '演示省',
      city: '演示市',
    };
  }

  return {
    name: 'mock',

    async resolveRoleId({ nickname, region }) {
      const trimmed = String(nickname ?? '').trim();
      if (!trimmed) {
        const error = new Error('游戏昵称不能为空');
        error.code = 'INVALID_NICKNAME';
        error.status = 400;
        throw error;
      }
      // 约定：昵称以 ! 开头模拟「查不到该角色」，方便验证前端错误提示
      if (trimmed.startsWith('!')) {
        const error = new Error(`没有找到角色「${trimmed.slice(1)}」，请确认昵称和大区与游戏里完全一致`);
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }

      const roleId = roleIdFor(trimmed, region);
      return {
        roleId,
        likes: currentLikes(roleId).likes,
        profile: profileFor(trimmed, roleId),
        raw: { mock: true, nickname: trimmed, region },
      };
    },

    async fetchLikes({ roleId }) {
      const id = String(roleId);
      const result = currentLikes(id);
      return {
        likes: result.likes,
        raw: {
          mock: true,
          roleId: id,
          weekKey: result.weekKey,
          elapsedWeeks: result.elapsedWeeks,
          weeklyGain: result.weeklyGain,
        },
      };
    },
  };
}
