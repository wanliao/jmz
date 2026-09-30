/**
 * 本地模式（未登录 / 游客）：账号只存在浏览器 localStorage 里，服务端一个字节都不存。
 *
 * 这里只提供**无状态**的换算接口：
 *   - 用接口 A 把「昵称 + 大区」换成 roleId（顺带拿到点赞数与账号档案）
 *   - 用接口 B 刷新点赞数
 *   - 复用同一套结算引擎（shared/week.js + settlement.js）算出「本周已刷」
 * 客户端拿着返回的对象存进 localStorage，下次请求再带回来。
 *
 * 这样既保证游客的数据不入库、后台看不到，又不会把接口密钥暴露到浏览器。
 */

import {
  LIKES_MAX_VALUE,
  NICKNAME_MAX_LENGTH,
  WEEKLY_LIKE_CAP,
  isRegionId,
} from '../../shared/constants.js';
import { getWeekStart } from '../../shared/week.js';
import { badRequest } from './errors.js';
import { BASELINE_SOURCE, buildAccountView, settleAccount } from './settlement.js';

const MAX_ACCOUNTS = 50;
const nowIso = (value = new Date()) => new Date(value).toISOString();

function errorInfo(error) {
  return {
    code: error?.code ?? 'ADAPTER_ERROR',
    message: error?.message ?? '接口调用失败',
    at: nowIso(),
  };
}

function toInteger(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

/** 只接受我们认识的字段，避免把客户端塞进来的杂物一路带着走 */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const roleId = String(raw.roleId ?? '').trim();
  if (!/^\d{1,20}$/.test(roleId)) return null;
  if (!isRegionId(raw.region)) return null;

  const baseline = toInteger(raw.baseline);
  const currentLikes = raw.currentLikes === null || raw.currentLikes === undefined ? null : toInteger(raw.currentLikes);
  const snapshot = raw.lastSnapshot && typeof raw.lastSnapshot === 'object'
    ? {
        likes: toInteger(raw.lastSnapshot.likes),
        weekKey: typeof raw.lastSnapshot.weekKey === 'string' ? raw.lastSnapshot.weekKey : null,
        at: typeof raw.lastSnapshot.at === 'string' ? raw.lastSnapshot.at : null,
      }
    : null;

  return {
    roleId,
    nickname: String(raw.nickname ?? '').slice(0, NICKNAME_MAX_LENGTH),
    region: raw.region,
    profile: raw.profile && typeof raw.profile === 'object' ? raw.profile : null,
    baseline: baseline ?? 0,
    baselineWeekKey: typeof raw.baselineWeekKey === 'string' ? raw.baselineWeekKey : null,
    baselineSource: typeof raw.baselineSource === 'string' ? raw.baselineSource : BASELINE_SOURCE.USER,
    baselineEstimated: Boolean(raw.baselineEstimated),
    baselineUpdatedAt: typeof raw.baselineUpdatedAt === 'string' ? raw.baselineUpdatedAt : null,
    baselineFromWeekKey: typeof raw.baselineFromWeekKey === 'string' ? raw.baselineFromWeekKey : null,
    currentLikes: currentLikes !== null && currentLikes > LIKES_MAX_VALUE ? null : currentLikes,
    lastQueriedAt: typeof raw.lastQueriedAt === 'string' ? raw.lastQueriedAt : null,
    lastSnapshot: snapshot && snapshot.likes !== null ? snapshot : null,
    lastError: raw.lastError && typeof raw.lastError === 'object' ? raw.lastError : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

/** 简单并发池，刷新多个账号时避免一次性打太多请求 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function createLocalService({ config, adapters }) {
  const { timeZone } = config;
  const weeklyCap = WEEKLY_LIKE_CAP;

  const view = (account, now) => buildAccountView(account, now, { timeZone, weeklyCap });

  /** 跨周时用「刷新前的快照」推进基线（和云端完全同一套逻辑） */
  function settle(account, now) {
    const result = settleAccount(account, now, { timeZone });
    return result;
  }

  async function fetchInto(account, now) {
    try {
      const result = await adapters.fetchLikes({ roleId: account.roleId });
      const weekKey = getWeekStart(now, timeZone).key;
      account.currentLikes = result.likes;
      account.lastQueriedAt = nowIso(now);
      account.lastSnapshot = { likes: result.likes, weekKey, at: nowIso(now) };
      account.lastError = null;
      return { ok: true, likes: result.likes };
    } catch (error) {
      account.lastError = errorInfo(error);
      return { ok: false, error: account.lastError };
    }
  }

  return {
    enabled: config.allowLocalMode,

    /** 添加账号：走接口 A 拿 roleId（顺带点赞数与档案），不落库 */
    async add({ nickname, region, lastWeekLikes }, now = new Date()) {
      const name = String(nickname ?? '').trim();
      if (!name) throw badRequest('请填写游戏昵称', 'INVALID_NICKNAME');
      if (name.length > NICKNAME_MAX_LENGTH) throw badRequest(`昵称最长 ${NICKNAME_MAX_LENGTH} 个字符`, 'INVALID_NICKNAME');
      if (!isRegionId(region)) throw badRequest('请选择大区（微信区 / QQ区）', 'INVALID_REGION');

      const baselineValue = Number(lastWeekLikes);
      if (!Number.isFinite(baselineValue) || baselineValue < 0) {
        throw badRequest('上周点赞数必须是 0 或正整数', 'INVALID_BASELINE');
      }
      if (baselineValue > LIKES_MAX_VALUE) throw badRequest('上周点赞数看起来不太对，请检查', 'INVALID_BASELINE');

      const week = getWeekStart(now, timeZone);
      const resolved = await adapters.resolveRoleId({ nickname: name, region });

      const account = {
        roleId: String(resolved.roleId),
        nickname: name,
        region,
        profile: resolved.profile ?? null,
        baseline: Math.floor(baselineValue),
        baselineWeekKey: week.key,
        baselineSource: BASELINE_SOURCE.USER,
        baselineEstimated: false,
        baselineUpdatedAt: nowIso(now),
        baselineFromWeekKey: null,
        currentLikes: null,
        lastQueriedAt: null,
        lastSnapshot: null,
        lastError: null,
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
      };

      let warning = null;
      if (typeof resolved.likes === 'number' && Number.isFinite(resolved.likes)) {
        // 接口 A 顺带返回了点赞数，省一次接口 B 调用
        account.currentLikes = resolved.likes;
        account.lastQueriedAt = nowIso(now);
        account.lastSnapshot = { likes: resolved.likes, weekKey: week.key, at: nowIso(now) };
      } else {
        const pulled = await fetchInto(account, now);
        if (!pulled.ok) warning = pulled.error;
      }

      return { account: view(account, now), warning };
    },

    /** 同步（刷新）一批本地账号：先结算再查点赞数，返回新的完整对象 */
    async sync({ accounts } = {}, now = new Date()) {
      const list = (Array.isArray(accounts) ? accounts : []).slice(0, MAX_ACCOUNTS).map(normalizeAccount);
      const valid = list.filter(Boolean);

      // 先全部推进基线（用刷新前的快照），再去查最新点赞
      for (const account of valid) settle(account, now);

      const pulled = await mapWithConcurrency(valid, 3, async (account) => {
        const result = await fetchInto(account, now);
        account.updatedAt = nowIso(now);
        return { roleId: account.roleId, ok: result.ok, error: result.ok ? null : result.error };
      });

      const failures = pulled.filter((item) => !item.ok);
      return {
        accounts: valid.map((account) => view(account, now)),
        total: valid.length,
        succeeded: valid.length - failures.length,
        failed: failures.length,
        errors: failures,
        dropped: list.length - valid.length,
      };
    },

    /** 手动修正「上周点赞数」 */
    async setBaseline({ account, lastWeekLikes }, now = new Date()) {
      const target = normalizeAccount(account);
      if (!target) throw badRequest('账号信息不合法', 'INVALID_ACCOUNT');

      const value = Number(lastWeekLikes);
      if (!Number.isFinite(value) || value < 0 || value > LIKES_MAX_VALUE) {
        throw badRequest('上周点赞数必须是 0 或正整数', 'INVALID_BASELINE');
      }

      settle(target, now);
      target.baseline = Math.floor(value);
      target.baselineWeekKey = getWeekStart(now, timeZone).key;
      target.baselineSource = BASELINE_SOURCE.MANUAL;
      target.baselineEstimated = false;
      target.baselineUpdatedAt = nowIso(now);
      target.updatedAt = nowIso(now);

      return { account: view(target, now) };
    },

    /** 只推进基线（打开页面时先把跨周算对，不联网） */
    async settleOnly({ accounts } = {}, now = new Date()) {
      const list = (Array.isArray(accounts) ? accounts : []).slice(0, MAX_ACCOUNTS).map(normalizeAccount);
      const valid = list.filter(Boolean);
      for (const account of valid) settle(account, now);
      return { accounts: valid.map((account) => view(account, now)) };
    },
  };
}
