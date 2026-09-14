/**
 * 运行时配置。
 *
 * 优先级：环境变量 > config/endpoints.json > 内置默认值
 *
 * 接口的真实地址 / 参数名 / 响应字段名都还没确定，所以全部做成可配置项：
 * 拿到真实接口后只需要改 config/endpoints.json（或环境变量），不用动业务代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIME_ZONE, isRegionId } from '../../shared/constants.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ENV_FILE = path.join(ROOT_DIR, '.env');

/** 极简 .env 解析器（避免引入 dotenv 依赖） */
export function loadEnvFile(file = ENV_FILE, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) env[key] = value;
  }
  return env;
}

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`配置文件解析失败：${file}\n${error.message}`);
  }
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

function resolvePath(value, fallback) {
  const target = str(value, fallback);
  return path.isAbsolute(target) ? target : path.resolve(ROOT_DIR, target);
}

/** 真实接口是否已经配置到位（未配置时即使 ADAPTER=http 也会自动回退 mock） */
export function isEndpointConfigured(endpoint) {
  return Boolean(endpoint && typeof endpoint.url === 'string' && endpoint.url.trim() !== '');
}

export function loadConfig(env = loadEnvFile()) {
  const fileConfig = readJsonSafe(path.join(ROOT_DIR, 'config', 'endpoints.json')) ?? {};

  const timeZone = str(env.TIME_ZONE, str(fileConfig.timeZone, DEFAULT_TIME_ZONE));

  // 大区 -> 接口参数值。和平营地 API：1 = QQ区，2 = 微信区
  const regionCodes = {
    qq: str(env.API_A_REGION_QQ, str(fileConfig.apiA?.regionCodes?.qq, '1')),
    wechat: str(env.API_A_REGION_WECHAT, str(fileConfig.apiA?.regionCodes?.wechat, '2')),
  };

  // 访问密钥（接口服务在管理界面设了密钥才需要）
  const apiKey = str(env.API_KEY, str(fileConfig.apiKey, ''));
  const apiKeyParam = str(env.API_KEY_PARAM, str(fileConfig.apiKeyParam, 'key'));
  const apiKeyHeader = str(env.API_KEY_HEADER, str(fileConfig.apiKeyHeader, ''));

  // 只想用环境变量配置的快捷方式：API_BASE_URL 一个地址同时覆盖两个接口
  const baseUrl = str(env.API_BASE_URL, '');

  const apiA = {
    url: str(baseUrl, str(env.API_A_URL, str(fileConfig.apiA?.url, ''))),
    method: str(env.API_A_METHOD, str(fileConfig.apiA?.method, 'POST')).toUpperCase(),
    headers: { ...(fileConfig.apiA?.headers ?? {}) },
    query: { ...(fileConfig.apiA?.query ?? {}) },
    body: { ...(fileConfig.apiA?.body ?? {}) },
    // 占位符名可配置：接口真实参数名定了以后改这里即可
    nicknameParam: str(fileConfig.apiA?.nicknameParam, 'nickname'),
    regionParam: str(fileConfig.apiA?.regionParam, 'region'),
    roleIdPath: str(env.API_A_ROLEID_PATH, str(fileConfig.apiA?.roleIdPath, 'roleId')),
    likesPath: str(env.API_A_LIKES_PATH, str(fileConfig.apiA?.likesPath, '')),
    successPath: str(fileConfig.apiA?.successPath, ''),
    successValue: fileConfig.apiA?.successValue ?? null,
    errorCodePath: str(fileConfig.apiA?.errorCodePath, ''),
    errorMessagePath: str(fileConfig.apiA?.errorMessagePath, 'message'),
    profile: fileConfig.apiA?.profile ? { ...fileConfig.apiA.profile } : null,
    regionCodes,
    // 不主动限速；只在接口提示「请求过于频繁」时自动重新请求这么多次
    retryOnRateLimit: num(env.API_A_RETRY_ON_RATE_LIMIT, num(fileConfig.apiA?.retryOnRateLimit, 3)),
    timeoutMs: num(fileConfig.apiA?.timeoutMs, 15_000),
  };

  const apiB = {
    url: str(baseUrl, str(env.API_B_URL, str(fileConfig.apiB?.url, ''))),
    method: str(env.API_B_METHOD, str(fileConfig.apiB?.method, 'GET')).toUpperCase(),
    headers: { ...(fileConfig.apiB?.headers ?? {}) },
    query: { ...(fileConfig.apiB?.query ?? {}) },
    body: { ...(fileConfig.apiB?.body ?? {}) },
    roleIdParam: str(env.API_B_ROLEID_PARAM, str(fileConfig.apiB?.roleIdParam, 'roleId')),
    likesPath: str(env.API_B_LIKES_PATH, str(fileConfig.apiB?.likesPath, 'likeNum')),
    successPath: str(fileConfig.apiB?.successPath, ''),
    successValue: fileConfig.apiB?.successValue ?? null,
    errorCodePath: str(fileConfig.apiB?.errorCodePath, ''),
    errorMessagePath: str(fileConfig.apiB?.errorMessagePath, 'message'),
    retryOnRateLimit: num(env.API_B_RETRY_ON_RATE_LIMIT, num(fileConfig.apiB?.retryOnRateLimit, 3)),
    timeoutMs: num(fileConfig.apiB?.timeoutMs, 15_000),
  };

  const requestedAdapter = str(env.ADAPTER, str(fileConfig.adapter, 'mock')).toLowerCase();
  const endpointsConfigured = isEndpointConfigured(apiA) && isEndpointConfigured(apiB);
  // 想用真实接口但地址还没填时，自动退回 mock，避免整个应用直接不可用
  const adapter = requestedAdapter === 'http' && !endpointsConfigured ? 'mock' : requestedAdapter;

  return {
    rootDir: ROOT_DIR,
    port: num(env.PORT, 8787),
    host: str(env.HOST, '0.0.0.0'),
    timeZone,
    // SQLite 数据库（新版）；dataFile 只是旧版 JSON，用来提示是否还有历史数据
    dbFile: resolvePath(env.DB_FILE, './data/kimuzhi.db'),
    dataFile: resolvePath(env.DATA_FILE, './data/accounts.json'),
    publicDir: path.join(ROOT_DIR, 'public'),
    sharedDir: path.join(ROOT_DIR, 'shared'),
    adapter,
    requestedAdapter,
    endpointsConfigured,
    apiKey,
    apiKeyParam,
    apiKeyHeader,
    settleGraceMs: num(env.SETTLE_GRACE_MS, 10 * 60 * 1000),
    autoRefreshMinutes: num(env.AUTO_REFRESH_MINUTES, 0),
    // 本地模式（未登录时把游戏账号存在浏览器里）：不落库，只借用服务端代理调接口
    allowLocalMode: str(env.ALLOW_LOCAL_MODE, '1') !== '0',
    // 管理员：配了就用配置的，没配且系统里一个管理员都没有时会建默认管理员并告警
    adminUsername: str(env.ADMIN_USERNAME, ''),
    adminPassword: str(env.ADMIN_PASSWORD, ''),
    // 每个账号保留多少条点赞记录（管理后台还能看到更早的，这里只是查询默认值）
    mock: {
      speed: Math.max(0, num(env.MOCK_SPEED, num(fileConfig.mock?.speed, 1))),
      epochKey: str(fileConfig.mock?.epochKey, '2024-01-01'),
    },
    apiA,
    apiB,
    regionCodes,
    version: readVersion(),
  };
}

function readVersion() {
  const pkg = readJsonSafe(path.join(ROOT_DIR, 'package.json'));
  return pkg?.version ?? '0.0.0';
}

export function assertRegion(value) {
  return isRegionId(value);
}
