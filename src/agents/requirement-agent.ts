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
import type { AgentError, AgentContext } from './types';
import type { StructuredRequirement } from '../types/requirement';
import type { UserStorySet } from '../types/user-story';
import type { KnowledgeItem } from '../types/knowledge';
import {
  CLARIFICATION_SYSTEM_PROMPT,
  STORY_SYSTEM_PROMPT,
  renderClarificationUserPrompt,
  renderStoryUserPrompt,
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
    _knowledge: KnowledgeItem[],
  ): Promise<string> {
    if (input.type === 'clarify') {
      return this.buildClarificationUserPrompt(input);
    }
    if (input.type === 'clarify-followup') {
      return this.buildFollowupUserPrompt(input);
    }
    return this.buildStoryUserPrompt(input);
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

  private buildClarificationUserPrompt(input: ClarificationInput): string {
    return renderClarificationUserPrompt({
      source: input.source ?? '未知来源',
      prdText: input.prdText,
    });
  }

  private buildFollowupUserPrompt(input: ClarificationFollowupInput): string {
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

请基于人工回答更新需求，并判断是否还有新的澄清问题。如果需求已经充分，clarificationLog 可以为空数组。

输出格式与第一轮相同（严格 JSON）。`;
  }

  private parseClarificationOutput(
    content: string,
    input: ClarificationInput | ClarificationFollowupInput,
  ): StructuredRequirement {
    const jsonStr = this.extractJsonObject(content);
    const parsed = JSON.parse(jsonStr);

    const now = new Date().toISOString();
    const isFollowup = input.type === 'clarify-followup';
    const prev = isFollowup ? (input as ClarificationFollowupInput).previousRequirement : undefined;

    return {
      id: prev?.id || `req-${Date.now()}`,
      instanceId: prev?.instanceId || '', // 由 Harness 填充
      version: prev ? prev.version + 1 : 1,
      meta: {
        title: parsed.meta?.title || prev?.meta.title || '未命名需求',
        source: isFollowup
          ? prev?.meta.source || '未知来源'
          : (input as ClarificationInput).source || parsed.meta?.source || '未知来源',
        version: parsed.meta?.version || prev?.meta.version || '1.0',
        parsedAt: prev?.meta.parsedAt || now,
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

  private buildStoryUserPrompt(input: StoryGenerationInput): string {
    return renderStoryUserPrompt({ requirement: input.requirement });
  }

  private parseStoryOutput(content: string, input: StoryGenerationInput): UserStorySet {
    const jsonStr = this.extractJsonObject(content);
    const parsed = JSON.parse(jsonStr);

    const now = new Date().toISOString();
    const stories = parsed.stories || [];

    // 计算质量检查
    const totalAC = stories.reduce(
      (sum: number, s: { acceptanceCriteria: unknown[] }) =>
        sum + (s.acceptanceCriteria?.length || 0),
      0,
    );
    const testableAC = stories.reduce(
      (sum: number, s: { acceptanceCriteria: { testable: boolean }[] }) =>
        sum + (s.acceptanceCriteria?.filter((ac) => ac.testable).length || 0),
      0,
    );

    const featureIds = new Set(input.requirement.features.map((f) => f.id));
    const coveredFeatureIds = new Set<string>();
    for (const story of stories) {
      for (const fid of story.relatedFeatureIds || []) {
        coveredFeatureIds.add(fid);
      }
    }
    const uncoveredFeatureIds = [...featureIds].filter((fid) => !coveredFeatureIds.has(fid));

    // INVEST：I/N/V/E 取 LLM 自评分（prompt 要求输出，缺失时降级为通过并记入 issues）；
    // Small/Testable 必须由程序计算，不信任 LLM，防止自检形同虚设
    const llmInvest: Partial<{
      independent: boolean;
      negotiable: boolean;
      valuable: boolean;
      estimable: boolean;
    }> = parsed.qualityCheck?.invest ?? {};
    const investIssues: string[] = [];
    if (!parsed.qualityCheck?.invest) {
      investIssues.push(
        'LLM 未输出 qualityCheck.invest 自评分，I/N/V/E 按通过处理，请关注模型输出完整性',
      );
    }
    const invest = {
      independent: llmInvest.independent ?? true,
      negotiable: llmInvest.negotiable ?? true,
      valuable: llmInvest.valuable ?? true,
      estimable: llmInvest.estimable ?? true,
      small: stories.every(
        (s: { acceptanceCriteria: unknown[] }) => (s.acceptanceCriteria?.length || 0) <= 10,
      ),
      testable: testableAC === totalAC,
    };
    const investPassed = Object.values(invest).every(Boolean);

    // perStory 逐故事质量检查（程序化，不信任 LLM 自评分，规范 1.14）
    const storyIdSet = new Set(stories.map((s: { id: string }) => s.id));
    const perStory = stories.map(
      (s: {
        id: string;
        acceptanceCriteria?: Array<{ testable?: boolean; id?: string }>;
        dependencies?: string[];
      }) => {
        const issues: string[] = [];
        const acCount = s.acceptanceCriteria?.length ?? 0;
        const notTestableACs = s.acceptanceCriteria?.filter((ac) => ac.testable === false) ?? [];
        const unknownDeps = (s.dependencies ?? []).filter((depId) => !storyIdSet.has(depId));

        // Small：AC 数超过阈值（10 条）视为故事过大，建议拆分
        if (acCount > 10) {
          issues.push(`故事过大：包含 ${acCount} 条验收标准（阈值 10），建议拆分为多个小故事`);
        }
        // Testable：存在标记为不可测试的 AC
        if (notTestableACs.length > 0) {
          issues.push(
            `存在 ${notTestableACs.length} 条不可测试的验收标准：${notTestableACs.map((ac) => ac.id).join(', ')}`,
          );
        }
        // Independent：依赖了未在当前故事集合中的故事（可能依赖未拆解的输出）
        if (unknownDeps.length > 0) {
          issues.push(
            `依赖了未定义的故事：${unknownDeps.join(', ')}（可能依赖未拆解的故事输出，影响独立性）`,
          );
        }

        return {
          storyId: s.id,
          issues,
          passed: issues.length === 0,
        };
      },
    );

    return {
      id: `stories-${Date.now()}`,
      instanceId: '',
      requirementId: input.requirement.id,
      version: 1,
      stories,
      storyMap: parsed.storyMap || [],
      nfrMapping: parsed.nfrMapping || [],
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
          ...investIssues,
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
