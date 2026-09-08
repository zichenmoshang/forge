/**
 * Agent 基类
 *
 * 所有专业 Agent 继承此类，使用模板方法模式定义通用执行流程：
 *   校验输入 → 构建 Prompt → 调用 LLM → 解析输出 → 校验输出 → 质量自检 → 返回结果
 *
 * 子类只需实现阶段特定的逻辑，不需要关心重试、日志、错误处理等横切关注点。
 */

import type { LLMProvider, LLMRequest } from '../llm/provider';
import type { Logger } from '../observability/logger';
import type { AgentContext, AgentError, AgentResult, AgentConfig } from './types';
import type { KnowledgeItem } from '../types/knowledge';

/**
 * 泛型执行器钩子（{@link BaseAgent.runAgentCycle}）。
 *
 * 把一次"校验→检索→Prompt→LLM→解析→校验→自检"所需的各阶段逻辑以函数注入，
 * 使标准 execute 与多模式方法（如 DesignAgent.revise）共用同一套重试/日志骨架。
 */
export interface AgentCycleHooks<TI, TO> {
  input: TI;
  context: AgentContext;
  validateInput: (input: TI) => AgentError[];
  retrieveKnowledge?: (input: TI, context: AgentContext) => Promise<KnowledgeItem[]>;
  buildSystemPrompt: (input: TI, context: AgentContext) => string;
  buildUserPrompt: (
    input: TI,
    context: AgentContext,
    knowledge: KnowledgeItem[],
  ) => Promise<string>;
  parseOutput: (content: string, input: TI, context: AgentContext) => TO;
  validateOutput: (output: TO, input: TI, context: AgentContext) => AgentError[];
  selfCheck: (output: TO, input: TI, context: AgentContext) => AgentError[];
}

export abstract class BaseAgent<I = unknown, O = unknown> {
  abstract readonly name: string;
  abstract readonly version: string;

  protected llm: LLMProvider;
  protected logger?: Logger;
  protected config: Required<AgentConfig>;

  constructor(llm: LLMProvider, options?: { logger?: Logger; config?: AgentConfig }) {
    this.llm = llm;
    this.logger = options?.logger;
    this.config = {
      maxRetries: options?.config?.maxRetries ?? 2,
      retryBaseDelayMs: options?.config?.retryBaseDelayMs ?? 1000,
      temperature: options?.config?.temperature ?? 0.7,
      maxTokens: options?.config?.maxTokens ?? 4096,
    };
  }

  /**
   * 模板方法：执行 Agent 完整流程（标准单次模式）。
   *
   * 多模式 Agent（如 DesignAgent 的 generate/revise）不在此方法内按 type 分发
   *（规范 8.3），而是为第二种模式单独构造 hooks 调用 {@link runAgentCycle}。
   */
  async execute(context: AgentContext): Promise<AgentResult<O>> {
    const input = context.input as I;
    return this.runAgentCycle<I, O>({
      input,
      context,
      validateInput: (i) => this.validateInput(i, context),
      retrieveKnowledge: (i, ctx) => this.retrieveKnowledge(i, ctx),
      buildSystemPrompt: (i) => this.buildSystemPrompt(i, context),
      buildUserPrompt: (i, _ctx, knowledge) => this.buildUserPrompt(i, context, knowledge),
      parseOutput: (content, i) => this.parseOutput(content, i, context),
      validateOutput: (output, i) => this.validateOutput(output, i, context),
      selfCheck: (output, i) => this.selfCheck(output, i, context),
    });
  }

  /**
   * 泛型执行器：校验输入 → 检索 → 构建 Prompt →（带重试）调用 LLM →
   * 解析 → 校验输出 → 自检。execute 与多模式方法（revise 等）共用，避免重复重试/日志逻辑。
   */
  protected async runAgentCycle<TI, TO>(hooks: AgentCycleHooks<TI, TO>): Promise<AgentResult<TO>> {
    const { input, context } = hooks;
    const startTime = Date.now();
    let llmCalls = 0;
    let retries = 0;

    this.logger?.info(`[${this.name}] 开始执行`, {
      instanceId: context.instanceId,
      traceId: context.traceId,
      stage: context.stage,
      agent: this.name,
    });

    try {
      // 1. 校验输入
      const inputErrors = hooks.validateInput(input);
      if (inputErrors.some((e) => e.severity === 'error')) {
        return this.buildFailure<TO>(inputErrors, startTime, 0, 0);
      }
      // 收集输入校验的 warning，最终合并到结果中
      const inputWarnings = inputErrors.filter((e) => e.severity === 'warning');

      // 2. 检索增强：根据输入检索相关知识
      const retrieve =
        hooks.retrieveKnowledge ?? ((_i: TI, ctx: AgentContext) => this.defaultKnowledge(ctx));
      const knowledge = await retrieve(input, context);
      if (knowledge.length > 0) {
        this.logger?.debug(`[${this.name}] 检索到 ${knowledge.length} 条相关知识`, {
          instanceId: context.instanceId,
          agent: this.name,
        });
      }

      // 3. 构建 Prompt
      const systemPrompt = hooks.buildSystemPrompt(input, context);
      const userPrompt = await hooks.buildUserPrompt(input, context, knowledge);

      // 3. 调用 LLM（带重试）
      let lastErrors: AgentError[] = [];

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (attempt > 0) {
          retries++;
          this.logger?.warn(
            `[${this.name}] 第 ${attempt} 次重试，原因: ${lastErrors.map((e) => e.message).join('; ')}`,
            { instanceId: context.instanceId, agent: this.name },
          );
          await this.sleep(this.config.retryBaseDelayMs * attempt);
        }

        const llmRequest: LLMRequest = {
          prompt: userPrompt,
          systemPrompt,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          caller: this.name,
          instanceId: context.instanceId,
          traceId: context.traceId,
        };

        const response = await this.llm.complete(llmRequest);
        llmCalls++;

        // 4. 解析输出
        let parsed: TO;
        try {
          parsed = hooks.parseOutput(response.content, input, context);
        } catch (err) {
          lastErrors = [
            {
              code: 'PARSE_ERROR',
              message: err instanceof Error ? err.message : String(err),
              severity: 'error',
            },
          ];
          continue; // 解析失败，重试
        }

        // 5. 校验输出
        const validationErrors = hooks.validateOutput(parsed, input, context);
        if (validationErrors.some((e) => e.severity === 'error')) {
          lastErrors = validationErrors;
          continue; // 校验失败，重试
        }

        // 6. 质量自检（warning 不阻塞，只记录）
        const selfCheckErrors = hooks.selfCheck(parsed, input, context);
        const allErrors = [...inputWarnings, ...validationErrors, ...selfCheckErrors];

        this.logger?.info(
          `[${this.name}] 执行成功，耗时 ${Date.now() - startTime}ms，LLM 调用 ${llmCalls} 次`,
          { instanceId: context.instanceId, agent: this.name },
        );

        return {
          success: true,
          data: parsed,
          errors: allErrors,
          durationMs: Date.now() - startTime,
          llmCalls,
          retries,
        };
      }

      // 重试耗尽
      this.logger?.error(
        `[${this.name}] 执行失败，重试 ${retries} 次后仍未通过校验`,
        { instanceId: context.instanceId, agent: this.name },
        { errors: lastErrors },
      );

      return this.buildFailure<TO>(lastErrors, startTime, llmCalls, retries);
    } catch (err) {
      const error: AgentError = {
        code: 'EXECUTION_ERROR',
        message: err instanceof Error ? err.message : String(err),
        severity: 'error',
      };

      this.logger?.error(`[${this.name}] 执行异常: ${error.message}`, {
        instanceId: context.instanceId,
        agent: this.name,
      });

      return this.buildFailure<TO>([error], startTime, llmCalls, retries);
    }
  }

  /** 默认知识来源（未重写 retrieveKnowledge 时使用） */
  private defaultKnowledge(context: AgentContext): KnowledgeItem[] {
    return context.knowledge ?? [];
  }

  // ============================================================
  // 子类需要实现的抽象方法
  // ============================================================

  /** 校验输入，返回错误列表（空数组表示通过） */
  protected abstract validateInput(input: I, context: AgentContext): AgentError[];

  /**
   * 检索增强：根据输入检索相关知识
   *
   * 默认不做检索（ADR-014 后 ContextManager 不再预检索）。
   * 子类（如 DesignAgent）重写此方法，通过 searchKnowledge() helper
   * 或直接调用 context.knowledgeService 按需多路检索。
   */
  protected async retrieveKnowledge(_input: I, context: AgentContext): Promise<KnowledgeItem[]> {
    return context.knowledge ?? [];
  }

  /**
   * 知识库多路并行检索 helper（ADR-014）
   *
   * 封装 projectScope 过滤（当前项目 + global 由 KnowledgeService 负责），
   * 子类传入多组 query/filter/topK，并行检索后合并返回。
   *
   * 未注入 knowledgeService 时返回空数组，保证无知识库环境可降级运行。
   */
  protected async searchKnowledge(
    context: AgentContext,
    queries: Array<{ query: string; types?: KnowledgeItem['type'][]; topK?: number }>,
  ): Promise<KnowledgeItem[]> {
    const service = context.knowledgeService;
    if (!service || queries.length === 0) {
      return context.knowledge ?? [];
    }

    const scopeFilter = context.projectId ? { projectScope: context.projectId } : {};
    const results = await Promise.all(
      queries.map((q) =>
        service.search(
          q.query,
          { ...(q.types ? { types: q.types } : {}), ...scopeFilter },
          q.topK ?? 5,
        ),
      ),
    );

    // 按 id 去重（多路检索可能命中同一条知识），保留首次出现顺序
    const seen = new Set<string>();
    const merged: KnowledgeItem[] = [];
    for (const item of results.flat()) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }

  /** 构建系统提示词 */
  protected abstract buildSystemPrompt(input: I, context: AgentContext): string;

  /** 构建用户提示词（注入检索到的知识） */
  protected abstract buildUserPrompt(
    input: I,
    context: AgentContext,
    knowledge: KnowledgeItem[],
  ): Promise<string>;

  /** 解析 LLM 输出为结构化数据 */
  protected abstract parseOutput(content: string, input: I, context: AgentContext): O;

  /** 校验输出结构，返回错误列表 */
  protected abstract validateOutput(output: O, input: I, context: AgentContext): AgentError[];

  /** 质量自检，返回警告列表（不阻塞执行） */
  protected abstract selfCheck(output: O, input: I, context: AgentContext): AgentError[];

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 从 LLM 输出中提取 JSON 文本（子类共享）。
   *
   * 兼容三种形态：
   * 1. ```json ... ``` 代码块包裹（取第一个代码块）
   * 2. 前后带解释文字（取第一个 { 到最后一个 } 之间内容）
   * 3. 纯 JSON 文本
   *
   * 只做文本截取，不做 parse；parse 由子类完成以便定位错误。
   */
  protected extractJsonObject(content: string): string {
    // 尝试提取 ```json ... ``` 包裹的内容
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }
    // 尝试提取第一个 { 到最后一个 } 之间的内容
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }
    return content.trim();
  }

  private buildFailure<T>(
    errors: AgentError[],
    startTime: number,
    llmCalls: number,
    retries: number,
  ): AgentResult<T> {
    return {
      success: false,
      errors,
      durationMs: Date.now() - startTime,
      llmCalls,
      retries,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
