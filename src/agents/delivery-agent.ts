/**
 * 交付 Agent - 阶段7
 *
 * 职责：
 * - 场景判定（新项目/新模块/代码修改，自动推断+可显式指定）
 * - 新项目初始化（基础结构：package.json + 目录 + 配置 + 入口文件）
 * - 代码落盘（GeneratedFile.content → 目标项目文件）
 * - 构建验证（自动检测包管理器+构建命令，执行构建）
 * - Git 操作（创建分支、add、commit，v1 不远程 push）
 * - PR 描述自动生成（LLM，关联需求/故事/测试/CR/变更）
 *
 * 输入：DeliveryAgentInput（coding + codeReview + requirementTitle + instanceId）
 * 输出：DeliveryResult（交付状态 + Git 信息 + PR 描述 + 变更统计 + 构建结果）
 *
 * 配置通过构造函数注入：deliveryConfig（targetProjectPath/git/build）
 * 工具层通过构造函数注入：fileSystemClient/gitClient/buildRunner（可替换，v1 默认实现）
 */

import { BaseAgent } from './base';
import type { AgentContext, AgentError, AgentResult } from './types';
import type { LLMProvider, LLMRequest } from '../llm/provider';
import type { Logger } from '../observability/logger';
import type { KnowledgeItem } from '../types/knowledge';
import type { DeliveryResult } from '../types/review-and-delivery';
import type { DeliveryAgentInput } from '../core/context-manager';
import type { DeliveryConfig } from '../config/schema';
import { DELIVERY_SYSTEM_PROMPT, renderDeliveryUserPrompt } from '../prompts/delivery';
import {
  DefaultFileSystemClient,
  DefaultGitClient,
  DefaultBuildRunner,
  generateCommitMessage,
  type FileSystemClient,
  type GitClient,
  type BuildRunner,
  type WriteFileResult,
  type ProjectState,
} from '../tools/delivery';

/** DeliveryAgent 构造函数选项 */
export interface DeliveryAgentOptions {
  logger?: Logger;
  /** 交付配置（目标项目路径、Git、构建） */
  deliveryConfig: DeliveryConfig;
  /** 文件系统客户端（可选，默认 DefaultFileSystemClient） */
  fileSystemClient?: FileSystemClient;
  /** Git 客户端（可选，默认 DefaultGitClient） */
  gitClient?: GitClient;
  /** 构建运行器（可选，默认 DefaultBuildRunner） */
  buildRunner?: BuildRunner;
}

/** 交付执行中间结果（程序化操作产出，LLM 生成 PR 描述前的状态） */
interface DeliveryExecutionState {
  projectState: ProjectState;
  scenario: 'new-project' | 'new-module' | 'code-modification';
  writeResults: WriteFileResult[];
  buildResult?: {
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
    packageManager: string;
    command: string;
  };
  gitBranch?: string;
  gitCommit?: { hash: string; message: string; author: string; createdAt: string };
  gitErrors: string[];
  knownIssues: string[];
}

export class DeliveryAgent extends BaseAgent<DeliveryAgentInput, DeliveryResult> {
  readonly name = 'delivery-agent';
  readonly version = '0.1.0';

  private deliveryConfig: DeliveryConfig;
  private fileSystemClient: FileSystemClient;
  private gitClient: GitClient;
  private buildRunner: BuildRunner;

  constructor(llm: LLMProvider, options: DeliveryAgentOptions) {
    super(llm, { logger: options.logger });
    this.deliveryConfig = options.deliveryConfig;
    this.fileSystemClient = options.fileSystemClient ?? new DefaultFileSystemClient();
    this.gitClient = options.gitClient ?? new DefaultGitClient();
    this.buildRunner = options.buildRunner ?? new DefaultBuildRunner();
  }

  /**
   * 重写 execute：交付阶段以程序化操作为主，LLM 仅用于生成 PR 描述。
   *
   * 流程：校验输入 → 场景判定 → 新项目初始化（如需要）→ 代码落盘 → 构建验证
   *       → Git 操作 → LLM 生成 PR 描述 → 校验输出 → 自检 → 返回
   */
  async execute(context: AgentContext): Promise<AgentResult<DeliveryResult>> {
    const input = context.input as DeliveryAgentInput;
    const startTime = Date.now();

    // 1. 校验输入
    const inputErrors = this.validateInput(input, context);
    if (inputErrors.some((e) => e.severity === 'error')) {
      return {
        success: false,
        errors: inputErrors,
        durationMs: Date.now() - startTime,
        llmCalls: 0,
        retries: 0,
      };
    }

    this.logger?.info(
      `[DeliveryAgent] 开始交付，目标项目: ${this.deliveryConfig.targetProjectPath}`,
    );

    // 2. 程序化操作：场景判定 + 初始化 + 落盘 + 构建 + Git
    const state = await this.performDelivery(input, context);

    // 3. LLM 生成 PR 描述
    let prDescription: string;
    let llmCalls = 0;
    try {
      prDescription = await this.generatePRDescription(input, context, state);
      llmCalls = 1;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      state.knownIssues.push(`PR 描述生成失败（使用默认模板）: ${errorMsg}`);
      prDescription = this.generateFallbackPRDescription(input, state);
    }

    // 4. 组装 DeliveryResult
    const result = this.assembleDeliveryResult(input, state, prDescription);

    // 5. 校验输出
    const outputErrors = this.validateOutput(result, input, context);

    // 6. 自检
    const selfCheckErrors = this.selfCheck(result, input, context);

    const allErrors = [...outputErrors, ...selfCheckErrors];
    const success = result.status !== 'failed' && !allErrors.some((e) => e.severity === 'error');

    this.logger?.info(
      `[DeliveryAgent] 交付完成，状态: ${result.status}, 变更文件: ${result.changes.filesAdded + result.changes.filesModified} 个, 耗时: ${Date.now() - startTime}ms`,
    );

    return {
      success,
      data: result,
      errors: allErrors,
      durationMs: Date.now() - startTime,
      llmCalls,
      retries: 0,
    };
  }

  // ==========================================================================
  // 程序化操作
  // ==========================================================================

  /** 执行交付的程序化操作：场景判定 + 初始化 + 落盘 + 构建 + Git */
  private async performDelivery(
    input: DeliveryAgentInput,
    _context: AgentContext,
  ): Promise<DeliveryExecutionState> {
    const targetPath = this.deliveryConfig.targetProjectPath;
    const state: DeliveryExecutionState = {
      projectState: {
        exists: false,
        isDirectory: false,
        hasPackageJson: false,
        hasSrcDir: false,
        hasGit: false,
        inferredScenario: 'new-project',
      },
      scenario: input.scenario ?? 'code-modification',
      writeResults: [],
      gitErrors: [],
      knownIssues: [],
    };

    // 2.1 场景判定
    state.projectState = await this.fileSystemClient.inspectProject(targetPath);
    state.scenario = input.scenario ?? state.projectState.inferredScenario;
    this.logger?.info(
      `[DeliveryAgent] 交付场景: ${state.scenario}（项目存在: ${state.projectState.exists}, hasPackageJson: ${state.projectState.hasPackageJson}）`,
    );

    // 2.2 新项目初始化
    if (state.scenario === 'new-project' && !state.projectState.hasPackageJson) {
      try {
        await this.fileSystemClient.initNewProject(targetPath, {
          framework: 'react',
          packageManager: 'npm',
          buildTool: 'vite',
          projectName: this.extractProjectName(targetPath),
          typescript: true,
        });
        this.logger?.info('[DeliveryAgent] 新项目初始化完成（React + TypeScript + Vite）');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        state.knownIssues.push(`新项目初始化失败: ${errorMsg}`);
      }
    }

    // 2.3 代码落盘
    const allFiles = input.coding.allFiles ?? [];
    for (const file of allFiles) {
      if (!file.content) {
        state.knownIssues.push(`文件 ${file.path} 缺少 content，跳过写入`);
        continue;
      }
      try {
        const writeResult = await this.fileSystemClient.writeFile(
          targetPath,
          file.path,
          file.content,
        );
        state.writeResults.push(writeResult);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        state.knownIssues.push(`文件写入失败 ${file.path}: ${errorMsg}`);
      }
    }
    this.logger?.info(`[DeliveryAgent] 代码落盘完成: ${state.writeResults.length} 个文件`);

    // 2.4 构建验证
    if (this.deliveryConfig.build.enabled) {
      try {
        const buildResult = await this.buildRunner.runBuild(targetPath, {
          command: this.deliveryConfig.build.command || undefined,
          timeoutMs: this.deliveryConfig.build.timeoutMs,
          installDeps: this.deliveryConfig.build.installDeps,
        });
        state.buildResult = {
          success: buildResult.success,
          output: buildResult.output,
          error: buildResult.error,
          durationMs: buildResult.durationMs,
          packageManager: buildResult.packageManager,
          command: buildResult.command,
        };
        if (buildResult.success) {
          this.logger?.info(
            `[DeliveryAgent] 构建验证通过（${buildResult.packageManager}, ${buildResult.durationMs}ms）`,
          );
        } else {
          state.knownIssues.push(`构建验证失败: ${buildResult.error ?? '未知错误'}`);
          this.logger?.warn(`[DeliveryAgent] 构建验证失败: ${buildResult.error}`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        state.knownIssues.push(`构建验证异常: ${errorMsg}`);
        state.buildResult = {
          success: false,
          output: '',
          error: errorMsg,
          durationMs: 0,
          packageManager: 'unknown',
          command: 'unknown',
        };
      }
    } else {
      this.logger?.info('[DeliveryAgent] 构建验证已禁用（配置 build.enabled=false）');
    }

    // 2.5 Git 操作
    try {
      // 检查是否为 git 仓库
      const isRepo = await this.gitClient.isRepo(targetPath);
      if (!isRepo) {
        const initResult = await this.gitClient.init(targetPath);
        if (!initResult.success) {
          state.gitErrors.push(`git init 失败: ${initResult.error}`);
        } else {
          await this.gitClient.configUser(
            targetPath,
            this.deliveryConfig.git.userName,
            this.deliveryConfig.git.userEmail,
          );
        }
      }

      // 创建分支
      const branchName = `${this.deliveryConfig.git.branchPrefix}/${input.instanceId}`;
      const branchResult = await this.gitClient.createBranch(
        targetPath,
        branchName,
        this.deliveryConfig.git.baseBranch,
      );
      if (branchResult.success) {
        state.gitBranch = branchName;
      } else {
        state.gitErrors.push(`创建分支失败: ${branchResult.error}`);
      }

      // 添加文件
      const filePaths = state.writeResults.map((r) => r.relativePath);
      const addResult = await this.gitClient.add(targetPath, filePaths);
      if (!addResult.success) {
        state.gitErrors.push(`git add 失败: ${addResult.error}`);
      }

      // 提交
      const storyIds = [...input.coding.successStoryIds, ...input.coding.partialStoryIds];
      const filesAdded = state.writeResults.filter((r) => r.operation === 'add').length;
      const filesModified = state.writeResults.filter((r) => r.operation === 'modify').length;
      const commitMessage = generateCommitMessage({
        requirementTitle: input.requirementTitle,
        storyIds,
        filesAdded,
        filesModified,
        instanceId: input.instanceId,
      });
      const commitResult = await this.gitClient.commit(targetPath, commitMessage);
      if (commitResult.success && commitResult.commit) {
        state.gitCommit = commitResult.commit;
        this.logger?.info(
          `[DeliveryAgent] Git 提交完成: ${commitResult.commit.hash.substring(0, 8)} on ${branchName}`,
        );
      } else {
        state.gitErrors.push(`git commit 失败: ${commitResult.error}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      state.gitErrors.push(`Git 操作异常: ${errorMsg}`);
    }

    if (state.gitErrors.length > 0) {
      state.knownIssues.push(...state.gitErrors);
      this.logger?.warn(`[DeliveryAgent] Git 操作有 ${state.gitErrors.length} 个错误`);
    }

    return state;
  }

  // ==========================================================================
  // PR 描述生成
  // ==========================================================================

  /** LLM 生成 PR 描述 */
  private async generatePRDescription(
    input: DeliveryAgentInput,
    context: AgentContext,
    state: DeliveryExecutionState,
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(input, context);
    const userPrompt = await this.buildUserPrompt(input, context, [], state);
    const request: LLMRequest = {
      prompt: userPrompt,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 2048,
      caller: this.name,
      instanceId: input.instanceId,
    };
    const response = await this.llm.complete(request);
    return response.content.trim();
  }

  /** 兜底 PR 描述模板（LLM 失败时使用） */
  private generateFallbackPRDescription(
    input: DeliveryAgentInput,
    state: DeliveryExecutionState,
  ): string {
    const storyIds =
      [...input.coding.successStoryIds, ...input.coding.partialStoryIds].join(', ') || 'N/A';
    const filesAdded = state.writeResults.filter((r) => r.operation === 'add').length;
    const filesModified = state.writeResults.filter((r) => r.operation === 'modify').length;
    const buildStatus = state.buildResult?.success ? '✅ 通过' : '❌ 失败/未执行';

    return `## ${input.requirementTitle}

### 变更概述
由 Forge 智能体自动生成，关联需求: ${input.requirementTitle}

### 完成的用户故事
${storyIds}

### 变更文件
- 新增: ${filesAdded} 个
- 修改: ${filesModified} 个

### 构建验证
${buildStatus}

### 已知问题
${state.knownIssues.length > 0 ? state.knownIssues.map((i) => `- ${i}`).join('\n') : '无'}

---
*由 Forge 自动生成，instance: ${input.instanceId}*
`;
  }

  // ==========================================================================
  // 结果组装
  // ==========================================================================

  /** 组装最终 DeliveryResult */
  private assembleDeliveryResult(
    input: DeliveryAgentInput,
    state: DeliveryExecutionState,
    prDescription: string,
  ): DeliveryResult {
    const filesAdded = state.writeResults.filter((r) => r.operation === 'add').length;
    const filesModified = state.writeResults.filter((r) => r.operation === 'modify').length;
    const storyIds = [...input.coding.successStoryIds, ...input.coding.partialStoryIds];
    const failedStories = input.coding.failedStories ?? [];

    // 交付状态判定
    let status: DeliveryResult['status'] = 'success';
    if (state.writeResults.length === 0) {
      status = 'failed';
    } else if (state.knownIssues.length > 0 || failedStories.length > 0) {
      status = 'partial';
    }
    if (state.buildResult && !state.buildResult.success) {
      status = status === 'failed' ? 'failed' : 'partial';
    }

    return {
      deliveryId: `delivery-${input.instanceId}`,
      instanceId: input.instanceId,
      status,
      scenario: state.scenario,
      git: {
        branchName: state.gitBranch ?? 'unknown',
        baseBranch: this.deliveryConfig.git.baseBranch,
        commitCount: state.gitCommit ? 1 : 0,
        commits: state.gitCommit ? [state.gitCommit] : [],
      },
      pullRequest: {
        title: input.requirementTitle,
        description: prDescription,
        status: state.gitCommit ? 'draft' : 'failed',
      },
      changes: {
        filesAdded,
        filesModified,
        filesDeleted: 0,
        linesAdded: 0,
        linesDeleted: 0,
        files: state.writeResults.map((r) => ({
          path: r.relativePath,
          operation: r.operation,
          summary: r.operation === 'add' ? '新增文件' : '修改文件',
        })),
      },
      buildVerification: {
        passed: state.buildResult?.success ?? false,
        buildOutput: state.buildResult?.output,
        testPassRate: undefined,
      },
      completedStories: storyIds,
      incompleteStories: failedStories.length > 0 ? failedStories : undefined,
      knownIssues: state.knownIssues.length > 0 ? state.knownIssues : undefined,
      followUpSuggestions: this.generateFollowUpSuggestions(state),
      deliveredAt: new Date().toISOString(),
    };
  }

  /** 生成后续建议 */
  private generateFollowUpSuggestions(state: DeliveryExecutionState): string[] | undefined {
    const suggestions: string[] = [];
    if (state.buildResult && !state.buildResult.success) {
      suggestions.push('构建验证失败，请检查构建错误并修复后重新提交');
    }
    if (state.gitErrors.length > 0) {
      suggestions.push('Git 操作有错误，请手动检查仓库状态');
    }
    if (!state.projectState.hasPackageJson && state.scenario !== 'new-project') {
      suggestions.push('目标项目缺少 package.json，建议确认项目结构');
    }
    if (this.deliveryConfig.git.remoteUrl) {
      suggestions.push(`请手动推送到远程仓库: git push origin ${state.gitBranch ?? '<branch>'}`);
    }
    return suggestions.length > 0 ? suggestions : undefined;
  }

  /** 从路径提取项目名 */
  private extractProjectName(targetPath: string): string {
    const parts = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'forge-project';
  }

  // ==========================================================================
  // BaseAgent 抽象方法实现（供 execute 内部调用）
  // ==========================================================================

  protected validateInput(input: DeliveryAgentInput, _context: AgentContext): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.coding) {
      errors.push({
        code: 'MISSING_CODING_RESULT',
        message: '缺少编码阶段产物（coding）',
        severity: 'error',
      });
    }
    if (!input.codeReview) {
      errors.push({
        code: 'MISSING_CODE_REVIEW',
        message: '缺少代码评审产物（code-review）',
        severity: 'error',
      });
    }
    if (!this.deliveryConfig.targetProjectPath) {
      errors.push({
        code: 'MISSING_TARGET_PATH',
        message: '缺少目标项目路径配置（delivery.targetProjectPath）',
        severity: 'error',
      });
    }
    if (input.coding && (!input.coding.allFiles || input.coding.allFiles.length === 0)) {
      errors.push({
        code: 'NO_FILES_TO_DELIVER',
        message: '编码产物中没有可交付的文件（allFiles 为空）',
        severity: 'warning',
      });
    }
    return errors;
  }

  protected buildSystemPrompt(_input: DeliveryAgentInput, _context: AgentContext): string {
    return DELIVERY_SYSTEM_PROMPT;
  }

  protected async buildUserPrompt(
    input: DeliveryAgentInput,
    _context: AgentContext,
    _knowledge: KnowledgeItem[],
    state?: DeliveryExecutionState,
  ): Promise<string> {
    const allStoryIds = [...input.coding.successStoryIds, ...input.coding.partialStoryIds];
    const storySummaries =
      allStoryIds.length > 0 ? allStoryIds.map((id) => `- ${id}`).join('\n') : 'N/A';

    const fileSummaries = state
      ? state.writeResults
          .map((r) => `- ${r.relativePath}（${r.operation === 'add' ? '新增' : '修改'}）`)
          .join('\n')
      : (input.coding.allFiles?.map((f) => `- ${f.path}`).join('\n') ?? 'N/A');

    const buildStatus = state?.buildResult
      ? state.buildResult.success
        ? `✅ 通过（${state.buildResult.packageManager} ${state.buildResult.command}, ${state.buildResult.durationMs}ms）`
        : `❌ 失败: ${state.buildResult.error ?? '未知错误'}`
      : '未执行';

    const crSummary = input.codeReview.summary ?? 'N/A';
    const crIssues =
      input.codeReview.issues
        ?.map((i) => `- ${i.issueId}: ${i.description}（${i.severity}）`)
        .join('\n') ?? '无';

    const knownIssues = state?.knownIssues.length
      ? state.knownIssues.map((i) => `- ${i}`).join('\n')
      : '无';

    return renderDeliveryUserPrompt({
      requirementTitle: input.requirementTitle,
      scenario: state?.scenario ?? input.scenario ?? '自动推断',
      instanceId: input.instanceId,
      storySummaries,
      fileSummaries,
      buildStatus,
      crSummary,
      crIssues,
      knownIssues,
    });
  }

  protected parseOutput(
    _content: string,
    _input: DeliveryAgentInput,
    _context: AgentContext,
  ): DeliveryResult {
    // DeliveryAgent.execute 已重写，程序化操作 + LLM 生成 PR 描述后直接组装 DeliveryResult，
    // 不经过 BaseAgent 模板方法的 parseOutput。此方法仅为满足抽象方法签名，不会被调用。
    throw new Error('DeliveryAgent.parseOutput 不会被调用（execute 已重写）');
  }

  protected validateOutput(
    output: DeliveryResult,
    _input: DeliveryAgentInput,
    _context: AgentContext,
  ): AgentError[] {
    const errors: AgentError[] = [];
    if (!output.deliveryId) {
      errors.push({
        code: 'MISSING_DELIVERY_ID',
        message: '交付结果缺少 deliveryId',
        severity: 'error',
      });
    }
    if (!output.pullRequest.description || output.pullRequest.description.length < 10) {
      errors.push({
        code: 'PR_DESCRIPTION_TOO_SHORT',
        message: 'PR 描述过短（少于 10 字符）',
        severity: 'warning',
      });
    }
    if (output.changes.files.length === 0 && output.status !== 'failed') {
      errors.push({ code: 'NO_CHANGES', message: '交付结果中没有变更文件', severity: 'warning' });
    }
    return errors;
  }

  protected selfCheck(
    output: DeliveryResult,
    input: DeliveryAgentInput,
    _context: AgentContext,
  ): AgentError[] {
    const errors: AgentError[] = [];
    // 变更文件数应与编码产物一致
    const expectedFiles = input.coding.allFiles?.length ?? 0;
    const actualFiles = output.changes.files.length;
    if (expectedFiles > 0 && actualFiles < expectedFiles) {
      errors.push({
        code: 'FILE_COUNT_MISMATCH',
        message: `交付文件数（${actualFiles}）少于编码产物文件数（${expectedFiles}），部分文件可能写入失败`,
        severity: 'warning',
      });
    }
    // Git 分支名应包含 instanceId
    if (output.git.branchName && !output.git.branchName.includes(input.instanceId)) {
      errors.push({
        code: 'BRANCH_NAME_MISMATCH',
        message: `Git 分支名（${output.git.branchName}）不包含实例 ID（${input.instanceId}）`,
        severity: 'warning',
      });
    }
    return errors;
  }

  // retrieveKnowledge：交付阶段不需要检索知识库
  protected async retrieveKnowledge(): Promise<KnowledgeItem[]> {
    return [];
  }
}
