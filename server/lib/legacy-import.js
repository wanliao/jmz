/**
 * 旧版（JSON 文件）账号数据的一次性导入。
 *
 * 旧版本没有用户体系，数据存在 data/accounts.json。升级到 SQLite 后不能直接丢，
 * 所以启动时如果发现「数据库里还没有任何角色」而旧文件里有账号，就导进来。
 * 现在的角色表是全站共享的（不绑定用户），所以导入的数据直接进 roles 表即可。
 */

import fs from 'node:fs';

import { getWeekStart } from '../../shared/week.js';

export const LEGACY_SOURCE = 'legacy-json';

/**
 * @returns {{ imported: number, roleIds: string[] }|null}
 */
export function importLegacyJson({ repo, config, logger = console }) {
  let parsed;
  try {
    if (!fs.existsSync(config.dataFile)) return null;
    parsed = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
  } catch {
    return null;
  }

  const accounts = Object.values(parsed?.accounts ?? {});
  if (accounts.length === 0) return null;

  // 只在「新库里一个角色都没有」时导入，避免重复
  if (repo.roles.countRoles() > 0) {
    logger.log(
      `[legacy] 旧版 JSON 里还有 ${accounts.length} 个账号，但数据库里已经有角色了，跳过导入（旧文件保留，不需要的话可以删掉）`,
    );
    return null;
  }

  const roleIds = [];
  for (const account of accounts) {
    const roleId = String(account.roleId);
    if (!roleId || repo.roles.getRole(roleId)) continue;

    try {
      repo.roles.createRole({
        roleId,
        nickname: account.nickname ?? '',
        region: account.region ?? 'wechat',
        profile: account.profile ?? null,
        baseline: Number(account.baseline ?? 0),
        baselineWeekKey: account.baselineWeekKey ?? getWeekStart(new Date(), config.timeZone).key,
        baselineSource: account.baselineSource ?? LEGACY_SOURCE,
        baselineEstimated: Boolean(account.baselineEstimated),
        baselineUpdatedAt: account.baselineUpdatedAt ?? null,
        baselineFromWeekKey: account.baselineFromWeekKey ?? null,
        currentLikes: account.currentLikes ?? null,
        lastQueriedAt: account.lastQueriedAt ?? null,
        lastSnapshot: account.lastSnapshot ?? null,
        lastError: account.lastError ?? null,
        createdAt: account.createdAt ?? new Date().toISOString(),
        updatedAt: account.updatedAt ?? new Date().toISOString(),
      });
      roleIds.push(roleId);
    } catch (error) {
      logger.error(`[legacy] 导入 ${roleId} 失败：${error.message}`);
    }
  }

  if (roleIds.length > 0) {
    repo.audit.log({
      actor: 'system',
      action: 'legacy.import',
      target: LEGACY_SOURCE,
      detail: { roleIds, count: roleIds.length },
    });
    // 导入过了就把旧文件改名存档，免得每次启动都重复扫描/告警（数据仍然保留着）
    try {
      const archived = `${config.dataFile}.imported-${Date.now()}.bak`;
      fs.renameSync(config.dataFile, archived);
      logger.log(`[legacy] 旧文件已存档为 ${archived}（内容没有删）`);
    } catch (error) {
      logger.warn(`[legacy] 旧文件改名失败（不影响使用）：${error.message}`);
    }
    logger.log(`[legacy] 已把旧版 JSON 里的 ${roleIds.length} 个账号导入数据库：${roleIds.join(', ')}`);
  }

  return { imported: roleIds.length, roleIds };
}
