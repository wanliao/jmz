/**
 * 命令行管理管理员账号（不需要启动服务，直接改数据库）。
 *
 * 用法：
 *   node scripts/create-admin.mjs --list                  列出所有用户（标出超级管理员）
 *   node scripts/create-admin.mjs <账号> <密码>            创建 / 重置为管理员
 *   node scripts/create-admin.mjs <账号> <密码> --no-admin  只建普通用户
 *   node scripts/create-admin.mjs <账号> --promote        把已有用户提为普通管理员
 *   node scripts/create-admin.mjs <账号> --demote         取消普通管理员
 *   node scripts/create-admin.mjs <账号> --super          把超级管理员移交给它（全站唯一）
 *   node scripts/create-admin.mjs <账号> --reset <新密码>  重置密码
 */

import { hashPassword } from '../server/lib/auth.js';
import { loadConfig } from '../server/lib/config.js';
import { openDatabase } from '../server/lib/db.js';
import { createRepo } from '../server/lib/repo.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((item) => item.startsWith('--')));
const positional = argv.filter((item) => !item.startsWith('--'));

const config = loadConfig();
const db = openDatabase({ file: config.dbFile });
const repo = createRepo(db);

function printUsers() {
  const users = repo.users.listUsers();
  if (users.length === 0) {
    console.log('（还没有任何用户）');
    return;
  }
  console.log(`共 ${users.length} 个用户：`);
  for (const user of users) {
    const kind = user.isSuper ? '超级管理员' : user.isAdmin ? '管理员' : user.isGuest ? '游客' : '注册用户';
    console.log(
      `  #${String(user.id).padStart(3)}  ${String(user.username ?? '（无）').padEnd(20)} ${kind.padEnd(6)}  游戏账号 ${user.roleCount} 个`,
    );
  }
  const superUser = repo.users.getSuper();
  console.log(`\n超级管理员：${superUser ? `${superUser.username}（#${superUser.id}）` : '（还没有）'}`);
}

function done(message) {
  console.log(`\n✅ ${message}\n`);
  db.close();
  process.exit(0);
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  db.close();
  process.exit(1);
}

try {
  if (flags.has('--list') || positional.length === 0) {
    printUsers();
    db.close();
    process.exit(0);
  }

  const username = positional[0];
  const existing = repo.users.getUserByUsername(username);

  if (flags.has('--super')) {
    if (!existing) fail(`没有找到用户「${username}」，请先创建`);
    const previous = repo.users.getSuper();
    repo.users.setSuper(existing.id);
    done(
      `超级管理员已移交给「${username}」（#${existing.id}）` +
        (previous && previous.id !== existing.id ? `，原来的「${previous.username ?? `#${previous.id}`}」已降为普通管理员` : ''),
    );
  }

  if (flags.has('--demote')) {
    if (!existing) fail(`没有找到用户「${username}」`);
    if (existing.isSuper) fail('超级管理员不能降级；要换人请用 --super 把超级管理员移交给别人');
    repo.users.setAdmin(existing.id, false);
    done(`已取消「${username}」的管理员权限`);
  }

  if (flags.has('--promote')) {
    if (!existing) fail(`没有找到用户「${username}」，请先创建`);
    repo.users.setAdmin(existing.id, true);
    done(`已把「${username}」提为管理员`);
  }

  if (flags.has('--reset')) {
    const newPassword = positional[1];
    if (!newPassword) fail('用法：node scripts/create-admin.mjs <账号> --reset <新密码>');
    if (!existing) fail(`没有找到用户「${username}」`);
    repo.users.setPassword(existing.id, hashPassword(newPassword));
    repo.sessions.removeUserSessions(existing.id);
    done(`已重置「${username}」的密码（该用户已登录的设备已踢下线）`);
  }

  const password = positional[1];
  if (!password) fail('用法：node scripts/create-admin.mjs <账号> <密码> [--no-admin]');

  const asAdmin = !flags.has('--no-admin');
  if (existing) {
    repo.users.setPassword(existing.id, hashPassword(password));
    if (asAdmin) repo.users.setAdmin(existing.id, true);
    repo.sessions.removeUserSessions(existing.id);
    done(`已更新「${username}」的密码${asAdmin ? '，并确保是管理员' : ''}`);
  } else {
    const user = repo.users.createUser({
      username,
      passwordHash: hashPassword(password),
      isAdmin: asAdmin,
    });
    done(`已创建${asAdmin ? '管理员' : '用户'}「${username}」（id=${user.id}）`);
  }
} catch (error) {
  fail(error.message);
}
