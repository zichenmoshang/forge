/**
 * 编码质量门纯函数（不信任 LLM 自报，规范 1.14）
 *
 * - 每个可测试 AC 必须被至少一个测试显式覆盖（来自 LLM 的 acTestMapping）；
 * - 单故事最终状态由"测试是否通过 + AC 是否全覆盖 + 是否耗尽修复次数"程序化推导。
 */

import type { CodingTask, GeneratedFile } from '../types/coding-task';

/** 找出没有任何测试覆盖的可测试 AC ID */
export function findMissingTestedAcs(task: CodingTask, coveredAcIds: Iterable<string>): string[] {
  const covered = new Set(coveredAcIds);
  return task.acceptanceCriteria
    .filter((ac) => ac.testable)
    .map((ac) => ac.id)
    .filter((id) => !covered.has(id));
}

/**
 * 从 LLM 输出的 ac→测试 映射中提取被覆盖的 AC（值非空才算覆盖）。
 */
export function coveredAcsFromMapping(acTestMapping: Record<string, string[]>): string[] {
  return Object.entries(acTestMapping)
    .filter(([, tests]) => Array.isArray(tests) && tests.length > 0)
    .map(([acId]) => acId);
}

/** 跨 red/green 产出按路径合并文件（同路径以后者覆盖） */
export function mergeGeneratedFiles(...groups: GeneratedFile[][]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const group of groups) {
    for (const file of group) byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export interface DeriveStatusInput {
  /** 最终一轮 green 测试是否通过 */
  greenPassed: boolean;
  /** 缺少测试覆盖的 AC */
  missingAcIds: string[];
  /** 是否因达到修复上限而停止（而非主动通过） */
  attemptsExhausted: boolean;
}

/**
 * 推导单故事编码状态：
 * - 测试未通过（含修复上限耗尽）→ failed
 * - 测试通过但有可测试 AC 缺测试 → partial（基本逻辑可运行，覆盖不全）
 * - 测试通过且 AC 全覆盖 → success
 */
export function deriveStoryStatus(input: DeriveStatusInput): 'success' | 'partial' | 'failed' {
  if (!input.greenPassed) return 'failed';
  return input.missingAcIds.length > 0 ? 'partial' : 'success';
}
