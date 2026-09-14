/** 展示格式化工具 */

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return Math.round(num).toLocaleString('zh-CN');
}

/** 距离下一周重置的倒计时 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '--';
  if (ms <= 0) return '即将重置';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function formatWith(ts, options) {
  if (!ts) return '--';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--';
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour12: false, ...options }).format(date);
  } catch {
    return date.toLocaleString('zh-CN');
  }
}

export function formatDateTime(iso, timeZone) {
  return formatWith(iso, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return '还没有查询过';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '还没有查询过';
  const diff = nowMs - ts;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(iso);
}
