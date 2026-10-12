/**
 * 评审 Agent - 阶段4（方案评审）+ 阶段6（代码 CR，#后续预留）
 *
 * 职责：
 * - 方案评审：覆盖度、异常完整性、接口一致性、架构合理性、状态管理、NFR
 * - 代码 CR：规范、逻辑、异常、安全、可维护性（v1 暂不实现，仅预留输入类型）
 *
 * 实现约束（ADR-014）：
 * - severity blocker/critical 由 normalizeIssues 强制 blocking，不信任 LLM 标记
 * - 是否通过只看是否存在 blocking 且 open 的 issue（hasBlockingIssue），conclusion 仅作总结
 * - LLM 想通过但仍有 blocking 时由 resolveDialogAction 程序化降级（消费方/未来 runReviewDialog 调用）
 * - 第 2 轮起对上轮 open issue 逐项 verification（findUnverifiedIssues，随 #42 多轮对话启用）
 *
 * v1（方案 A）只实现方案单轮评审 review-design；多轮对话与代码 CR 后续落地。
 */

import { BaseAgent } from './base';
import type { AgentError, AgentContext } from './types';
import type { FrontendDesignDoc } from '../types/frontend-design';
import type { CodingPhaseResult } from '../types/coding-task';
import type {
  ReviewResult,
  ReviewIssue,
  DesignReviewChecklist,
} from '../types/review-and-delivery';
import type { KnowledgeItem } from '../types/knowledge';
import type { IssueResponse } from '../types/review-dialog';
import {
  normalizeIssues,
  hasBlockingIssue,
  validateReviewConsistency,
  resolveDialogAction,
  findUnverifiedIssues,
  type LlmDialogAction,
} from '../core/review-policy';
import {
  DESIGN_REVIEW_SYSTEM_PROMPT,
  CODE_REVIEW_SYSTEM_PROMPT,
  renderDesignReviewUserPrompt,
  renderCodeReviewUserPrompt,
} from '../prompts/review';

/** 方案评审输入（ContextManager 按此装配；多轮对话由 Harness 注入轮次信息，#42） */
export interface DesignReviewInput {
  type: 'review-design';
  design: FrontendDesignDoc;
  /** 当前评审轮次，从 1 开始；>=2 时触发问题跟踪闭环校验 */
  round?: number;
  /** 上一轮遗留问题（round>=2 时必传，只给结构化 issue，不给上轮自然语言评论以避免自我锚定） */
  previousIssues?: ReviewIssue[];
  /** 修改方（Designer）针对上轮问题的逐项回应（round>=2 时存在） */
  issueResponses?: IssueResponse[];
}

/** 代码 CR 输入（coding 为编码阶段聚合产物，CR 只针对成功/部分故事） */
export interface CodeReviewInput {
  type: 'review-code';
  design: FrontendDesignDoc;
  coding: CodingPhaseResult;
  /** 当前评审轮次，从 1 开始；>=2 时触发问题跟踪闭环校验 */
  round?: number;
  /** 上一轮遗留问题（round>=2 时必传） */
  previousIssues?: ReviewIssue[];
  /** Coder 针对上轮问题的逐项回应（round>=2 时存在） */
  issueResponses?: IssueResponse[];
}

export type ReviewAgentInput = DesignReviewInput | CodeReviewInput;

/** LLM 输出的原始评审结果（元数据由系统补全） */
interface RawReview {
  conclusion?: ReviewResult['conclusion'];
  /** LLM 显式给出的对话动作（多轮对话时可输出 request_human；优先于 conclusion 映射） */
  dialogAction?: 'approve' | 'request_changes' | 'request_human';
  summary?: string;
  issues?: Array<Omit<ReviewIssue, 'blocking'> & { blocking?: boolean }>;
  checklist?: DesignReviewChecklist;
}

export class ReviewAgent extends BaseAgent<ReviewAgentInput, ReviewResult> {
  readonly name = 'review-agent';
  readonly version = '0.1.0';

  protected validateInput(input: ReviewAgentInput): AgentError[] {
    const errors: AgentError[] = [];
    if (!input.design) {
      errors.push({
        code: 'NO_DESIGN',
        message: '评审需要被评审的技术方案',
        severity: 'error',
      });
      return errors;
    }
    if (input.type === 'review-design') {
      if (input.design.pages.length === 0 || input.design.componentTree.length === 0) {
        errors.push({
          code: 'EMPTY_DESIGN',
          message: '被评审方案缺少页面或组件树，无法评审',
          severity: 'error',
        });
      }
      return errors;
    }
    // review-code
    if (!input.coding) {
      errors.push({ code: 'NO_CODING', message: '代码 CR 需要编码阶段产物', severity: 'error' });
      return errors;
    }
    const reviewable = input.coding.results.filter((r) => r.status !== 'failed');
    if (reviewable.length === 0) {
      errors.push({
        code: 'NO_REVIEWABLE_CODE',
        message: '编码产物中没有可审查的故事（全部失败），无法 CR',
        severity: 'error',
      });
    }
    return errors;
  }

  protected buildSystemPrompt(input: ReviewAgentInput, _context: AgentContext): string {
    return input.type === 'review-code' ? CODE_REVIEW_SYSTEM_PROMPT : DESIGN_REVIEW_SYSTEM_PROMPT;
  }

  protected async buildUserPrompt(
    input: ReviewAgentInput,
    _context: AgentContext,
    _knowledge: KnowledgeItem[],
  ): Promise<string> {
    if (input.type === 'review-code') {
      return renderCodeReviewUserPrompt({
        design: input.design,
        coding: input.coding,
        round: input.round ?? 1,
        previousIssues: input.previousIssues ?? [],
        issueResponses: input.issueResponses ?? [],
      });
    }
    return renderDesignReviewUserPrompt({
      design: input.design,
      round: input.round ?? 1,
      previousIssues: input.previousIssues ?? [],
      issueResponses: input.issueResponses ?? [],
    });
  }

  protected parseOutput(content: string, input: ReviewAgentInput): ReviewResult {
    const jsonStr = this.extractJsonObject(content);
    const parsed = this.parseJsonWithRecovery<RawReview>(jsonStr);
    const now = new Date().toISOString();
    const round = input.round ?? 1;
    const isCodeReview = input.type === 'review-code';

    // 程序化强制 blocker/critical 阻塞（ADR-014）
    const rawIssues = (parsed.issues ?? []).map((issue) => ({
      ...issue,
      status: issue.status ?? ('open' as const),
    }));
    const issues = normalizeIssues(rawIssues as ReviewIssue[]);

    const checklist = parsed.checklist;
    if (checklist) {
      // overallPassed 程序化：无 blocking open issue 才算通过，覆盖 LLM 自报
      checklist.overallPassed = !hasBlockingIssue(issues);
    }

    // 动作来源：LLM 显式 dialogAction（多轮对话，可 request_human）优先；否则按 conclusion 映射
    const llmAction: LlmDialogAction =
      parsed.dialogAction ?? (parsed.conclusion === 'reject' ? 'request_changes' : 'approve');
    const resolvedAction = resolveDialogAction(llmAction, issues);

    return {
      reviewId: `${isCodeReview ? 'code-review' : 'design-review'}-r${round}-${Date.now()}`,
      instanceId: '', // 由 Harness 回填
      reviewType: isCodeReview ? 'code-review' : 'design-review',
      targetArtifactId: isCodeReview ? input.coding.id : input.design.id,
      targetVersion: isCodeReview ? input.coding.version : input.design.version,
      conclusion: parsed.conclusion ?? 'pass-with-comments',
      resolvedAction,
      issues,
      checklist,
      summary: parsed.summary ?? '',
      durationMs: 0,
      reviewer: this.name,
      reviewedAt: now,
    };
  }

  protected validateOutput(output: ReviewResult, input: ReviewAgentInput): AgentError[] {
    const errors: AgentError[] = [];
    const round = input.round ?? 1;

    // 一致性：问题 ID 重复、resolved 缺 verification 等
    for (const msg of validateReviewConsistency(output, round)) {
      errors.push({ code: 'REVIEW_INCONSISTENT', message: msg, severity: 'error' });
    }

    // #49 修复：round>=2 时 previousIssues 为必填项，缺失（undefined）直接报错（fail-close），
    // 不允许 ?? [] 转空数组后静默通过（fail-open 会导致闭环校验失效且不报错）。
    // 注意：空数组 [] 是合法的（上一轮确实没有问题），只有 undefined（Harness 漏传）才是错误。
    if (round >= 2 && input.previousIssues === undefined) {
      errors.push({
        code: 'MISSING_PREVIOUS_ISSUES',
        message: `第 ${round} 轮评审缺少上一轮问题列表（previousIssues），无法执行问题跟踪闭环校验`,
        severity: 'error',
      });
    }
    const missing = findUnverifiedIssues(input.previousIssues ?? [], output.issues, round);
    for (const issueId of missing) {
      errors.push({
        code: 'MISSING_ISSUE_VERIFICATION',
        message: `第 ${round} 轮遗漏了对上一轮问题 ${issueId} 的 verification`,
        severity: 'error',
      });
    }

    for (const issue of output.issues) {
      if (!issue.suggestion || issue.suggestion.trim() === '') {
        errors.push({
          code: 'ISSUE_WITHOUT_SUGGESTION',
          message: `问题 ${issue.issueId} 缺少可执行的修改建议`,
          severity: 'warning',
        });
      }
      if (!issue.category) {
        errors.push({
          code: 'ISSUE_WITHOUT_CATEGORY',
          message: `问题 ${issue.issueId} 缺少分类 category`,
          severity: 'error',
        });
      }
    }
    return errors;
  }

  protected selfCheck(output: ReviewResult, input: ReviewAgentInput): AgentError[] {
    const warnings: AgentError[] = [];

    // LLM 结论与程序化 blocking 判定矛盾（系统已以程序化为准，仅提示）
    const blocking = hasBlockingIssue(output.issues);
    if (output.conclusion === 'pass' && blocking) {
      warnings.push({
        code: 'CONCLUSION_CONTRADICTS_ISSUES',
        message: 'LLM 结论为 pass 但存在 blocking 问题，已程序化判定为不通过',
        severity: 'warning',
      });
    }

    // 评审遗漏：方案自身覆盖度未达标，但评审没有提出 coverage 类问题（仅方案评审分支；代码 CR 不检查方案覆盖度）
    if (input.type === 'review-design') {
      const designHasCoverageGap = !input.design.coverageCheck.passed;
      const raisedCoverageIssue = output.issues.some((i) => i.category === 'coverage');
      if (designHasCoverageGap && !raisedCoverageIssue) {
        warnings.push({
          code: 'REVIEW_MISSED_COVERAGE',
          message: '方案覆盖度未达标，但评审未提出 coverage 类问题，存在漏审',
          severity: 'warning',
        });
      }
    }

    return warnings;
  }
}
