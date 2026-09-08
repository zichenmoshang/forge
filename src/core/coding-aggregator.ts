/**
 * 编码阶段聚合与故事排序（纯函数，issue #40 部分成功出口的判定基础）
 */

import type { UserStory } from '../types/user-story';
import type { CodingResult, CodingPhaseResult, GeneratedFile } from '../types/coding-task';

/** 拓扑排序结果 */
export interface TopoSortResult {
  /** 排序后的故事列表（环中故事按输入顺序追加在末尾） */
  sorted: UserStory[];
  /** 循环依赖中的故事 ID（空数组表示无环） */
  cyclicStoryIds: string[];
}

/**
 * 按 dependencies 拓扑排序（被依赖的故事在前）。
 * 存在循环依赖或依赖缺失时，剩余故事按输入顺序保底追加，不抛错（流程不能因排序中断）。
 * #51 修复：检测到循环依赖时返回 cyclicStoryIds，调用方应记录日志/警告，不再静默降级。
 */
export function topoSortStories(stories: UserStory[]): TopoSortResult {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const s of stories) {
    indegree.set(s.id, 0);
    dependents.set(s.id, []);
  }
  for (const s of stories) {
    for (const dep of s.dependencies) {
      // 只统计集合内存在的依赖
      if (byId.has(dep)) {
        indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1);
        dependents.get(dep)?.push(s.id);
      }
    }
  }

  // 用输入顺序作为同层稳定顺序
  const queue = stories.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const sorted: UserStory[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    visited.add(id);
    const story = byId.get(id);
    if (story) sorted.push(story);
    for (const dependentId of dependents.get(id) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, next);
      if (next <= 0) queue.push(dependentId);
    }
  }

  // 环/异常保底：未访问的按原顺序追加，并记录为循环依赖
  const cyclicStoryIds: string[] = [];
  for (const s of stories) {
    if (!visited.has(s.id)) {
      sorted.push(s);
      cyclicStoryIds.push(s.id);
    }
  }
  return { sorted, cyclicStoryIds };
}

export interface AggregateMeta {
  id: string;
  instanceId: string;
  designDocId: string;
  /** 产物版本号，默认 1；CR revise 后重新聚合时传入递增后的值 */
  version?: number;
}

/** 跨故事文件去重（同路径保留最后一次生成的版本） */
function dedupeFiles(results: CodingResult[]): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const result of results) {
    for (const file of result.files) byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/** 将各故事 CodingResult 聚合为编码阶段汇总，并程序化计算总体状态与测试统计 */
export function aggregateCodingResults(
  results: CodingResult[],
  meta: AggregateMeta,
): CodingPhaseResult {
  const successStoryIds = results.filter((r) => r.status === 'success').map((r) => r.storyId);
  const partialStoryIds = results.filter((r) => r.status === 'partial').map((r) => r.storyId);
  const failedStories = results
    .filter((r) => r.status === 'failed')
    .map((r) => ({ storyId: r.storyId, reason: (r.issues ?? []).join('; ') || '编码失败' }));

  const totalTests = results.reduce((sum, r) => sum + r.testResult.totalTests, 0);
  const passedTests = results.reduce((sum, r) => sum + r.testResult.passedTests, 0);
  const failedTests = results.reduce((sum, r) => sum + r.testResult.failedTests, 0);

  let overallStatus: CodingPhaseResult['overallStatus'];
  if (successStoryIds.length === results.length && results.length > 0) {
    overallStatus = 'all-success';
  } else if (successStoryIds.length + partialStoryIds.length === 0) {
    overallStatus = 'all-failed';
  } else {
    overallStatus = 'partial-success';
  }

  return {
    id: meta.id,
    instanceId: meta.instanceId,
    designDocId: meta.designDocId,
    version: meta.version ?? 1,
    totalStories: results.length,
    successStoryIds,
    partialStoryIds,
    failedStories,
    results,
    overallTestStats: {
      totalTests,
      passedTests,
      failedTests,
      passRate: totalTests > 0 ? Number((passedTests / totalTests).toFixed(4)) : 0,
    },
    allFiles: dedupeFiles(results),
    overallStatus,
    completedAt: new Date().toISOString(),
  };
}

/** 是否至少有一个故事成功生成、可进入代码 CR（失败故事不参与 CR） */
export function hasAnySuccessStory(phase: CodingPhaseResult): boolean {
  return phase.successStoryIds.length + phase.partialStoryIds.length > 0;
}
