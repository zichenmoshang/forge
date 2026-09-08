/**
 * Forge 配置入口
 *
 * 用法：
 *   import { getConfig } from '../config';
 *   const config = getConfig();
 *
 * 配置来源：.env 文件 > 环境变量 > 默认值
 * 启动时用 zod 校验，必填字段缺失则 fail-fast
 */

export * from './schema';
export { loadConfig, getConfig, resetConfigCache } from './loader';
