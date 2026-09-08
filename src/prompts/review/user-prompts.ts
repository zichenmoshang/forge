/**
 * 评审 Agent - 用户提示词模板
 */

import type { FrontendDesignDoc } from '../../types/frontend-design';
import type { ReviewIssue } from '../../types/review-and-delivery';
import type { IssueResponse } from '../../types/review-dialog';
import type { CodingPhaseResult } from '../../types/coding-task';

/** 方案评审用户提示词变量 */
export interface DesignReviewPromptVars {
  design: FrontendDesignDoc;
  /** 当前轮次（默认 1） */
  round?: number;
  /** 上一轮遗留问题（round>=2 时注入） */
  previousIssues?: ReviewIssue[];
  /** 修改方逐项回应（round>=2 时注入） */
  issueResponses?: IssueResponse[];
}

function renderIssueBrief(issues: ReviewIssue[]): string {
  if (issues.length === 0) return '（无）';
  return issues
    .map(
      (i) =>
        `- ${i.issueId}[${i.severity}${i.blocking ? '/blocking' : ''}/${i.category}] ${i.description}` +
        `（状态 ${i.status}；建议：${i.suggestion}）`,
    )
    .join('\n');
}

function renderIssueResponses(responses: IssueResponse[]): string {
  if (responses.length === 0) return '（无）';
  return responses
    .map((r) => `- ${r.issueId}: ${r.action}${r.explanation ? `（${r.explanation}）` : ''}`)
    .join('\n');
}

/** 渲染方案评审用户提示词 */
export function renderDesignReviewUserPrompt(vars: DesignReviewPromptVars): string {
  const d = vars.design;
  const round = vars.round ?? 1;
  const previousIssues = vars.previousIssues ?? [];
  const issueResponses = vars.issueResponses ?? [];
  const isDialogRound = round >= 2;

  const pages = d.pages
    .map(
      (p) =>
        `- ${p.id} ${p.name}（${p.route}）故事 ${p.relatedStoryIds.join(',')}，组件 ${p.componentIds.join(',')}`,
    )
    .join('\n');

  const components = d.componentTree
    .map(
      (c) =>
        `- ${c.id} ${c.name}[${c.type}/${c.reuseStatus}] 故事 ${c.relatedStoryIds.join(',')} AC ${c.relatedAcIds.join(',')}`,
    )
    .join('\n');

  const apis = d.apiContracts
    .map(
      (a) =>
        `- ${a.id} ${a.method} ${a.path} [${a.source}] 关联故事 ${a.relatedStoryIds.join(',')}`,
    )
    .join('\n');

  const exceptions = d.exceptionScenarios
    .map((e) => `- [${e.type}] ${e.id}: ${e.trigger}`)
    .join('\n');
  const nfrs = d.nfrSolutions.map((n) => `- ${n.nfrId}[${n.category}]: ${n.solution}`).join('\n');

  const dialogBlock = isDialogRound
    ? `
## 多轮评审（第 ${round} 轮）
### 上一轮遗留问题（必须逐项核对，不得遗漏）
${renderIssueBrief(previousIssues)}

### 修改方逐项回应
${renderIssueResponses(issueResponses)}

你必须对上一轮每个仍 open 的问题，在对应 issue 上输出 verification：
- result=resolved（已修复并核实）/ not-resolved（未修复，保持 open 继续阻塞）/ accepted-wont-fix（认可不修复理由，闭环）/ rejected-wont-fix（不认可，保持 open）
- verification.round 必须等于 ${round}
- 修复后新发现的问题用新的 issueId 提出。遗漏上一轮问题的验证将被系统判为无效输出。
`
    : '';

  return `请评审以下前端技术方案（版本 ${d.version}），当前第 ${round} 轮评审。

## 页面
${pages || '（无）'}

## 组件树
${components || '（无）'}

## API 契约
${apis || '（无）'}

## 异常场景
${exceptions || '（无）'}

## 非功能落地方案
${nfrs || '（无）'}
${dialogBlock}
## 系统计算的覆盖度（重点核对）
- 故事覆盖 ${d.coverageCheck.storyCoverage.coveredStories}/${d.coverageCheck.storyCoverage.totalStories}，未覆盖 ${d.coverageCheck.storyCoverage.uncoveredStoryIds.join(',') || '无'}
- AC 覆盖 ${d.coverageCheck.acCoverage.coveredACs}/${d.coverageCheck.acCoverage.totalACs}，未覆盖 ${d.coverageCheck.acCoverage.uncoveredAcIds.join(',') || '无'}
- 异常基础项 ${d.coverageCheck.exceptionCoverage.checklist.map((c) => `${c.item}:${c.covered ? '有' : '缺'}`).join('，')}
- 待人工确认 API：${d.apiConfirmation.pendingApiIds.join(',') || '无'}

请输出严格 JSON：
{
  "conclusion": "pass|reject|pass-with-comments",
  "summary": "总体评价",
  "issues": [{
    "issueId": "I1",
    "severity": "blocker|critical|major|minor|suggestion",
    "category": "coverage|exception|api-consistency|architecture|state-management|nfr|design-fidelity|other",
    "description": "",
    "location": { "target": "组件ID/章节", "detail": "" },
    "suggestion": "",
    "relatedStoryIds": [],
    "status": "open|resolved|wont-fix",
    "blocking": false${
      isDialogRound
        ? `,
    "verification": { "round": ${round}, "result": "resolved|not-resolved|accepted-wont-fix|rejected-wont-fix", "note": "" }`
        : ''
    }
  }],
  "checklist": {
    "coverage": { "passed": true, "storyCoverage": { "total": 0, "covered": 0, "uncovered": [] }, "acCoverage": { "total": 0, "covered": 0, "uncovered": [] } },
    "exceptionCompleteness": { "passed": true, "checklist": [], "missingScenarios": [] },
    "apiConsistency": { "passed": true, "issues": [] },
    "architecture": { "passed": true, "issues": [] },
    "stateManagement": { "passed": true, "issues": [] },
    "nfrCoverage": { "passed": true, "missingNfrIds": [] },
    "componentReuse": { "passed": true, "missedReuseOpportunities": [] }
  }
}

注意：checklist 各维度按实际情况判定，overallPassed 与最终是否通过由系统根据 blocking 问题计算，你不需要输出。是否存在 blocking 问题比 conclusion 字段更重要。`;
}

/** 代码 CR 用户提示词变量 */
export interface CodeReviewPromptVars {
  design: FrontendDesignDoc;
  /** 编码阶段聚合产物（CR 只针对 success/partial 故事） */
  coding: CodingPhaseResult;
  round?: number;
  previousIssues?: ReviewIssue[];
  issueResponses?: IssueResponse[];
}

function renderCodeFiles(coding: CodingPhaseResult): string {
  const reviewable = coding.results.filter((r) => r.status !== 'failed');
  if (reviewable.length === 0) return '（无可审查的代码）';
  return reviewable
    .map((r) => {
      const files = r.files
        .map((f) => {
          const content = f.content
            ? `\n\`\`\`\n${f.content}\n\`\`\``
            : '\n（无内容，v1 内存模式应含 content）';
          return `### ${f.path} [${f.type}/${f.operation}]${f.relatedAcIds?.length ? ` AC ${f.relatedAcIds.join(',')}` : ''}${content}`;
        })
        .join('\n');
      return `## 故事 ${r.storyId}（状态 ${r.status}，测试 ${r.testResult.passedTests}/${r.testResult.totalTests} 通过）\n${files}`;
    })
    .join('\n\n');
}

/** 渲染代码 CR 用户提示词 */
export function renderCodeReviewUserPrompt(vars: CodeReviewPromptVars): string {
  const { design, coding } = vars;
  const round = vars.round ?? 1;
  const previousIssues = vars.previousIssues ?? [];
  const issueResponses = vars.issueResponses ?? [];
  const isDialogRound = round >= 2;

  const failedStories = coding.failedStories.map((f) => `- ${f.storyId}: ${f.reason}`).join('\n');

  const dialogBlock = isDialogRound
    ? `
## 多轮 CR（第 ${round} 轮）
### 上一轮遗留问题（必须逐项核对，不得遗漏）
${renderIssueBrief(previousIssues)}

### Coder 逐项回应
${renderIssueResponses(issueResponses)}

你必须对上一轮每个仍 open 的问题，在对应 issue 上输出 verification：
- result=resolved（已修复并核实）/ not-resolved（未修复，保持 open 继续阻塞）/ accepted-wont-fix（认可不修复理由，闭环）/ rejected-wont-fix（不认可，保持 open）
- verification.round 必须等于 ${round}
- 修复后新发现的问题用新的 issueId 提出。遗漏上一轮问题的验证将被系统判为无效输出。
`
    : '';

  return `请对以下前端代码做 CR（第 ${round} 轮），编码阶段整体状态：${coding.overallStatus}，成功 ${coding.successStoryIds.length}/部分 ${coding.partialStoryIds.length}/失败 ${coding.failedStories.length}。

## 技术方案（简要，用于核对一致性）
- 组件：${design.componentTree.map((c) => `${c.id}(${c.name})`).join('、') || '无'}
- API：${design.apiContracts.map((a) => `${a.method} ${a.path}`).join('、') || '无'}
- 全局状态：${design.stateManagement.globalStores.map((s) => s.name).join('、') || '无'}

## 待审查代码（仅 success/partial 故事）
${renderCodeFiles(coding)}

${failedStories ? `## 失败故事（不参与 CR，交付时列为 incomplete）\n${failedStories}\n` : ''}
${dialogBlock}
请输出严格 JSON：
{
  "conclusion": "pass|reject|pass-with-comments",
  "summary": "总体评价",
  "issues": [{
    "issueId": "C1",
    "severity": "blocker|critical|major|minor|suggestion",
    "category": "design-consistency|code-style|logic|exception-handling|security|maintainability|duplication|test-quality|design-fidelity|design|other",
    "description": "",
    "location": { "target": "文件路径", "detail": "行号/函数" },
    "suggestion": "",
    "relatedStoryIds": [],
    "status": "open|resolved|wont-fix",
    "blocking": false${
      isDialogRound
        ? `,
    "verification": { "round": ${round}, "result": "resolved|not-resolved|accepted-wont-fix|rejected-wont-fix", "note": "" }`
        : ''
    }
  }],
  "checklist": {
    "designConsistency": { "passed": true, "mismatches": [] },
    "codeStyle": { "passed": true, "issues": [] },
    "logic": { "passed": true, "issues": [] },
    "exceptionHandling": { "passed": true, "missingHandling": [] },
    "security": { "passed": true, "vulnerabilities": [] },
    "maintainability": { "passed": true, "issues": [] },
    "duplication": { "passed": true, "duplicatedBlocks": [] },
    "testQuality": { "passed": true, "uncoveredAcs": [] },
    "designFidelity": { "passed": true, "mismatches": [] },
    "overallPassed": true
  }
}

注意：checklist 各维度按实际情况判定，overallPassed 与最终是否通过由系统根据 blocking 问题计算。category="design" 表示方案本身有缺陷，需要人工决定是否回退方案设计。`;
}
