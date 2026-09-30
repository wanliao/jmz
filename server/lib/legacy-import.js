/**
 * 旧版（JSON 文件）账号数据的一次性导入。
 *
 * 旧版本没有用户体系，数据存在 data/accounts.json。升级到 SQLite 后不能直接丢，
 * 所以启动时如果发现「数据库里还没有任何角色」而旧文件里有账号，就导进来，
 * 统一挂在一个名为 legacy-import 的账号下；管理员可以在后台点「改归属」
 * 把它们转给真正的用户。
 */

import fs from 'node:fs';

import { getWeekStart, weekKeyToWeek } from '../../shared/week.js';

export const LEGACY_USERNAME = 'legacy-import';

function previousWeekKeyOf(weekKey, timeZone) {
  const week = weekKeyToWeek(weekKey, timeZone);
  if (!week) return null;
  return getWeekStart(new Date(week.startMs - 1), timeZone).key;
}

/**
 * @returns {{ imported: number, userId: number|null, roleIds: string[] }|null}
 */
export function importLegacyJson({ repo, config, logger = console, randomPassword }) {
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

  let user = repo.users.getUserByUsername(LEGACY_USERNAME);
  if (!user) {
    // 建一个不能登录的账号（随机密码，谁也不知道），只用来承载导入的数据
    user = repo.users.createUser({
      username: LEGACY_USERNAME,
      passwordHash: randomPassword ? randomPassword() : 'disabled',
    });
  }

  const roleIds = [];
  for (const account of accounts) {
    const roleId = String(account.roleId);
    if (!roleId || repo.roles.getRole(roleId)) continue;

    try {
      repo.roles.createRole({
        roleId,
        userId: user.id,
        nickname: account.nickname ?? '',
        region: account.region ?? 'wechat',
        profile: account.profile ?? null,
        baseline: Number(account.baseline ?? 0),
        baselineWeekKey: account.baselineWeekKey ?? getWeekStart(new Date(), config.timeZone).key,
        baselineSource: account.baselineSource ?? 'legacy',
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

      // 顺手补一条「上周点赞数」记录
      const prevKey = account.baselineWeekKey
        ? previousWeekKeyOf(account.baselineWeekKey, config.timeZone)
        : null;
      if (prevKey && !repo.weeklyLikes.getWeeklyLike(roleId, prevKey)) {
        repo.weeklyLikes.createWeeklyLike({
          roleId,
          weekKey: prevKey,
          likes: Number(account.baseline ?? 0),
          source: 'legacy',
          note: '旧版 JSON 导入时带过来的上周点赞数',
        });
      }

      roleIds.push(roleId);
    } catch (error) {
      logger.error(`[legacy] 导入 ${roleId} 失败：${error.message}`);
    }
  }

  if (roleIds.length > 0) {
    repo.audit.log({
      actor: 'system',
      action: 'legacy.import',
      target: LEGACY_USERNAME,
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
    logger.warn(
      [
        '',
        `  ℹ️  已把旧版 JSON 里的 ${roleIds.length} 个账号导入数据库（归属账号：${LEGACY_USERNAME}）`,
        `      roleId：${roleIds.join(', ')}`,
        '      想交给哪个用户：登录管理员 → 管理后台 → 游戏账号 → 「改归属」',
        '',
      ].join('\n'),
    );
  }

  return { imported: roleIds.length, userId: user.id, roleIds };
}
