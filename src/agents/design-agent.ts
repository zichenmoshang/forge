/**
 * 方案设计 Agent - 阶段3（生成）+ 阶段4评审对话循环（修改，#42 预留）
 *
 * 职责：
 * - 技术栈检测/建议
 * - Figma 设计数据消费（v1 为外部依赖，不可用时降级）
 * - 页面/路由/组件树设计
 * - 现有组件复用检查（内部通过 searchKnowledge 自主多路检索知识库）
 * - API 契约生成
 * - 异常场景补齐（checklist 驱动）、非功能需求落地方案
 *
 * 实现约束（ADR-014 / 规范 8.3）：
 * - generate（从 0 生成）与 revise（评审循环内修改）使用独立输入输出类型、独立方法，
 *   不在一个 execute 内按 input.type 做 if 分发。
 * - v1（方案 A）只实现 generate 单轮生成；revise 随 #42 评审多轮对话落地，当前仅预留类型。
 * - coverageCheck / apiConfirmation 由 core/design-coverage 程序计算，不采信 LLM 自报（规范 1.14）。
 */

import { BaseAgent } from './base';
import type { AgentError, AgentContext, AgentResult } from './types';
import type { StructuredRequirement } from '../types/requirement';
import type { UserStorySet } from '../types/user-story';
import type { KnowledgeItem, KnowledgeType } from '../types/knowledge';
import type { ReviewIssue } from '../types/review-and-delivery';
import type { DesignRevision, IssueResponse } from '../types/review-dialog';
import type {
  FrontendDesignDoc,
  TechStack,
  FigmaReference,
  PageDesign,
  ComponentNode,
  StateManagementDesign,
  DataModel,
  ApiContract,
  ExceptionScenario,
  NFRSolution,
  ReusableComponent,
  DirectoryNode,
} from '../types/frontend-design';
import { buildDesignCoverage, buildApiConfirmation } from '../core/design-coverage';
import { findUnansweredIssues } from '../core/review-policy';
import {
  DESIGN_GENERATE_SYSTEM_PROMPT,
  DESIGN_REVISE_SYSTEM_PROMPT,
  renderDesignGenerateUserPrompt,
  renderDesignReviseUserPrompt,
} from '../prompts/design';

/** 技术方案从 0 生成的输入（ContextManager 按此装配） */
export interface DesignGenerateInput {
  type: 'generate-design';
  requirement: StructuredRequirement;
  stories: UserStorySet;
}

/**
 * 评审循环内按意见修改的输入（#42，独立于 generate 的 public revise 方法使用）。
 * round>=2 时 previousIssues 必须逐项回应，由 core/review-policy 校验。
 */
export interface DesignReviseInput {
  type: 'revise-design';
  /** 上一版方案 */
  previousDesign: FrontendDesignDoc;
  /** 上一轮评审遗留的 open 问题 */
  previousIssues: ReviewIssue[];
  /** 当前评审轮次（revise 发生在第 round 轮评审之后，从 2 开始） */
  round: number;
  /** 故事集合（用于重算覆盖度，与 generate 口径一致） */
  stories: UserStorySet;
}

export type DesignAgentInput = DesignGenerateInput;

/** LLM 输出的原始方案（字段均可选，parse 阶段兜底补全） */
interface RawDesign {
  techStack?: Partial<TechStack>;
  figmaReference?: Partial<FigmaReference>;
  pages?: PageDesign[];
  componentTree?: ComponentNode[];
  stateManagement?: Partial<StateManagementDesign>;
  dataModels?: DataModel[];
  apiContracts?: ApiContract[];
  exceptionScenarios?: ExceptionScenario[];
  nfrSolutions?: NFRSolution[];
  reusableComponents?: ReusableComponent[];
  directoryStructure?: DirectoryNode;
}

/** LLM 输出的原始方案修订（updatedDesign 走与 generate 相同的 RawDesign 归一化） */
interface RawRevision {
  changeSummary?: string;
  changedSections?: string[];
  issueResponses?: IssueResponse[];
  updatedDesign?: RawDesign;
}

export class DesignAgent extends BaseAgent<DesignAgentInput, FrontendDesignDoc> {
  readonly name = 'design-agent';
  readonly version = '0.1.0';

  // ============================================================
  // 知识库多路检索（第一个真正消费知识库的 Agent）
  // ============================================================

  protected async retrieveKnowledge(
    input: DesignAgentInput,
    context: AgentContext,
  ): Promise<KnowledgeItem[]> {
    const featureKeywords = input.stories.stories
      .map((s) => s.title)
      .concat(input.requirement.features.map((f) => f.name))
      .slice(0, 6)
      .join(' ');

    const queries: Array<{ query: string; types: KnowledgeType[]; topK: number }> = [
      // 组件/高频模式复用
      { query: `${featureKeywords} 组件 页面`, types: ['component', 'pattern'], topK: 6 },
      // 历史 API / 数据模型复用
      { query: `${featureKeywords} 接口 数据模型`, types: ['api', 'model'], topK: 6 },
      // 团队规范与异常处理约定
      {
        query: `${context.globalContext?.techStack ?? ''} 规范 状态管理 异常处理`,
        types: ['spec', 'exception', 'doc'],
        topK: 5,
      },
    ];
    return this.searchKnowledge(context, queries);
  }

  // ============================================================
  // BaseAgent 模板方法（仅 generate 路径）
  // ============================================================

  protected validateInput(input: DesignAgentInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.requirement) {
      errors.push({
        code: 'NO_REQUIREMENT',
        message: '技术方案设计需要结构化需求',
        severity: 'error',
      });
    }
    if (!input.stories || input.stories.stories.length === 0) {
      errors.push({ code: 'NO_STORIES', message: '技术方案设计需要用户故事', severity: 'error' });
    }
    if (input.requirement && !input.requirement.frozen.frozen) {
      errors.push({
        code: 'REQUIREMENT_NOT_FROZEN',
        message: '需求尚未冻结，建议先完成澄清再设计技术方案',
        severity: 'warning',
      });
    }
    return errors;
  }

  protected buildSystemPrompt(): string {
    return DESIGN_GENERATE_SYSTEM_PROMPT;
  }

  protected async buildUserPrompt(
    input: DesignAgentInput,
    context: AgentContext,
    knowledge: KnowledgeItem[],
  ): Promise<string> {
    const figmaSummary = context.params?.figmaSummary as string | undefined;
    return renderDesignGenerateUserPrompt({
      requirement: input.requirement,
      stories: input.stories,
      globalContext: context.globalContext,
      knowledge,
      figmaSummary,
    });
  }

  protected parseOutput(content: string, input: DesignAgentInput): FrontendDesignDoc {
    const jsonStr = this.extractJsonObject(content);
    const parsed: RawDesign = JSON.parse(jsonStr);
    const now = new Date().toISOString();

    return this.normalizeDesignDoc(
      parsed,
      {
        id: `design-${Date.now()}`,
        requirementId: input.requirement.id,
        storySetId: input.stories.id,
        version: 1,
      },
      input.stories,
      now,
    );
  }

  /**
   * 把 LLM 输出的 RawDesign 归一化为 FrontendDesignDoc（generate/revise 共用）。
   * 覆盖度与 API 确认一律程序重算（规范 1.14），元数据（id/版本/关联/时间戳）由系统决定。
   */
  private normalizeDesignDoc(
    parsed: RawDesign,
    meta: { id: string; requirementId: string; storySetId: string; version: number },
    stories: UserStorySet,
    now: string,
  ): FrontendDesignDoc {
    const pages = parsed.pages ?? [];
    const componentTree = parsed.componentTree ?? [];
    const apiContracts = parsed.apiContracts ?? [];
    const exceptionScenarios = parsed.exceptionScenarios ?? [];
    const nfrSolutions = parsed.nfrSolutions ?? [];
    const businessFields = { pages, componentTree, apiContracts, exceptionScenarios };

    // 覆盖度与 API 确认一律程序计算（规范 1.14）
    const coverageCheck = buildDesignCoverage(businessFields, stories);
    const apiConfirmation = buildApiConfirmation(apiContracts);

    const figmaReference: FigmaReference = {
      available: parsed.figmaReference?.available ?? false,
      fileUrl: parsed.figmaReference?.fileUrl,
      unavailableReason: parsed.figmaReference?.unavailableReason,
      designTokens: parsed.figmaReference?.designTokens,
      frames: parsed.figmaReference?.frames ?? [],
      componentMappings: parsed.figmaReference?.componentMappings ?? [],
    };

    return {
      id: meta.id,
      instanceId: '', // 由 Harness 回填
      requirementId: meta.requirementId,
      storySetId: meta.storySetId,
      version: meta.version,
      techStack: this.normalizeTechStack(parsed.techStack),
      figmaReference,
      pages,
      componentTree,
      stateManagement: {
        principle: parsed.stateManagement?.principle ?? '',
        globalStores: parsed.stateManagement?.globalStores ?? [],
        serverState: parsed.stateManagement?.serverState,
        crossPageState: parsed.stateManagement?.crossPageState,
      },
      dataModels: parsed.dataModels ?? [],
      apiContracts,
      exceptionScenarios,
      nfrSolutions,
      reusableComponents: parsed.reusableComponents ?? [],
      directoryStructure: parsed.directoryStructure ?? {
        name: 'src',
        type: 'directory',
        path: 'src',
      },
      coverageCheck,
      apiConfirmation,
      createdAt: now,
      updatedAt: now,
    };
  }

  protected validateOutput(output: FrontendDesignDoc, input: DesignAgentInput): AgentError[] {
    const errors = this.validateDesignStructure(output, input.stories);

    // 需求中的每条 NFR 都应有落地方案（warning；仅 generate 阶段掌握 requirement）
    const solvedNfrs = new Set(output.nfrSolutions.map((n) => n.nfrId));
    for (const nfr of input.requirement.nonFunctionalRequirements) {
      if (!solvedNfrs.has(nfr.id)) {
        errors.push({
          code: 'NFR_WITHOUT_SOLUTION',
          message: `非功能需求 ${nfr.id}（${nfr.category}）缺少落地方案`,
          severity: 'warning',
        });
      }
    }
    return errors;
  }

  /**
   * 方案结构校验（generate/revise 共用）：页面/组件/状态管理必填 + 引用完整性。
   * 不依赖 requirement，因此 revise 阶段也可复用。
   */
  private validateDesignStructure(output: FrontendDesignDoc, stories: UserStorySet): AgentError[] {
    const errors: AgentError[] = [];

    if (output.pages.length === 0) {
      errors.push({ code: 'NO_PAGES', message: '技术方案缺少页面设计', severity: 'error' });
    }
    if (output.componentTree.length === 0) {
      errors.push({ code: 'NO_COMPONENTS', message: '技术方案缺少组件树', severity: 'error' });
    }
    if (!output.stateManagement.principle) {
      errors.push({
        code: 'NO_STATE_MANAGEMENT_PRINCIPLE',
        message: '必须明确全局状态与局部状态的划分原则（stateManagement.principle）',
        severity: 'error',
      });
    }

    const componentIds = new Set(output.componentTree.map((c) => c.id));
    const storyIds = new Set(stories.stories.map((s) => s.id));

    // 引用完整性：页面引用的组件必须存在
    for (const page of output.pages) {
      for (const cid of page.componentIds ?? []) {
        if (!componentIds.has(cid)) {
          errors.push({
            code: 'BROKEN_COMPONENT_REF',
            message: `页面 ${page.id} 引用了不存在的组件 ${cid}`,
            severity: 'error',
            field: `pages.${page.id}.componentIds`,
          });
        }
      }
    }
    // 组件 children 引用必须存在
    for (const comp of output.componentTree) {
      for (const childId of comp.children ?? []) {
        if (!componentIds.has(childId)) {
          errors.push({
            code: 'BROKEN_CHILD_REF',
            message: `组件 ${comp.id} 的 children 引用了不存在的组件 ${childId}`,
            severity: 'error',
            field: `componentTree.${comp.id}.children`,
          });
        }
      }
      // 组件关联的故事必须存在（warning）
      for (const sid of comp.relatedStoryIds ?? []) {
        if (!storyIds.has(sid)) {
          errors.push({
            code: 'UNKNOWN_STORY_REF',
            message: `组件 ${comp.id} 关联了不存在的故事 ${sid}`,
            severity: 'warning',
          });
        }
      }
    }
    return errors;
  }

  protected selfCheck(output: FrontendDesignDoc): AgentError[] {
    const warnings: AgentError[] = [];

    if (!output.coverageCheck.passed) {
      warnings.push({
        code: 'DESIGN_COVERAGE_GAP',
        message: `方案覆盖度未达标：${output.coverageCheck.issues.join('；')}`,
        severity: 'warning',
      });
    }

    const needsDesign = output.exceptionScenarios.filter((e) => e.status === 'needs-design');
    if (needsDesign.length > 0) {
      warnings.push({
        code: 'SCENARIOS_NEED_DESIGN',
        message: `有 ${needsDesign.length} 个异常场景需要设计稿支持后补全`,
        severity: 'warning',
      });
    }

    // 没有关联任何故事的孤立页面
    const orphanPages = output.pages.filter((p) => (p.relatedStoryIds ?? []).length === 0);
    if (orphanPages.length > 0) {
      warnings.push({
        code: 'ORPHAN_PAGE',
        message: `页面 ${orphanPages.map((p) => p.id).join(',')} 未关联任何用户故事，请确认是否多余`,
        severity: 'warning',
      });
    }

    if (!output.figmaReference.available) {
      warnings.push({
        code: 'FIGMA_UNAVAILABLE',
        message: '未使用 Figma 设计稿，UI 细节与还原度需在编码/评审阶段人工确认',
        severity: 'warning',
      });
    }

    return warnings;
  }

  // ============================================================
  // revise（评审多轮对话内的修改，独立于 generate，规范 8.3 / #42）
  // ============================================================

  /**
   * 根据上一轮评审意见修订方案（独立 public 方法，不在 execute 内按 type 分发）。
   * 复用 runAgentCycle 的重试/日志骨架，使用 revise 专属的输入输出与钩子。
   */
  async revise(context: AgentContext): Promise<AgentResult<DesignRevision>> {
    const input = context.input as DesignReviseInput;
    return this.runAgentCycle<DesignReviseInput, DesignRevision>({
      input,
      context,
      // 修订阶段不再检索知识库（以上一轮问题为驱动），用默认知识
      validateInput: (i) => this.validateReviseInput(i),
      buildSystemPrompt: () => DESIGN_REVISE_SYSTEM_PROMPT,
      buildUserPrompt: async (i) =>
        renderDesignReviseUserPrompt({
          previousDesign: i.previousDesign,
          previousIssues: i.previousIssues,
          round: i.round,
        }),
      parseOutput: (content, i) => this.parseRevise(content, i),
      validateOutput: (output, i) => this.validateRevise(output, i),
      selfCheck: (output) => this.reviseSelfCheck(output),
    });
  }

  private validateReviseInput(input: DesignReviseInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.previousDesign) {
      errors.push({
        code: 'NO_PREVIOUS_DESIGN',
        message: 'revise 需要上一版方案',
        severity: 'error',
      });
    }
    if (!input.stories || input.stories.stories.length === 0) {
      errors.push({
        code: 'NO_STORIES',
        message: 'revise 需要故事集合以重算覆盖度',
        severity: 'error',
      });
    }
    if ((input.previousIssues ?? []).length === 0) {
      errors.push({
        code: 'REVISE_WITHOUT_ISSUES',
        message: '没有上一轮 open 问题却触发了 revise，请确认流程是否正确',
        severity: 'warning',
      });
    }
    return errors;
  }

  private parseRevise(content: string, input: DesignReviseInput): DesignRevision {
    const jsonStr = this.extractJsonObject(content);
    const parsed: RawRevision = JSON.parse(jsonStr);
    const now = new Date().toISOString();
    const prev = input.previousDesign;

    const rawUpdated = parsed.updatedDesign ?? {};
    const updatedDesign = this.normalizeDesignDoc(
      rawUpdated,
      {
        // 沿用原方案 id 与关联，版本 +1（评审内修改不是回退，ADR-014）
        id: prev.id,
        requirementId: prev.requirementId,
        storySetId: prev.storySetId,
        version: prev.version + 1,
      },
      input.stories,
      now,
    );
    // 保留首次创建时间
    updatedDesign.createdAt = prev.createdAt;

    return {
      changeSummary: parsed.changeSummary ?? '',
      changedSections: parsed.changedSections ?? [],
      issueResponses: parsed.issueResponses ?? [],
      updatedDesign,
    };
  }

  private validateRevise(output: DesignRevision, input: DesignReviseInput): AgentError[] {
    const errors: AgentError[] = [];

    // 修改方逐项回应闭环（ADR-014）：不得遗漏上轮 open 问题，wont-fix 必须有理由
    const unanswered = findUnansweredIssues(input.previousIssues ?? [], output.issueResponses);
    for (const item of unanswered) {
      errors.push({
        code: 'ISSUE_RESPONSE_INCOMPLETE',
        message: `问题 ${item.issueId}: ${item.reason}`,
        severity: 'error',
      });
    }

    // 回应的问题 ID 必须确实来自上一轮（warning，防止答非所问）
    const prevIds = new Set((input.previousIssues ?? []).map((i) => i.issueId));
    for (const resp of output.issueResponses) {
      if (!prevIds.has(resp.issueId)) {
        errors.push({
          code: 'UNKNOWN_ISSUE_RESPONSE',
          message: `issueResponse 回应了上一轮不存在的问题 ${resp.issueId}`,
          severity: 'warning',
        });
      }
    }

    // 修改后的方案仍需通过结构校验（引用完整性等）
    errors.push(...this.validateDesignStructure(output.updatedDesign, input.stories));
    return errors;
  }

  private reviseSelfCheck(output: DesignRevision): AgentError[] {
    const warnings: AgentError[] = [];
    if (!output.updatedDesign.coverageCheck.passed) {
      warnings.push({
        code: 'REVISED_DESIGN_COVERAGE_GAP',
        message: `修订后方案覆盖度仍未达标：${output.updatedDesign.coverageCheck.issues.join('；')}`,
        severity: 'warning',
      });
    }
    return warnings;
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /** 兜底补全技术栈必填结构，避免下游访问空指针 */
  private normalizeTechStack(tech?: Partial<TechStack>): TechStack {
    return {
      source: tech?.source === 'detected' ? 'detected' : 'suggested',
      framework: tech?.framework ?? { name: '', version: '' },
      language: tech?.language === 'JavaScript' ? 'JavaScript' : 'TypeScript',
      stateManagement: tech?.stateManagement ?? { library: '' },
      uiLibrary: tech?.uiLibrary,
      testing: tech?.testing ?? { framework: '' },
      buildTool: tech?.buildTool ?? '',
      additionalDependencies: tech?.additionalDependencies,
      configFiles: tech?.configFiles,
    };
  }
}
