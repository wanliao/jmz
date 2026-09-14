/**
 * 服务入口：HTTP 服务 + 静态前端 + API + 定时结算任务。
 * 零第三方依赖（只用 Node 内置模块，数据库用内置 node:sqlite）。
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAdapters } from './lib/adapters/index.js';
import { createAdminService } from './lib/admin.js';
import { createApiHandler } from './api.js';
import { createAuthService, ensureAdmin, hashPassword } from './lib/auth.js';
import { loadConfig, loadEnvFile } from './lib/config.js';
import { closeDatabase, openDatabase } from './lib/db.js';
import { serveStatic } from './lib/http-utils.js';
import { startScheduler } from './lib/jobs/weekly.js';
import { importLegacyJson } from './lib/legacy-import.js';
import { createLocalService } from './lib/local.js';
import { createRepo } from './lib/repo.js';
import { createService } from './lib/service.js';
import { randomBytes } from 'node:crypto';

/** 旧版（JSON 文件）数据还在的话，启动时导入到数据库，避免用户数据丢失 */
function importLegacyIfNeeded({ repo, config }) {
  return importLegacyJson({
    repo,
    config,
    randomPassword: () => hashPassword(randomBytes(24).toString('base64url')),
  });
}

export async function createApp({ env = loadEnvFile() } = {}) {
  const config = loadConfig(env);

  const db = openDatabase({ file: config.dbFile });
  const repo = createRepo(db);
  const adapters = createAdapters(config);
  const auth = createAuthService({ repo, config });
  const service = createService({ config, repo, adapters, auth });
  const admin = createAdminService({ config, repo, auth, adapters });
  const local = createLocalService({ config, adapters });

  const legacy = importLegacyIfNeeded({ repo, config });
  const adminInfo = ensureAdmin({ repo, config });

  const handleApi = createApiHandler({ service, admin, auth, local });

  const mounts = [
    { prefix: '/shared/', dir: config.sharedDir },
    { prefix: '/', dir: config.publicDir },
  ];
  const spaFallback = path.join(config.publicDir, 'index.html');

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    response.on('finish', () => {
      if (url.pathname.startsWith('/api/')) {
        console.log(
          `${request.method} ${url.pathname} -> ${response.statusCode} (${Date.now() - startedAt}ms)`,
        );
      }
    });

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method Not Allowed');
        return;
      }
      const served = await serveStatic({ request, response }, mounts, spaFallback);
      if (!served) response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    } catch (error) {
      console.error('[server] 未捕获异常：', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal Server Error');
    }
  });

  const scheduler = startScheduler({ service, config, logger: console });

  return { config, db, repo, adapters, auth, service, admin, local, adminInfo, legacy, server, scheduler };
}

/** 列出局域网 IPv4 地址，方便直接用手机打开 */
function lanAddresses() {
  const VIRTUAL = /vmnet|virtualbox|vbox|hyper-v|docker|br-|veth|loopback|ztun|utun/i;
  const PHYSICAL = /wlan|wi-?fi|无线|ethernet|以太网|^eth\d|^en[0-9sd]|^eno|^ens|^enp/i;
  const found = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      found.push({ name, address: info.address, virtual: VIRTUAL.test(name), physical: PHYSICAL.test(name) });
    }
  }
  // 真实网卡优先，虚拟网卡（VMware / VirtualBox / Docker）排后面
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(b.physical) - Number(a.physical));
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain || process.env.START_SERVER === '1') {
  const { config, server, scheduler, repo, db, adminInfo } = await createApp();
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    console.log('');
    console.log('  👍 金拇指 · 和平精英每周点赞统计工具 已启动');
    console.log('');
    console.log(`  电脑上打开：http://${shown}:${config.port}`);
    if (config.host === '0.0.0.0') {
      const lan = lanAddresses();
      if (lan.length > 0) {
        console.log('  手机上打开（需连同一个 WiFi）：');
        for (const item of lan) {
          console.log(`      http://${item.address}:${config.port}   [${item.name}${item.virtual ? ' 虚拟网卡' : ''}]`);
        }
      } else {
        console.log('  手机上打开：没检测到局域网地址，请检查网络连接');
      }
    } else {
      console.log('  （当前只监听本机，手机访问请把 HOST 改成 0.0.0.0）');
    }
    console.log('');
    console.log(`  接口适配器：${config.adapter}${config.adapter !== config.requestedAdapter ? `（配置要求 ${config.requestedAdapter}，但真实接口地址未填，已回退 mock）` : ''}`);
    console.log(`  数据库：${config.dbFile}`);
    console.log(`  注册用户 ${repo.users.countUsers()} 个 / 游戏账号 ${repo.roles.countRoles()} 个`);
    console.log(`  未登录（本地模式）：${config.allowLocalMode ? '开启，账号只存在访客浏览器里，不入库' : '关闭'}`);
    console.log(`  管理员：${adminInfo.username ?? '（已有管理员）'}${adminInfo.defaultPassword ? '  ← 默认密码，请尽快修改' : ''}`);
    console.log(`  游戏周时区：${config.timeZone}（每周一 00:00:01 重置并结算）`);
    console.log(`  管理后台：http://${shown}:${config.port}/admin.html`);
    console.log('');
    console.log('  按 Ctrl + C 停止服务');
    console.log('');
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    scheduler.stop();
    server.close(() => {
      closeDatabase(db);
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabase(db);
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
