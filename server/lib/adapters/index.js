import { createHttpAdapter } from './http.js';
import { createMockAdapter } from './mock.js';

export { AdapterError } from './http.js';

/**
 * 根据配置创建接口适配器。
 * ADAPTER=mock 用假数据；ADAPTER=http 走真实接口（地址没填时 config 会自动回退成 mock）。
 */
export function createAdapters(config) {
  if (config.adapter === 'http') {
    return createHttpAdapter({ config });
  }
  return createMockAdapter({ config });
}
