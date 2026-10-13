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
            {
              instanceId: context.instanceId,
              traceId: context.traceId,
              stage: context.stage,
              agent: this.name,
            },
          );
          await this.sleep(this.config.retryBaseDelayMs * attempt);
        }

        // 预算控制（issue #39）：调用前检查累计是否超限，超限直接失败不再发起调用
        const budget = context.tokenBudget;
        if (budget?.isExceeded()) {
          this.logger?.error(
            `[${this.name}] Token 预算已超限（${budget.usedTokens}/${budget.limitTokens}），停止本次调用`,
            {
              instanceId: context.instanceId,
              traceId: context.traceId,
              stage: context.stage,
              agent: this.name,
            },
          );
          return this.buildFailure<TO>(
            [
              {
                code: 'BUDGET_EXCEEDED',
                message: `单流程 token 预算已超限（${budget.usedTokens}/${budget.limitTokens}），需人工调整预算或降级后重试`,
                severity: 'error',
              },
            ],
            startTime,
            llmCalls,
            retries,
          );
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

        // Metrics：记录本次调用指标（终态聚合 run-summary，#87 性能基准数据源）
        context.metrics?.recordCall({
          stage: context.stage,
          agent: this.name,
          model: response.model,
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          totalTokens: response.totalTokens,
          durationMs: response.durationMs,
          success: true,
          finishReason: response.finishReason,
        });

        // 预算控制：调用后累计本次 token；单次调用超限按失败处理（防异常膨胀）
        if (budget) {
          const perCall = budget.checkPerCall(response.totalTokens);
          if (!perCall.ok) {
            this.logger?.error(
              `[${this.name}] 单次调用超限: ${perCall.reason}`,
              {
                instanceId: context.instanceId,
                traceId: context.traceId,
                stage: context.stage,
                agent: this.name,
              },
            );
            return this.buildFailure<TO>(
              [
                {
                  code: 'CALL_LIMIT_EXCEEDED',
                  message: perCall.reason ?? '单次调用 token 超过上限',
                  severity: 'error',
                },
              ],
              startTime,
              llmCalls,
              retries,
            );
          }
          const acc = budget.add(response.totalTokens);
          if (acc.exceeded) {
            this.logger?.warn(
              `[${this.name}] 本次调用后累计 token ${acc.used}/${acc.limit}，已触及预算上限`,
              {
                instanceId: context.instanceId,
                traceId: context.traceId,
                stage: context.stage,
                agent: this.name,
              },
            );
          }
        }

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
          // 原始输出片段一并落日志：LLM 输出格式漂移时可直接定位（完整原文在 llm-calls.log，按 traceId 关联）
          this.logger?.warn(
            `[${this.name}] 输出解析失败，原始输出片段见 data 字段（完整原文查 llm-calls.log，traceId=${context.traceId ?? '无'}）`,
            {
              instanceId: context.instanceId,
              traceId: context.traceId,
              stage: context.stage,
              agent: this.name,
            },
            {
              parseErrorMessage: err instanceof Error ? err.message : String(err),
              rawLength: response.content.length,
              rawContentHead: response.content.slice(0, 2000),
            },
          );
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
          {
            instanceId: context.instanceId,
            traceId: context.traceId,
            stage: context.stage,
            agent: this.name,
          },
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
        {
          instanceId: context.instanceId,
          traceId: context.traceId,
          stage: context.stage,
          agent: this.name,
        },
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
        traceId: context.traceId,
        stage: context.stage,
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

  /**
   * 解析 JSON，失败时尝试恢复（处理 LLM 输出被截断、尾部不完整等问题）。
   *
   * 恢复策略：
   * 1. 直接解析
   * 2. 失败时，找到最后一个完整的结构边界，截断不完整尾部并补全闭合括号
   * 3. 仍失败时，删除尾部多余逗号后重试
   *
   * @param jsonStr 提取后的 JSON 字符串
   * @returns 解析后的对象
   * @throws 恢复失败时抛出原始解析错误
   */
  protected parseJsonWithRecovery<T = unknown>(jsonStr: string): T {
    // 1. 直接解析
    try {
      return JSON.parse(jsonStr) as T;
    } catch (firstError) {
      // 2. 尝试恢复：截断不完整的尾部并补全闭合括号
      const recovered = this.recoverTruncatedJson(jsonStr);
      if (recovered !== jsonStr) {
        try {
          return JSON.parse(recovered) as T;
        } catch {
          // 继续尝试其他恢复策略
        }
      }

      // 3. 尝试删除尾部多余逗号
      const trimmed = this.removeTrailingCommas(jsonStr);
      if (trimmed !== jsonStr) {
        try {
          return JSON.parse(trimmed) as T;
        } catch {
          // 继续
        }
      }

      // 4. 对恢复后的字符串再尝试删除尾部逗号
      if (recovered !== jsonStr) {
        const recoveredTrimmed = this.removeTrailingCommas(recovered);
        try {
          return JSON.parse(recoveredTrimmed) as T;
        } catch {
          // 全部失败，抛出原始错误
        }
      }

      throw firstError;
    }
  }

  /**
   * 恢复被截断的 JSON：找到最后一个完整的结构边界，截断不完整尾部并补全闭合括号。
   */
  private recoverTruncatedJson(jsonStr: string): string {
    // 从后往前扫描，跟踪括号深度，找到最后一个完整的对象/数组结束位置
    let depth = 0;
    let lastCompletePos = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          lastCompletePos = i;
        }
      }
    }

    // 如果没有找到完整的顶层结构（depth > 0 说明被截断）
    if (depth > 0 && lastCompletePos === -1) {
      // 尝试找到最后一个完整的元素边界（逗号后）
      const lastComma = jsonStr.lastIndexOf(',');
      if (lastComma > 0) {
        let truncated = jsonStr.slice(0, lastComma);
        // 补全缺失的闭合括号
        truncated = this.closeOpenBrackets(truncated);
        return truncated;
      }
      return jsonStr;
    }

    // 如果有完整的顶层结构，但后面还有不完整的内容
    if (lastCompletePos > 0 && lastCompletePos < jsonStr.length - 1) {
      return jsonStr.slice(0, lastCompletePos + 1);
    }

    // 如果 depth > 0（被截断在中间），找到最后一个完整元素并截断
    if (depth > 0) {
      const lastComma = jsonStr.lastIndexOf(',');
      if (lastComma > 0) {
        let truncated = jsonStr.slice(0, lastComma);
        truncated = this.closeOpenBrackets(truncated);
        return truncated;
      }
    }

    return jsonStr;
  }

  /**
   * 补全字符串中未闭合的括号（从内到外）。
   */
  private closeOpenBrackets(str: string): string {
    const openBrackets: string[] = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        openBrackets.push(ch);
      } else if (ch === '}' || ch === ']') {
        openBrackets.pop();
      }
    }

    // 从内到外补全闭合括号
    let result = str;
    for (let i = openBrackets.length - 1; i >= 0; i--) {
      result += openBrackets[i] === '{' ? '}' : ']';
    }
    return result;
  }

  /**
   * 删除数组/对象尾部多余的逗号（如 `[1, 2, ]` → `[1, 2]`）。
   */
  private removeTrailingCommas(jsonStr: string): string {
    // 匹配 , 后面紧跟 ] 或 } 的情况（可能有空白）
    return jsonStr.replace(/,\s*([\]}])/g, '$1');
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
