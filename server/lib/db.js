/**
 * SQLite 数据库（Node 内置 node:sqlite，仍然零第三方依赖）。
 *
 * 表结构说明：
 *   users     用户（游客不存在数据库里，游客的账号只存浏览器本地）
 *             is_admin = 普通管理员；is_super = 超级管理员（全站唯一，不能被降级/删除）
 *   sessions  登录会话（token 存本地，请求带 Authorization: Bearer <token>）
 *   roles     游戏账号：roleId + 名字 + 大区 + 上周点赞(基线) + 当前总点赞
 *             ★ 昵称只在 display_name 里，用于把 roleId 显示成人看得懂的名字
 *   audit_logs 操作日志（管理员改动留痕）
 *   settings  运行状态（例如「这一周的结算任务已经跑过了」）
 *
 * 用 PRAGMA user_version 做版本化迁移，升级时按顺序补齐，不会丢数据。
 */

import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync;
let sqliteAvailable = true;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  sqliteAvailable = false;
}

export function assertSqliteAvailable() {
  if (sqliteAvailable) return;
  const version = process.version;
  throw new Error(
    [
      `当前 Node.js ${version} 不带内置 SQLite（node:sqlite）。`,
      '  · 推荐：升级到 Node.js 24 LTS（https://nodejs.org/）',
      '  · 或者：用 node --experimental-sqlite server/index.js 启动（Node 22.5 ~ 23.3）',
      '  · 或者：用 Docker 部署（Dockerfile 里已经是 Node 24）',
    ].join('\n'),
  );
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT UNIQUE,
        password_hash TEXT,
        is_guest      INTEGER NOT NULL DEFAULT 1,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token        TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        user_agent   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      -- 角色映射表：昵称（display_name）只存在于这里
      CREATE TABLE IF NOT EXISTS roles (
        role_id              TEXT PRIMARY KEY,
        user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        display_name         TEXT,
        region               TEXT NOT NULL,
        baseline             INTEGER NOT NULL DEFAULT 0,
        baseline_week_key    TEXT,
        baseline_source      TEXT,
        baseline_estimated   INTEGER NOT NULL DEFAULT 0,
        baseline_updated_at  TEXT,
        baseline_from_week_key TEXT,
        profile_json         TEXT,
        current_likes        INTEGER,
        last_queried_at      TEXT,
        last_snapshot_likes  INTEGER,
        last_snapshot_week_key TEXT,
        last_snapshot_at     TEXT,
        last_error           TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_roles_user ON roles(user_id);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

      -- 运行状态键值对（例如「这一周的结算任务已经跑过了」）
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'drop-weekly-likes-and-guests',
    sql: `
      -- 每周点赞不再单独存历史：只保留 roles 上的「上周点赞(基线)」与「当前总点赞」
      DROP TABLE IF EXISTS weekly_likes;

      -- 游客改为纯本地模式（不入库），清掉遗留的、名下没有任何账号的游客行；
      -- 有账号的游客保留，避免外键级联把数据一起删掉
      DELETE FROM users
      WHERE is_guest = 1
        AND id NOT IN (SELECT user_id FROM roles);
    `,
  },
  {
    version: 3,
    name: 'super-admin',
    sql: `
      -- 超级管理员：最高层级，全站只有一个，不能被降级/删除
      ALTER TABLE users ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;

      -- 数据库层直接保证「最多一个超级管理员」，代码写错也插不进第二个
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_super
        ON users(is_super) WHERE is_super = 1;

      -- 已经存在的管理员里，把最早那个设为超级管理员（具体是谁由 ensureAdmin 再校正）
      UPDATE users
      SET is_super = 1
      WHERE is_admin = 1
        AND id = (SELECT MIN(id) FROM users WHERE is_admin = 1);
    `,
  },
];

/** 打开数据库并执行迁移 */
export function openDatabase({ file }) {
  assertSqliteAvailable();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL：读写并发更稳；外键约束必须显式打开
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  migrate(db);
  return db;
}

function getUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function migrate(db) {
  const current = getUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      console.log(`[db] 已应用迁移 v${migration.version}（${migration.name}）`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`数据库迁移 v${migration.version} 失败：${error.message}`);
    }
  }
}

export function closeDatabase(db) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ 行 -> 对象 */

export function rowToUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username ?? null,
    isGuest: Number(row.is_guest) === 1,
    isAdmin: Number(row.is_admin) === 1,
    isSuper: Number(row.is_super ?? 0) === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
  };
}

export function rowToRole(row) {
  if (!row) return null;
  let profile = null;
  if (row.profile_json) {
    try {
      profile = JSON.parse(row.profile_json);
    } catch {
      profile = null;
    }
  }
  return {
    roleId: String(row.role_id),
    userId: Number(row.user_id),
    nickname: row.display_name ?? '',
    region: row.region,
    profile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    baseline: Number(row.baseline ?? 0),
    baselineWeekKey: row.baseline_week_key ?? null,
    baselineSource: row.baseline_source ?? null,
    baselineEstimated: Number(row.baseline_estimated) === 1,
    baselineUpdatedAt: row.baseline_updated_at ?? null,
    baselineFromWeekKey: row.baseline_from_week_key ?? null,

    currentLikes: row.current_likes === null || row.current_likes === undefined ? null : Number(row.current_likes),
    lastQueriedAt: row.last_queried_at ?? null,
    lastSnapshot:
      row.last_snapshot_likes === null || row.last_snapshot_likes === undefined
        ? null
        : {
            likes: Number(row.last_snapshot_likes),
            weekKey: row.last_snapshot_week_key ?? null,
            at: row.last_snapshot_at ?? null,
          },
    lastError: row.last_error ? safeParse(row.last_error) : null,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: String(text) };
  }
}

export function rowToWeeklyLike(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    roleId: String(row.role_id),
    weekKey: row.week_key,
    likes: Number(row.likes),
    source: row.source,
    note: row.note ?? null,
    recordedAt: row.recorded_at,
  };
}

export function rowToAudit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    detail: row.detail ? safeParse(row.detail) : null,
    createdAt: row.created_at,
  };
}

export { sqliteAvailable };
