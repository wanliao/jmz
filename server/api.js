/**
 * HTTP API 路由。约定：成功返回 { ok: true, data }，失败返回 { ok: false, error }。
 *
 * 账号模型：一个 roleId 全站只有一条记录、不绑定用户；
 * 但「看哪些账号」由每台设备自己决定 —— 主页把本机添加过的 roleIds 发上来，
 * 服务端只按这批 roleId 返回/刷新，**不会把全库列表下发**，所以别人看不到你的列表。
 * 添加已存在的角色 = 认领进本机列表，并顺手把库里的昵称/档案同步成游戏里的当前值
 * （玩家改名后用新昵称再添加一次就会自动更正），但不动基线/当前点赞。
 *
 *   GET    /api/config                    运行配置
 *   GET    /api/health                    健康检查
 *
 *   POST   /api/accounts                  添加账号（已存在则认领 + 同步新昵称，无需登录）
 *   POST   /api/accounts/query            按 roleIds 批量查询（无需登录）
 *   POST   /api/accounts/refresh          按 roleIds 批量刷新（无需登录）
 *   POST   /api/accounts/:roleId/refresh  刷新单个
 *   PATCH  /api/accounts/:roleId          修正上周点赞数
 *
 * 认证（只有管理后台才需要身份）：
 *   POST   /api/auth/register             注册
 *   POST   /api/auth/login                登录
 *   POST   /api/auth/logout               退出登录
 *   GET    /api/auth/me                   当前身份
 *   POST   /api/auth/password             修改自己的密码
 *
 * 管理员（需 is_admin）：
 *   GET    /api/admin/overview
 *   GET    /api/admin/users
 *   PATCH  /api/admin/users/:id            设为/取消管理员
 *   POST   /api/admin/users/:id/password   重置该用户密码
 *   DELETE /api/admin/users/:id
 *   GET    /api/admin/roles                全站账号列表（唯一能看到全部的地方）
 *   PATCH  /api/admin/roles/:roleId        改名 / 改大区 / 改基线 / 改当前点赞
 *   POST   /api/admin/roles/:roleId/role-id 改 roleId（主键）
 *   DELETE /api/admin/roles/:roleId        真正从数据库删除（公开接口没有删除能力）
 *   GET    /api/admin/audit-logs
 *   GET    /api/admin/settings             后台设置（目前只有首页公告）
 *   PATCH  /api/admin/settings             改首页公告
 *   POST   /api/admin/jobs/weekly-settle   手动触发每周结算
 */

import { readJsonBody, sendJson } from './lib/http-utils.js';
import { HttpError, normalizeError } from './lib/errors.js';

function bearerToken(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (match) return match[1].trim();
  return null;
}

/**
 * 读账号的接口都必须显式给 roleIds（本机列表），否则一律 400。
 * 这样「谁都能添加」不等于「谁都能把全库列表拉走」。
 */
function requireRoleIdList(value) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_ROLE_IDS', 'roleIds 必须是数组（本机添加过的 roleId 列表）');
  }
  return value;
}

export function createApiHandler({ service, admin, auth }) {
  return async function handleApi(request, response, url) {
    const { pathname } = url;
    const method = (request.method ?? 'GET').toUpperCase();

    const token = bearerToken(request);
    const resolved = token ? auth.resolveToken(token) : null;
    const currentUser = resolved?.user ?? null;

    const requireUser = () => {
      if (!currentUser) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
      return currentUser;
    };

    const requireAdmin = () => {
      const user = requireUser();
      if (!user.isAdmin) throw new HttpError(403, 'FORBIDDEN', '需要管理员权限');
      return user;
    };

    /** 审计日志里的操作者：登录了就是 user:<id>，没登录就是 guest（后台显示成「游客」） */
    const actorOf = () => (currentUser ? `user:${currentUser.id}` : 'guest');

    const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 200) || null;

    try {
      /* ------------------------------------------------------------- 基础 */

      if (pathname === '/api/health' && method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          data: {
            status: 'up',
            version: service.config.version,
            adapter: service.adapters.name,
            users: service.repo.users.countUsers(),
            roles: service.repo.roles.countRoles(),
            uptimeSeconds: Math.round(process.uptime()),
            serverNow: Date.now(),
          },
        });
        return true;
      }

      if (pathname === '/api/config' && method === 'GET') {
        sendJson(response, 200, { ok: true, data: service.getRuntimeInfo() });
        return true;
      }

      /* --------------------------------------------------------------- 认证 */

      if (pathname === '/api/auth/register' && method === 'POST') {
        const body = await readJsonBody(request);
        const result = auth.register({
          username: body.username,
          password: body.password,
          currentUser,
          userAgent,
        });
        sendJson(response, 201, {
          ok: true,
          data: { token: result.token, user: result.user },
        });
        return true;
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody(request);
        const result = auth.login({
          username: body.username,
          password: body.password,
          currentUser,
          userAgent,
        });
        sendJson(response, 200, {
          ok: true,
          data: { token: result.token, user: result.user },
        });
        return true;
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        if (token) auth.logout(token);
        sendJson(response, 200, { ok: true, data: { loggedOut: true } });
        return true;
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          data: {
            user: currentUser,
            loggedIn: Boolean(currentUser),
            isAdmin: currentUser ? currentUser.isAdmin : false,
            roleCount: service.repo.roles.countRoles(),
          },
        });
        return true;
      }

      if (pathname === '/api/auth/password' && method === 'POST') {
        const user = requireUser();
        const body = await readJsonBody(request);
        auth.changePassword({ user, oldPassword: body.oldPassword, newPassword: body.newPassword });
        sendJson(response, 200, { ok: true, data: { changed: true } });
        return true;
      }

      /* ----------------------------------------------------------- 账号管理 */
      /* 全站唯一 + 本机视图：服务端只按客户端给的 roleIds 返回，绝不主动下发全库列表 */

      if (pathname === '/api/accounts' && method === 'POST') {
        const body = await readJsonBody(request);
        const result = await service.addAccount(
          {
            nickname: body.nickname,
            region: body.region,
            lastWeekLikes: body.lastWeekLikes,
          },
          { actor: actorOf() },
        );
        sendJson(response, result.claimed ? 200 : 201, { ok: true, data: result });
        return true;
      }

      if (pathname === '/api/accounts/query' && method === 'POST') {
        const body = await readJsonBody(request);
        requireRoleIdList(body.roleIds);
        const result = await service.queryAccounts(body.roleIds);
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      if (pathname === '/api/accounts/refresh' && method === 'POST') {
        const body = await readJsonBody(request);
        requireRoleIdList(body.roleIds);
        const result = await service.refreshAccounts(body.roleIds);
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      const refreshMatch = /^\/api\/accounts\/([^/]+)\/refresh$/.exec(pathname);
      if (refreshMatch && method === 'POST') {
        const result = await service.refreshAccount(decodeURIComponent(refreshMatch[1]));
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      const accountMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
      if (accountMatch && method === 'PATCH') {
        const body = await readJsonBody(request);
        const result = await service.updateAccountBaseline(
          decodeURIComponent(accountMatch[1]),
          body.lastWeekLikes,
          { actor: actorOf() },
        );
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }
      // 公开接口没有 DELETE：主页的「删」只是把这台设备的列表移除，
      // 真正从数据库删账号只能由管理员在后台做（/api/admin/roles/:roleId）

      /* ------------------------------------------------------------ 管理端 */

      if (pathname.startsWith('/api/admin/')) {
        const actor = requireAdmin();

        if (pathname === '/api/admin/overview' && method === 'GET') {
          sendJson(response, 200, { ok: true, data: admin.overview(actor) });
          return true;
        }

        if (pathname === '/api/admin/users' && method === 'GET') {
          sendJson(response, 200, { ok: true, data: { users: admin.listUsers() } });
          return true;
        }

        const userPasswordMatch = /^\/api\/admin\/users\/(\d+)\/password$/.exec(pathname);
        if (userPasswordMatch && method === 'POST') {
          const body = await readJsonBody(request);
          const result = admin.resetPassword(actor, Number(userPasswordMatch[1]), body.newPassword);
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        const userMatch = /^\/api\/admin\/users\/(\d+)$/.exec(pathname);
        if (userMatch && method === 'PATCH') {
          const body = await readJsonBody(request);
          if (body.isSuper !== undefined) {
            throw new HttpError(
              400,
              'SUPER_ADMIN_FIXED',
              '超级管理员全站只有一个，不能在这里指派；要换人在 .env 里改 ADMIN_USERNAME 后重启',
            );
          }
          if (body.isAdmin === undefined) {
            throw new HttpError(400, 'NOTHING_TO_UPDATE', '目前只支持修改 isAdmin');
          }
          const result = admin.setAdmin(actor, Number(userMatch[1]), Boolean(body.isAdmin));
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }
        if (userMatch && method === 'DELETE') {
          const result = admin.deleteUser(actor, Number(userMatch[1]));
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        if (pathname === '/api/admin/roles' && method === 'GET') {
          const roles = admin.listRoles();
          sendJson(response, 200, { ok: true, data: { roles } });
          return true;
        }

        const roleIdChangeMatch = /^\/api\/admin\/roles\/([^/]+)\/role-id$/.exec(pathname);
        if (roleIdChangeMatch && method === 'POST') {
          const body = await readJsonBody(request);
          const result = admin.changeRoleId(
            actor,
            decodeURIComponent(roleIdChangeMatch[1]),
            body.roleId,
          );
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        const roleMatch = /^\/api\/admin\/roles\/([^/]+)$/.exec(pathname);
        if (roleMatch && method === 'PATCH') {
          const body = await readJsonBody(request);
          const result = admin.updateRole(actor, decodeURIComponent(roleMatch[1]), body);
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }
        if (roleMatch && method === 'DELETE') {
          const result = admin.deleteRole(actor, decodeURIComponent(roleMatch[1]));
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        if (pathname === '/api/admin/audit-logs' && method === 'GET') {
          const records = admin.listAudits(Number(url.searchParams.get('limit')) || 60);
          sendJson(response, 200, { ok: true, data: { records } });
          return true;
        }

        if (pathname === '/api/admin/settings' && method === 'GET') {
          sendJson(response, 200, { ok: true, data: admin.getAnnouncement() });
          return true;
        }

        if (pathname === '/api/admin/settings' && method === 'PATCH') {
          const body = await readJsonBody(request);
          if (body.announcement === undefined) {
            throw new HttpError(400, 'NOTHING_TO_UPDATE', '目前只支持修改 announcement');
          }
          const result = admin.updateAnnouncement(actor, body.announcement);
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        if (pathname === '/api/admin/jobs/weekly-settle' && method === 'POST') {
          const body = await readJsonBody(request).catch(() => ({}));
          const result = await service.runWeeklySettlement({
            at: body.at,
            refresh: body.refresh !== false,
            force: body.force === true,
          });
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }

        sendJson(response, 404, {
          ok: false,
          error: { code: 'NOT_FOUND', message: `没有这个管理接口：${method} ${pathname}` },
        });
        return true;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(response, 404, {
          ok: false,
          error: { code: 'NOT_FOUND', message: `没有这个接口：${method} ${pathname}` },
        });
        return true;
      }

      return false;
    } catch (error) {
      const { status, body } = normalizeError(error);
      if (status >= 500) console.error(`[api] ${method} ${pathname} 出错：`, error);
      sendJson(response, status, body);
      return true;
    }
  };
}
