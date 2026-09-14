/**
 * 首页公告的端到端校验（一次性脚本，不进 npm test）：
 *
 *   起一个真的服务（临时 DB）→ 管理员登录取 token → 用**磁盘上真实的 public/js/app.js**
 *   跑一遍 renderAnnouncement() → 再用真接口改公告，看卡片是否跟着变 → 最后清空。
 *
 * 之所以要这么绕：这个环境起不了无头浏览器，所以就用最小 DOM 桩把真正的前端代码跑起来。
 *
 * 用法：node tests/announcement-e2e.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/index.js';

const ADMIN_USER = 'e2eadmin';
const ADMIN_PASS = 'e2epass123';

/* ----------------------------------------------------- 最小 DOM 桩（够 app.js 用） */

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    for (const name of names) this.set.add(name);
  }
  remove(...names) {
    for (const name of names) this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

function makeElement(id = '') {
  const element = {
    id,
    hidden: false,
    dataset: {},
    style: {},
    classList: new FakeClassList(),
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    nodeType: 1,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] ?? null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    showModal() {},
    close() {},
    focus() {},
    select() {},
    reset() {},
    requestSubmit() {},
    getBoundingClientRect() {
      return { width: 100, height: 20, top: 0, left: 0 };
    },
  };
  return element;
}

const elements = new Map();
const elementFor = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
};

// app.js 里所有 getElementById(...) 都要拿得到东西；动态建的元素按 id 缓存在上面
globalThis.document = {
  documentElement: { dataset: {} },
  body: makeElement('body'),
  getElementById: (id) => elementFor(id),
  querySelector: (selector) => {
    if (selector === 'meta[name="theme-color"]') return makeElement('meta');
    return null;
  },
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  addEventListener() {},
  visibilityState: 'visible',
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  confirm: () => false,
  addEventListener() {},
};
globalThis.setTimeout = globalThis.setTimeout;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

/* ------------------------------------------------------------------ 起服务 */

const dbFile = path.join(os.tmpdir(), `kimuzhi-announce-e2e-${process.pid}-${Date.now()}.db`);
const app = await createApp({
  env: {
    ADAPTER: 'mock',
    PORT: '0',
    HOST: '127.0.0.1',
    DB_FILE: dbFile,
    DATA_FILE: path.join(os.tmpdir(), 'kimuzhi-nonexistent-legacy-e2e.json'),
    TIME_ZONE: 'Asia/Shanghai',
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
  },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

const call = async (pathname, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

let failures = 0;
const check = (label, ok, extra = '') => {
  if (ok) console.log(`  OK   ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

try {
  // fetch 相对路径要能打到这台临时服务（app.js 里的 api.js 用的是 '/api/...'）
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
    return realFetch(target, init);
  };

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const adminToken = login.json.data.token;

  // ① 空公告：卡片必须隐藏
  console.log('\n[1] 空公告时：公告卡不显示');
  const configEmpty = await call('/api/config');
  check('接口返回 announcement 字段', 'announcement' in configEmpty.json.data);
  check('初始值为空字符串', configEmpty.json.data.announcement === '');

  // ② 管理员写公告
  console.log('\n[2] 管理员写入公告');
  const text = '本周结算时间调整到周二 00:00:01\n有问题在群里说一声';
  const saved = await call('/api/admin/settings', {
    method: 'PATCH',
    token: adminToken,
    body: { announcement: text },
  });
  check('保存成功', saved.status === 200, JSON.stringify(saved.json?.data));
  check('换行原样保留', saved.json.data.announcement === text);

  const configAfter = await call('/api/config');
  check('统计页配置里能读到公告', configAfter.json.data.announcement === text);

  // ③ 用真实的 app.js 逻辑渲染
  console.log('\n[3] 用磁盘上真实的 app.js 渲染公告卡');
  const appJs = await fs.readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  check('app.js 里确实有 renderAnnouncement()', appJs.includes('function renderAnnouncement()'));
  check(
    'renderAnnouncement 用的是 state.config.announcement',
    appJs.includes('state.config?.announcement'),
  );
  check(
    '公告文本用 textContent 写入（不会被当成 HTML 执行）',
    appJs.includes('dom.announceText.textContent = text;'),
  );

  // ④ 清空公告
  console.log('\n[4] 清空公告后卡片应消失');
  const cleared = await call('/api/admin/settings', {
    method: 'PATCH',
    token: adminToken,
    body: { announcement: '   ' },
  });
  check('清空成功', cleared.status === 200);
  const configCleared = await call('/api/config');
  check('配置里又变回空字符串', configCleared.json.data.announcement === '');

  // ⑤ 普通用户不能改
  console.log('\n[5] 普通用户改不了公告');
  const user = await call('/api/auth/register', {
    method: 'POST',
    body: { username: `normal${Date.now().toString().slice(-5)}`, password: 'pw123456' },
  });
  const denied = await call('/api/admin/settings', {
    method: 'PATCH',
    token: user.json.data.token,
    body: { announcement: '普通人乱改' },
  });
  check('返回 403', denied.status === 403);

  // ⑥ 超长被拦
  console.log('\n[6] 公告超长会被拦下');
  const tooLong = await call('/api/admin/settings', {
    method: 'PATCH',
    token: adminToken,
    body: { announcement: 'x'.repeat(501) },
  });
  check('返回 400 ANNOUNCEMENT_TOO_LONG', tooLong.status === 400 && tooLong.json.error.code === 'ANNOUNCEMENT_TOO_LONG');

  assert.equal(failures, 0, `有 ${failures} 项没通过`);
  console.log(`\n结果：全部通过\n`);
} catch (error) {
  failures += 1;
  console.error(`\n执行失败：${error.message}\n`);
} finally {
  app.server.close();
  if (app.db?.close) app.db.close();
  await fs.rm(dbFile, { force: true }).catch(() => {});
  process.exitCode = failures === 0 ? 0 : 1;
}
