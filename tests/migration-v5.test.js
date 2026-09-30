/**
 * 迁移 v5（roles-rebind-users）测试。
 *
 * 背景：有一版改造把 roles 表的 user_id 去掉了（user_version = 4）。
 * 如果那个库要跑回「账号归属用户」的代码，roles 就少了 user_id、老代码直接报错。
 * v5 负责把它重建回来，并按操作日志把账号挂回「当初添加它的人」。
 *
 * 同时验证：本来就是老结构（roles 已经有 user_id）的库，v5 什么都不改。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../server/lib/db.js';
import { createRepo } from '../server/lib/repo.js';

let dir;
const files = [];

const newFile = (name) => {
  const file = path.join(dir, name);
  files.push(file);
  return file;
};

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimuzhi-mig-v5-'));
});

after(async () => {
  for (const file of files) {
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(`${file}${suffix}`, { force: true });
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
});

/** 造一个「被改造成不绑用户」的库：user_version = 4，roles 没有 user_id */
function makeV4Database(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE, password_hash TEXT,
      is_guest INTEGER NOT NULL DEFAULT 1, is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_seen_at TEXT,
      is_super INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_users_single_super ON users(is_super) WHERE is_super = 1;
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, last_used_at TEXT, user_agent TEXT
    );
    CREATE TABLE roles (
      role_id TEXT PRIMARY KEY, display_name TEXT, region TEXT NOT NULL,
      baseline INTEGER NOT NULL DEFAULT 0, baseline_week_key TEXT, baseline_source TEXT,
      baseline_estimated INTEGER NOT NULL DEFAULT 0, baseline_updated_at TEXT,
      baseline_from_week_key TEXT, profile_json TEXT, current_likes INTEGER, last_queried_at TEXT,
      last_snapshot_likes INTEGER, last_snapshot_week_key TEXT, last_snapshot_at TEXT,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT, detail TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
  `);

  const at = '2026-09-20T00:00:00.000Z';
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, is_guest, is_admin, is_super, created_at) VALUES (?,?,?,?,?,?)',
  );
  insertUser.run('admin', 'x', 0, 1, 1, at);
  insertUser.run('laoban', 'x', 0, 0, 0, at);
  insertUser.run('legacy-import', 'x', 0, 0, 0, at);

  const insertRole = db.prepare(
    `INSERT INTO roles (role_id, display_name, region, baseline, current_likes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  insertRole.run('1111111111', '老板加的号', 'qq', 5000, 5300, at, at);
  insertRole.run('2222222222', '游客加的号', 'wechat', 10, 40, at, at);
  insertRole.run('3333333333', '旧数据导入的号', 'qq', 0, 123, at, at);

  const insertAudit = db.prepare(
    'INSERT INTO audit_logs (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)',
  );
  insertAudit.run('user:2', 'role.add', '1111111111', '{}', at);
  insertAudit.run('guest', 'role.add', '2222222222', '{}', at);
  insertAudit.run('legacy-json', 'legacy.import', 'legacy-json', '{"roleIds":["3333333333"]}', at);

  db.exec('PRAGMA user_version = 4;');
  db.close();
}

test('v4 库（roles 没有 user_id）升级回老结构：账号一个不少，并挂回添加它的人', async () => {
  const file = newFile('v4.db');
  makeV4Database(file);

  const db = openDatabase({ file });
  const repo = createRepo(db);

  const columns = db
    .prepare('PRAGMA table_info(roles)')
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes('user_id'), 'roles 要重新有 user_id 列');
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 5);

  const roles = repo.roles.listAllRoles();
  assert.equal(roles.length, 3, '三个账号都要在');

  const byRoleId = Object.fromEntries(roles.map((role) => [role.roleId, role]));
  assert.equal(byRoleId['1111111111'].baseline, 5000, '基线不能变');
  assert.equal(byRoleId['1111111111'].currentLikes, 5300, '当前点赞不能变');
  assert.equal(byRoleId['1111111111'].userId, 2, '挂回用 role.add 添加它的人');

  // 游客加的、旧数据导入的 → 挂到 legacy-import（和当初老版本的表现一致）
  const legacy = repo.users.getUserByUsername('legacy-import');
  assert.equal(byRoleId['2222222222'].userId, legacy.id);
  assert.equal(byRoleId['3333333333'].userId, legacy.id);

  // 老代码的按用户查询也能用了
  assert.equal(repo.roles.listRolesByUser(2).length, 1);
  assert.equal(repo.users.countUsers(), 3);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('已经是老结构的库（roles 本来就有 user_id）：v5 不动它，归属保持原样', async () => {
  const file = newFile('v3.db');
  const db0 = new DatabaseSync(file);
  db0.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT,
      is_guest INTEGER NOT NULL DEFAULT 1, is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_seen_at TEXT, is_super INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_users_single_super ON users(is_super) WHERE is_super = 1;
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, last_used_at TEXT, user_agent TEXT
    );
    CREATE TABLE roles (
      role_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT, region TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
      baseline_week_key TEXT, baseline_source TEXT, baseline_estimated INTEGER NOT NULL DEFAULT 0,
      baseline_updated_at TEXT, baseline_from_week_key TEXT, profile_json TEXT,
      current_likes INTEGER, last_queried_at TEXT, last_snapshot_likes INTEGER,
      last_snapshot_week_key TEXT, last_snapshot_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT, detail TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
    PRAGMA user_version = 3;
  `);
  const at = '2026-09-20T00:00:00.000Z';
  db0.prepare('INSERT INTO users (id, username, is_guest, is_admin, is_super, created_at) VALUES (2,?,0,0,0,?)').run('laoban', at);
  db0.prepare(
    "INSERT INTO roles (role_id, user_id, display_name, region, baseline, created_at, updated_at) VALUES ('9999999999', 2, '本来就属于老板', 'qq', 777, ?, ?)",
  ).run(at, at);
  db0.close();

  const db = openDatabase({ file });
  const repo = createRepo(db);
  const role = repo.roles.getRole('9999999999');
  assert.equal(role.userId, 2, '归属保持原样，不能被改掉');
  assert.equal(role.baseline, 777);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 5);
  db.close();
});
