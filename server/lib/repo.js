/**
 * 数据访问层：所有 SQL 都集中在这里，业务代码只调方法。
 * 想换 MySQL / Postgres，替换本文件即可。
 */

import { rowToAudit, rowToRole, rowToUser } from './db.js';

const nowIso = (value = new Date()) => new Date(value).toISOString();

export function createRepo(db) {
  const stmt = (sql) => db.prepare(sql);

  /* ------------------------------------------------------------------ users */

  const insertUser = stmt(
    `INSERT INTO users (username, password_hash, is_guest, is_admin, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectUserById = stmt('SELECT * FROM users WHERE id = ?');
  const selectUserByUsername = stmt('SELECT * FROM users WHERE username = ?');
  const updateLastSeen = stmt('UPDATE users SET last_seen_at = ? WHERE id = ?');
  const updateAdminFlag = stmt('UPDATE users SET is_admin = ? WHERE id = ?');
  const clearSuper = stmt('UPDATE users SET is_super = 0 WHERE is_super = 1');
  const setSuperFlag = stmt('UPDATE users SET is_admin = 1, is_super = 1 WHERE id = ?');
  const updatePassword = stmt('UPDATE users SET password_hash = ? WHERE id = ?');
  const deleteUserStmt = stmt('DELETE FROM users WHERE id = ?');
  const listUsersStmt = stmt(`
    SELECT u.*
    FROM users u
    ORDER BY u.is_guest ASC, u.id DESC
  `);
  const countUsersStmt = stmt('SELECT COUNT(*) AS total FROM users');

  function createUser({ username, passwordHash, isAdmin = false }) {
    const at = nowIso();
    const info = insertUser.run(username, passwordHash, 0, isAdmin ? 1 : 0, at, at);
    return rowToUser(selectUserById.get(Number(info.lastInsertRowid)));
  }

  const getUser = (id) => rowToUser(selectUserById.get(Number(id)));
  const getUserByUsername = (username) => rowToUser(selectUserByUsername.get(String(username)));
  const touchUser = (id, at = new Date()) => updateLastSeen.run(nowIso(at), Number(id));

  /** 设置/取消普通管理员（超级管理员不受影响，它由 setSuper 单独管） */
  const setAdmin = (id, isAdmin) => updateAdminFlag.run(isAdmin ? 1 : 0, Number(id)).changes > 0;

  /**
   * 把超级管理员移交给某个用户（全站唯一）。
   * 事务里先清掉旧的，再设新的 —— 顺序不能反，否则会撞上唯一索引。
   */
  function setSuper(id) {
    const target = getUser(id);
    if (!target) return false;
    db.exec('BEGIN');
    try {
      clearSuper.run();
      setSuperFlag.run(Number(id));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  const getSuper = () => listUsersStmt.all().map(rowToUser).find((user) => user.isSuper) ?? null;
  const setPassword = (id, passwordHash) => updatePassword.run(passwordHash, Number(id));

  function deleteUser(id) {
    return deleteUserStmt.run(Number(id)).changes > 0;
  }

  function listUsers() {
    return listUsersStmt.all().map(rowToUser);
  }

  const countUsers = () => Number(countUsersStmt.get()?.total ?? 0);

  /* --------------------------------------------------------------- sessions */

  const insertSession = stmt(
    'INSERT INTO sessions (token, user_id, created_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  );
  const selectSession = stmt('SELECT * FROM sessions WHERE token = ?');
  const touchSession = stmt('UPDATE sessions SET last_used_at = ? WHERE token = ?');
  const deleteSession = stmt('DELETE FROM sessions WHERE token = ?');
  const deleteUserSessions = stmt('DELETE FROM sessions WHERE user_id = ?');
  const countSessionsByUser = stmt('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?');

  function createSession({ token, userId, userAgent = null }) {
    const at = nowIso();
    insertSession.run(token, Number(userId), at, at, userAgent);
    return { token, userId: Number(userId), createdAt: at };
  }

  function getSession(token) {
    const row = selectSession.get(String(token));
    if (!row) return null;
    return {
      token: row.token,
      userId: Number(row.user_id),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
    };
  }

  const touchSessionToken = (token, at = new Date()) => touchSession.run(nowIso(at), String(token));
  const removeSession = (token) => deleteSession.run(String(token)).changes > 0;
  const removeUserSessions = (userId) => deleteUserSessions.run(Number(userId)).changes;
  const countSessions = (userId) => Number(countSessionsByUser.get(Number(userId))?.total ?? 0);

  /* ------------------------------------------------------------------ roles */

  const insertRole = stmt(`
    INSERT INTO roles (
      role_id, display_name, region, baseline, baseline_week_key, baseline_source,
      baseline_estimated, baseline_updated_at, baseline_from_week_key, profile_json,
      current_likes, last_queried_at, last_snapshot_likes, last_snapshot_week_key, last_snapshot_at,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRole = stmt('SELECT * FROM roles WHERE role_id = ?');
  const selectAllRoles = stmt('SELECT * FROM roles ORDER BY created_at ASC, role_id ASC');
  const deleteRoleStmt = stmt('DELETE FROM roles WHERE role_id = ?');
  const countRolesStmt = stmt('SELECT COUNT(*) AS total FROM roles');
  const countRolesBySource = stmt(
    'SELECT baseline_source AS source, COUNT(*) AS total FROM roles GROUP BY baseline_source',
  );

  // 支持 snake_case 和 camelCase 两种写法，调用方写起来更自然
  const ROLE_COLUMNS = {
    display_name: 'display_name',
    displayName: 'display_name',
    region: 'region',
    baseline: 'baseline',
    baseline_week_key: 'baseline_week_key',
    baselineWeekKey: 'baseline_week_key',
    baseline_source: 'baseline_source',
    baselineSource: 'baseline_source',
    baseline_estimated: 'baseline_estimated',
    baselineEstimated: 'baseline_estimated',
    baseline_updated_at: 'baseline_updated_at',
    baselineUpdatedAt: 'baseline_updated_at',
    baseline_from_week_key: 'baseline_from_week_key',
    baselineFromWeekKey: 'baseline_from_week_key',
    profile_json: 'profile_json',
    profile: 'profile_json',
    current_likes: 'current_likes',
    currentLikes: 'current_likes',
    last_queried_at: 'last_queried_at',
    lastQueriedAt: 'last_queried_at',
    last_snapshot_likes: 'last_snapshot_likes',
    lastSnapshotLikes: 'last_snapshot_likes',
    last_snapshot_week_key: 'last_snapshot_week_key',
    lastSnapshotWeekKey: 'last_snapshot_week_key',
    last_snapshot_at: 'last_snapshot_at',
    lastSnapshotAt: 'last_snapshot_at',
    last_error: 'last_error',
    lastError: 'last_error',
    updated_at: 'updated_at',
    updatedAt: 'updated_at',
  };

  function createRole(role) {
    const at = nowIso();
    insertRole.run(
      String(role.roleId),
      role.nickname ?? null,
      role.region ?? '',
      Number(role.baseline ?? 0),
      role.baselineWeekKey ?? null,
      role.baselineSource ?? null,
      role.baselineEstimated ? 1 : 0,
      role.baselineUpdatedAt ?? null,
      role.baselineFromWeekKey ?? null,
      role.profile ? JSON.stringify(role.profile) : null,
      role.currentLikes ?? null,
      role.lastQueriedAt ?? null,
      role.lastSnapshot?.likes ?? null,
      role.lastSnapshot?.weekKey ?? null,
      role.lastSnapshot?.at ?? null,
      role.lastError ? JSON.stringify(role.lastError) : null,
      role.createdAt ?? at,
      role.updatedAt ?? at,
    );
    return getRole(role.roleId);
  }

  const getRole = (roleId) => rowToRole(selectRole.get(String(roleId)));
  const listAllRoles = () => selectAllRoles.all().map(rowToRole);
  const deleteRole = (roleId) => deleteRoleStmt.run(String(roleId)).changes > 0;
  const countRoles = () => Number(countRolesStmt.get()?.total ?? 0);
  const countRolesByBaselineSource = () =>
    countRolesBySource.all().map((row) => ({ source: row.source ?? 'unknown', total: Number(row.total) }));

  /** 局部更新（只写传进来的字段），updated_at 自动带上 */
  function updateRole(roleId, patch = {}) {
    const assignments = [];
    const values = [];
    const written = new Set();
    for (const [key, column] of Object.entries(ROLE_COLUMNS)) {
      if (!(key in patch)) continue;
      if (written.has(column)) continue; // camelCase 与 snake_case 同时出现时以先出现的为准
      let value = patch[key];
      if (column === 'baseline_estimated') value = value ? 1 : 0;
      if (column === 'profile_json' && value !== null && typeof value === 'object') {
        value = JSON.stringify(value);
      }
      if (column === 'last_error' && value !== null && typeof value === 'object') {
        value = JSON.stringify(value);
      }
      written.add(column);
      assignments.push(`${column} = ?`);
      values.push(value ?? null);
    }
    if (!written.has('updated_at')) {
      assignments.push('updated_at = ?');
      values.push(nowIso());
    }
    if (assignments.length === 0) return getRole(roleId);
    values.push(String(roleId));
    db.prepare(`UPDATE roles SET ${assignments.join(', ')} WHERE role_id = ?`).run(...values);
    return getRole(roleId);
  }

  /** 改 roleId（主键）：事务内复制行到新主键，再删旧行 */
  function changeRoleId(oldRoleId, newRoleId) {
    const from = String(oldRoleId);
    const to = String(newRoleId);
    if (from === to) return getRole(from);
    if (getRole(to)) {
      const error = new Error(`roleId ${to} 已存在`);
      error.code = 'ROLE_ID_EXISTS';
      throw error;
    }
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO roles (
           role_id, display_name, region, baseline, baseline_week_key, baseline_source,
           baseline_estimated, baseline_updated_at, baseline_from_week_key, profile_json,
           current_likes, last_queried_at, last_snapshot_likes, last_snapshot_week_key, last_snapshot_at,
           last_error, created_at, updated_at
         )
         SELECT ?, display_name, region, baseline, baseline_week_key, baseline_source,
                baseline_estimated, baseline_updated_at, baseline_from_week_key, profile_json,
                current_likes, last_queried_at, last_snapshot_likes, last_snapshot_week_key, last_snapshot_at,
                last_error, created_at, updated_at
         FROM roles WHERE role_id = ?`,
      ).run(to, from);
      db.prepare('DELETE FROM roles WHERE role_id = ?').run(from);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getRole(to);
  }

  /* ------------------------------------------------------------ audit_logs */

  const insertAudit = stmt(
    'INSERT INTO audit_logs (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectAudits = stmt('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?');

  function log({ actor, action, target = null, detail = null, at = new Date() }) {
    insertAudit.run(
      String(actor),
      String(action),
      target === null ? null : String(target),
      detail === null ? null : JSON.stringify(detail),
      nowIso(at),
    );
  }

  const listAudits = (limit = 50) => selectAudits.all(Number(limit)).map(rowToAudit);

  /**
   * 每个游戏账号「是谁添加的」——从操作日志里取（roles 表本身不记归属）。
   * 返回 Map<roleId, actor>，同一个 roleId 有多次记录时以最新一次为准。
   */
  const selectRoleAddActors = stmt(`
    SELECT target, actor, MAX(id) AS last_id
    FROM audit_logs
    WHERE action = 'role.add' AND target IS NOT NULL
    GROUP BY target
  `);

  function roleAddActors() {
    const map = new Map();
    for (const row of selectRoleAddActors.all()) map.set(String(row.target), String(row.actor));
    return map;
  }

  /* -------------------------------------------------------------- settings */

  const selectSetting = stmt('SELECT value FROM settings WHERE key = ?');
  const upsertSetting = stmt(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const selectAllSettings = stmt('SELECT key, value FROM settings');

  const getSetting = (key) => selectSetting.get(String(key))?.value ?? null;
  const setSetting = (key, value) => {
    upsertSetting.run(String(key), value === null || value === undefined ? null : String(value), nowIso());
    return value;
  };
  const allSettings = () =>
    Object.fromEntries(selectAllSettings.all().map((row) => [row.key, row.value]));

  /* ------------------------------------------------------------------ 统计 */

  function stats() {
    return {
      users: countUsers(),
      roles: countRoles(),
      byBaselineSource: countRolesByBaselineSource(),
    };
  }

  return {
    raw: db,
    users: {
      createUser,
      getUser,
      getUserByUsername,
      touchUser,
      setAdmin,
      setSuper,
      getSuper,
      setPassword,
      deleteUser,
      listUsers,
      countUsers,
    },
    sessions: {
      createSession,
      getSession,
      touchSession: touchSessionToken,
      removeSession,
      removeUserSessions,
      countSessions,
    },
    roles: {
      createRole,
      getRole,
      listAllRoles,
      updateRole,
      changeRoleId,
      deleteRole,
      countRoles,
    },
    audit: { log, listAudits, roleAddActors },
    settings: { get: getSetting, set: setSetting, all: allSettings },
    stats,
  };
}
