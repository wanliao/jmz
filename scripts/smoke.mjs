/**
 * 冒烟测试：对一个正在运行的服务跑一遍完整接口流程。
 *
 * 用法：
 *   node scripts/smoke.mjs                                    # 只读检查（不会写任何数据）
 *   node scripts/smoke.mjs --nickname 你的角色名 --zone 1       # 顺便测「注册 → 添加账号 → 刷新 → 删除」
 *   node scripts/smoke.mjs --nickname 角色名 --admin admin:密码  # 测完顺便把临时用户删掉
 *
 * 说明：
 *   - 未登录时是「本地模式」（账号只存浏览器），所以服务端只读检查不涉及数据库写入；
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
check('本地模式开关已暴露给前端', typeof config.json?.data?.allowLocalMode === 'boolean',
  `allowLocalMode=${config.json?.data?.allowLocalMode}`);
const home = await call('/');
check('GET / 返回前端页面', home.status === 200 && home.text.includes('金拇指'));
const adminPage = await call('/admin.html');
check('GET /admin.html 返回管理后台', adminPage.status === 200 && adminPage.text.includes('管理后台'));
const shared = await call('/shared/constants.js');
check('GET /shared/constants.js', shared.status === 200 && shared.text.includes('WEEKLY_LIKE_CAP'));

console.log('\n[2] 鉴权：没有游客身份了，未登录不能读云端数据');
const anonymous = await call('/api/accounts');
check('没有 token 访问账号接口返回 401', anonymous.status === 401, anonymous.json?.error?.code);
const guestEndpoint = await call('/api/auth/guest', { method: 'POST' });
check('旧的游客接口已移除（404）', guestEndpoint.status === 404);
const me = await call('/api/auth/me');
check('未登录时 /api/auth/me 返回 user: null', me.status === 200 && me.json?.data?.user === null);

console.log('\n[3] 本地模式接口（不落库、不消耗接口调用）');
if (config.json?.data?.allowLocalMode) {
  const settle = await call('/api/local/settle', { method: 'POST', body: { accounts: [] } });
  check('POST /api/local/settle（空列表）', settle.status === 200 && Array.isArray(settle.json?.data?.accounts),
    `账号数 ${settle.json?.data?.accounts?.length ?? '-'}`);
  const sync = await call('/api/local/sync', { method: 'POST', body: { accounts: [] } });
  check('POST /api/local/sync（空列表）', sync.status === 200 && sync.json?.data?.total === 0);
  const dirty = await call('/api/local/sync', {
    method: 'POST',
    body: { accounts: [{ roleId: 'abc', region: 'qq' }] },
  });
  check('非法本地账号会被丢弃而不是报错', dirty.status === 200 && dirty.json?.data?.dropped === 1);
} else {
  console.log('    服务端已关闭本地模式（ALLOW_LOCAL_MODE=0），跳过');
}

// ---- 写入流程：mock 模式随便测；真实接口模式必须给真实角色名 ----
const canWrite = adapterMode === 'mock' || Boolean(realNickname);
let tempUserId = null;

if (!canWrite) {
  console.log('\n[4] 跳过「注册 + 添加账号」写入流程');
  console.log('    当前是真实接口模式：加账号会真的调用接口 A 查询角色。');
  console.log('    要测这条路径就带上真实角色名，例如：');
  console.log('      node scripts/smoke.mjs --nickname 你的角色名 --zone 1     (1 = QQ区, 2 = 微信区)');
} else {
  const username = `smoke${Date.now().toString().slice(-7)}`;
  console.log(`\n[4] 注册临时用户 ${username} 并走一遍写入流程`);

  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'smoke-password' },
  });
  check('POST /api/auth/register', registered.status === 201, registered.json?.error?.message ?? '');
  const token = registered.json?.data?.token;
  tempUserId = registered.json?.data?.user?.id ?? null;

  if (token) {
    const nickname = realNickname ?? `冒烟测试${Date.now().toString().slice(-6)}`;
    const region = realNickname ? (realZone === 2 ? 'wechat' : 'qq') : 'qq';

    const created = await call('/api/accounts', {
      method: 'POST',
      token,
      body: { nickname, region, lastWeekLikes: 1000 },
    });
    check('POST /api/accounts', created.status === 201, created.json?.error?.message ?? '');
    const account = created.json?.data?.account;
    check('拿到隐藏 roleId', /^\d+$/.test(String(account?.roleId ?? '')), `roleId=${account?.roleId}`);
    check('本周已刷 = 当前总点赞 − 上周点赞',
      account?.weekLikes === Math.max(0, (account?.currentLikes ?? 0) - (account?.baseline ?? 0)),
      `本周已刷=${account?.weekLikes} / 350`);

    const duplicate = await call('/api/accounts', {
      method: 'POST',
      token,
      body: { nickname, region, lastWeekLikes: 1000 },
    });
    check('重复添加同一个角色返回 409',
      duplicate.status === 409 && duplicate.json?.error?.code === 'DUPLICATE_ACCOUNT');

    const refreshed = await call(`/api/accounts/${account?.roleId}/refresh`, { method: 'POST', token });
    check('POST /api/accounts/:roleId/refresh',
      refreshed.status === 200 && Boolean(refreshed.json?.data?.account),
      refreshed.json?.data?.warning?.message ?? `本周已刷=${refreshed.json?.data?.account?.weekLikes}`);

    const fixed = await call(`/api/accounts/${account?.roleId}`, {
      method: 'PATCH',
      token,
      body: { lastWeekLikes: refreshed.json?.data?.account?.currentLikes ?? 0 },
    });
    check('PATCH /api/accounts/:roleId（修正基线）',
      fixed.status === 200 && fixed.json?.data?.account?.weekLikes === 0);

    const removed = await call(`/api/accounts/${account?.roleId}`, { method: 'DELETE', token });
    check('DELETE /api/accounts/:roleId', removed.status === 200);
  }
}

console.log('\n[5] 清理临时数据');
if (tempUserId && adminCred) {
  const [adminUser, adminPass] = adminCred.split(':');
  const login = await call('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPass } });
  if (login.status === 200) {
    const deleted = await call(`/api/admin/users/${tempUserId}`, {
      method: 'DELETE',
      token: login.json.data.token,
    });
    check('已删除冒烟测试用的临时用户', deleted.status === 200 || deleted.status === 404,
      `用户 #${tempUserId}`);
  } else {
    check('管理员登录成功（用于清理）', false, login.json?.error?.message);
  }
} else if (tempUserId) {
  console.log(`    临时用户 #${tempUserId} 保留着；想自动清理就加 --admin 管理员账号:密码`);
} else {
  console.log('    本次没有创建任何数据，无需清理');
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
// 不要用 process.exit()：Windows 上会和 undici 的连接回收抢时序，触发 libuv 断言
process.exitCode = failed === 0 ? 0 : 1;
