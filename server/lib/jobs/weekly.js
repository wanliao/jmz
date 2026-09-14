/**
 * 定时任务：
 *  1. 每周一 00:00:01（游戏周起点）之后，遍历数据库里所有 roleId，
 *     用接口 B 查到点赞数并记成「上一周的点赞记录」，同时把新一周的基线设成这个值；
 *  2. 可选的周期性全量刷新（AUTO_REFRESH_MINUTES > 0 时开启）。
 *
 * 用「每 15 秒检查一次 + 记录已结算的周标识」而不是精确 setTimeout，
 * 这样进程重启、服务器时间跳变、机器休眠后都能自愈，且不会重复结算。
 */

import { getWeekStart } from '../../../shared/week.js';

const CHECK_INTERVAL_MS = 15_000;

/**
 * @param {object} options
 * @param {() => Date} [options.now] 取当前时间的函数（测试时可以注入假时钟）
 */
export function startScheduler({ service, config, logger = console, now = () => new Date() }) {
  let stopped = false;
  let tickTimer = null;
  let lastAutoRefreshAt = 0;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const at = now();
      const week = getWeekStart(at, config.timeZone);
      const withinGrace = at.getTime() - week.startMs <= config.settleGraceMs;
      const lastCronWeekKey = service.repo.settings.get('lastCronWeekKey');

      // 跨周结算：宽限期窗口内且这一周还没结算过
      if (withinGrace && lastCronWeekKey !== week.key) {
        const result = await service.runWeeklySettlement({ at });
        logger.log(
          `[job] 周结算完成 week=${week.key} 上周=${result.prevWeekKey} ` +
            `推进基线=${result.settledAccounts} 刷新=${result.refreshed} 失败=${result.refreshedFailed}`,
        );
      }

      // 周期性全量刷新（可选）
      const intervalMs = Math.max(0, config.autoRefreshMinutes) * 60_000;
      if (intervalMs > 0 && at.getTime() - lastAutoRefreshAt >= intervalMs) {
        lastAutoRefreshAt = at.getTime();
        const roles = service.repo.roles.listAllRoles();
        const byUser = new Map();
        for (const role of roles) {
          if (!byUser.has(role.userId)) byUser.set(role.userId, []);
          byUser.get(role.userId).push(role);
        }
        let succeeded = 0;
        let failed = 0;
        for (const userId of byUser.keys()) {
          const result = await service.refreshAll(userId, at);
          succeeded += result.succeeded;
          failed += result.failed;
        }
        logger.log(`[job] 自动刷新完成 成功=${succeeded} 失败=${failed}`);
      }
    } catch (error) {
      logger.error('[job] 定时任务执行失败：', error);
    } finally {
      running = false;
    }
  }

  // 启动后延迟几秒先跑一次，覆盖「服务器停机期间错过结算窗口」的情况
  const bootTimer = setTimeout(tick, 5_000);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  tickTimer = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();

  return {
    stop() {
      stopped = true;
      clearTimeout(bootTimer);
      clearInterval(tickTimer);
    },
    runNow: tick,
  };
}
