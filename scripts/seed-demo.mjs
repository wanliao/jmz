/**
 * 生成几个演示账号，方便第一次打开页面就能看到卡片效果（仅 Mock 适配器下有意义的假数据）。
 * 用法：node scripts/seed-demo.mjs [baseUrl]
 * 清理：直接点卡片上的「删除」，或 node scripts/seed-demo.mjs --clean
 */

const baseUrl = (process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const clean = process.argv.includes('--clean');

const DEMO = [
  { nickname: '演示账号·已刷满', region: 'wechat', target: 350 },
  { nickname: '演示账号·微信区', region: 'wechat', target: 128 },
  { nickname: '演示账号·QQ区', region: 'qq', target: 46 },
];

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
  try {
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, json: null };
  }
}

// 演示数据挂在游客身份下，所以先领一个游客 token
const guest = await call('/api/auth/guest', { method: 'POST' });
const token = guest.json?.data?.token;
if (!token) {
  console.error('拿不到游客身份，服务是不是没启动？');
  process.exit(1);
}

async function findExisting(nickname) {
  const list = await call('/api/accounts', { token });
  return (list.json?.data?.accounts ?? []).find((item) => item.nickname === nickname) ?? null;
}

if (clean) {
  let removed = 0;
  for (const item of DEMO) {
    const existing = await findExisting(item.nickname);
    if (existing) {
      const res = await call(`/api/accounts/${existing.roleId}`, { method: 'DELETE', token });
      if (res.status === 200) removed += 1;
    }
  }
  console.log(`已清理 ${removed} 个演示账号`);
} else {
  for (const item of DEMO) {
    let account = await findExisting(item.nickname);

    if (!account) {
      const created = await call('/api/accounts', {
        method: 'POST',
        token,
        body: { nickname: item.nickname, region: item.region, lastWeekLikes: 0 },
      });
      if (created.status !== 201) {
        console.error(`创建失败：${item.nickname} — ${created.json?.error?.message ?? created.status}`);
        continue;
      }
      account = created.json.data.account;
    }

    // 把基线调成「当前总点赞 − 想让页面显示的本周已刷」，看起来更真实
    const baseline = Math.max(0, (account.currentLikes ?? 0) - item.target);
    const patched = await call(`/api/accounts/${account.roleId}`, {
      method: 'PATCH',
      token,
      body: { lastWeekLikes: baseline },
    });
    const final = patched.json?.data?.account ?? account;
    console.log(
      `${item.nickname}（${item.region}）roleId=${final.roleId} 当前总点赞=${final.currentLikes} 上周=${final.baseline} 本周已刷=${final.weekLikes}`,
    );
  }
  console.log(`\n提示：这些账号挂在刚创建的游客身份下（用户 #${guest.json.data.user.id}），`);
  console.log('      浏览器里打开页面时会另建游客身份，所以你看不到它们；');
  console.log('      要真正看到效果，请在 .env 里把 ADAPTER 改成 mock，然后直接自己在页面上添加。');
}
