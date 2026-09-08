/**
 * 编码工具层（可替换执行环境）
 *
 * 设计：CodingAgent 只依赖 {@link Workspace} / {@link TestRunner} 抽象，
 * v1 提供内存工作区 + 静态推断 runner（不真实起子进程，符合"测试到 mock 级、保证基本逻辑"），
 * 后续可替换为真实落盘工作区 + 子进程 vitest runner（LocalSubprocessTestRunner，v2），
 * 编排逻辑（TDD 红绿循环、逐故事、出口判定）无需改动。
 */

import type { TestResult } from '../types/coding-task';

/** 工作区内的一个文件 */
export interface WorkspaceFile {
  /** 相对工作区根的 POSIX 风格路径 */
  path: string;
  content: string;
}

/**
 * 文件工作区：隔离 CodingAgent 生成的文件，避免未验证代码直接写入真实项目。
 *
 * v1 为内存实现；真实落盘实现需保证同样的读写/列举/清空语义。
 */
export interface Workspace {
  /** 写入（覆盖）单个文件 */
  writeFile(path: string, content: string): void;
  /** 批量写入 */
  writeFiles(files: WorkspaceFile[]): void;
  /** 读取文件，不存在返回 undefined */
  readFile(path: string): string | undefined;
  /** 文件是否存在 */
  exists(path: string): boolean;
  /** 列出全部文件路径（排序，便于测试断言） */
  listFiles(): string[];
  /** 清空工作区 */
  clear(): void;
}

/** TestRunner 运行选项 */
export interface TestRunOptions {
  /** TDD 阶段：red 期望测试失败（实现尚缺），green 期望通过 */
  phase: 'red' | 'green';
  /** 本故事需要被测试覆盖的 AC ID（静态 runner 据此判断覆盖是否齐备） */
  expectedAcIds?: string[];
}

/**
 * 测试执行器抽象。
 *
 * - static：v1 默认，依据工作区文件齐备性推断结果（诚实标注未真实执行）；
 * - scriptable：测试用，按预置脚本返回结果；
 * - subprocess（v2）：在真实/临时项目内执行测试命令并解析输出。
 */
export interface TestRunner {
  /** 实现种类标识，写入 TestResult.outputSummary 以便区分能力边界 */
  readonly kind: 'static' | 'scriptable' | 'subprocess';
  run(workspace: Workspace, options: TestRunOptions): Promise<TestResult>;
}
