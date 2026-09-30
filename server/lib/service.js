/**
 * 业务服务层：把「接口适配器 + 结算引擎 + SQLite 数据库」串起来。
 *
 * 设计要点：
 *  - 游戏账号是**全站唯一**的：一个 roleId 在库里只有一条记录，不绑定任何用户；
 *  - 但「看哪些账号」是**每台设备自己决定**的：主页只显示本机添加过的 roleId
 *    （列表存在浏览器里，服务端只按 roleIds 批量查询/刷新，不会把全库列表发出去）；
 *  - 添加已存在的角色 = 把它「认领」进本机列表，不重复入库、也不覆盖别人的基线；
 *  - 真正从数据库删账号只在管理后台（需要管理员）。
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
import { badRequest, notFound } from './errors.js';
import { BASELINE_SOURCE, buildAccountView, previousWeekKey, settleAccount } from './settlement.js';

const nowIso = (value = new Date()) => new Date(value).toISOString();

/** 一次最多处理多少个 roleId（防止有人塞一个超大数组） */
const MAX_ACCOUNT_IDS = 100;

/** 把客户端传来的 roleId 列表清洗成「合法、去重、有序」的数组 */
export function normalizeRoleIds(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (!/^\d{1,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_ACCOUNT_IDS) break;
  }
  return out;
}

/**
 * 这个角色在游戏里当前叫什么。
 * 接口A 的档案里 roleName 是游戏内真实昵称（玩家改名后它会变），以它为准；
 * 拿不到就退回用户填的那个昵称。
 */
function currentRoleName(resolved, fallback) {
  const raw = resolved?.profile?.roleName ?? fallback;
  return String(raw ?? '').trim().slice(0, NICKNAME_MAX_LENGTH);
}

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

  /** 全站共享：账号按 roleId 找，找到就能操作，不再校验归属 */
  function requireRole(roleId) {
    const role = repo.roles.getRole(roleId);
    if (!role) throw notFound('账号不存在或已被删除', 'ACCOUNT_NOT_FOUND');
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
      };
    },

    /**
     * 按 roleIds 查询账号（主页用）：只返回客户端指定的那些，全库列表不会下发。
     * missing 里是被管理员删掉（或 roleId 不合法）的那些，前端据此清理本机列表。
     */
    async queryAccounts(roleIds, now = new Date()) {
      const ids = normalizeRoleIds(roleIds);
      const roles = ids.map((id) => repo.roles.getRole(id)).filter(Boolean);
      for (const role of roles) settleAndPersist(role, now);
      const found = new Set(roles.map((role) => role.roleId));
      return {
        accounts: roles.map((role) => view(role, now)),
        missing: ids.filter((id) => !found.has(id)),
      };
    },

    /**
     * 添加账号：不需要登录，游客添加的账号同样入库。
     * 如果这个 roleId 全站已经有了，就把它「认领」进本机列表，并且顺手
     * **把库里的昵称/档案同步成游戏里的当前值**（玩家改名后，用新昵称再添加一次就会自动更正），
     * 但绝不覆盖基线、当前点赞这些成绩数据。
     */
    async addAccount({ nickname, region, lastWeekLikes }, { actor = 'guest' } = {}, now = new Date()) {
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
      const gameName = currentRoleName(resolved, name);

      // 全站唯一：库里已经有了就直接认领（顺手同步昵称/档案，不动成绩数据）
      const existing = repo.roles.getRole(roleId);
      if (existing) {
        settleAndPersist(existing, now);

        const patch = {};
        if (gameName && gameName !== existing.nickname) patch.display_name = gameName;
        if (resolved.profile) patch.profile_json = resolved.profile;
        if (Object.keys(patch).length > 0) repo.roles.updateRole(roleId, patch);

        const renamed = patch.display_name ? { from: existing.nickname ?? '', to: patch.display_name } : null;
        repo.audit.log({
          actor,
          action: renamed ? 'role.rename' : 'role.claim',
          target: roleId,
          detail: renamed ? { ...renamed, source: name } : { nickname: existing.nickname },
        });
        return {
          account: view(repo.roles.getRole(roleId), now),
          claimed: true,
          renamed,
          warning: null,
        };
      }

      const role = {
        roleId,
        nickname: gameName,
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

      // actor 为 "guest" 表示未登录的访客添加的，后台「添加者」列会显示成「游客」
      repo.audit.log({
        actor,
        action: 'role.add',
        target: roleId,
        detail: { nickname: gameName, typed: name, region, baseline: Math.floor(baselineValue) },
      });

      return {
        account: view(repo.roles.getRole(roleId), now),
        claimed: false,
        renamed: null,
        warning: pulled.ok ? null : pulled.error,
      };
    },

    async refreshAccount(roleId, now = new Date()) {
      const role = requireRole(roleId);

      // 顺序很重要：先结算（用刷新前的快照推进基线），再去查最新点赞
      settleAndPersist(role, now);
      const pulled = await pullLikes(role, now);
      repo.roles.updateRole(role.roleId, { updated_at: nowIso(now) });

      return { account: view(repo.roles.getRole(roleId), now), warning: pulled.ok ? null : pulled.error };
    },

    /**
     * 刷新一批账号（主页「刷新全部」用）：只刷客户端给的 roleIds，
     * 不会顺带刷全库（别人的账号不该因为你的刷新而消耗接口调用）。
     * roleIds 传 null 表示全库，只给内部定时任务用。
     */
    async refreshAccounts(roleIds, now = new Date(), { concurrency = 4 } = {}) {
      const ids = roleIds === null ? repo.roles.listAllRoles().map((role) => role.roleId) : normalizeRoleIds(roleIds);
      const roles = ids.map((id) => repo.roles.getRole(id)).filter(Boolean);
      for (const role of roles) settleAndPersist(role, now);

      const results = await mapWithConcurrency(roles, concurrency, async (role) => {
        const pulled = await pullLikes(role, now);
        return { roleId: role.roleId, ok: pulled.ok, error: pulled.ok ? null : pulled.error };
      });

      const failures = results.filter((item) => !item.ok);
      const found = new Set(roles.map((role) => role.roleId));
      return {
        accounts: roles.map((role) => view(repo.roles.getRole(role.roleId), now)),
        missing: ids.filter((id) => !found.has(id)),
        total: roles.length,
        succeeded: results.length - failures.length,
        failed: failures.length,
        errors: failures,
      };
    },

    /** 需求 6.4：允许手动修正「上周点赞数」 */
    async updateAccountBaseline(roleId, lastWeekLikes, { actor = 'guest' } = {}, now = new Date()) {
      const role = requireRole(roleId);

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
        actor,
        action: 'role.baseline',
        target: roleId,
        detail: { baseline: Math.floor(value), weekKey: week },
      });

      return { account: view(repo.roles.getRole(roleId), now) };
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
        accounts: repo.roles.listAllRoles().map((role) => view(role, now)),
      };
    },
  };
}
