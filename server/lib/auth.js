/**
 * 认证：注册 / 登录 / 会话。
 *
 * 设计要点：
 *  - 没有「游客用户」：未登录时前端走**本地模式**，游戏账号只存浏览器，不入库；
 *  - 密码用 PBKDF2-SHA256 + 随机盐哈希存储，绝不存明文；
 *  - 会话 token 存在浏览器 localStorage，请求带 Authorization: Bearer <token>。
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const PBKDF2_ITERATIONS = 120_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'admin123';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return `pbkdf2$${DIGEST}$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterations, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length === 0) return false;
  const candidate = pbkdf2Sync(String(password), salt, Number(iterations), expected.length, digest);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createToken() {
  return randomBytes(32).toString('base64url');
}

/** 校验用户名：只要求非空、长度合理（按需求「不做验证」） */
export function validateCredentials(username, password) {
  const name = String(username ?? '').trim();
  if (name === '') return { ok: false, message: '请输入账号' };
  if (name.length > 32) return { ok: false, message: '账号最长 32 个字符' };
  if (/\s/.test(name)) return { ok: false, message: '账号不能包含空格' };
  const pass = String(password ?? '');
  if (pass === '') return { ok: false, message: '请输入密码' };
  if (pass.length > 128) return { ok: false, message: '密码太长了' };
  return { ok: true, username: name, password: pass };
}

export function createAuthService({ repo, config }) {
  const getHash = (userId) => {
    const row = repo.raw.prepare('SELECT password_hash FROM users WHERE id = ?').get(Number(userId));
    return row?.password_hash ?? null;
  };

  function issueSession(user, { userAgent = null } = {}) {
    const token = createToken();
    repo.sessions.createSession({ token, userId: user.id, userAgent });
    return token;
  }

  return {
    /**
     * 注册。当前若已登录（一般不会）也只新建账号，不影响已有账号。
     * 未登录时前端攒在浏览器里的游戏账号，注册后由 /api/accounts/import 搬到云端。
     */
    register({ username, password, currentUser = null, userAgent = null }) {
      const valid = validateCredentials(username, password);
      if (!valid.ok) {
        const error = new Error(valid.message);
        error.status = 400;
        error.code = 'INVALID_CREDENTIALS';
        throw error;
      }

      const existing = repo.users.getUserByUsername(valid.username);
      if (existing) {
        const error = new Error(`账号「${valid.username}」已经被注册了，换一个或者直接登录`);
        error.status = 409;
        error.code = 'USERNAME_TAKEN';
        throw error;
      }

      const user = repo.users.createUser({
        username: valid.username,
        passwordHash: hashPassword(valid.password),
      });
      const token = issueSession(user, { userAgent });
      repo.audit.log({
        actor: `user:${user.id}`,
        action: 'auth.register',
        target: user.id,
        detail: { username: valid.username, fromUser: currentUser?.id ?? null },
      });
      return { token, user };
    },

    /** 登录已有账号 */
    login({ username, password, currentUser = null, userAgent = null }) {
      const valid = validateCredentials(username, password);
      if (!valid.ok) {
        const error = new Error(valid.message);
        error.status = 400;
        error.code = 'INVALID_CREDENTIALS';
        throw error;
      }

      const row = repo.users.getUserByUsername(valid.username);
      if (!row || row.isGuest || !verifyPassword(valid.password, getHash(row.id))) {
        const error = new Error('账号或密码不对');
        error.status = 401;
        error.code = 'BAD_CREDENTIALS';
        throw error;
      }

      const token = issueSession(row, { userAgent });
      repo.users.touchUser(row.id);

      repo.audit.log({ actor: `user:${row.id}`, action: 'auth.login', target: row.id });
      return { token, user: row };
    },

    logout(token) {
      if (!token) return false;
      const removed = repo.sessions.removeSession(token);
      return removed;
    },

    /** 用 token 换取当前用户（顺带更新 last_used_at，最多每分钟一次） */
    resolveToken(token) {
      if (!token) return null;
      const session = repo.sessions.getSession(token);
      if (!session) return null;
      const user = repo.users.getUser(session.userId);
      if (!user) {
        repo.sessions.removeSession(token);
        return null;
      }
      const lastUsed = session.lastUsedAt ? new Date(session.lastUsedAt).getTime() : 0;
      if (Date.now() - lastUsed > 60_000) repo.sessions.touchSession(token);
      return { user, session };
    },

    /** 改密码（管理员界面 / 个人设置都能用） */
    changePassword({ user, oldPassword, newPassword, requireOld = true }) {
      if (requireOld && !verifyPassword(oldPassword, getHash(user.id))) {
        const error = new Error('原密码不对');
        error.status = 401;
        error.code = 'BAD_CREDENTIALS';
        throw error;
      }
      const valid = validateCredentials(user.username ?? 'x', newPassword);
      if (!valid.ok) {
        const error = new Error(valid.message);
        error.status = 400;
        error.code = 'INVALID_CREDENTIALS';
        throw error;
      }
      repo.users.setPassword(user.id, hashPassword(newPassword));
      repo.audit.log({ actor: `user:${user.id}`, action: 'auth.password', target: user.id });
      return true;
    },

    /** 当前管理员是否还在用默认密码（用来在后台顶部挂警告横幅） */
    isUsingDefaultAdminPassword(user) {
      if (!user?.isAdmin) return false;
      return verifyPassword(DEFAULT_ADMIN_PASSWORD, getHash(user.id));
    },
  };
}

/**
 * 启动时保证管理员状态正确。
 *
 * 规则：**超级管理员全站只有一个**，就是 ADMIN_USERNAME 指定的那个账号
 * （没配就是默认的 admin）。这个账号不存在就创建它；如果超级管理员是别的账号，
 * 就把超级管理员移交给它（旧的那个降为普通管理员，不删号）。
 */
export function ensureAdmin({ repo, config, logger = console }) {
  const configured = String(config.adminUsername ?? '').trim();
  const username = configured || DEFAULT_ADMIN_USERNAME;
  const password = String(config.adminPassword ?? '').trim();

  let user = repo.users.getUserByUsername(username);

  if (!user) {
    // 配了自定义账号却没给密码：不能凭空建一个没密码的管理员
    if (configured && !password) {
      logger.warn(
        `[auth] 配了 ADMIN_USERNAME=${configured} 却没有 ADMIN_PASSWORD，无法创建它；` +
          '请在 .env 里补上密码，或用 npm run admin -- 账号 密码 创建',
      );
      const superUser = repo.users.getSuper();
      return { created: false, username: configured, defaultPassword: false, superUsername: superUser?.username ?? null };
    }
    user = repo.users.createUser({
      username,
      passwordHash: hashPassword(password || DEFAULT_ADMIN_PASSWORD),
      isAdmin: true,
    });
    logger.log(`[auth] 已创建管理员：${username}（id=${user.id}）`);
  } else if (!user.isAdmin) {
    repo.users.setAdmin(user.id, true);
  }

  // 超级管理员唯一：移交给这个账号
  const currentSuper = repo.users.getSuper();
  if (!currentSuper || currentSuper.id !== user.id) {
    repo.users.setSuper(user.id);
    if (currentSuper) {
      logger.log(
        `[auth] 超级管理员已从「${currentSuper.username ?? `#${currentSuper.id}`}」移交给「${username}」` +
          '（旧账号保留为普通管理员）',
      );
    }
  }

  const usingDefaultPassword = !configured && (!password || password === DEFAULT_ADMIN_PASSWORD);
  if (usingDefaultPassword && !repo.settings.get('defaultAdminWarned')) {
    repo.settings.set('defaultAdminWarned', new Date().toISOString());
    logger.warn(
      [
        '',
        `  ⚠️  超级管理员「${username}」当前用的是默认密码 ${DEFAULT_ADMIN_PASSWORD}`,
        '      请登录后到「管理后台 → 修改我的密码」立刻改掉，或启动前在 .env 里配置：',
        '        ADMIN_USERNAME=你的账号',
        '        ADMIN_PASSWORD=你的密码',
        '',
      ].join('\n'),
    );
  }

  return {
    created: !currentSuper,
    username,
    defaultPassword: usingDefaultPassword,
    superUsername: username,
  };
}
