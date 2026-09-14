/**
 * 真实接口适配器（接口 A / 接口 B）。
 *
 * 地址、请求参数名、响应字段名、成功码、错误码字段全部来自 config/endpoints.json
 * 或环境变量，拿到新接口只改配置，不动业务代码。
 *
 * 针对「和平营地 roleId 查询 API」的几个坑专门做了处理（见接口文档）：
 *  1. HTTP 状态码恒为 200，成败只看 body 里的 code —— 所以必须配 successPath/successValue；
 *  2. likeTimes 是字符串、且可能是 null（和数字 0 含义不同）—— 不能直接 Number()；
 *  3. 服务端可能限速（每小时/每秒的上限以后会调整）—— 不主动限速、不管额度，
 *     只在收到「请求过于频繁」时自动退避重新请求；
 *  4. 错误码在 error 字段（NOT_FOUND / ALL_TOKENS_EXHAUSTED / BAD_ZONE ...）—— 翻成中文提示；
 *  5. roleId 最大 42 亿，全程按字符串传，不转数字。
 */

import { buildQueryString, getByPath, renderTemplate } from '../template.js';

export class AdapterError extends Error {
  constructor(message, { code = 'ADAPTER_ERROR', status = 502, cause } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** 接口文档里列出的错误码 -> 给用户看的中文提示 */
const BUSINESS_ERROR_MESSAGES = {
  NOT_FOUND: '没有找到这个角色，请确认昵称和大区与游戏里完全一致',
  ROLE_NOT_FOUND: '这个 roleId 查不到数据（角色可能已注销，或 roleId 不对）',
  RATE_LIMITED: '接口提示请求过于频繁，自动重试后仍然被限速，请稍后再试',
  MISSING_ID: '接口参数缺失：没有传角色名',
  MISSING_ROLEID: '接口参数缺失：没有传 roleId',
  BAD_ZONE: '大区参数不对（和平营地 API：1 = QQ区，2 = 微信区）',
  BAD_ROLEID: 'roleId 必须是纯数字',
  UNAUTHORIZED: '接口访问密钥不对，请检查 config/endpoints.json 的 apiKey（或 .env 的 API_KEY）',
  NO_TOKEN_AVAILABLE: '接口服务里一个可用 token 都没有，请到它的管理后台添加 token',
  ALL_TOKENS_EXHAUSTED: '接口服务的 token 全部失效或额度用尽，请到它的管理后台处理',
};

const HTTP_STATUS_WHITELIST = new Set([400, 401, 403, 404, 409, 429, 502, 503, 504]);

/**
 * 接口的 error 是字符串标识（NOT_FOUND / BAD_ROLEID ...），
 * body 里的 code 才是数字状态码。两个都要用上，才能把真实状态透传给前端。
 */
const ERROR_CODE_STATUS = {
  NOT_FOUND: 404,
  ROLE_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  MISSING_ID: 400,
  MISSING_ROLEID: 400,
  BAD_ZONE: 400,
  BAD_ROLEID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NO_TOKEN_AVAILABLE: 503,
  ALL_TOKENS_EXHAUSTED: 503,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function friendlyMessage(code, upstreamMessage, label) {
  if (code && BUSINESS_ERROR_MESSAGES[code]) return BUSINESS_ERROR_MESSAGES[code];
  if (typeof code === 'string' && code.startsWith('UPSTREAM')) {
    return `${label} 上游异常：${upstreamMessage || code}`;
  }
  if (upstreamMessage) return `${label} 返回失败：${upstreamMessage}`;
  return `${label} 返回失败${code !== undefined && code !== null ? `（错误码 ${code}）` : ''}`;
}

function statusForCode(code) {
  const numeric = Number(code);
  return HTTP_STATUS_WHITELIST.has(numeric) ? numeric : 502;
}

/** 头像上游一般给 URL 字符串；万一给了 {url:...} 之类的结构，尽量捞出里面那个字符串 */
function pickAvatarUrl(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['url', 'avatar', 'avatarUrl', 'src']) {
      if (typeof value[key] === 'string') return value[key].trim();
    }
  }
  return '';
}

/** 从响应里按配置的路径抽出账号档案（头像、段位、印记……） */
function extractProfile(payload, profilePaths) {
  if (!profilePaths) return null;
  const profile = {};
  for (const [key, path] of Object.entries(profilePaths)) {
    const raw = getByPath(payload, path);
    if (raw === undefined || raw === null || raw === '') continue;
    const value = key === 'avatar' ? pickAvatarUrl(raw) : raw;
    if (value === undefined || value === null || value === '') continue;
    profile[key] = value;
  }
  return Object.keys(profile).length > 0 ? profile : null;
}

/** 接口返回的点赞数可能是字符串、可能是 null；null 与 0 含义不同 */
function parseLikes(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function hasBody(method) {
  return !['GET', 'HEAD'].includes(method);
}

export function createHttpAdapter({ config }) {
  const { apiA, apiB } = config;

  /** 发一次请求（不含重试），返回解析后的 JSON */
  async function requestOnce(endpoint, vars, label) {
    const renderedUrl = renderTemplate(endpoint.url, vars);
    let url;
    try {
      url = new URL(renderedUrl);
    } catch {
      throw new AdapterError(`${label} 的接口地址不合法：${renderedUrl}`, {
        code: 'INVALID_ENDPOINT_URL',
        status: 500,
      });
    }

    const method = (endpoint.method || 'GET').toUpperCase();
    const headers = renderTemplate(endpoint.headers ?? {}, vars);
    let query = renderTemplate(endpoint.query ?? {}, vars);
    let body = renderTemplate(endpoint.body ?? {}, vars);

    // 便捷处理：GET 请求只填了 body 时，自动当成查询参数用
    if (!hasBody(method) && Object.keys(query).length === 0 && Object.keys(body).length > 0) {
      query = body;
      body = {};
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    // 访问密钥：优先放请求头，否则放查询参数（接口文档：key 或 X-Api-Key）
    if (config.apiKey) {
      if (config.apiKeyHeader) headers[config.apiKeyHeader] = config.apiKey;
      else url.searchParams.set(config.apiKeyParam || 'key', config.apiKey);
    }

    const init = { method, headers: { ...headers } };
    if (hasBody(method) && Object.keys(body).length > 0) {
      const isJson = !init.headers['Content-Type'] || /json/i.test(init.headers['Content-Type']);
      init.body = isJson ? JSON.stringify(body) : buildQueryString(body).slice(1);
      if (isJson && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1000, Number(endpoint.timeoutMs) || 10_000)),
      });
    } catch (error) {
      throw new AdapterError(`${label} 请求失败：${error.message}`, {
        code: 'NETWORK_ERROR',
        status: 504,
        cause: error,
      });
    }

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      // 反代/WAF 有时会把 JSON 换成自己的 HTML 错误页
      throw new AdapterError(
        `${label} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`,
        { code: 'INVALID_RESPONSE', status: 502 },
      );
    }

    // 注意：这类接口的 HTTP 状态码恒为 200，真实成败在 body 的业务码里
    if (endpoint.successPath) {
      const actual = getByPath(payload, endpoint.successPath);
      const expected = endpoint.successValue;
      const match =
        expected === null || expected === undefined || String(actual) === String(expected);
      if (!match) {
        const errorCode = endpoint.errorCodePath ? getByPath(payload, endpoint.errorCodePath) : undefined;
        const numericCode = endpoint.successPath ? getByPath(payload, endpoint.successPath) : undefined;
        const upstreamMessage = getByPath(payload, endpoint.errorMessagePath);
        throw new AdapterError(friendlyMessage(errorCode, upstreamMessage, label), {
          code:
            errorCode === undefined || errorCode === null
              ? `UPSTREAM_ERROR_${numericCode ?? 'UNKNOWN'}`
              : String(errorCode),
          status: statusForCode(ERROR_CODE_STATUS[errorCode] ?? numericCode),
        });
      }
    } else if (!response.ok) {
      const upstreamMessage = getByPath(payload, endpoint.errorMessagePath);
      throw new AdapterError(friendlyMessage(null, upstreamMessage, label), {
        code: 'UPSTREAM_HTTP_ERROR',
        status: response.status,
      });
    }

    return payload;
  }

  /**
   * 发请求；如果服务端提示「请求过于频繁」，自动退避后重新请求。
   * （不做主动限速、不做额度管理 —— 撞上了就重试。）
   */
  async function request(endpoint, vars, label) {
    const maxRetries = Math.max(0, Number(endpoint.retryOnRateLimit) || 0);
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await requestOnce(endpoint, vars, label);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AdapterError && error.code === 'RATE_LIMITED';
        if (!retryable || attempt === maxRetries) throw error;
        const backoff = 800 * (attempt + 1);
        console.warn(`[adapter] ${label} 提示请求频繁，${backoff}ms 后重新请求（第 ${attempt + 1}/${maxRetries} 次）`);
        await sleep(backoff);
      }
    }
    throw lastError;
  }

  return {
    name: 'http',

    async resolveRoleId({ nickname, region }) {
      const vars = {
        nickname,
        region,
        regionCode: apiA.regionCodes?.[region] ?? region,
        regionLabel: region,
      };
      const payload = await request(apiA, vars, '接口A（查询 roleId）');

      const roleId = getByPath(payload, apiA.roleIdPath);
      if (roleId === undefined || roleId === null || String(roleId).trim() === '') {
        throw new AdapterError(
          `接口A 响应里取不到 roleId（配置路径 apiA.roleIdPath=${apiA.roleIdPath}）`,
          { code: 'ROLE_ID_MISSING' },
        );
      }

      return {
        // roleId 最大 42 亿，必须保持字符串
        roleId: String(roleId).trim(),
        // 接口A 顺带返回了点赞数，能省一次接口B 调用
        likes: apiA.likesPath ? parseLikes(getByPath(payload, apiA.likesPath)) : null,
        profile: extractProfile(payload, apiA.profile),
        raw: payload,
      };
    },

    async fetchLikes({ roleId }) {
      const payload = await request(apiB, { roleId: String(roleId) }, '接口B（查询点赞数）');
      const likes = parseLikes(getByPath(payload, apiB.likesPath));
      if (likes === null) {
        throw new AdapterError(
          `接口B 没返回点赞数（配置路径 apiB.likesPath=${apiB.likesPath}，实际值 ${JSON.stringify(
            getByPath(payload, apiB.likesPath),
          )}）：上游有时会返回 null，这不等同于 0`,
          { code: 'LIKES_MISSING' },
        );
      }
      return { likes, raw: payload };
    },
  };
}
