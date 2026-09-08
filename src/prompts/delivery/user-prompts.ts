/**
 * 交付 Agent - 用户提示词
 *
 * 职责：根据交付上下文生成 PR 描述的输入提示
 */

/** 交付用户提示词变量 */
export interface DeliveryPromptVars {
  /** 需求标题 */
  requirementTitle: string;
  /** 交付场景 */
  scenario: string;
  /** 实例 ID */
  instanceId: string;
  /** 完成的用户故事摘要（Markdown 列表） */
  storySummaries: string;
  /** 变更文件摘要（Markdown 列表） */
  fileSummaries: string;
  /** 构建验证状态 */
  buildStatus: string;
  /** 代码评审摘要 */
  crSummary: string;
  /** 评审问题列表（Markdown 列表） */
  crIssues: string;
  /** 已知问题列表（Markdown 列表） */
  knownIssues: string;
}

/** 渲染交付用户提示词 */
export function renderDeliveryUserPrompt(vars: DeliveryPromptVars): string {
  return `请根据以下信息生成 PR 描述：

## 需求标题
${vars.requirementTitle}

## 完成的用户故事
${vars.storySummaries}

## 变更文件
${vars.fileSummaries}

## 构建验证
${vars.buildStatus}

## 代码评审摘要
${vars.crSummary}

### 评审问题
${vars.crIssues}

## 已知问题
${vars.knownIssues}

## 交付场景
${vars.scenario}

## 实例 ID
${vars.instanceId}

请生成完整的 PR 描述（Markdown 格式）。`;
}
