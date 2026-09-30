/**
 * 管理员后台的业务逻辑。
 *
 * 能做的事（对应需求）：
 *  - 管理用户：查看、设为/取消管理员、改密码、删除（用户和游戏账号已经互不相干）
 *  - 管理**全站共享**的游戏账号：改名 / 改大区 / 改上周点赞(基线) / 改当前点赞 / 改 roleId / 删除
 *    （账号不绑定用户，所以后台列出的是全部账号，并标出是谁添加的）
 */

import { WEEKLY_LIKE_CAP, isRegionId } from '../../shared/constants.js';
import { getWeekStart } from '../../shared/week.js';
import { HttpError, badRequest, notFound } from './errors.js';
import { buildAccountView } from './settlement.js';

const nowIso = (value = new Date()) => new Date(value).toISOString();

/** 首页公告：存在 settings 表里，key = announcement，最长 500 字 */
const ANNOUNCEMENT_MAX_LENGTH = 500;

/** 审计日志里的 actor 变成后台能看懂的「添加者」文案 */
function actorLabel(actor) {
  const text = String(actor ?? '');
  if (text === 'guest') return '游客（未登录）';
  if (text === 'system') return '系统';
  if (text.startsWith('user:')) return `用户 #${text.slice(5)}`;
  if (text.startsWith('admin:')) return `管理员 #${text.slice(6)}`;
  return text || '未知';
}


export function createAdminService({ config, repo, auth, adapters }) {
  const { timeZone } = config;
  const view = (role, now = new Date()) =>
    buildAccountView(role, now, { timeZone, weeklyCap: WEEKLY_LIKE_CAP });

  function requireUser(id) {
    const user = repo.users.getUser(id);
    if (!user) throw notFound('用户不存在', 'USER_NOT_FOUND');
    return user;
  }

  function requireRole(roleId) {
    const role = repo.roles.getRole(roleId);
    if (!role) throw notFound('roleId 不存在', 'ROLE_NOT_FOUND');
    return role;
  }

  return {
    /** 后台首页概览 */
    overview(currentUser = null, now = new Date()) {
      const week = getWeekStart(now, timeZone);
      return {
        stats: repo.stats(),
        week: { key: week.key, startMs: week.startMs, endMs: week.endMs, timeZone },
        settings: repo.settings.all(),
        runtime: { adapter: adapters.name, mockSpeed: config.mock?.speed ?? null, timeZone },
        defaultAdminPassword: currentUser ? auth.isUsingDefaultAdminPassword(currentUser) : false,
        serverNow: now.getTime(),
        version: config.version,
      };
    },

    /* ----------------------------------------------------------------- 用户 */

    listUsers() {
      return repo.users.listUsers().map((user) => ({
        ...user,
        sessionCount: repo.sessions.countSessions(user.id),
      }));
    },

    /** 把普通用户设为/取消管理员（只有超级管理员能做；超级管理员本身动不了） */
    setAdmin(actor, userId, isAdmin) {
      const user = requireUser(userId);

      // 1) 权限：只有超级管理员能管管理员层级
      if (!actor.isSuper) {
        throw new HttpError(403, 'SUPER_ONLY', '只有超级管理员能设置管理员');
      }
      // 2) 超级管理员全站唯一，任何人都不能把它降级（包括它自己）
      if (user.isSuper) {
        throw badRequest(
          '超级管理员不能被降级（全站只有一个），要换人在 .env 里改 ADMIN_USERNAME 后重启',
          'SUPER_ADMIN_PROTECTED',
        );
      }
      // 3) 剩下的就是普通管理员/普通用户，自己改自己没意义
      if (user.id === actor.id) {
        throw badRequest('不能修改自己的管理员状态', 'CANNOT_CHANGE_SELF');
      }

      repo.users.setAdmin(user.id, isAdmin);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: isAdmin ? 'admin.user.promote' : 'admin.user.demote',
        target: String(user.id),
        detail: { username: user.username },
      });
      return { user: repo.users.getUser(user.id) };
    },

    resetPassword(actor, userId, newPassword) {
      const user = requireUser(userId);
      if (user.isSuper && actor.id !== user.id) {
        throw new HttpError(403, 'SUPER_ADMIN_PROTECTED', '超级管理员的密码不能被别人重置');
      }
      const target = { username: user.username ?? 'x', id: user.id };
      auth.changePassword({ user: target, newPassword, requireOld: false });
      // 改完密码把该用户的其他会话踢掉，避免旧 token 还能用
      repo.sessions.removeUserSessions(user.id);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.user.reset-password',
        target: String(user.id),
        detail: { username: user.username },
      });
      return { user: repo.users.getUser(user.id) };
    },

    deleteUser(actor, userId) {
      const user = requireUser(userId);
      if (user.id === actor.id) throw badRequest('不能删除自己的账号', 'CANNOT_DELETE_SELF');
      if (user.isSuper) {
        throw new HttpError(403, 'SUPER_ADMIN_PROTECTED', '超级管理员不能被删除');
      }
      if (user.isAdmin && !actor.isSuper) {
        throw new HttpError(403, 'SUPER_ONLY', '只有超级管理员能删除其他管理员');
      }
      // 游戏账号是全站共享的，和用户没有关系：删用户不会动任何游戏账号
      repo.users.deleteUser(userId);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.user.delete',
        target: String(userId),
        detail: { username: user.username },
      });
      return { deleted: true, roleCount: 0 };
    },

    /* ----------------------------------------------------------- 游戏账号 */

    listRoles(now = new Date()) {
      const addedBy = repo.audit.roleAddActors();
      return repo.roles.listAllRoles().map((role) => ({
        ...view(role, now),
        addedBy: actorLabel(addedBy.get(role.roleId) ?? 'system'),
      }));
    },

    /** 改名 / 改大区 / 改基线 / 改当前点赞数 */
    updateRole(actor, roleId, patch = {}, now = new Date()) {
      const role = requireRole(roleId);
      const update = {};

      if (patch.displayName !== undefined || patch.nickname !== undefined) {
        const name = String(patch.displayName ?? patch.nickname ?? '').trim();
        if (name.length > 32) throw badRequest('昵称最长 32 个字符', 'INVALID_NICKNAME');
        update.display_name = name === '' ? null : name;
      }

      if (patch.region !== undefined) {
        if (!isRegionId(patch.region)) throw badRequest('大区只能是 wechat 或 qq', 'INVALID_REGION');
        update.region = patch.region;
      }

      if (patch.baseline !== undefined) {
        const value = Number(patch.baseline);
        if (!Number.isFinite(value) || value < 0) throw badRequest('上周点赞数必须是 0 或正整数', 'INVALID_BASELINE');
        update.baseline = Math.floor(value);
        update.baseline_source = 'admin';
        update.baseline_estimated = false;
        update.baseline_updated_at = nowIso(now);
        if (patch.baselineWeekKey !== undefined) {
          if (!isWeekKey(patch.baselineWeekKey)) throw badRequest('周标识格式应为 YYYY-MM-DD', 'INVALID_WEEK_KEY');
          update.baseline_week_key = String(patch.baselineWeekKey);
        } else {
          update.baseline_week_key = getWeekStart(now, timeZone).key;
        }
      } else if (patch.baselineWeekKey !== undefined) {
        if (!isWeekKey(patch.baselineWeekKey)) throw badRequest('周标识格式应为 YYYY-MM-DD', 'INVALID_WEEK_KEY');
        update.baseline_week_key = String(patch.baselineWeekKey);
      }

      if (patch.currentLikes !== undefined) {
        const value = patch.currentLikes === null ? null : Number(patch.currentLikes);
        if (value !== null && (!Number.isFinite(value) || value < 0)) {
          throw badRequest('当前点赞数必须是 0 或正整数', 'INVALID_LIKES');
        }
        update.current_likes = value === null ? null : Math.floor(value);
      }

      if (Object.keys(update).length === 0) throw badRequest('没有需要修改的字段', 'NOTHING_TO_UPDATE');

      const updated = repo.roles.updateRole(roleId, update);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.role.update',
        target: roleId,
        detail: patch,
      });
      return { account: view(updated, now) };
    },

    /** 改 roleId（主键），顺带迁移它的点赞记录 */
    changeRoleId(actor, roleId, newRoleId) {
      const role = requireRole(roleId);
      const target = String(newRoleId ?? '').trim();
      if (!/^\d{1,20}$/.test(target)) {
        throw badRequest('roleId 必须是纯数字（游戏内角色 ID）', 'INVALID_ROLE_ID');
      }
      if (repo.roles.getRole(target)) {
        throw new HttpError(409, 'ROLE_ID_EXISTS', `roleId ${target} 已经存在`, { roleId: target });
      }
      repo.roles.changeRoleId(roleId, target);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.role.change-id',
        target: roleId,
        detail: { from: role.roleId, to: target },
      });
      return { account: view(repo.roles.getRole(target), new Date()), roleId: target };
    },

    deleteRole(actor, roleId) {
      const role = requireRole(roleId);
      repo.roles.deleteRole(roleId);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.role.delete',
        target: roleId,
        detail: { nickname: role.nickname },
      });
      return { deleted: true };
    },

    listAudits(limit = 60) {
      return repo.audit.listAudits(Math.min(300, Math.max(1, Number(limit) || 60)));
    },

    /* --------------------------------------------------------------- 公告 */

    /** 首页公告内容（后台表单初始化用） */
    getAnnouncement() {
      return {
        announcement: repo.settings.get('announcement') ?? '',
        maxLength: ANNOUNCEMENT_MAX_LENGTH,
      };
    },

    /** 改公告：留空表示不显示公告卡片 */
    updateAnnouncement(actor, text) {
      const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (value.length > ANNOUNCEMENT_MAX_LENGTH) {
        throw badRequest(`公告最长 ${ANNOUNCEMENT_MAX_LENGTH} 个字`, 'ANNOUNCEMENT_TOO_LONG');
      }
      repo.settings.set('announcement', value);
      repo.audit.log({
        actor: `admin:${actor.id}`,
        action: 'admin.settings.announcement',
        target: 'announcement',
        detail: { length: value.length, preview: value.slice(0, 60) },
      });
      return { announcement: value, maxLength: ANNOUNCEMENT_MAX_LENGTH };
    },
  };
}
