/**
 * 前端交互自动校验：用 CDP 驱动无头 Chrome/Edge，真实点一遍界面。
 *
 * 前置：服务已在运行（npm start），且本机装有 Chrome 或 Edge。
 * 用法：
 *   node scripts/ui-check.mjs                                   # mock 模式跑全流程
 *   node scripts/ui-check.mjs --nickname 你的角色名 --zone 1     # 真实接口模式下测「添加账号」
 *   node scripts/ui-check.mjs http://127.0.0.1:8799
 *
 * 为真实接口模式考虑：不给 --nickname 时只跑「不需要查角色」的检查
 * （首屏渲染、弹窗、表单校验、主题切换），不会白白消耗一次接口 A 调用。
 *
 * 覆盖：首屏渲染 → 表单校验 → 添加账号 → 卡片内容 → 刷新 → 改基线（含异常钳制）→ 主题切换 → 刷新全部 → 删除。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const APP = (
  argv.find((item) => item.startsWith('http')) ??
  process.env.APP_URL ??
  'http://127.0.0.1:8787'
).replace(/\/$/, '');
const realNickname = argValue('--nickname');
const realZone = Number(argValue('--zone') ?? 1);
const DEBUG_PORT = 9300 + (process.pid % 400);
const PROFILE = path.join(os.tmpdir(), `kimuzhi-ui-${Date.now()}`);

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

const browser = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.log('未找到 Chrome / Edge，跳过前端交互校验（可用 CHROME_PATH 环境变量指定浏览器路径）');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=430,900',
    APP,
  ],
  { stdio: 'ignore' },
);

async function waitForTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((target) => target.type === 'page' && target.url.startsWith('http'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`连不上浏览器调试端口 ${DEBUG_PORT}`);
}

let ws;
let msgId = 0;
const pending = new Map();

async function cleanup(code) {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  await sleep(200);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exitCode = code;
}

try {
  ws = new WebSocket(await waitForTarget());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const details = res.result?.exceptionDetails;
    if (details) throw new Error(`页面里报错：${details.exception?.description ?? details.text}`);
    return res.result?.result?.value;
  };

  const waitFor = (expression, timeoutMs = 8000) =>
    evaluate(`new Promise((resolve) => {
      const deadline = Date.now() + ${timeoutMs};
      const tick = () => {
        let value = false;
        try { value = (${expression}); } catch (e) { value = false; }
        if (value) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    })`);

  console.log(`\n前端交互校验：${APP}\n`);

  await waitFor(`!!document.getElementById('addBtn')`);
  await sleep(1200); // 冷启动时会先显示骨架屏，等 app.js 完成首次渲染
  check('首屏渲染完成（骨架屏消失）', await evaluate(`document.querySelector('.skeleton') === null`));

  const mode = await fetch(`${APP}/api/config`)
    .then((res) => res.json())
    .then((data) => data?.data?.adapterMode)
    .catch(() => null);
  console.log(`接口模式：${mode ?? '未知'}`);

  console.log('\n[1] 打开「添加账号」弹窗并检查表单校验（不触发任何接口调用）');
  await evaluate(`document.getElementById('addBtn').click()`);
  check('弹窗打开', await waitFor(`document.getElementById('addDialog').open === true`));

  await evaluate(`document.getElementById('addForm').requestSubmit()`);
  await sleep(300);
  check('空表单提交会提示填昵称',
    await evaluate(`document.getElementById('addFormError').textContent.includes('昵称')`));

  await evaluate(`
    (() => {
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(document.getElementById('nicknameInput'), '校验测试');
      setValue(document.getElementById('baselineInput'), '-5');
      document.querySelector('.segmented button[data-region="qq"]').click();
      document.getElementById('addForm').requestSubmit();
      return true;
    })()
  `);
  await sleep(300);
  check('负数基线会被前端拦下',
    await evaluate(`document.getElementById('addFormError').textContent.includes('正整数')`));
  check('QQ区单选按钮被选中',
    await evaluate(`document.querySelector('.segmented button[data-region="qq"]').getAttribute('aria-checked') === 'true'`));

  const canWrite = mode === 'mock' || Boolean(realNickname);

  console.log('\n[2] 未登录（本地模式）：账号弹窗里只应有该有的输入框');
  // 关键：按真实几何尺寸判断可见性。只看 hidden 属性会被作者样式的 display 骗过
  //（之前 .sheet form { display: block } 就让注册/登录/改密码三张表单同时显示）
  const visibleInputs = `
    (() => {
      const dlg = document.getElementById('accountDialog');
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...dlg.querySelectorAll('input')].filter(visible).map((el) => el.id);
    })()
  `;

  await evaluate(`document.getElementById('accountBtn').click()`);
  check('点头像能打开账号弹窗', await waitFor(`document.getElementById('accountDialog').open === true`));

  const openedInputs = await evaluate(visibleInputs);
  check('未登录时弹窗直接就是注册表单（不该露出别的表单）',
    openedInputs.length === 2 && openedInputs.includes('registerUsername'),
    openedInputs.join(',') || '无');
  check('未登录时看不到「原密码 / 新密码」',
    !openedInputs.includes('oldPassword') && !openedInputs.includes('newPassword'));

  check('注册界面只有账号 + 密码两个输入框',
    openedInputs.length === 2 &&
      openedInputs.includes('registerUsername') &&
      openedInputs.includes('registerPassword'),
    openedInputs.join(','));
  check('注册时看不到登录表单的输入框',
    !openedInputs.includes('loginUsername') && !openedInputs.includes('loginPassword'));

  await evaluate(`document.querySelector('[data-auth-tab="login"]').click()`);
  await sleep(300);
  const loginInputs = await evaluate(visibleInputs);
  check('切到登录时只有登录的两个输入框',
    loginInputs.length === 2 && loginInputs.includes('loginUsername') && loginInputs.includes('loginPassword'),
    loginInputs.join(',') || '无');

  await evaluate(`document.getElementById('accountDialog').close()`);

  if (!canWrite) {
    console.log('\n[3] 跳过「添加账号」写入流程');
    console.log('    当前是真实接口模式：加账号会真的调用接口 A 查询角色。');
    console.log('    要测这条路径就带上真实角色名，例如：');
    console.log('      node scripts/ui-check.mjs --nickname 你的角色名 --zone 1     (1 = QQ区, 2 = 微信区)');
    await evaluate(`document.getElementById('addDialog').close()`);

    console.log('\n[4] 深色 / 浅色切换');
    const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
    await evaluate(`document.getElementById('themeToggle').click()`);
    const themeAfter = await evaluate(`document.documentElement.dataset.theme`);
    check('主题能切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
  } else {

  console.log('\n[3] 填表提交，添加一个账号');
  const nickname = realNickname ?? `界面校验${Date.now().toString().slice(-6)}`;
  const region = realNickname ? (realZone === 2 ? 'wechat' : 'qq') : 'qq';
  await evaluate(`
    (() => {
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(document.getElementById('nicknameInput'), ${JSON.stringify(nickname)});
      setValue(document.getElementById('baselineInput'), '2000');
      document.querySelector('.segmented button[data-region="${region}"]').click();
      document.getElementById('addForm').requestSubmit();
      return true;
    })()
  `);
  check('提交后弹窗自动关闭', await waitFor(`document.getElementById('addDialog').open === false`, 25000));

  const found = await waitFor(`
    [...document.querySelectorAll('.card')].some((c) => c.querySelector('.card-nickname')?.textContent.trim() === ${JSON.stringify(nickname)})
  `, 25000);
  check('列表里出现新账号卡片', found, nickname);

  const cardInfo = await evaluate(`
    (() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-nickname')?.textContent.trim() === ${JSON.stringify(nickname)});
      if (!card) return null;
      return {
        roleId: card.dataset.card,
        badge: card.querySelector('.badge')?.textContent.trim(),
        weekLikes: card.querySelector('.hero-num')?.textContent.trim(),
        cap: card.querySelector('.hero-cap')?.textContent.trim(),
        barWidth: card.querySelector('.progress-bar')?.style.width,
        current: card.querySelectorAll('.kv-value')[0]?.textContent.trim(),
        baseline: card.querySelectorAll('.kv-value')[1]?.textContent.trim(),
      };
    })()
  `);
  check('卡片显示大区标识', cardInfo?.badge === (region === 'qq' ? 'QQ区' : '微信区'), cardInfo?.badge);
  check('卡片显示「本周已刷 / 350」', cardInfo?.cap === '/ 350', `${cardInfo?.weekLikes} ${cardInfo?.cap}`);
  check('进度条有宽度', /%$/.test(cardInfo?.barWidth ?? ''), cardInfo?.barWidth);
  check('当前总点赞与基线都有值', Number(cardInfo?.current?.replace(/,/g, '')) > 0 && cardInfo?.baseline === '2,000',
    `当前=${cardInfo?.current} 基线=${cardInfo?.baseline}`);
  check(
    '本周已刷 = 当前总点赞 − 基线',
    Number(cardInfo?.weekLikes?.replace(/,/g, '')) === Number(cardInfo?.current?.replace(/,/g, '')) - 2000,
    `已刷=${cardInfo?.weekLikes}`,
  );
  check('卡片带游戏头像（图片或首字色块兜底）',
    await evaluate(`
      (() => {
        const box = document.querySelector('.card[data-card="${cardInfo?.roleId}"] .avatar');
        if (!box) return false;
        const rect = box.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const img = box.querySelector('img');
        return Boolean(img?.getAttribute('src')) || Boolean(box.querySelector('.avatar-fallback')?.textContent.trim());
      })()
    `));
  check('卡片不显示「基线来源」',
    await evaluate(`document.querySelector('.card[data-card="${cardInfo?.roleId}"]').textContent.includes('基线来源') === false`));
  check('卡片不显示段位徽章 / 王牌印记 / K-D / 注册时间',
    await evaluate(`
      (() => {
        const text = document.querySelector('.card[data-card="${cardInfo?.roleId}"]').textContent;
        return !text.includes('王牌印记') && !text.includes('K/D') && !text.includes('注册于') && !document.querySelector('.chip-division');
      })()
    `));

  console.log('\n[4] 刷新单个账号');
  await evaluate(`document.querySelector('.card[data-card="${cardInfo?.roleId}"] [data-act="refresh"]').click()`);
  check('刷新后不再处于 busy 状态',
    await waitFor(`!document.querySelector('.card[data-card="${cardInfo?.roleId}"]').classList.contains('is-busy')`));
  check('出现了 toast 提示', await evaluate(`document.querySelectorAll('.toast').length > 0`));
  console.log('\n[5] 需求 6.4：基线故意填得比当前总点赞高，已刷数不能为负');
  const currentLikes = Number((cardInfo?.current ?? '0').replace(/,/g, ''));
  const editBaseline = async (value) => {
    await evaluate(`document.querySelector('.card[data-card="${cardInfo?.roleId}"] [data-act="baseline"]').click()`);
    await waitFor(`document.getElementById('baselineDialog').open === true`);
    await evaluate(`
      (() => {
        const el = document.getElementById('baselineEditInput');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '${value}');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('baselineForm').requestSubmit();
        return true;
      })()
    `);
    return waitFor(`document.getElementById('baselineDialog').open === false`);
  };

  await editBaseline(currentLikes + 500);
  const anomaly = await evaluate(`
    (() => {
      const card = document.querySelector('.card[data-card="${cardInfo?.roleId}"]');
      return {
        weekLikes: card.querySelector('.hero-num').textContent.trim(),
        anomaly: card.classList.contains('is-anomaly'),
        alert: card.querySelector('.card-alert')?.textContent.trim() ?? '',
        hasFixButton: !!card.querySelector('.card-alert [data-act="baseline"]'),
      };
    })()
  `);
  check('当前 < 基线时显示 0（不是负数）', anomaly?.weekLikes === '0', `已刷=${anomaly?.weekLikes}`);
  check('卡片给出异常提示', anomaly?.anomaly === true && anomaly?.alert.includes('比上周基线'), anomaly?.alert.slice(0, 30));
  check('异常提示里带「修正」按钮', anomaly?.hasFixButton === true);

  console.log('\n[6] 修正回正常基线');
  await editBaseline(Math.max(0, currentLikes - 120));
  const afterFix = await evaluate(`
    (() => {
      const card = document.querySelector('.card[data-card="${cardInfo?.roleId}"]');
      return { weekLikes: card.querySelector('.hero-num').textContent.trim(), anomaly: card.classList.contains('is-anomaly') };
    })()
  `);
  check('修正后本周已刷变成 120', Number(afterFix?.weekLikes?.replace(/,/g, '')) === 120, `已刷=${afterFix?.weekLikes}`);
  check('修正后异常标记消失', afterFix?.anomaly === false);

  console.log('\n[7] 深色 / 浅色切换');
  const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
  await evaluate(`document.getElementById('themeToggle').click()`);
  const themeAfter = await evaluate(`document.documentElement.dataset.theme`);
  check('主题能切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

  console.log('\n[8] 刷新全部 / 删除');
  await evaluate(`document.getElementById('refreshAllBtn').click()`);
  check('刷新全部完成后按钮恢复可用', await waitFor(`document.getElementById('refreshAllBtn').disabled === false`, 15000));
  await evaluate(`window.confirm = () => true; document.querySelector('.card[data-card="${cardInfo?.roleId}"] [data-act="delete"]').click(); true`);
  check('删除后卡片消失', await waitFor(`!document.querySelector('.card[data-card="${cardInfo?.roleId}"]')`));
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  await cleanup(fail === 0 ? 0 : 1);
} catch (error) {
  console.error(`\n前端交互校验执行失败：${error.message}\n`);
  await cleanup(1);
}
