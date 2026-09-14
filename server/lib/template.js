/** 接口配置里的小工具：占位符替换 + 按路径取字段。真实接口字段名变了只改配置。 */

/**
 * 递归替换对象 / 字符串里的 {placeholder}。
 * 值为纯占位符且未定义时保留原样，避免把 undefined 拼进请求里。
 */
export function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    const exact = /^\{([a-zA-Z0-9_]+)\}$/.exec(value);
    if (exact) {
      const replacement = vars[exact[1]];
      return replacement === undefined ? '' : String(replacement);
    }
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      vars[name] === undefined ? match : String(vars[name]),
    );
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const renderedKey = renderTemplate(key, vars);
      out[renderedKey] = renderTemplate(item, vars);
    }
    return out;
  }
  return value;
}

/**
 * 按 "data.list.0.roleId" 这样的路径取值。
 * 路径为空时返回整个对象；取不到返回 undefined（调用方决定怎么报错）。
 */
export function getByPath(source, path) {
  if (!path) return source;
  const segments = String(path)
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  let cursor = source;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** 拼查询串（跳过空值） */
export function buildQueryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
