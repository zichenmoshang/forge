/**
 * 上下文管理器 - 上游产物传递给下游
 *
 * 职责（ADR-014 收敛后）：
 * - 上下文装配：根据当前状态，从产物存储读取上游产物，组装成 Agent 输入
 * - 全局上下文维护：技术栈约束、团队规范等全局信息
 *
 * 明确不做：
 * - 不做知识库检索（ADR-014：检索是 Agent 的业务逻辑，由 Agent 在 retrieveKnowledge
 *   钩子中通过 AgentContext.knowledgeService 自主多路检索，Harness/ContextManager 不干预）
 *
 * v2 预留：
 * - 产物引用传递（buildAgentInputWithRefs）：大产物不传完整内容，只传引用
 * - 按需检索（retrieveRelevantParts）：编码阶段只加载当前故事相关的方案片段
 * - 摘要压缩（summarizeArtifact）：跨阶段传递时对大产物生成摘要
 *
 * 设计参考：docs/03-architecture.md "上下文管理策略"
 */

import type { ArtifactStore } from './artifact-store';
import type { PipelineStateName, ArtifactStage } from '../types/state';
import type { StructuredRequirement } from '../types/requirement';
import type { UserStorySet, UserStory } from '../types/user-story';
import type { FrontendDesignDoc } from '../types/frontend-design';
import type {
  CodingPhaseResult,
  CodingTask,
  ProjectContext,
  TestRequirements,
} from '../types/coding-task';
import { buildCodingTask } from './coding-planner';
import type { ReviewResult } from '../types/review-and-delivery';
import type { RequirementAgentInput } from '../agents/requirement-agent';
import type { DesignGenerateInput } from '../agents/design-agent';
import type { DesignReviewInput, CodeReviewInput } from '../agents/review-agent';
import type { GlobalContext } from '../agents/types';

// GlobalContext 定义在 agents/types（中立位置），此处 re-export 保持既有引用路径
export type { GlobalContext };

/** 上下文管理器配置 */
export interface ContextManagerConfig {
  artifactStore: ArtifactStore;
  /** 全局上下文（技术栈、规范等约束） */
  globalContext?: GlobalContext;
}

/** 交付阶段输入 */
export interface DeliveryAgentInput {
  type: 'deliver';
  coding: CodingPhaseResult;
  codeReview: ReviewResult;
  /** 交付场景（可选，不填自动推断目标项目状态） */
  scenario?: 'new-project' | 'new-module' | 'code-modification';
  /** 需求标题（用于 commit message 和 PR 描述） */
  requirementTitle: string;
  /** 流程实例 ID（用于分支命名和 commit 关联） */
  instanceId: string;
}

/**
 * 上下文管理器
 *
 * v1 实现：直接传递完整产物对象
 * v2 计划：产物引用传递 + 按需检索 + 摘要压缩
 */
export class ContextManager {
  private artifactStore: ArtifactStore;
  private globalContext: GlobalContext;

  constructor(config: ContextManagerConfig) {
    this.artifactStore = config.artifactStore;
    this.globalContext = config.globalContext ?? {};
  }

  /**
   * 根据当前状态构建 Agent 输入
   *
   * 只做产物装配，不做知识库检索。返回 undefined 表示缺少上游产物，
   * 由 Harness 判定为失败。
   *
   * v1：直接从产物存储读取完整产物，组装成输入对象
   * v2：大产物改为引用传递，Agent 按需读取
   */
  buildAgentInput(
    state: PipelineStateName,
    instanceId: string,
    extra?: Record<string, unknown>,
  ): unknown {
    switch (state) {
      case 'REQUIREMENT_PARSING': {
        const prdText = extra?.prdText as string | undefined;
        const prdSource = extra?.prdSource as string | undefined;
        if (!prdText) return undefined;
        return {
          type: 'clarify',
          prdText,
          source: prdSource,
        } satisfies RequirementAgentInput;
      }

      case 'STORIES_GENERATING': {
        const requirement = this.artifactStore.get<StructuredRequirement>(
          'requirement',
          instanceId,
        );
        if (!requirement) return undefined;
        return {
          type: 'generate-stories',
          requirement,
        } satisfies RequirementAgentInput;
      }

      // TODO(v2): 技术方案可能较大，改为引用传递（requirementId + storiesId）
      case 'DESIGN_GENERATING': {
        const requirement = this.artifactStore.get<StructuredRequirement>(
          'requirement',
          instanceId,
        );
        const stories = this.artifactStore.get<UserStorySet>('stories', instanceId);
        if (!requirement || !stories) return undefined;
        return {
          type: 'generate-design',
          requirement,
          stories,
        } satisfies DesignGenerateInput;
      }

      // CODING 为逐故事循环（issue #40），不走单次 buildAgentInput：
      // Harness.runCodingPhase 对每个故事调用 buildCodingTaskForStory 装配 CodingTask
      case 'CODING':
        return undefined;

      case 'DESIGN_REVIEWING': {
        const design = this.artifactStore.get<FrontendDesignDoc>('design', instanceId);
        if (!design) return undefined;
        return { type: 'review-design', design } satisfies DesignReviewInput;
      }

      // CODE_REVIEWING 走多轮对话循环（Harness.runCodeReviewDialog 直接装配输入），
      // 不会走到通用单次 buildAgentInput；此分支仅为类型完整性与未来单次执行路径保留。
      case 'CODE_REVIEWING': {
        const design = this.artifactStore.get<FrontendDesignDoc>('design', instanceId);
        const coding = this.artifactStore.get<CodingPhaseResult>('coding', instanceId);
        if (!design || !coding) return undefined;
        return { type: 'review-code', design, coding } satisfies CodeReviewInput;
      }

      case 'DELIVERING': {
        const coding = this.artifactStore.get<CodingPhaseResult>('coding', instanceId);
        const codeReview = this.artifactStore.get<ReviewResult>('code-review', instanceId);
        const requirement = this.artifactStore.get<StructuredRequirement>(
          'requirement',
          instanceId,
        );
        if (!coding || !codeReview) return undefined;
        return {
          type: 'deliver',
          coding,
          codeReview,
          requirementTitle: requirement?.meta?.title ?? '未命名需求',
          instanceId,
        } satisfies DeliveryAgentInput;
      }

      // 硬卡点/终态等状态本身不执行 Agent，不需要输入
      default:
        return {};
    }
  }

  /**
   * 为指定故事构建编码任务（CODING 阶段逐故事循环使用，issue #40）。
   *
   * 从产物存储读取技术方案，结合单个故事抽取该故事的 CodingTask；
   * 缺少技术方案时返回 undefined，由 Harness 判定为失败。
   */
  buildCodingTaskForStory(
    instanceId: string,
    story: UserStory,
    storyIndex: number,
    totalStories: number,
    options: { projectContext: ProjectContext; testRequirements?: TestRequirements },
  ): CodingTask | undefined {
    const design = this.artifactStore.get<FrontendDesignDoc>('design', instanceId);
    if (!design) return undefined;
    return buildCodingTask(design, story, {
      instanceId,
      storyIndex,
      totalStories,
      projectContext: options.projectContext,
      testRequirements: options.testRequirements,
    });
  }

  /**
   * 获取全局上下文（始终携带的约束信息）
   *
   * v1：接口已定义，暂未注入到 Agent 输入
   * v2：在 buildAgentInput 中合并全局上下文
   */
  getGlobalContext(): GlobalContext {
    return structuredClone(this.globalContext);
  }

  /**
   * 更新全局上下文
   */
  updateGlobalContext(patch: Partial<GlobalContext>): void {
    this.globalContext = { ...this.globalContext, ...patch };
  }

  // ============================================================
  // v2 预留接口（暂未实现）
  // ============================================================

  /**
   * v2：构建带产物引用的 Agent 输入
   *
   * 大产物（技术方案、代码）不传完整内容，只传产物 ID，
   * Agent 内部通过 ArtifactStore 按需读取。
   *
   * TODO: 实现产物引用传递
   */
  buildAgentInputWithRefs(
    _state: PipelineStateName,
    _instanceId: string,
  ): { artifactRefs: Partial<Record<ArtifactStage, string>> } {
    throw new Error('v2 功能未实现：产物引用传递');
  }

  /**
   * v2：按需检索产物的相关部分
   *
   * 编码阶段不加载完整技术方案，只检索当前故事相关的部分。
   *
   * TODO: 实现按需检索（需要代码索引/语义检索支持）
   */
  retrieveRelevantParts(_artifactId: string, _query: string): unknown {
    throw new Error('v2 功能未实现：按需检索');
  }

  /**
   * v2：对大产物生成摘要
   *
   * 跨阶段传递时，对大产物生成摘要 + 关键细节，
   * 完整内容存文件，Agent 需要时再读取。
   *
   * TODO: 实现摘要压缩（需要 LLM 调用）
   */
  summarizeArtifact(_artifactId: string): Promise<string> {
    throw new Error('v2 功能未实现：摘要压缩');
  }
}
