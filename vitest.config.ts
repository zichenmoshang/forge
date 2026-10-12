import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 排除运行期临时目录：LocalSubprocessTestRunner（#83）把工作区落盘到 .sandbox/，
    // 若不做排除，其中的测试文件会被全量扫描误判为测试套件
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.sandbox/**',
      '**/data/**',
      '**/.tmp/**',
      '**/output/**',
    ],
  },
});
