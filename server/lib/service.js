/**
 * 业务服务层：把「接口适配器 + 结算引擎 + SQLite 数据库」串起来。
 *
 * 与旧版的区别：
 *  - 所有账号操作都带 userId，只能操作自己的角色；
 *  - 点赞数会写进 weekly_likes（★ 只有 roleId + 点赞数，不存昵称）；
 *  - 每周一 00:00:01 的结算任务遍历全库 roleId（用 roleId 请求接口 B）。
 */

import {
  LIKES_MAX_VALUE,
  NICKNAME_MAX_LENGTH,
  REGIONS,
  WEEKLY_LIKE_CAP,
  isRegionId,
} from '../../shared/constants.js';
import { getWeekStart } from '../../shared/week.js';
import { HttpError, badRequest, notFound } from './errors.js';
import { BASELINE_SOURCE, buildAccountView, previousWeekKey, settleAccount } from './settlement.js';

const nowIso = (value = new Date()) => new Date(value).toISOString();

function errorInfo(error) {
  return {
    code: error?.code ?? 'ADAPTER_ERROR',
    message: error?.message ?? '接口调用失败',
    at: nowIso(),
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

/** 落库时用到的字段名（和 repo.updateRole 的列名一致） */
function settlementPatch(role) {
  return {
    baseline: role.baseline,
    baseline_week_key: role.baselineWeekKey,
    baseline_source: role.baselineSource,
    baseline_estimated: role.baselineEstimated,
    baseline_updated_at: role.baselineUpdatedAt,
    baseline_from_week_key: role.baselineFromWeekKey ?? null,
  };
}

export function createService({ config, repo, adapters, auth }) {
  const { timeZone } = config;
  const weeklyCap = WEEKLY_LIKE_CAP;

  const view = (role, now) => buildAccountView(role, now, { timeZone, weeklyCap });

  /**
   * 推进某个角色到当前周，并落库。
   * 跨周时新基线取「刷新前记录的点赞数」（上一周结束时的快照），绝不写入库的是刚查到的最新值。
   */
  function settleAndPersist(role, now) {
    const result = settleAccount(role, now, { timeZone });
    if (!result.changed) return result;
    repo.roles.updateRole(role.roleId, settlementPatch(role));
    return result;
  }

  /** 查一次接口 B 并落库 */
  async function pullLikes(role, now) {
    try {
      const result = await adapters.fetchLikes({ roleId: role.roleId });
      const weekKey = getWeekStart(now, timeZone).key;
      const lastError = null;
      repo.roles.updateRole(role.roleId, {
        current_likes: result.likes,
        last_queried_at: nowIso(now),
        last_snapshot_likes: result.likes,
        last_snapshot_week_key: weekKey,
        last_snapshot_at: nowIso(now),
        last_error: lastError,
      });
      role.currentLikes = result.likes;
      role.lastQueriedAt = nowIso(now);
      role.lastSnapshot = { likes: result.likes, weekKey, at: nowIso(now) };
      role.lastError = null;
      return { ok: true, likes: result.likes };
    } catch (error) {
      const info = errorInfo(error);
      repo.roles.updateRole(role.roleId, { last_error: info });
      role.lastError = info;
      return { ok: false, error: info };
    }
  }

  function requireOwnedRole(userId, roleId) {
    const role = repo.roles.getRole(roleId);
    if (!role) throw notFound('账号不存在或已被删除', 'ACCOUNT_NOT_FOUND');
    if (role.userId !== Number(userId)) {
      // 不暴露「存在但不属于你」，统一按不存在处理
      throw notFound('账号不存在或已被删除', 'ACCOUNT_NOT_FOUND');
    }
    return role;
  }

  return {
    config,
    repo,
    adapters,
    auth,

    getRuntimeInfo(now = new Date()) {
      const week = getWeekStart(now, timeZone);
      return {
        weeklyCap,
        regions: REGIONS,
        timeZone,
        adapter: adapters.name,
        adapterMode: adapters.name === 'mock' ? 'mock' : 'live',
        requestedAdapter: config.requestedAdapter,
        endpointsConfigured: config.endpointsConfigured,
        mockSpeed: adapters.name === 'mock' ? config.mock.speed : null,
        week: { key: week.key, startMs: week.startMs, endMs: week.endMs },
        serverNow: new Date(now).getTime(),
        version: config.version,
        // 首页底部那张卡片显示的内容，由管理员在后台改（存 settings 表，不用改库结构）
        announcement: repo.settings.get('announcement') ?? '',
        // 未登录时前端走本地模式（账号存浏览器，不入库）
        allowLocalMode: config.allowLocalMode,
      };
    },

    /** 账号列表（只返回自己的；顺便把基线推进到当前周） */
    async listAccounts(userId, now = new Date()) {
      const roles = repo.roles.listRolesByUser(userId);
      for (const role of roles) settleAndPersist(role, now);
      return roles.map((role) => view(role, now));
    },

    async addAccount(userId, { nickname, region, lastWeekLikes }, now = new Date()) {
      const name = String(nickname ?? '').trim();
      if (!name) throw badRequest('请填写游戏昵称', 'INVALID_NICKNAME');
      if (name.length > NICKNAME_MAX_LENGTH) {
        throw badRequest(`昵称最长 ${NICKNAME_MAX_LENGTH} 个字符`, 'INVALID_NICKNAME');
      }
      if (!isRegionId(region)) throw badRequest('请选择大区（微信区 / QQ区）', 'INVALID_REGION');

      const baselineValue = Number(lastWeekLikes);
      if (!Number.isFinite(baselineValue) || baselineValue < 0) {
        throw badRequest('上周点赞数必须是 0 或正整数', 'INVALID_BASELINE');
      }
      if (baselineValue > LIKES_MAX_VALUE) {
        throw badRequest('上周点赞数看起来不太对，请检查', 'INVALID_BASELINE');
      }

      const week = getWeekStart(now, timeZone);
      const resolved = await adapters.resolveRoleId({ nickname: name, region });
      const roleId = String(resolved.roleId);

      // 同一个 roleId 全库唯一：别人加过、或者自己已经加过，都拒绝
      const existing = repo.roles.getRole(roleId);
      if (existing) {
        const mine = existing.userId === Number(userId);
        throw new HttpError(
          409,
          'DUPLICATE_ACCOUNT',
          mine
            ? `「${existing.nickname || roleId}」你已经添加过了，不用重复添加`
            : '这个角色已经被其他用户添加了',
          { roleId, mine, existing: mine ? view(existing, now) : null },
        );
      }

      const role = {
        roleId,
        userId: Number(userId),
        nickname: name,
        region,
        profile: resolved.profile ?? null,
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
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
      };

      // 接口A 已经把点赞数带回来了就直接用（省一次调用），否则再查接口B
      let pulled;
      if (typeof resolved.likes === 'number' && Number.isFinite(resolved.likes)) {
        role.currentLikes = resolved.likes;
        role.lastQueriedAt = nowIso(now);
        role.lastSnapshot = { likes: resolved.likes, weekKey: week.key, at: nowIso(now) };
        pulled = { ok: true, likes: resolved.likes };
      } else {
        const fetched = await adapters
          .fetchLikes({ roleId })
          .then((result) => ({ ok: true, likes: result.likes }))
          .catch((error) => ({ ok: false, error: errorInfo(error) }));
        if (fetched.ok) {
          role.currentLikes = fetched.likes;
          role.lastQueriedAt = nowIso(now);
          role.lastSnapshot = { likes: fetched.likes, weekKey: week.key, at: nowIso(now) };
        } else {
          role.lastError = fetched.error;
        }
        pulled = fetched;
      }

      repo.roles.createRole(role);

      repo.audit.log({
        actor: `user:${userId}`,
        action: 'role.add',
        target: roleId,
        detail: { nickname: name, region, baseline: Math.floor(baselineValue) },
      });

      return { account: view(repo.roles.getRole(roleId), now), warning: pulled.ok ? null : pulled.error };
    },

    async refreshAccount(userId, roleId, now = new Date()) {
      const role = requireOwnedRole(userId, roleId);

      // 顺序很重要：先结算（用刷新前的快照推进基线），再去查最新点赞
      settleAndPersist(role, now);
      const pulled = await pullLikes(role, now);
      repo.roles.updateRole(role.roleId, { updated_at: nowIso(now) });

      return { account: view(repo.roles.getRole(roleId), now), warning: pulled.ok ? null : pulled.error };
    },

    async refreshAll(userId, now = new Date(), { concurrency = 4 } = {}) {
      const roles = repo.roles.listRolesByUser(userId);
      for (const role of roles) settleAndPersist(role, now);

      const results = await mapWithConcurrency(roles, concurrency, async (role) => {
        const pulled = await pullLikes(role, now);
        return { roleId: role.roleId, ok: pulled.ok, error: pulled.ok ? null : pulled.error };
      });

      const failures = results.filter((item) => !item.ok);
      return {
        accounts: repo.roles.listRolesByUser(userId).map((role) => view(role, now)),
        total: roles.length,
        succeeded: results.length - failures.length,
        failed: failures.length,
        errors: failures,
      };
    },

    /** 需求 6.4：允许用户手动修正「上周点赞数」（只改自己的） */
    async updateAccountBaseline(userId, roleId, lastWeekLikes, now = new Date()) {
      const role = requireOwnedRole(userId, roleId);

      const value = Number(lastWeekLikes);
      if (!Number.isFinite(value) || value < 0 || value > LIKES_MAX_VALUE) {
        throw badRequest('上周点赞数必须是 0 或正整数', 'INVALID_BASELINE');
      }

      settleAndPersist(role, now);
      const week = getWeekStart(now, timeZone).key;
      repo.roles.updateRole(roleId, {
        baseline: Math.floor(value),
        baseline_week_key: week,
        baseline_source: BASELINE_SOURCE.MANUAL,
        baseline_estimated: false,
        baseline_updated_at: nowIso(now),
      });

      repo.audit.log({
        actor: `user:${userId}`,
        action: 'role.baseline',
        target: roleId,
        detail: { baseline: Math.floor(value), weekKey: week },
      });

      return { account: view(repo.roles.getRole(roleId), now) };
    },

    async removeAccount(userId, roleId) {
      requireOwnedRole(userId, roleId);
      repo.roles.deleteRole(roleId);
      repo.audit.log({ actor: `user:${userId}`, action: 'role.remove', target: roleId });
      return { roleId: String(roleId) };
    },

    /**
     * 每周结算任务。
     * 每周一 00:00:01 之后触发：遍历全库 roleId，用接口 B 查点赞数，
     * 把这个值设为新一周的「上周点赞(基线)」（本周已刷从 0 重新开始）。
     */
    async runWeeklySettlement({ at, refresh = true, force = false } = {}) {
      const now = at ? new Date(at) : new Date();
      if (Number.isNaN(now.getTime())) throw badRequest('at 不是合法时间', 'INVALID_TIME');

      const week = getWeekStart(now, timeZone);
      const withinGrace = now.getTime() - week.startMs <= config.settleGraceMs;
      const prevKey = previousWeekKey(now, timeZone);
      const roles = repo.roles.listAllRoles();

      // 1) 先按快照把基线推进到新的一周（不联网，保证即使上游挂了逻辑也不会错）
      const settled = [];
      for (const role of roles) {
        const result = settleAndPersist(role, now);
        if (result.changed) settled.push({ roleId: role.roleId, reason: result.reason });
      }

      // 2) 宽限窗口内再拉一次接口 B，把「上周结束时的真实总点赞」记成新基线
      let refreshed = [];
      const shouldRefresh = refresh && (withinGrace || force);
      if (shouldRefresh) {
        refreshed = await mapWithConcurrency(roles, 3, async (role) => {
          try {
            const result = await adapters.fetchLikes({ roleId: role.roleId });
            repo.roles.updateRole(role.roleId, {
              baseline: result.likes,
              baseline_week_key: week.key,
              baseline_source: BASELINE_SOURCE.SETTLED_CRON,
              baseline_estimated: false,
              baseline_updated_at: nowIso(now),
              current_likes: result.likes,
              last_queried_at: nowIso(now),
              last_snapshot_likes: result.likes,
              last_snapshot_week_key: week.key,
              last_snapshot_at: nowIso(now),
              last_error: null,
            });
            return { roleId: role.roleId, ok: true };
          } catch (error) {
            const info = errorInfo(error);
            repo.roles.updateRole(role.roleId, { last_error: info });
            return { roleId: role.roleId, ok: false, error: info };
          }
        });
      }

      repo.settings.set('lastCronWeekKey', week.key);
      repo.settings.set('lastCronAt', nowIso(now));
      repo.settings.set('lastCronPrevWeekKey', prevKey);
      repo.audit.log({
        actor: 'system',
        action: 'job.weekly-settle',
        target: week.key,
        detail: {
          prevWeekKey: prevKey,
          withinGrace,
          settled: settled.length,
          refreshed: refreshed.length,
          failed: refreshed.filter((item) => !item.ok).length,
        },
      });

      return {
        week: { key: week.key, startMs: week.startMs, endMs: week.endMs },
        prevWeekKey: prevKey,
        withinGrace,
        settleGraceMs: config.settleGraceMs,
        settledAccounts: settled.length,
        refreshed: refreshed.length,
        refreshedFailed: refreshed.filter((item) => !item.ok).length,
        accounts: repo.roles.listAllRoles().map((role) => ({
          ...view(role, now),
          userId: role.userId,
        })),
      };
    },

    /**
     * 注册后把「本地模式下攒的游戏账号」一次性搬到云端。
     * 这些账号已经带 roleId / 基线 / 快照，所以不需要再查接口 A。
     */
    async importLocalAccounts(userId, accounts, now = new Date()) {
      const list = Array.isArray(accounts) ? accounts.slice(0, 50) : [];
      const imported = [];
      const skipped = [];

      for (const item of list) {
        const roleId = String(item?.roleId ?? '').trim();
        if (!/^\d{1,20}$/.test(roleId)) {
          skipped.push({ roleId: roleId || '(空)', reason: 'INVALID_ROLE_ID' });
          continue;
        }
        if (repo.roles.getRole(roleId)) {
          skipped.push({ roleId, reason: 'ALREADY_EXISTS' });
          continue;
        }
        if (!isRegionId(item?.region)) {
          skipped.push({ roleId, reason: 'INVALID_REGION' });
          continue;
        }

        const baseline = Number(item?.baseline);
        const role = {
          roleId,
          userId: Number(userId),
          nickname: String(item?.nickname ?? '').slice(0, 32),
          region: item.region,
          profile: item?.profile ?? null,
          baseline: Number.isFinite(baseline) && baseline >= 0 ? Math.floor(baseline) : 0,
          baselineWeekKey: item?.baselineWeekKey ?? getWeekStart(now, timeZone).key,
          baselineSource: item?.baselineSource ?? BASELINE_SOURCE.USER,
          baselineEstimated: Boolean(item?.baselineEstimated),
          baselineUpdatedAt: item?.baselineUpdatedAt ?? nowIso(now),
          baselineFromWeekKey: item?.baselineFromWeekKey ?? null,
          currentLikes: Number.isFinite(Number(item?.currentLikes)) ? Math.floor(Number(item.currentLikes)) : null,
          lastQueriedAt: item?.lastQueriedAt ?? null,
          lastSnapshot: item?.lastSnapshot ?? null,
          lastError: item?.lastError ?? null,
        };
        repo.roles.createRole(role);
        imported.push(view(repo.roles.getRole(roleId), now));
      }

      if (imported.length > 0) {
        repo.audit.log({
          actor: `user:${userId}`,
          action: 'role.import-local',
          target: String(userId),
          detail: { imported: imported.length, skipped: skipped.length, roleIds: imported.map((r) => r.roleId) },
        });
      }
      return { imported: imported.length, skipped: skipped.length, accounts: imported, skippedDetail: skipped };
    },
  };
}
