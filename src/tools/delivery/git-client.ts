/**
 * Git 客户端 - 交付阶段 Git 操作
 *
 * 职责：
 * - 初始化 git 仓库（新项目）
 * - 创建特性分支
 * - 添加变更文件
 * - 提交（自动生成 commit message）
 * - 查看状态
 *
 * v1 默认实现：调用本地 git CLI（通过 child_process）
 * v1 不执行远程 push（远程地址配置但不使用）
 * 可注入：测试时用 InMemoryGitClient
 */

import { execFileSync } from 'child_process';

/** Git 提交信息 */
export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  createdAt: string;
}

/** Git 操作结果 */
export interface GitOperationResult {
  success: boolean;
  /** 操作输出 */
  output?: string;
  /** 错误信息 */
  error?: string;
}

/** 创建分支结果 */
export interface CreateBranchResult extends GitOperationResult {
  branchName: string;
}

/** 提交结果 */
export interface CommitResult extends GitOperationResult {
  commit?: GitCommit;
}

/** Git 状态 */
export interface GitStatus {
  /** 当前分支 */
  currentBranch: string;
  /** 暂存区文件数 */
  stagedCount: number;
  /** 未暂存修改文件数 */
  modifiedCount: number;
  /** 未跟踪文件数 */
  untrackedCount: number;
  /** 是否有未提交变更 */
  hasChanges: boolean;
}

/** Git 客户端接口 */
export interface GitClient {
  /** 检查 git 是否可用 */
  isGitAvailable(): Promise<boolean>;
  /** 初始化 git 仓库 */
  init(projectPath: string): Promise<GitOperationResult>;
  /** 配置用户信息 */
  configUser(projectPath: string, name: string, email: string): Promise<GitOperationResult>;
  /** 创建并切换到分支 */
  createBranch(
    projectPath: string,
    branchName: string,
    baseBranch?: string,
  ): Promise<CreateBranchResult>;
  /** 添加文件到暂存区 */
  add(projectPath: string, filePaths: string[]): Promise<GitOperationResult>;
  /** 提交 */
  commit(projectPath: string, message: string): Promise<CommitResult>;
  /** 查看状态 */
  status(projectPath: string): Promise<GitStatus>;
  /** 获取当前分支名 */
  getCurrentBranch(projectPath: string): Promise<string>;
  /** 检查是否为 git 仓库 */
  isRepo(projectPath: string): Promise<boolean>;
}

/** 默认 Git 客户端：调用本地 git CLI */
export class DefaultGitClient implements GitClient {
  private gitPath = 'git';

  async isGitAvailable(): Promise<boolean> {
    try {
      execFileSync(this.gitPath, ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async init(projectPath: string): Promise<GitOperationResult> {
    return this.runGit(projectPath, ['init']);
  }

  async configUser(projectPath: string, name: string, email: string): Promise<GitOperationResult> {
    await this.runGit(projectPath, ['config', 'user.name', name]);
    return this.runGit(projectPath, ['config', 'user.email', email]);
  }

  async createBranch(
    projectPath: string,
    branchName: string,
    baseBranch?: string,
  ): Promise<CreateBranchResult> {
    // 先切换到基础分支并拉取最新（v1 不 pull，只 checkout）
    if (baseBranch) {
      const checkoutResult = await this.runGit(projectPath, ['checkout', baseBranch]);
      if (!checkoutResult.success) {
        return { success: false, branchName, error: checkoutResult.error };
      }
    }
    // 创建并切换到新分支
    const result = await this.runGit(projectPath, ['checkout', '-b', branchName]);
    return { ...result, branchName };
  }

  async add(projectPath: string, filePaths: string[]): Promise<GitOperationResult> {
    if (filePaths.length === 0) {
      return { success: true, output: 'no files to add' };
    }
    return this.runGit(projectPath, ['add', ...filePaths]);
  }

  async commit(projectPath: string, message: string): Promise<CommitResult> {
    const result = await this.runGit(projectPath, ['commit', '-m', message]);
    if (!result.success) {
      return { ...result };
    }
    // 获取提交信息
    const logResult = await this.runGit(projectPath, ['log', '-1', '--format=%H|%an|%aI|%s']);
    if (logResult.success && logResult.output) {
      const parts = logResult.output.trim().split('|');
      if (parts.length >= 4) {
        return {
          success: true,
          commit: {
            hash: parts[0],
            author: parts[1],
            createdAt: parts[2],
            message: parts.slice(3).join('|'),
          },
        };
      }
    }
    return { success: true };
  }

  async status(projectPath: string): Promise<GitStatus> {
    const result = await this.runGit(projectPath, ['status', '--porcelain']);
    const lines = result.output ? result.output.trim().split('\n').filter(Boolean) : [];
    let stagedCount = 0;
    let modifiedCount = 0;
    let untrackedCount = 0;
    for (const line of lines) {
      const status = line.substring(0, 2);
      if (status.includes('??')) {
        untrackedCount++;
      } else if (status[0] !== ' ') {
        stagedCount++;
      } else if (status[1] !== ' ') {
        modifiedCount++;
      }
    }
    const currentBranch = await this.getCurrentBranch(projectPath);
    return {
      currentBranch,
      stagedCount,
      modifiedCount,
      untrackedCount,
      hasChanges: lines.length > 0,
    };
  }

  async getCurrentBranch(projectPath: string): Promise<string> {
    const result = await this.runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.success && result.output ? result.output.trim() : 'unknown';
  }

  async isRepo(projectPath: string): Promise<boolean> {
    const result = await this.runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
    return result.success && result.output?.trim() === 'true';
  }

  /** 执行 git 命令（使用 execFileSync 数组参数，杜绝 shell 注入） */
  private runGit(projectPath: string, args: string[]): GitOperationResult {
    try {
      const output = execFileSync(this.gitPath, args, {
        cwd: projectPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 30000,
      });
      return { success: true, output };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}

/**
 * 生成 commit message
 *
 * 格式：
 *   feat: {需求标题}
 *
 *   - 完成故事: {storyId1}, {storyId2}
 *   - 变更文件: {N} 个新增, {M} 个修改
 *   - 关联: Forge instance {instanceId}
 */
export function generateCommitMessage(options: {
  requirementTitle: string;
  storyIds: string[];
  filesAdded: number;
  filesModified: number;
  instanceId: string;
}): string {
  const title =
    options.requirementTitle.length > 50
      ? options.requirementTitle.substring(0, 50) + '...'
      : options.requirementTitle;
  const lines = [
    `feat: ${title}`,
    '',
    `- 完成故事: ${options.storyIds.join(', ')}`,
    `- 变更文件: ${options.filesAdded} 个新增, ${options.filesModified} 个修改`,
    `- 关联: Forge instance ${options.instanceId}`,
  ];
  return lines.join('\n');
}
