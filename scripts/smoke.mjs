/**
 * 冒烟测试：对一个正在运行的服务跑一遍完整接口流程。
 *
 * 用法：
 *   node scripts/smoke.mjs                                    # 只读检查（不会写任何数据）
 *   node scripts/smoke.mjs --nickname 你的角色名 --zone 1       # 顺便测「添加 → 认领 → 刷新 → 改基线」
 *   node scripts/smoke.mjs --nickname 角色名 --admin admin:密码  # 测完顺手把临时账号从库里删掉
 *
 * 说明：
 *   - 账号全站唯一、不绑用户，未登录也能添加；但列表是「本机视图」：
 *     读账号必须给 roleIds，服务端不会下发全库列表；
 *   - 真实接口模式下「添加账号」会真的查一次接口 A，所以必须显式给 --nickname 才测写入。
 */

const argv = process.argv.slice(2);
const argValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const baseUrl = (
  argv.find((item) => item.startsWith('http')) ??
  process.env.BASE_URL ??
  'http://127.0.0.1:8787'
).replace(/\/$/, '');
const realNickname = argValue('--nickname');
const realZone = Number(argValue('--zone') ?? 1);
const adminCred = argValue('--admin');

let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

async function call(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

console.log(`\n对 ${baseUrl} 进行冒烟测试…\n`);

console.log('[1] 健康检查 / 运行配置 / 静态资源');
const health = await call('/api/health');
check('GET /api/health', health.status === 200 && health.json?.ok === true, health.json?.data?.status);
const config = await call('/api/config');
const adapterMode = config.json?.data?.adapterMode;
check('GET /api/config', config.status === 200 && config.json?.data?.weeklyCap === 350,
  `适配器=${adapterMode} 时区=${config.json?.data?.timeZone}`);
check('游戏周起点在下周之前', config.json?.data?.week?.startMs < config.json?.data?.week?.endMs,
  `本周 ${config.json?.data?.week?.key}`);
const home = await call('/');
check('GET / 返回前端页面', home.status === 200 && home.text.includes('金拇指'));
const adminPage = await call('/admin.html');
check('GET /admin.html 返回管理后台', adminPage.status === 200 && adminPage.text.includes('管理后台'));
const shared = await call('/shared/constants.js');
check('GET /shared/constants.js', shared.status === 200 && shared.text.includes('WEEKLY_LIKE_CAP'));

console.log('\n[2] 账号接口：不需要登录，但读列表必须给 roleIds（别想拉走全库）');
const legacyList = await call('/api/accounts');
check('旧的「列出全部账号」接口已移除（404）', legacyList.status === 404);
const noIds = await call('/api/accounts/query', { method: 'POST', body: {} });
check('不给 roleIds 查询被拒（400 INVALID_ROLE_IDS）',
  noIds.status === 400 && noIds.json?.error?.code === 'INVALID_ROLE_IDS');
const emptyQuery = await call('/api/accounts/query', { method: 'POST', body: { roleIds: [] } });
check('空 roleIds 返回空列表（不会下发全库）',
  emptyQuery.status === 200 && emptyQuery.json?.data?.accounts?.length === 0);
const guestEndpoint = await call('/api/auth/guest', { method: 'POST' });
check('旧的游客接口已移除（404）', guestEndpoint.status === 404);
const localEndpoint = await call('/api/local/settle', { method: 'POST', body: { accounts: [] } });
check('旧的本地模式接口已移除（404）', localEndpoint.status === 404);
const me = await call('/api/auth/me');
check('未登录时 /api/auth/me 返回 user: null', me.status === 200 && me.json?.data?.user === null);
const adminGuard = await call('/api/admin/overview');
check('未登录访问管理接口返回 401', adminGuard.status === 401, adminGuard.json?.error?.code);

// ---- 写入流程：mock 模式随便测；真实接口模式必须给真实角色名 ----
const canWrite = adapterMode === 'mock' || Boolean(realNickname);
let createdRoleId = null;

if (!canWrite) {
  console.log('\n[3] 跳过「添加账号」写入流程');
  console.log('    当前是真实接口模式：加账号会真的调用接口 A 查询角色。');
  console.log('    要测这条路径就带上真实角色名，例如：');
  console.log('      node scripts/smoke.mjs --nickname 你的角色名 --zone 1     (1 = QQ区, 2 = 微信区)');
} else {
  console.log('\n[3] 未登录（游客）直接走一遍写入流程');

  const nickname = realNickname ?? `冒烟测试${Date.now().toString().slice(-6)}`;
  const region = realNickname ? (realZone === 2 ? 'wechat' : 'qq') : 'qq';

  const created = await call('/api/accounts', {
    method: 'POST',
    body: { nickname, region, lastWeekLikes: 1000 },
  });
  check('POST /api/accounts（不登录也能添加）',
    created.status === 201 || (created.status === 200 && created.json?.data?.claimed === true),
    created.json?.error?.message ?? '');
  const account = created.json?.data?.account;
  createdRoleId = account?.roleId ?? null;
  check('拿到隐藏 roleId', /^\d+$/.test(String(account?.roleId ?? '')), `roleId=${account?.roleId}`);
  if (!created.json?.data?.claimed) {
    check('本周已刷 = 当前总点赞 − 上周点赞',
      account?.weekLikes === Math.max(0, (account?.currentLikes ?? 0) - (account?.baseline ?? 0)),
      `本周已刷=${account?.weekLikes} / 350`);
  }

  const mine = await call('/api/accounts/query', { method: 'POST', body: { roleIds: [account?.roleId] } });
  check('按 roleIds 查询能查到刚加的账号',
    mine.status === 200 && mine.json?.data?.accounts?.[0]?.roleId === account?.roleId);

  const claimed = await call('/api/accounts', {
    method: 'POST',
    body: { nickname, region, lastWeekLikes: 1 },
  });
  check('同一角色再加一次 = 认领（200 claimed，不重复入库）',
    claimed.status === 200 && claimed.json?.data?.claimed === true);

  const refreshed = await call('/api/accounts/refresh', {
    method: 'POST',
    body: { roleIds: [account?.roleId, '9999999999'] },
  });
  check('POST /api/accounts/refresh（只刷给的那批）',
    refreshed.status === 200 && refreshed.json?.data?.total === 1,
    refreshed.json?.data?.errors?.[0]?.error?.message ?? `本周已刷=${refreshed.json?.data?.accounts?.[0]?.weekLikes}`);
  check('不存在的 roleId 会落到 missing 里',
    (refreshed.json?.data?.missing ?? []).includes('9999999999'));

  const fixed = await call(`/api/accounts/${account?.roleId}`, {
    method: 'PATCH',
    body: { lastWeekLikes: refreshed.json?.data?.accounts?.[0]?.currentLikes ?? 0 },
  });
  check('PATCH /api/accounts/:roleId（修正基线）',
    fixed.status === 200 && fixed.json?.data?.account?.weekLikes === 0);

  const publicDelete = await call(`/api/accounts/${account?.roleId}`, { method: 'DELETE' });
  check('公开接口没有删除能力（404，只能管理员在后台删）', publicDelete.status === 404);
}

console.log('\n[4] 清理临时数据');
if (!createdRoleId) {
  console.log('    本次没有创建任何账号，无需清理');
} else if (adminCred) {
  const [adminUser, adminPass] = adminCred.split(':');
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: adminUser, password: adminPass },
  });
  if (login.status === 200) {
    const deleted = await call(`/api/admin/roles/${createdRoleId}`, {
      method: 'DELETE',
      token: login.json.data.token,
    });
    check('已从数据库删掉冒烟测试账号', deleted.status === 200 || deleted.status === 404, `roleId=${createdRoleId}`);
  } else {
    check('管理员登录成功（用于清理）', false, login.json?.error?.message);
  }
} else {
  console.log(`    临时账号 roleId=${createdRoleId} 留在库里了；`);
  console.log('    想自动清掉就加 --admin 管理员账号:密码（主页的「删」只是从本机列表移除，不会删库）');
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
// 不要用 process.exit()：Windows 上会和 undici 的连接回收抢时序，触发 libuv 断言
process.exitCode = failed === 0 ? 0 : 1;
