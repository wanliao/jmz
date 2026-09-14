/** HTTP 小工具：JSON 响应、请求体解析、静态文件服务（带 gzip / ETag 协商缓存） */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const TEXT_LIKE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJsonBody(req, { limitBytes = 64 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error('请求体过大');
      error.status = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      const error = new Error('请求体必须是 JSON 对象');
      error.status = 400;
      error.code = 'INVALID_BODY';
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.code === 'INVALID_BODY') throw error;
    const invalid = new Error('请求体不是合法 JSON');
    invalid.status = 400;
    invalid.code = 'INVALID_BODY';
    throw invalid;
  }
}

/** 解析后的路径必须留在挂载目录内，防目录穿越 */
function resolveWithin(baseDir, relativePath) {
  const target = path.resolve(baseDir, `.${path.posix.normalize(`/${relativePath}`)}`);
  const normalizedBase = path.resolve(baseDir);
  if (target !== normalizedBase && !target.startsWith(normalizedBase + path.sep)) return null;
  return target;
}

const gzipCache = new Map(); // key: filePath -> { mtimeMs, size, body }

function gzipCached(filePath, mtimeMs, buffer) {
  const cached = gzipCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === buffer.length) return cached.body;
  const body = zlib.gzipSync(buffer, { level: 6 });
  gzipCache.set(filePath, { mtimeMs, size: buffer.length, body });
  if (gzipCache.size > 100) {
    const oldest = gzipCache.keys().next().value;
    gzipCache.delete(oldest);
  }
  return body;
}

/**
 * 静态文件服务。
 * @param {{request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse}} ctx
 * @param {Array<{ prefix: string, dir: string }>} mounts 前缀 -> 目录，按顺序匹配
 * @param {string} [spaFallback] 未命中时的回退文件（前端单页应用）
 */
export async function serveStatic(ctx, mounts, spaFallback) {
  const { request, response } = ctx;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad Request');
    return true;
  }

  const mount = mounts.find((item) => pathname.startsWith(item.prefix));
  let filePath = null;

  if (mount) {
    const relative = pathname.slice(mount.prefix.length);
    filePath = resolveWithin(mount.dir, relative === '' ? 'index.html' : relative);

    if (filePath) {
      try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch {
        filePath = null;
      }
    }
  }

  if (!filePath && spaFallback) {
    filePath = spaFallback;
  }
  if (!filePath) return false;

  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    ETag: etag,
  };

  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    response.end();
    return true;
  }

  // HTML 不缓存 gzip，其余文本类型按需压缩
  const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
  const compressible = TEXT_LIKE.test(contentType) && stat.size > 1024 && ext !== '.html';

  if (acceptsGzip && compressible) {
    const buffer = await fsp.readFile(filePath);
    const body = gzipCached(filePath, stat.mtimeMs, buffer);
    response.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
    return true;
  }

  response.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(response);
    response.on('close', () => stream.destroy());
  });
  return true;
}
