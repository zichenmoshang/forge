/**
 * 构建运行器 - 交付阶段构建验证
 *
 * 职责：
 * - 自动检测包管理器（packageManager 字段 / lock 文件）
 * - 运行构建命令（npm run build / pnpm build / yarn build）
 * - 捕获构建输出和错误
 * - 超时控制
 *
 * v1 默认实现：调用本地包管理器 CLI
 * 可注入：测试时用 MockBuildRunner
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** 包管理器类型 */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** 构建结果 */
export interface BuildResult {
  /** 是否成功 */
  success: boolean;
  /** 包管理器 */
  packageManager: PackageManager;
  /** 执行的命令 */
  command: string;
  /** 构建输出（stdout + stderr） */
  output: string;
  /** 错误信息（如果失败） */
  error?: string;
  /** 构建耗时（毫秒） */
  durationMs: number;
  /** 是否超时 */
  timedOut?: boolean;
}

/** 构建运行器接口 */
export interface BuildRunner {
  /** 检测项目的包管理器 */
  detectPackageManager(projectPath: string): Promise<PackageManager>;
  /** 检测构建命令 */
  detectBuildCommand(projectPath: string, packageManager: PackageManager): Promise<string>;
  /** 运行构建 */
  runBuild(projectPath: string, options?: BuildOptions): Promise<BuildResult>;
}

/** 构建选项 */
export interface BuildOptions {
  /** 自定义构建命令（不填自动检测） */
  command?: string;
  /** 包管理器（不填自动检测） */
  packageManager?: PackageManager;
  /** 超时时间（毫秒），默认 300000 */
  timeoutMs?: number;
  /** 是否安装依赖（默认 false，假设已安装） */
  installDeps?: boolean;
}

/** 默认构建运行器：调用本地包管理器 CLI */
export class DefaultBuildRunner implements BuildRunner {
  async detectPackageManager(projectPath: string): Promise<PackageManager> {
    // 1. 检查 package.json 的 packageManager 字段
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (typeof pkg.packageManager === 'string') {
          if (pkg.packageManager.startsWith('pnpm')) return 'pnpm';
          if (pkg.packageManager.startsWith('yarn')) return 'yarn';
          if (pkg.packageManager.startsWith('npm')) return 'npm';
        }
      } catch {
        // 解析失败，继续检测
      }
    }

    // 2. 检查 lock 文件
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(projectPath, 'package-lock.json'))) return 'npm';

    // 3. 默认 npm
    return 'npm';
  }

  async detectBuildCommand(projectPath: string, packageManager: PackageManager): Promise<string> {
    // 检查 package.json scripts.build
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (pkg.scripts && typeof pkg.scripts.build === 'string') {
          return `${packageManager} run build`;
        }
      } catch {
        // 解析失败，继续
      }
    }

    // 默认构建命令
    return `${packageManager} run build`;
  }

  async runBuild(projectPath: string, options?: BuildOptions): Promise<BuildResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 300000;
    const packageManager =
      options?.packageManager ?? (await this.detectPackageManager(projectPath));
    const command =
      options?.command ?? (await this.detectBuildCommand(projectPath, packageManager));

    // 安装依赖（如果需要）
    if (options?.installDeps) {
      const installCommand =
        packageManager === 'pnpm'
          ? 'pnpm install'
          : packageManager === 'yarn'
            ? 'yarn install'
            : 'npm install';
      try {
        execSync(installCommand, {
          cwd: projectPath,
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120000,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        return {
          success: false,
          packageManager,
          command: installCommand,
          output: '',
          error: `依赖安装失败: ${err instanceof Error ? err.message : String(err)}`,
          durationMs,
        };
      }
    }

    // 运行构建
    try {
      const output = execSync(command, {
        cwd: projectPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: timeoutMs,
      });
      const durationMs = Date.now() - startTime;
      return {
        success: true,
        packageManager,
        command,
        output,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      const timedOut = error.includes('ETIMEDOUT') || error.includes('timed out');
      // 提取 stderr 输出
      let output = '';
      if (err && typeof err === 'object' && 'stderr' in err) {
        output = String((err as { stderr?: string }).stderr ?? '');
      }
      return {
        success: false,
        packageManager,
        command,
        output,
        error,
        durationMs,
        timedOut,
      };
    }
  }
}
