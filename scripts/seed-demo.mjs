/**
 * 生成几个演示账号，方便第一次打开页面就能看到卡片效果（仅 Mock 适配器下有意义的假数据）。
 * 用法：node scripts/seed-demo.mjs [baseUrl]
 * 清理：node scripts/seed-demo.mjs --clean（直接删数据库里的这几条）
 *
 * 注意：账号是存在服务器上的，但**主页只显示每台设备自己添加过的账号**。
 * 所以造完之后，在页面上用下面同样的昵称「添加」一次就能看到（会直接认领，
 * 不会再查接口 A，也不会覆盖脚本设置好的基线）。
 */

import { loadConfig } from '../server/lib/config.js';
import { openDatabase } from '../server/lib/db.js';
import { createRepo } from '../server/lib/repo.js';

const baseUrl = (process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const clean = process.argv.includes('--clean');

const DEMO = [
  { nickname: '演示账号·已刷满', region: 'wechat', target: 350 },
  { nickname: '演示账号·微信区', region: 'wechat', target: 128 },
  { nickname: '演示账号·QQ区', region: 'qq', target: 46 },
];

async function call(pathname, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, json: null };
  }
}

/** 清理时直接开库按昵称找（不需要管理员账号，也不需要服务在跑） */
function withRepo(fn) {
  const config = loadConfig();
  const db = openDatabase({ file: config.dbFile });
  try {
    return fn(createRepo(db), config);
  } finally {
    db.close();
  }
}

if (clean) {
  const removed = withRepo((repo) => {
    const names = new Set(DEMO.map((item) => item.nickname));
    const targets = repo.roles.listAllRoles().filter((role) => names.has(role.nickname));
    for (const role of targets) repo.roles.deleteRole(role.roleId);
    return targets;
  });
  console.log(`已从数据库删除 ${removed.length} 个演示账号${removed.length ? `：${removed.map((r) => r.nickname).join('、')}` : ''}`);
  process.exit(0);
}

const health = await call('/api/health');
if (health.status !== 200) {
  console.error(`连不上 ${baseUrl}，服务是不是没启动？`);
  process.exit(1);
}

for (const item of DEMO) {
  // 已经在库里就会直接被「认领」（claimed=true），不会重复入库
  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname: item.nickname, region: item.region, lastWeekLikes: 0 },
  });
  const account = created.json?.data?.account;
  if (!account) {
    console.error(`创建失败：${item.nickname} — ${created.json?.error?.message ?? created.status}`);
    continue;
  }

  // 把基线调成「当前总点赞 − 想让页面显示的本周已刷」，看起来更真实
  const baseline = Math.max(0, (account.currentLikes ?? 0) - item.target);
  const patched = await call(`/api/accounts/${account.roleId}`, {
    method: 'PATCH',
    body: { lastWeekLikes: baseline },
  });
  const final = patched.json?.data?.account ?? account;
  console.log(
    `${item.nickname}（${item.region}）roleId=${final.roleId} 当前总点赞=${final.currentLikes} 上周=${final.baseline} 本周已刷=${final.weekLikes}${created.json?.data?.claimed ? '  [已存在，直接认领]' : ''}`,
  );
}

console.log('\n这些账号已经存在服务器上了（管理后台的「游戏账号」里看得到）。');
console.log('主页只显示你在这台设备上加过的账号，所以想看效果就打开页面，用上面同样的昵称各「添加」一次：');
console.log(`  ${DEMO.map((item) => item.nickname).join('  /  ')}`);
console.log('添加时会直接认领（不查接口、不覆盖上面的基线）。清理：npm run seed:clean');
