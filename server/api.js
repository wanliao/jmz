/**
 * HTTP API 路由。约定：成功返回 { ok: true, data }，失败返回 { ok: false, error }。
 *
 * 本地模式（未登录即可用，不落库，账号存在浏览器里）：
 *   POST   /api/local/add                 昵称+大区 → roleId（接口A，顺带点赞数与档案）
 *   POST   /api/local/sync                刷新一批本地账号（接口B）
 *   POST   /api/local/baseline            修正本地账号的「上周点赞数」
 *
 * 认证：
 *   POST   /api/auth/register             注册
 *   POST   /api/auth/login                登录
 *   POST   /api/auth/logout               退出登录
 *   GET    /api/auth/me                   当前身份
 *   POST   /api/auth/password             修改自己的密码
 *
 * 用户自己的数据（需登录态）：
 *   GET    /api/accounts                  账号列表（只返回自己的）
 *   POST   /api/accounts                  添加账号
 *   POST   /api/accounts/import           注册后把本地账号搬上云
 *   POST   /api/accounts/refresh          刷新全部
 *   POST   /api/accounts/:roleId/refresh  刷新单个
 *   PATCH  /api/accounts/:roleId          修正上周点赞数
 *   DELETE /api/accounts/:roleId          删除
 *
 * 管理员（需 is_admin）：
 *   GET    /api/admin/overview
 *   GET    /api/admin/users                GET /api/admin/users/:id
 *   PATCH  /api/admin/users/:id            设为/取消管理员
 *   POST   /api/admin/users/:id/password   重置该用户密码
 *   DELETE /api/admin/users/:id
 *   GET    /api/admin/roles
 *   PATCH  /api/admin/roles/:roleId        改名 / 改大区 / 改基线 / 改当前点赞
 *   POST   /api/admin/roles/:roleId/role-id 改 roleId（主键）
 *   POST   /api/admin/roles/:roleId/owner   改归属
 *   DELETE /api/admin/roles/:roleId
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

export function createApiHandler({ service, admin, auth, local }) {
  return async function handleApi(request, response, url) {
    const { pathname } = url;
    const method = (request.method ?? 'GET').toUpperCase();

    const token = bearerToken(request);
    const resolved = token ? auth.resolveToken(token) : null;
    const currentUser = resolved?.user ?? null;

    const requireUser = () => {
      if (!currentUser) {
        throw new HttpError(401, 'UNAUTHORIZED', '请先登录（游客身份也需要先获取一个身份）');
      }
      return currentUser;
    };

    const requireAdmin = () => {
      const user = requireUser();
      if (!user.isAdmin) throw new HttpError(403, 'FORBIDDEN', '需要管理员权限');
      return user;
    };

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

      /* ------------------------------------------------------- 本地模式（不落库） */

      if (pathname.startsWith('/api/local/')) {
        if (!local.enabled) {
          throw new HttpError(403, 'LOCAL_MODE_DISABLED', '本地模式已被服务端关闭，请先注册账号');
        }
        if (pathname === '/api/local/add' && method === 'POST') {
          const body = await readJsonBody(request);
          const result = await local.add({
            nickname: body.nickname,
            region: body.region,
            lastWeekLikes: body.lastWeekLikes,
          });
          sendJson(response, 201, { ok: true, data: result });
          return true;
        }
        if (pathname === '/api/local/sync' && method === 'POST') {
          const body = await readJsonBody(request);
          const result = await local.sync({ accounts: body.accounts });
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }
        if (pathname === '/api/local/baseline' && method === 'POST') {
          const body = await readJsonBody(request);
          const result = await local.setBaseline({
            account: body.account,
            lastWeekLikes: body.lastWeekLikes,
          });
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }
        if (pathname === '/api/local/settle' && method === 'POST') {
          const body = await readJsonBody(request);
          const result = await local.settleOnly({ accounts: body.accounts });
          sendJson(response, 200, { ok: true, data: result });
          return true;
        }
        sendJson(response, 404, {
          ok: false,
          error: { code: 'NOT_FOUND', message: `没有这个本地接口：${method} ${pathname}` },
        });
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
            roleCount: currentUser ? service.repo.roles.listRolesByUser(currentUser.id).length : 0,
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

      if (pathname === '/api/accounts' && method === 'GET') {
        const user = requireUser();
        const accounts = await service.listAccounts(user.id);
        sendJson(response, 200, {
          ok: true,
          data: { accounts, ...service.getRuntimeInfo(), user },
        });
        return true;
      }

      if (pathname === '/api/accounts' && method === 'POST') {
        const user = requireUser();
        const body = await readJsonBody(request);
        const result = await service.addAccount(user.id, {
          nickname: body.nickname,
          region: body.region,
          lastWeekLikes: body.lastWeekLikes,
        });
        sendJson(response, 201, { ok: true, data: result });
        return true;
      }

      if (pathname === '/api/accounts/import' && method === 'POST') {
        const user = requireUser();
        const body = await readJsonBody(request);
        const result = await service.importLocalAccounts(user.id, body.accounts);
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      if (pathname === '/api/accounts/refresh' && method === 'POST') {
        const user = requireUser();
        const result = await service.refreshAll(user.id);
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      const refreshMatch = /^\/api\/accounts\/([^/]+)\/refresh$/.exec(pathname);
      if (refreshMatch && method === 'POST') {
        const user = requireUser();
        const result = await service.refreshAccount(user.id, decodeURIComponent(refreshMatch[1]));
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      const accountMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
      if (accountMatch && method === 'PATCH') {
        const user = requireUser();
        const body = await readJsonBody(request);
        const result = await service.updateAccountBaseline(
          user.id,
          decodeURIComponent(accountMatch[1]),
          body.lastWeekLikes,
        );
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

      if (accountMatch && method === 'DELETE') {
        const user = requireUser();
        const result = await service.removeAccount(user.id, decodeURIComponent(accountMatch[1]));
        sendJson(response, 200, { ok: true, data: result });
        return true;
      }

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
        if (userMatch && method === 'GET') {
          sendJson(response, 200, { ok: true, data: admin.getUserDetail(Number(userMatch[1])) });
          return true;
        }
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
          const roles = admin.listRoles({
            userId: url.searchParams.get('userId') ? Number(url.searchParams.get('userId')) : null,
          });
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

        const roleOwnerMatch = /^\/api\/admin\/roles\/([^/]+)\/owner$/.exec(pathname);
        if (roleOwnerMatch && method === 'POST') {
          const body = await readJsonBody(request);
          const result = admin.transferRole(
            actor,
            decodeURIComponent(roleOwnerMatch[1]),
            body.userId,
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
