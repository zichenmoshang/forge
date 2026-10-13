/**
 * 需求分析 Agent - 阶段1（需求澄清）+ 阶段2（用户故事拆解）
 *
 * 职责：
 * - PRD 多格式解析
 * - 澄清问题生成
 * - 非功能需求提示
 * - 全局需求缺失检查
 * - 用户故事拆解 + AC 生成
 * - 质量自检（INVEST、AC可测试性）
 */

import { BaseAgent } from './base';
import type { AgentError, AgentContext, AgentResult } from './types';
import type { StructuredRequirement } from '../types/requirement';
import type { UserStorySet, UserStory, AcceptanceCriterion } from '../types/user-story';
import type { KnowledgeItem } from '../types/knowledge';
import {
  CLARIFICATION_SYSTEM_PROMPT,
  STORY_SYSTEM_PROMPT,
  renderClarificationUserPrompt,
  renderStoryUserPrompt,
  formatKnowledgeSection,
} from '../prompts/requirement';

/** 需求澄清输入 */
export interface ClarificationInput {
  type: 'clarify';
  prdText: string;
  source?: string;
}

/** 用户故事拆解输入 */
export interface StoryGenerationInput {
  type: 'generate-stories';
  requirement: StructuredRequirement;
}

/** 继续澄清输入（多轮澄清问答） */
export interface ClarificationFollowupInput {
  type: 'clarify-followup';
  /** 上一轮生成的需求 */
  previousRequirement: StructuredRequirement;
  /** 人工回答的澄清问答（question -> answer），v2 按问题编号匹配时使用，v1 用统一回答 */
  answers?: Record<string, string>;
}

export type RequirementAgentInput =
  ClarificationInput | StoryGenerationInput | ClarificationFollowupInput;
export type RequirementAgentOutput = StructuredRequirement | UserStorySet;

export class RequirementAgent extends BaseAgent<RequirementAgentInput, RequirementAgentOutput> {
  readonly name = 'requirement-agent';
  readonly version = '0.1.0';

  // ============================================================
  // 分批执行：generate-stories 按 module 分组逐批调用 LLM，避免单批次输出过大超时
  // ============================================================

  /** 分批阈值：功能点超过此数量时按 module 分批处理 */
  private static readonly BATCH_THRESHOLD = 6;
  /** 每批最大功能点数量：超过此数量的 module 会进一步拆分（避免单批次输出过大超时，实测 6 个约 10 分钟，8 个会 15 分钟超时） */
  private static readonly MAX_FEATURES_PER_BATCH = 6;

  async execute(context: AgentContext): Promise<AgentResult<RequirementAgentOutput>> {
    const input = context.input as RequirementAgentInput;

    // 只有 generate-stories 且功能点超过阈值才分批
    if (input.type !== 'generate-stories' || !input.requirement || input.requirement.features.length <= RequirementAgent.BATCH_THRESHOLD) {
      return super.execute(context);
    }

    const requirement = input.requirement;

    // 按 module 分组，每个 module 超过 MAX_FEATURES_PER_BATCH 时进一步拆分
    const batches: Array<{ name: string; features: typeof requirement.features }> = [];
    const moduleGroups = new Map<string, typeof requirement.features>();
    for (const feature of requirement.features) {
      const module = feature.module || '未分类';
      if (!moduleGroups.has(module)) moduleGroups.set(module, []);
      moduleGroups.get(module)!.push(feature);
    }
    for (const [moduleName, features] of moduleGroups) {
      if (features.length <= RequirementAgent.MAX_FEATURES_PER_BATCH) {
        batches.push({ name: moduleName, features });
      } else {
        // 大 module 拆分成多个子批次
        for (let i = 0; i < features.length; i += RequirementAgent.MAX_FEATURES_PER_BATCH) {
          const subFeatures = features.slice(i, i + RequirementAgent.MAX_FEATURES_PER_BATCH);
          batches.push({ name: `${moduleName}-${Math.floor(i / RequirementAgent.MAX_FEATURES_PER_BATCH) + 1}`, features: subFeatures });
        }
      }
    }

    // 只有 1 个批次时走单次模式
    if (batches.length <= 1) {
      return super.execute(context);
    }

    this.logger?.info(
      `[${this.name}] 故事拆解分批并行处理：${batches.length} 批，${requirement.features.length} 个功能点`,
      { instanceId: context.instanceId, agent: this.name },
    );

    // 并行执行所有批次（限制并发数 3，避免 API 限流）
    const MAX_CONCURRENCY = 3;
    const startTime = Date.now();
    const results: Array<AgentResult<UserStorySet> | null> = new Array(batches.length).fill(null);
    let nextBatchIndex = 0;

    const runBatch = async (workerId: number): Promise<void> => {
      while (true) {
        const idx = nextBatchIndex++;
        if (idx >= batches.length) return;

        const batch = batches[idx];
        const subRequirement: StructuredRequirement = { ...requirement, features: batch.features };
        const subInput: StoryGenerationInput = { type: 'generate-stories', requirement: subRequirement };
        const subContext: AgentContext = { ...context, input: subInput, stage: `${context.stage}:${batch.name}` };

        try {
          const result = await this.runAgentCycle<StoryGenerationInput, UserStorySet>({
            input: subInput,
            context: subContext,
            validateInput: (i: StoryGenerationInput) => this.validateStoryInput(i),
            retrieveKnowledge: (i: StoryGenerationInput, ctx: AgentContext) => this.retrieveKnowledge(i, ctx),
            buildSystemPrompt: () => this.buildStorySystemPrompt(),
            buildUserPrompt: (
              i: StoryGenerationInput,
              _ctx: AgentContext,
              knowledge: KnowledgeItem[],
            ) => Promise.resolve(this.buildStoryUserPrompt(i, knowledge)),
            parseOutput: (content: string, i: StoryGenerationInput) => this.parseStoryOutput(content, i),
            validateOutput: (output: UserStorySet) => this.validateStoryOutput(output),
            selfCheck: (output: UserStorySet) => this.selfCheckStory(output),
          });
          results[idx] = result;

          if (!result.success || !result.data) {
            this.logger?.error(
              `[${this.name}] 故事拆解批次 [${batch.name}] 失败`,
              { instanceId: context.instanceId, agent: this.name, errors: result.errors },
            );
          } else {
            this.logger?.info(
              `[${this.name}] 批次 [${batch.name}] 完成：${result.data.stories.length} 个故事，${result.llmCalls} 次 LLM 调用`,
              { instanceId: context.instanceId, agent: this.name },
            );
          }
        } catch (err) {
          this.logger?.error(
            `[${this.name}] 批次 [${batch.name}] 异常：${err instanceof Error ? err.message : String(err)}`,
            { instanceId: context.instanceId, agent: this.name },
          );
          results[idx] = {
            success: false,
            data: undefined,
            errors: [{ code: 'BATCH_ERROR', message: `批次执行异常: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' }],
            durationMs: 0,
            llmCalls: 0,
            retries: 0,
          };
        }
      }
    };

    // 启动并发 worker
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, (_, i) =>
      runBatch(i),
    );
    await Promise.all(workers);

    const wallClockTime = Date.now() - startTime;
    const allStories: UserStorySet['stories'] = [];
    let totalLlmCalls = 0;
    let totalDuration = 0;
    let totalRetries = 0;
    const allErrors: AgentError[] = [];
    let hasFailure = false;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) {
        hasFailure = true;
        allErrors.push({ code: 'BATCH_MISSING', message: `批次 ${i + 1} 未返回结果`, severity: 'error' });
        continue;
      }
      totalLlmCalls += result.llmCalls;
      totalDuration += result.durationMs;
      totalRetries += result.retries;
      allErrors.push(...result.errors);
      if (!result.success || !result.data) {
        hasFailure = true;
      } else {
        allStories.push(...result.data.stories);
      }
    }

    if (hasFailure) {
      return {
        success: false,
        data: undefined,
        errors: allErrors,
        durationMs: wallClockTime,
        llmCalls: totalLlmCalls,
        retries: totalRetries,
      };
    }

    // 构造合并后的伪 LLM 输出，复用 parseStoryOutput 计算 qualityCheck 和 storyMap
    const mergedRawOutput = JSON.stringify({ stories: allStories });
    const merged = this.parseStoryOutput(mergedRawOutput, input);

    this.logger?.info(
      `[${this.name}] 故事拆解分批并行完成：${allStories.length} 个故事，${batches.length} 批，墙钟时间 ${(wallClockTime / 1000).toFixed(1)}s，累计 LLM 时间 ${(totalDuration / 1000).toFixed(1)}s`,
      { instanceId: context.instanceId, agent: this.name },
    );

    return {
      success: true,
      data: merged,
      errors: allErrors,
      durationMs: wallClockTime,
      llmCalls: totalLlmCalls,
      retries: totalRetries,
    };
  }

  // ============================================================
  // BaseAgent 抽象方法实现（按 input.type 分发）
  // ============================================================

  protected validateInput(input: RequirementAgentInput): AgentError[] {
    if (input.type === 'clarify') {
      return this.validateClarificationInput(input);
    }
    if (input.type === 'clarify-followup') {
      return this.validateFollowupInput(input);
    }
    return this.validateStoryInput(input);
  }

  protected buildSystemPrompt(input: RequirementAgentInput): string {
    if (input.type === 'generate-stories') {
      return this.buildStorySystemPrompt();
    }
    return this.buildClarificationSystemPrompt();
  }

  protected async buildUserPrompt(
    input: RequirementAgentInput,
    _context: AgentContext,
    knowledge: KnowledgeItem[],
  ): Promise<string> {
    if (input.type === 'clarify') {
      return this.buildClarificationUserPrompt(input, knowledge);
    }
    if (input.type === 'clarify-followup') {
      return this.buildFollowupUserPrompt(input, knowledge);
    }
    return this.buildStoryUserPrompt(input, knowledge);
  }

  /**
   * 需求阶段知识库检索（P0-B）：澄清 / followup / 故事拆解分别构造多路 query，
   * 团队飞书 wiki（规范、历史澄清/故事）通过 searchKnowledge 多路并行检索。
   */
  protected async retrieveKnowledge(
    input: RequirementAgentInput,
    context: AgentContext,
  ): Promise<KnowledgeItem[]> {
    if (input.type === 'clarify') {
      // 首次澄清尚无结构化信息，用 PRD 文本片段 + 通用规范多路检索
      const head = input.prdText.slice(0, 500);
      return this.searchKnowledge(context, [
        { query: `${head} 需求 功能 业务`, topK: 5 },
        {
          query: '需求澄清 非功能需求 全局需求 登录权限 错误监控 团队规范',
          types: ['spec', 'doc', 'exception', 'pattern'],
          topK: 5,
        },
      ]);
    }

    if (input.type === 'clarify-followup') {
      const req = input.previousRequirement;
      const pending = req.clarificationLog
        .filter((q) => q.status === 'pending')
        .map((q) => q.question)
        .join(' ');
      return this.searchKnowledge(context, [
        { query: `${req.meta.title} ${pending}`, topK: 5 },
        {
          query: '需求澄清 非功能需求 全局需求 团队规范',
          types: ['spec', 'doc', 'exception'],
          topK: 3,
        },
      ]);
    }

    // generate-stories：用功能点/模块检索既有组件、模式、历史故事
    const featureKeywords = input.requirement.features
      .map((f) => `${f.name} ${f.module}`)
      .join(' ');
    return this.searchKnowledge(context, [
      { query: `${featureKeywords} 用户故事 组件 拆解`, topK: 6 },
      {
        query: `${input.requirement.meta.title} 状态管理 异常处理 页面`,
        types: ['component', 'pattern', 'story', 'exception'],
        topK: 6,
      },
    ]);
  }

  protected parseOutput(content: string, input: RequirementAgentInput): RequirementAgentOutput {
    if (input.type === 'clarify' || input.type === 'clarify-followup') {
      return this.parseClarificationOutput(content, input);
    }
    return this.parseStoryOutput(content, input);
  }

  protected validateOutput(
    output: RequirementAgentOutput,
    input: RequirementAgentInput,
  ): AgentError[] {
    if (input.type === 'clarify' || input.type === 'clarify-followup') {
      return this.validateClarificationOutput(output as StructuredRequirement);
    }
    return this.validateStoryOutput(output as UserStorySet);
  }

  protected selfCheck(output: RequirementAgentOutput, input: RequirementAgentInput): AgentError[] {
    if (input.type === 'clarify' || input.type === 'clarify-followup') {
      return this.selfCheckClarification(output as StructuredRequirement);
    }
    return this.selfCheckStory(output as UserStorySet);
  }

  // ============================================================
  // 需求澄清子流程
  // ============================================================

  private validateClarificationInput(input: ClarificationInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.prdText || input.prdText.trim().length === 0) {
      errors.push({
        code: 'EMPTY_PRD',
        message: 'PRD 文本不能为空',
        severity: 'error',
      });
    }
    if (input.prdText && input.prdText.trim().length < 20) {
      errors.push({
        code: 'PRD_TOO_SHORT',
        message: 'PRD 文本过短（少于20字符），可能无法有效分析',
        severity: 'warning',
      });
    }
    return errors;
  }

  private validateFollowupInput(input: ClarificationFollowupInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.previousRequirement) {
      errors.push({
        code: 'NO_PREVIOUS_REQUIREMENT',
        message: '继续澄清需要上一轮的需求',
        severity: 'error',
      });
    }
    // v1 使用统一回答 humanAnswers（Harness 写入），answers 为 v2 按问题匹配预留；
    // 两者都为空才说明本轮没有任何人工输入
    const hasStructuredAnswers = !!input.answers && Object.keys(input.answers).length > 0;
    const hasUnifiedAnswers = (input.previousRequirement?.humanAnswers ?? []).length > 0;
    if (!hasStructuredAnswers && !hasUnifiedAnswers) {
      errors.push({
        code: 'NO_ANSWERS',
        message: '继续澄清需要人工回答的澄清问题',
        severity: 'warning',
      });
    }
    return errors;
  }

  private buildClarificationSystemPrompt(): string {
    return CLARIFICATION_SYSTEM_PROMPT;
  }

  private buildClarificationUserPrompt(
    input: ClarificationInput,
    knowledge?: KnowledgeItem[],
  ): string {
    return renderClarificationUserPrompt({
      source: input.source ?? '未知来源',
      prdText: input.prdText,
      knowledge,
    });
  }

  private buildFollowupUserPrompt(
    input: ClarificationFollowupInput,
    knowledge?: KnowledgeItem[],
  ): string {
    const req = input.previousRequirement;

    // 从 humanAnswers 读取统一回答（#13 修复后，回答存在这里）
    const humanAnswersText = (req.humanAnswers ?? [])
      .map((a, i) => `[回答 ${i + 1}] ${a.answer}`)
      .join('\n');

    // 已处理的澄清问题（status === 'resolved'）
    const resolvedQuestions = req.clarificationLog
      .filter((q) => q.status === 'resolved')
      .map((q) => `- [${q.priority}] ${q.question}`)
      .join('\n');

    // 仍待澄清的问题
    const pendingQuestions = req.clarificationLog
      .filter((q) => q.status === 'pending')
      .map((q) => `- [${q.priority}] ${q.question}`)
      .join('\n');

    return `根据人工回答继续完善需求，判断是否还有需要澄清的问题。

当前需求标题：${req.meta.title}

人工回答记录：
${humanAnswersText || '（无）'}

已处理的澄清问题：
${resolvedQuestions || '（无）'}

仍待澄清的问题：
${pendingQuestions || '（无）'}

${formatKnowledgeSection(knowledge)}【输出要求 — 增量模式，不要输出完整需求】
只输出以下两部分：
1. clarificationLog（必填）：更新后的澄清问题列表。已解决的问题标记 status: "resolved"，新问题标记 status: "pending"。如果没有任何待澄清的新问题，输出空数组 []。
2. updates（可选）：只有当人工回答导致需求内容实际变更时才输出。包含需要更新的字段（如 features、businessRules、nonFunctionalRequirements 等），每个字段输出完整的更新后数组。如果没有内容变更，不要输出 updates。

示例（无内容变更，仅更新澄清状态）：
{"clarificationLog": [{"id": "Q-001", "question": "...", "status": "resolved"}, {"id": "Q-002", "question": "...", "status": "pending"}]}

示例（有内容变更）：
{"clarificationLog": [], "updates": {"features": [{"id": "F-001", ...}, {"id": "F-002", ...}], "nonFunctionalRequirements": [{"id": "N-001", ...}]}}

输出严格 JSON，不要包含解释性文字。`;
  }

  private parseClarificationOutput(
    content: string,
    input: ClarificationInput | ClarificationFollowupInput,
  ): StructuredRequirement {
    const jsonStr = this.extractJsonObject(content);
    const parsed = this.parseJsonWithRecovery<Record<string, any>>(jsonStr);

    const now = new Date().toISOString();
    const isFollowup = input.type === 'clarify-followup';
    const prev = isFollowup ? (input as ClarificationFollowupInput).previousRequirement : undefined;

    // ============================================================
    // followup 增量模式：以 previousRequirement 为基础，合并 LLM 输出的增量
    // 支持两种输出格式：
    //   1. 增量格式：{ clarificationLog: [...], updates: { features: [...], ... } }
    //   2. 全量格式（兼容）：直接输出 meta/features/... 等顶层字段
    // ============================================================
    if (isFollowup && prev) {
      // 深拷贝 previousRequirement 作为基础
      const result: StructuredRequirement = JSON.parse(JSON.stringify(prev));
      result.version = prev.version + 1;
      result.updatedAt = now;
      result.meta.frozenAt = '';
      result.frozen = {
        frozen: false,
        frozenAt: '',
        checklist: {
          businessGoalsClear: false,
          rolesComplete: false,
          featuresNoMissing: false,
          rulesNoAmbiguity: false,
          nfrDefined: false,
          globalRequirementsCovered: false,
          trackingProvided: false,
          allClarificationsResolved: false,
        },
      };

      const updatableFields = [
        'businessGoals', 'roles', 'features', 'businessRules',
        'nonFunctionalRequirements', 'globalRequirements', 'trackingRequirements',
      ] as const;

      // 1. 应用 clarificationLog 更新（如果输出了该字段，即使是空数组也替换，表示无新问题）
      if (parsed.clarificationLog !== undefined) {
        result.clarificationLog = parsed.clarificationLog;
      }

      // 2. 应用 updates 中的字段变更（增量格式）
      if (parsed.updates && typeof parsed.updates === 'object') {
        for (const field of updatableFields) {
          if (parsed.updates[field] !== undefined) {
            (result as unknown as Record<string, unknown>)[field] = parsed.updates[field];
          }
        }
        if (parsed.updates.meta?.title) {
          result.meta.title = parsed.updates.meta.title;
        }
      }

      // 3. 兼容全量输出：如果 LLM 直接输出了顶层字段（且 updates 中没有同名字段），用顶层值替换
      for (const field of updatableFields) {
        if (parsed.updates?.[field] === undefined && parsed[field] !== undefined) {
          (result as unknown as Record<string, unknown>)[field] = parsed[field];
        }
      }
      if (parsed.meta) {
        if (parsed.meta.title && !parsed.updates?.meta?.title) {
          result.meta.title = parsed.meta.title;
        }
        if (parsed.meta.version) {
          result.meta.version = parsed.meta.version;
        }
      }

      // 保留 humanAnswers（由 Harness 管理）
      if (prev.humanAnswers) {
        result.humanAnswers = prev.humanAnswers;
      }

      return result;
    }

    // ============================================================
    // 首次澄清模式
    // ============================================================
    return {
      id: `req-${Date.now()}`,
      instanceId: '', // 由 Harness 填充
      version: 1,
      meta: {
        title: parsed.meta?.title || '未命名需求',
        source: (input as ClarificationInput).source || parsed.meta?.source || '未知来源',
        version: parsed.meta?.version || '1.0',
        parsedAt: now,
        frozenAt: '',
      },
      businessGoals: parsed.businessGoals || [],
      roles: parsed.roles || [],
      features: parsed.features || [],
      businessRules: parsed.businessRules || [],
      nonFunctionalRequirements: parsed.nonFunctionalRequirements || [],
      globalRequirements: parsed.globalRequirements || [],
      trackingRequirements: parsed.trackingRequirements || [],
      clarificationLog: parsed.clarificationLog || [],
      frozen: {
        frozen: false,
        frozenAt: '',
        checklist: {
          businessGoalsClear: false,
          rolesComplete: false,
          featuresNoMissing: false,
          rulesNoAmbiguity: false,
          nfrDefined: false,
          globalRequirementsCovered: false,
          trackingProvided: false,
          allClarificationsResolved: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  private validateClarificationOutput(output: StructuredRequirement): AgentError[] {
    const errors: AgentError[] = [];

    if (!output.meta.title || output.meta.title.trim() === '') {
      errors.push({ code: 'NO_TITLE', message: '需求标题不能为空', severity: 'error' });
    }
    if (output.features.length === 0) {
      errors.push({ code: 'NO_FEATURES', message: '未识别到任何功能点', severity: 'error' });
    }
    if (output.businessGoals.length === 0) {
      errors.push({ code: 'NO_GOALS', message: '未识别到业务目标', severity: 'warning' });
    }
    if (output.roles.length === 0) {
      errors.push({ code: 'NO_ROLES', message: '未识别到角色', severity: 'warning' });
    }

    // 检查功能点关联的角色是否存在
    const roleIds = new Set(output.roles.map((r) => r.id));
    for (const feature of output.features) {
      for (const roleId of feature.relatedRoleIds) {
        if (!roleIds.has(roleId)) {
          errors.push({
            code: 'INVALID_ROLE_REF',
            message: `功能点 ${feature.name} 引用了不存在的角色 ${roleId}`,
            severity: 'warning',
            field: `features.${feature.id}.relatedRoleIds`,
          });
        }
      }
    }

    return errors;
  }

  private selfCheckClarification(output: StructuredRequirement): AgentError[] {
    const warnings: AgentError[] = [];

    // 检查是否有 blocking 级别的澄清问题
    const blockingQuestions = output.clarificationLog.filter(
      (q) => q.priority === 'blocking' && q.status === 'pending',
    );
    if (blockingQuestions.length > 0) {
      warnings.push({
        code: 'BLOCKING_CLARIFICATIONS',
        message: `存在 ${blockingQuestions.length} 个阻塞级澄清问题，需要人工回答后才能冻结`,
        severity: 'warning',
      });
    }

    // 检查非功能需求是否覆盖了常见类别
    const nfrCategories = new Set(output.nonFunctionalRequirements.map((n) => n.category));
    const commonCategories: Array<(typeof output.nonFunctionalRequirements)[number]['category']> = [
      'performance',
      'compatibility',
      'security',
    ];
    for (const cat of commonCategories) {
      if (!nfrCategories.has(cat)) {
        warnings.push({
          code: 'MISSING_NFR',
          message: `缺少 ${cat} 类非功能需求，建议确认是否需要`,
          severity: 'warning',
        });
      }
    }

    // 检查全局需求是否覆盖了登录和权限
    const globalCategories = new Set(output.globalRequirements.map((g) => g.category));
    if (!globalCategories.has('authentication')) {
      warnings.push({
        code: 'MISSING_AUTH',
        message: '未发现登录/认证相关全局需求，建议确认是否需要',
        severity: 'warning',
      });
    }

    return warnings;
  }

  // ============================================================
  // 用户故事拆解子流程
  // ============================================================

  private validateStoryInput(input: StoryGenerationInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.requirement) {
      errors.push({
        code: 'NO_REQUIREMENT',
        message: '结构化需求不能为空',
        severity: 'error',
      });
      return errors;
    }
    if (input.requirement.features.length === 0) {
      errors.push({
        code: 'NO_FEATURES',
        message: '需求中没有功能点，无法生成用户故事',
        severity: 'error',
      });
    }
    if (!input.requirement.frozen.frozen) {
      errors.push({
        code: 'REQUIREMENT_NOT_FROZEN',
        message: '需求尚未冻结，建议先完成澄清再生成故事',
        severity: 'warning',
      });
    }
    return errors;
  }

  private buildStorySystemPrompt(): string {
    return STORY_SYSTEM_PROMPT;
  }

  private buildStoryUserPrompt(input: StoryGenerationInput, knowledge?: KnowledgeItem[]): string {
    return renderStoryUserPrompt({ requirement: input.requirement, knowledge });
  }

  private parseStoryOutput(content: string, input: StoryGenerationInput): UserStorySet {
    const jsonStr = this.extractJsonObject(content);
    const parsed = this.parseJsonWithRecovery<Record<string, any>>(jsonStr);

    const now = new Date().toISOString();
    const rawStories = parsed.stories || [];

    // 将简化的故事转换为完整 UserStory
    const stories: UserStory[] = rawStories.map((s: any, idx: number) => ({
      id: s.id || `s${idx + 1}`,
      title: s.title || '',
      description: {
        role: s.description?.role || '',
        action: s.description?.action || '',
        benefit: s.description?.benefit || '',
      },
      acceptanceCriteria: this.parseAcceptanceCriteria(s.acceptanceCriteria, s.id || `s${idx + 1}`),
      priority: s.priority || 'P1',
      dependencies: s.dependencies || [],
      relatedFeatureIds: s.relatedFeatureIds || [],
      relatedRuleIds: s.relatedRuleIds || [],
      type: s.type || 'feature',
      hasExceptionFlow: (s.acceptanceCriteria || []).some((ac: string | any) =>
        typeof ac === 'string'
          ? /异常|边界|错误|失败|权限|未登录/.test(ac)
          : ac.scenarioType !== 'normal',
      ),
    }));

    // 计算质量检查
    const totalAC = stories.reduce((sum, s) => sum + s.acceptanceCriteria.length, 0);
    const testableAC = stories.reduce(
      (sum, s) => sum + s.acceptanceCriteria.filter((ac) => ac.testable !== false).length,
      0,
    );

    const featureIds = new Set(input.requirement.features.map((f) => f.id));
    const coveredFeatureIds = new Set<string>();
    for (const story of stories) {
      for (const fid of story.relatedFeatureIds) {
        coveredFeatureIds.add(fid);
      }
    }
    const uncoveredFeatureIds = [...featureIds].filter((fid) => !coveredFeatureIds.has(fid));

    // INVEST：全部由程序计算（不再依赖 LLM 自评分）
    const invest = {
      independent: stories.every((s) => s.dependencies.length === 0),
      negotiable: true, // 程序无法判断，默认通过
      valuable: stories.every((s) => s.description.benefit.length > 0),
      estimable: stories.every((s) => s.acceptanceCriteria.length > 0),
      small: stories.every((s) => s.acceptanceCriteria.length <= 5),
      testable: testableAC === totalAC,
    };
    const investPassed = Object.values(invest).every(Boolean);

    // perStory 逐故事质量检查
    const storyIdSet = new Set(stories.map((s) => s.id));
    const perStory = stories.map((s) => {
      const issues: string[] = [];
      const acCount = s.acceptanceCriteria.length;
      const notTestableACs = s.acceptanceCriteria.filter((ac) => ac.testable === false);
      const unknownDeps = s.dependencies.filter((depId) => !storyIdSet.has(depId));

      if (acCount > 5) {
        issues.push(`故事过大：包含 ${acCount} 条验收标准（阈值 5），建议拆分`);
      }
      if (acCount < 2) {
        issues.push(`验收标准不足：仅 ${acCount} 条（建议至少 2 条：正常+异常）`);
      }
      if (notTestableACs.length > 0) {
        issues.push(`存在 ${notTestableACs.length} 条不可测试的验收标准`);
      }
      if (unknownDeps.length > 0) {
        issues.push(`依赖了未定义的故事：${unknownDeps.join(', ')}`);
      }

      return { storyId: s.id, issues, passed: issues.length === 0 };
    });

    // 生成 storyMap：按功能点 module 分组
    const featureModuleMap = new Map(input.requirement.features.map((f) => [f.id, f.module || '未分类']));
    const moduleGroups = new Map<string, string[]>();
    for (const story of stories) {
      const module = story.relatedFeatureIds.length > 0
        ? (featureModuleMap.get(story.relatedFeatureIds[0]) || '未分类')
        : '未分类';
      if (!moduleGroups.has(module)) moduleGroups.set(module, []);
      moduleGroups.get(module)!.push(story.id);
    }
    const storyMap = [...moduleGroups.entries()].map(([groupName, storyIds], idx) => ({
      groupName,
      storyIds,
      order: idx,
    }));

    return {
      id: `stories-${Date.now()}`,
      instanceId: '',
      requirementId: input.requirement.id,
      version: 1,
      stories,
      storyMap,
      nfrMapping: [], // 技术方案阶段处理
      qualityCheck: {
        invest,
        perStory,
        acceptanceCriteriaStats: {
          total: totalAC,
          testable: testableAC,
          notTestable: totalAC - testableAC,
        },
        featureCoverage: {
          totalFeatures: featureIds.size,
          coveredFeatures: coveredFeatureIds.size,
          uncoveredFeatureIds,
        },
        passed: uncoveredFeatureIds.length === 0 && investPassed,
        issues: [
          ...(uncoveredFeatureIds.length > 0
            ? [`有 ${uncoveredFeatureIds.length} 个功能点未被故事覆盖`]
            : []),
        ],
      },
      confirmation: {
        confirmedBy: 'ai-self-check',
        confirmedAt: now,
        version: 1,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 将简化的验收标准字符串数组转换为 AcceptanceCriterion[] */
  private parseAcceptanceCriteria(rawACs: Array<string | any>, storyId: string): AcceptanceCriterion[] {
    if (!Array.isArray(rawACs) || rawACs.length === 0) return [];

    return rawACs.map((ac, idx) => {
      if (typeof ac === 'object' && ac !== null) {
        // 兼容完整对象格式
        return {
          id: ac.id || `${storyId}-ac${idx + 1}`,
          given: ac.given || [],
          when: ac.when || '',
          then: ac.then || [],
          scenarioType: ac.scenarioType || 'normal',
          testable: ac.testable !== false,
        };
      }

      // 字符串格式："正常场景：给定...当...则..."
      const text = String(ac);
      const scenarioType: AcceptanceCriterion['scenarioType'] = /异常|边界|错误|失败/.test(text)
        ? 'exception'
        : /权限|未登录|无权/.test(text)
          ? 'permission'
          : /边界|极限|空|最大|最小/.test(text)
            ? 'boundary'
            : 'normal';

      // 简单解析 Given/When/Then
      let given: string[] = [];
      let when = '';
      let then: string[] = [];

      const givenMatch = text.match(/给定(.+?)(?:当|则|$)/);
      const whenMatch = text.match(/当(.+?)(?:则|$)/);
      const thenMatch = text.match(/则(.+?)$/);

      if (givenMatch) given = [givenMatch[1].trim()];
      if (whenMatch) when = whenMatch[1].trim();
      if (thenMatch) then = [thenMatch[1].trim()];

      // 如果解析失败，将整个文本作为 when
      if (!when && !then.length) when = text;

      return {
        id: `${storyId}-ac${idx + 1}`,
        given,
        when,
        then,
        scenarioType,
        testable: true,
      };
    });
  }

  private validateStoryOutput(output: UserStorySet): AgentError[] {
    const errors: AgentError[] = [];

    if (output.stories.length === 0) {
      errors.push({ code: 'NO_STORIES', message: '未生成任何用户故事', severity: 'error' });
    }

    for (const story of output.stories) {
      if (!story.description.role || !story.description.action) {
        errors.push({
          code: 'INVALID_STORY',
          message: `故事 ${story.title || story.id} 缺少 role 或 action`,
          severity: 'error',
          field: `stories.${story.id}.description`,
        });
      }
      if (!story.acceptanceCriteria || story.acceptanceCriteria.length === 0) {
        errors.push({
          code: 'NO_AC',
          message: `故事 ${story.title || story.id} 没有验收标准`,
          severity: 'error',
          field: `stories.${story.id}.acceptanceCriteria`,
        });
      }
    }

    return errors;
  }

  private selfCheckStory(output: UserStorySet): AgentError[] {
    const warnings: AgentError[] = [];

    if (output.qualityCheck.featureCoverage.uncoveredFeatureIds.length > 0) {
      warnings.push({
        code: 'INCOMPLETE_COVERAGE',
        message: `有 ${output.qualityCheck.featureCoverage.uncoveredFeatureIds.length} 个功能点未被故事覆盖`,
        severity: 'warning',
      });
    }

    if (output.qualityCheck.acceptanceCriteriaStats.notTestable > 0) {
      warnings.push({
        code: 'UNTESTABLE_AC',
        message: `有 ${output.qualityCheck.acceptanceCriteriaStats.notTestable} 条验收标准不可测试`,
        severity: 'warning',
      });
    }

    // 检查是否每个故事都有异常流程的 AC
    const storiesWithoutException = output.stories.filter(
      (s) =>
        !s.acceptanceCriteria.some(
          (ac) => ac.scenarioType === 'exception' || ac.scenarioType === 'boundary',
        ),
    );
    if (storiesWithoutException.length > 0) {
      warnings.push({
        code: 'MISSING_EXCEPTION_AC',
        message: `有 ${storiesWithoutException.length} 个故事缺少异常/边界场景的验收标准`,
        severity: 'warning',
      });
    }

    return warnings;
  }
}
