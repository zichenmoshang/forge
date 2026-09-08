/**
 * 结构化日志
 *
 * 每条日志带：timestamp、level、trace_id、instance_id、stage、agent、message
 * LLM 调用的 prompt/response/token 完整记录
 * 输出：console + 文件（JSON Lines 格式）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ObservabilityConfig } from '../config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 日志上下文 */
export interface LogContext {
  traceId?: string;
  instanceId?: string;
  stage?: string;
  agent?: string;
  [key: string]: unknown;
}

/** 单条日志记录 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  data?: Record<string, unknown>;
}

/** LLM 调用记录 */
export interface LLMCallLog {
  timestamp: string;
  traceId?: string;
  instanceId?: string;
  agent?: string;
  provider: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  response: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export class Logger {
  private config: ObservabilityConfig;
  private logFilePath: string;
  private llmLogFilePath: string;

  constructor(config: ObservabilityConfig) {
    this.config = config;
    const logDir = config.logDir || './data/logs';

    // 确保日志目录存在
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // 按实例分文件：pipeline.log（流程日志）、llm-calls.log（LLM 调用详情）
    this.logFilePath = path.join(logDir, 'pipeline.log');
    this.llmLogFilePath = path.join(logDir, 'llm-calls.log');
  }

  /** 判断是否应该输出该级别日志 */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.logLevel || 'info'];
  }

  /** 写日志到文件和console */
  private write(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    const line = JSON.stringify(entry);

    // 写文件
    try {
      fs.appendFileSync(this.logFilePath, line + '\n', 'utf-8');
    } catch (err) {
      // 文件写入失败时降级到 console，不静默丢失
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Logger] 日志文件写入失败: ${errMsg}，降级到 console 输出`);
    }

    // console 输出
    const prefix = `[${entry.level.toUpperCase()}]`;
    const ctx = entry.context.instanceId ? `[${entry.context.instanceId}]` : '';
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    const output = `${prefix}${ctx} ${entry.message}${dataStr}`;

    if (entry.level === 'error') {
      console.error(output);
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  debug(message: string, context: LogContext = {}, data?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      context,
      data,
    });
  }

  info(message: string, context: LogContext = {}, data?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      context,
      data,
    });
  }

  warn(message: string, context: LogContext = {}, data?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      context,
      data,
    });
  }

  error(message: string, context: LogContext = {}, data?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      context,
      data,
    });
  }

  /**
   * 记录 LLM 调用（独立文件，完整保存 prompt/response）
   */
  logLLMCall(call: LLMCallLog): void {
    if (!this.config.logLLMRequests) return;

    const line = JSON.stringify(call);
    try {
      fs.appendFileSync(this.llmLogFilePath, line + '\n', 'utf-8');
    } catch (err) {
      // LLM 日志写入失败时降级到 console，不静默丢失
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Logger] LLM 调用日志写入失败: ${errMsg}，降级到 console 输出`);
      console.warn(
        `[LLM Call] ${call.provider}/${call.model} ${call.totalTokens}tokens ${call.durationMs}ms ${call.success ? '成功' : '失败'}`,
      );
    }

    // 同时在主日志里记一条摘要
    this.info(
      `LLM调用: ${call.provider}/${call.model} ${call.totalTokens}tokens ${call.durationMs}ms ${call.success ? '成功' : '失败'}`,
      {
        traceId: call.traceId,
        instanceId: call.instanceId,
        agent: call.agent,
      },
      {
        model: call.model,
        totalTokens: call.totalTokens,
        durationMs: call.durationMs,
        success: call.success,
      },
    );
  }
}
