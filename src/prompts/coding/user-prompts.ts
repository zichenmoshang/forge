/**
 * 编码 Agent - 用户提示词
 */

import type { CodingTask, CodingResult } from '../../types/coding-task';
import type { ReviewIssue } from '../../types/review-and-delivery';

export interface CodingGreenPromptVars {
  /** red 阶段已生成的测试/mock 文件路径与 AC 映射摘要 */
  redSummary: string;
  /** 上一轮 green 测试失败信息（首轮为空） */
  lastFailures?: Array<{ testName: string; errorMessage: string; relatedAcId?: string }>;
  /** 当前是第几次 green 尝试（从 1 开始） */
  attempt: number;
}

function taskSection(task: CodingTask): string {
  return [
    `# 编码任务（故事 ${task.storyIndex + 1}/${task.totalStories}）：${task.storyTitle}`,
    `- storyId: ${task.storyId}`,
    `- 故事：作为${task.storyDescription.role}，我希望${task.storyDescription.action}，以便${task.storyDescription.benefit}`,
    `- 前置故事依赖: ${task.dependencies.length ? task.dependencies.join(', ') : '无'}`,
    '',
    '## 验收标准',
    JSON.stringify(task.acceptanceCriteria, null, 2),
    '',
    '## 需要实现的组件',
    JSON.stringify(task.components, null, 2),
    '',
    '## API 契约（mock 依据）',
    JSON.stringify(task.apiContracts, null, 2),
    '',
    '## 数据模型',
    JSON.stringify(task.dataModels, null, 2),
    '',
    '## 状态管理要求',
    JSON.stringify(task.stateManagement, null, 2),
    '',
    '## 异常场景要求',
    JSON.stringify(task.exceptionRequirements, null, 2),
    '',
    '## 技术栈',
    JSON.stringify(task.techStack, null, 2),
    '',
    '## 测试要求',
    JSON.stringify(task.testRequirements, null, 2),
  ].join('\n');
}

/** red 阶段用户提示：产出测试 + mock */
export function renderCodingRedUserPrompt(task: CodingTask): string {
  return [
    taskSection(task),
    '',
    '请输出严格 JSON，结构如下：',
    '{',
    '  "testFiles": [ { "path": string, "type": "test", "operation": "create"|"modify"|"reuse", "summary": string, "content": string, "relatedAcIds": string[] } ],',
    '  "mockFiles": [ { "path": string, "type": "mock", "operation": "create", "summary": string, "content": string } ],',
    '  "acTestMapping": { "<acId>": ["测试名1", "测试名2"] }',
    '}',
    '',
    '注意：这是 RED 阶段，不要输出业务实现文件。',
  ].join('\n');
}

/** green 阶段用户提示：产出实现 */
export function renderCodingGreenUserPrompt(task: CodingTask, vars: CodingGreenPromptVars): string {
  const lines = [
    taskSection(task),
    '',
    `## RED 阶段已生成（测试与 mock，不要重写其测试预期）`,
    vars.redSummary,
  ];
  if (vars.attempt > 1 && vars.lastFailures && vars.lastFailures.length > 0) {
    lines.push(
      '',
      `## 第 ${vars.attempt - 1} 次实现后仍失败的测试，请最小修复`,
      JSON.stringify(vars.lastFailures, null, 2),
    );
  }
  lines.push(
    '',
    '请输出严格 JSON，结构如下：',
    '{',
    '  "implFiles": [ { "path": string, "type": "component"|"store"|"type"|"api"|"util"|"config", "operation": "create"|"modify"|"reuse", "summary": string, "content": string, "componentId"?: string, "relatedAcIds"?: string[] } ],',
    '  "updatedTestFiles": [ /* 仅在确需补测试时给出，结构同 testFiles，否则为空数组 */ ],',
    '  "needsDesignFallback": false,',
    '  "fallbackReason": ""',
    '}',
  );
  return lines.join('\n');
}

/** CR 修订用户提示变量 */
export interface CodeRevisePromptVars {
  task: CodingTask;
  currentResult: CodingResult;
  previousIssues: ReviewIssue[];
  round: number;
}

/** 渲染 CR 修订用户提示 */
export function renderCodeReviseUserPrompt(vars: CodeRevisePromptVars): string {
  const { task, currentResult, previousIssues, round } = vars;
  const files = currentResult.files
    .map(
      (f) =>
        `### ${f.path} [${f.type}/${f.operation}]\n\`\`\`\n${f.content ?? '（无内容）'}\n\`\`\``,
    )
    .join('\n');
  const issues = previousIssues
    .map(
      (i) =>
        `- ${i.issueId}[${i.severity}${i.blocking ? '/blocking' : ''}/${i.category}] ${i.description}（建议：${i.suggestion}）`,
    )
    .join('\n');
  return [
    taskSection(task),
    '',
    `## 当前代码（第 ${round - 1} 轮 CR 后版本，测试 ${currentResult.testResult.passedTests}/${currentResult.testResult.totalTests} 通过）`,
    files,
    '',
    `## 上一轮 CR 提出的 open 问题（必须逐个回应，不得遗漏）`,
    issues || '（无）',
    '',
    '请输出严格 JSON，结构如下：',
    '{',
    '  "changeSummary": "本次修改说明",',
    '  "changedFiles": ["修改/新增的文件路径"],',
    '  "issueResponses": [ { "issueId": "C1", "action": "fixed|wont-fix|needs-discussion", "explanation": "说明" } ],',
    '  "updatedFiles": [ { "path": string, "type": "component"|"test"|"store"|"type"|"api"|"util"|"config"|"mock", "operation": "create"|"modify"|"reuse", "summary": string, "content": string, "componentId"?: string, "relatedAcIds"?: string[] } ],',
    '  "needsDesignFallback": false,',
    '  "fallbackReason": ""',
    '}',
  ].join('\n');
}
