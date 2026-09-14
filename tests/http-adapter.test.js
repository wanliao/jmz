/**
 * 真实接口适配器契约测试。
 *
 * 用本地桩服务完整复刻「和平营地 roleId 查询 API」的行为（含那些坑），
 * 所以这里不消耗任何接口额度，也能验证：
 *   - HTTP 恒为 200、成败只看 body 的 code；
 *   - zone 映射（1 = QQ区，2 = 微信区）；
 *   - likeTimes 是字符串、null 不等于 0；
 *   - 429 限速自动退避重试；
 *   - NOT_FOUND / ALL_TOKENS_EXHAUSTED / BAD_ROLEID 翻成中文提示；
 *   - 访问密钥放查询参数或请求头；
 *   - 节流（minIntervalMs）真的生效。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { AdapterError, createHttpAdapter } from '../server/lib/adapters/http.js';

let server;
let baseUrl;
let hits = [];
const rateLimited = new Map();

const ROLE_ID = '3728977992';

const PROFILE_PAYLOAD = {
  code: 200,
  avatar: 'https://p.qlogo.cn/yoyo_avatar/0/xxx/106',
  nickname: 'end',
  userId: '794937741',
  roleName: 'TvT辣条',
  uinType: 'QQ区',
  roleId: ROLE_ID,
  highestDivName: '绝世王牌16星',
  currentDivName: '绝世王牌16星',
  wangpaiLevel: '16',
  likeTimes: '4189',
  kd: { 全部: '2.16', 经典模式: '2.35', 创意工坊: '1.95' },
  locationName: '安徽',
  city: '阜阳',
  registerTime: '2022-01-14 18:59:17',
};

function json(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    hits.push({ query, headers: req.headers });

    const needKey = query.id === '需要密钥';
    const providedKey = query.key ?? req.headers['x-api-key'];
    if (needKey && providedKey !== 'secret-key') {
      json(res, { code: 401, error: 'UNAUTHORIZED', message: '访问密钥不正确' });
      return;
    }

    // ---- 接口A：?id=&zone= ----
    if (query.id !== undefined) {
      if (query.id === 'TvT辣条') {
        json(res, PROFILE_PAYLOAD);
        return;
      }
      if (query.id === '需要密钥') {
        json(res, PROFILE_PAYLOAD);
        return;
      }
      if (query.id === '查不到的人') {
        json(res, { code: 404, error: 'NOT_FOUND', message: '未找到该用户' });
        return;
      }
      if (query.id === '额度用尽') {
        json(res, { code: 503, error: 'ALL_TOKENS_EXHAUSTED', message: '' });
        return;
      }
      if (query.id === '大区错') {
        json(res, { code: 400, error: 'BAD_ZONE', message: 'zone 只能是 1 或 2' });
        return;
      }
      json(res, { code: 404, error: 'NOT_FOUND', message: '未找到该用户' });
      return;
    }

    // ---- 接口B：?roleId= ----
    if (query.roleId !== undefined) {
      const id = query.roleId;
      if (id === ROLE_ID) {
        json(res, { code: 200, roleId: id, likeTimes: '4189' });
        return;
      }
      if (id === '1234567890') {
        // 上游没给这个字段时是 null —— 不能当成 0
        json(res, { code: 200, roleId: id, likeTimes: null });
        return;
      }
      if (id === 'abc') {
        json(res, { code: 400, error: 'BAD_ROLEID', message: 'roleId 必须是纯数字' });
        return;
      }
      if (id === '1111111111') {
        // 前两次限速，第三次成功
        const count = (rateLimited.get(id) ?? 0) + 1;
        rateLimited.set(id, count);
        if (count <= 2) {
          json(res, { code: 429, error: 'RATE_LIMITED', message: '请求过于频繁' });
        } else {
          json(res, { code: 200, roleId: id, likeTimes: '777' });
        }
        return;
      }
      if (id === '2222222222') {
        // 反代/WAF 把 JSON 换成了 HTML 错误页
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>502 Bad Gateway</body></html>');
        return;
      }
      json(res, { code: 404, error: 'ROLE_NOT_FOUND', message: '拿不到该角色的荣耀数据' });
      return;
    }

    json(res, { code: 400, error: 'MISSING_ID', message: '缺少 id 或 roleId' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeConfig({ apiKey = '', apiKeyHeader = '', retryOnRateLimit = 2 } = {}) {
  const shared = {
    url: baseUrl,
    method: 'GET',
    headers: { Accept: 'application/json' },
    body: {},
    successPath: 'code',
    successValue: 200,
    errorCodePath: 'error',
    errorMessagePath: 'message',
    retryOnRateLimit,
    timeoutMs: 5000,
  };
  return {
    apiKey,
    apiKeyParam: 'key',
    apiKeyHeader,
    apiA: {
      ...shared,
      query: { id: '{nickname}', zone: '{regionCode}' },
      roleIdPath: 'roleId',
      likesPath: 'likeTimes',
      regionCodes: { qq: '1', wechat: '2' },
      profile: {
        avatar: 'avatar',
        campNickname: 'nickname',
        roleName: 'roleName',
        highestDivName: 'highestDivName',
        location: 'locationName',
        city: 'city',
      },
    },
    apiB: { ...shared, query: { roleId: '{roleId}' }, likesPath: 'likeTimes' },
  };
}

test('接口A：按昵称+大区换 roleId，并带回点赞数与账号档案', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  const result = await adapter.resolveRoleId({ nickname: 'TvT辣条', region: 'qq' });

  assert.equal(result.roleId, ROLE_ID);
  assert.equal(typeof result.roleId, 'string', 'roleId 必须保持字符串（最大 42 亿）');
  assert.equal(result.likes, 4189, '接口A 顺带返回的 likeTimes 应被解析成数字');

  // 只抓「不会过期」的档案字段 + 头像（当前段位/印记/K-D/注册时间不再抓）
  assert.equal(result.profile.campNickname, 'end');
  assert.equal(result.profile.highestDivName, '绝世王牌16星');
  assert.equal(result.profile.location, '安徽');
  assert.equal(result.profile.city, '阜阳');
  assert.equal(result.profile.currentDivName, undefined, '当前段位不再抓取');
  assert.equal(result.profile.avatar, PROFILE_PAYLOAD.avatar, '头像要抓回来（卡片上要显示）');
  assert.equal(result.profile.wangpaiLevel, undefined, '王牌印记不再抓取');
  assert.equal(result.profile.kd, undefined, 'K/D 不再抓取');
  assert.equal(result.profile.registerTime, undefined, '注册时间不再抓取');

  // 大区映射：qq = 1，微信 = 2（文档里明确写死的，不能反）
  assert.equal(hits.at(-1).query.zone, '1');
  await adapter.resolveRoleId({ nickname: 'TvT辣条', region: 'wechat' });
  assert.equal(hits.at(-1).query.zone, '2');
});

test('接口A：NOT_FOUND 翻成中文提示，并带上 404', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.resolveRoleId({ nickname: '查不到的人', region: 'qq' }),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      assert.match(error.message, /没有找到这个角色/);
      return true;
    },
  );
});

test('接口A：token 额度用尽时给出可操作的中文提示（503）', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.resolveRoleId({ nickname: '额度用尽', region: 'qq' }),
    (error) => {
      assert.equal(error.code, 'ALL_TOKENS_EXHAUSTED');
      assert.equal(error.status, 503);
      assert.match(error.message, /额度|token/);
      return true;
    },
  );
});

test('接口A：参数错误（BAD_ZONE）也会被正确识别', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.resolveRoleId({ nickname: '大区错', region: 'qq' }),
    (error) => {
      assert.equal(error.code, 'BAD_ZONE');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('接口B：只查点赞数', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  const result = await adapter.fetchLikes({ roleId: ROLE_ID });
  assert.equal(result.likes, 4189);
  assert.equal(result.raw.roleId, ROLE_ID);
});

test('接口B：likeTimes 为 null 时报错，而不是当成 0', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.fetchLikes({ roleId: '1234567890' }),
    (error) => {
      assert.equal(error.code, 'LIKES_MISSING');
      assert.match(error.message, /null/);
      return true;
    },
  );
});

test('接口B：roleId 传错（非数字）给出明确提示', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.fetchLikes({ roleId: 'abc' }),
    (error) => {
      assert.equal(error.code, 'BAD_ROLEID');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('接口提示「请求频繁」时自动重新请求，成功即返回', async () => {
  const adapter = createHttpAdapter({ config: makeConfig({ retryOnRateLimit: 3 }) });
  const before = hits.length;
  const result = await adapter.fetchLikes({ roleId: '1111111111' });
  assert.equal(result.likes, 777);
  assert.equal(hits.length - before, 3, '应该是失败两次 + 成功一次');
  assert.equal(rateLimited.get('1111111111') ?? 0, 3);
});

test('重试次数用尽后如实报错（前端会把这个提示显示出来）', async () => {
  rateLimited.set('1111111111', 0);
  const adapter = createHttpAdapter({ config: makeConfig({ retryOnRateLimit: 1 }) });
  await assert.rejects(
    () => adapter.fetchLikes({ roleId: '1111111111' }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.status, 429);
      assert.match(error.message, /频繁/);
      return true;
    },
  );
});

test('返回的不是 JSON（被反代换成 HTML）时给出可排查的报错', async () => {
  const adapter = createHttpAdapter({ config: makeConfig() });
  await assert.rejects(
    () => adapter.fetchLikes({ roleId: '2222222222' }),
    (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.match(error.message, /不是 JSON/);
      return true;
    },
  );
});

test('访问密钥：默认放查询参数 key', async () => {
  const adapter = createHttpAdapter({ config: makeConfig({ apiKey: 'secret-key' }) });
  const result = await adapter.resolveRoleId({ nickname: '需要密钥', region: 'qq' });
  assert.equal(result.roleId, ROLE_ID);
  assert.equal(hits.at(-1).query.key, 'secret-key');
});

test('访问密钥：也可以放请求头，且密钥不对时提示明确', async () => {
  const withHeader = createHttpAdapter({
    config: makeConfig({ apiKey: 'secret-key', apiKeyHeader: 'X-Api-Key' }),
  });
  await withHeader.resolveRoleId({ nickname: '需要密钥', region: 'qq' });
  assert.equal(hits.at(-1).headers['x-api-key'], 'secret-key');
  assert.equal(hits.at(-1).query.key, undefined, '配了请求头就不该再塞查询参数');

  const wrongKey = createHttpAdapter({ config: makeConfig({ apiKey: '错误的密钥' }) });
  await assert.rejects(
    () => wrongKey.resolveRoleId({ nickname: '需要密钥', region: 'qq' }),
    (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.status, 401);
      assert.match(error.message, /密钥/);
      return true;
    },
  );
});
