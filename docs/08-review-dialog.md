# 评审阶段多轮对话机制设计

> 状态机内嵌套角色驱动对话循环的技术方案
> 创建时间：2026-09-04
> 适用阶段：阶段4（技术方案评审）、阶段6（代码 CR）

---

## 一、设计目标

在保持 Harness 状态机整体控制的前提下，在**方案评审**和**代码 CR** 两个阶段引入**多 Agent 多轮对话循环**，让 Reviewer 和 Designer/Coder 可以多轮交互，直到方案/代码通过评审或达到终止条件。

**核心原则**：外层状态机控流程，内层对话循环控质量。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Harness 状态机                         │
│                                                         │
│  ... → DESIGN_GENERATING → DESIGN_REVIEWING → API_CONFIRMATION → CODING... │
│                        │                                 │
│                        ▼                                 │
│              ┌─────────────────────┐                    │
│              │   对话循环（内嵌）    │                    │
│              │                     │                    │
│              │  round=1:           │                    │
│              │    Reviewer 评审    │                    │
│              │         │           │                    │
│              │         ▼           │                    │
│              │    verdict?         │                    │
│              │    ├─ approve → 退出 │                    │
│              │    ├─ request_human │                    │
│              │    │     → 暂停等人工│                    │
│              │    └─ request_changes│                    │
│              │         │           │                    │
│              │         ▼           │                    │
│              │    Designer 修改    │                    │
│              │         │           │                    │
│              │         ▼           │                    │
│              │    round++          │                    │
│              │    round > max?     │                    │
│              │    └─ 是 → 暂停等人工│                    │
│              └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

---

## 三、类型定义

### 3.1 对话消息

```typescript
/** 对话中的一条消息 */
export interface DialogMessage {
  /** 发送方角色 */
  role: 'reviewer' | 'designer' | 'coder' | 'system';
  /** 消息内容（自然语言） */
  content: string;
  /** 这一轮产生的结构化结果 */
  structuredOutput?: ReviewResult | DesignRevision | CodeRevision;
  /** 时间戳 */
  timestamp: string;
  /** 轮次（从1开始） */
  round: number;
}

/** Designer 根据评审意见修改后的方案 */
export interface DesignRevision {
  /** 修改说明 */
  changeSummary: string;
  /** 修改的章节/组件 */
  changedSections: string[];
  /** 针对每个 issue 的回应 */
  issueResponses: Array<{
    issueId: string;
    action: 'fixed' | 'wont-fix' | 'needs-discussion';
    explanation: string;
  }>;
  /** 修改后的完整方案（v1 全量替换，v2 增量） */
  updatedDesign: FrontendDesign;
}

/** Coder 根据 CR 意见修改后的代码 */
export interface CodeRevision {
  /** 修改说明 */
  changeSummary: string;
  /** 修改的文件 */
  changedFiles: string[];
  /** 针对每个 issue 的回应 */
  issueResponses: Array<{
    issueId: string;
    action: 'fixed' | 'wont-fix' | 'needs-discussion';
    explanation: string;
  }>;
  /** 测试是否通过 */
  testsPassed: boolean;
}
```

### 3.2 评审轮次记录

```typescript
/** 一轮评审的完整记录 */
export interface ReviewRound {
  /** 轮次（从1开始） */
  round: number;
  /** Reviewer 的评审结果 */
  review: ReviewResult;
  /** Designer/Coder 的修改（如果有） */
  revision?: DesignRevision | CodeRevision;
  /** 这轮的对话消息 */
  messages: DialogMessage[];
  /** 这轮是否解决了所有 blocking 问题 */
  allBlockingResolved: boolean;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 多轮评审的完整历史 */
export interface ReviewDialogHistory {
  /** 评审类型 */
  reviewType: 'design-review' | 'code-review';
  /** 最大轮次 */
  maxRounds: number;
  /** 实际执行的轮次 */
  rounds: ReviewRound[];
  /** 最终结论 */
  finalVerdict: 'approved' | 'needs_human' | 'max_rounds_reached';
  /** 最终通过的方案/代码版本 */
  finalVersion: number;
  /** 总耗时（毫秒） */
  totalDurationMs: number;
}
```

### 3.3 Agent 对话上下文

```typescript
/** 对话模式下的 Agent 上下文 */
export interface AgentDialogContext {
  /** 实例 ID */
  instanceId: string;
  /** 阶段 */
  stage: string;
  /** 当前角色 */
  role: 'reviewer' | 'designer' | 'coder';
  /** 当前轮次 */
  round: number;
  /** 最大轮次 */
  maxRounds: number;
  /** 对话历史（所有轮次的消息） */
  dialogHistory: DialogMessage[];
  /** 当前待评审的产物（方案/代码） */
  targetArtifact: unknown;
  /** 知识库检索结果 */
  knowledge: KnowledgeItem[];
}

/** 对话模式下的 Agent 输出 */
export interface AgentDialogOutput {
  /** 对话动作：决定下一步 */
  dialogAction: 'approve' | 'request_changes' | 'request_human';
  /** 自然语言回复（加入对话历史） */
  reply: string;
  /** 结构化输出（评审结果 / 修改结果） */
  structuredOutput?: ReviewResult | DesignRevision | CodeRevision;
}
```

---

## 四、Agent 层设计

### 4.1 BaseAgent 扩展

> ⚠️ **实现偏差（以代码为准）**：最终没有新增并行的 `executeDialog()`/`AgentDialogContext` 抽象，而是抽出泛型执行器 `runAgentCycle`，由 execute 与独立的 revise 方法共用；同一评审任务的多轮靠输入参数化（round/previousIssues/issueResponses）。原因与对照见[第十章实施顺序](#十实施顺序)末尾。下面的 executeDialog 草案保留作为设计推演记录。

在现有 `execute()` 方法之外，增加 `executeDialog()` 方法：

```typescript
abstract class BaseAgent<TInput, TOutput> {
  // 现有：单次执行
  async execute(context: AgentContext): Promise<AgentResult<TOutput>> { ... }

  // 新增：对话模式执行
  async executeDialog(context: AgentDialogContext): Promise<AgentDialogOutput> {
    // 1. validateDialogInput(context)
    // 2. buildDialogSystemPrompt(context)
    // 3. buildDialogUserPrompt(context)  — 包含对话历史 + 当前产物
    // 4. callLLM
    // 5. parseDialogOutput(content)
    // 6. validateDialogOutput(output)
    // 7. 返回 AgentDialogOutput
  }

  // 子类需要实现的对话模式方法
  protected abstract buildDialogSystemPrompt(context: AgentDialogContext): string;
  protected abstract buildDialogUserPrompt(context: AgentDialogContext): string;
  protected abstract parseDialogOutput(content: string): AgentDialogOutput;
  protected validateDialogInput(context: AgentDialogContext): void {}
  protected validateDialogOutput(output: AgentDialogOutput): void {}
}
```

### 4.2 ReviewAgent（评审者）

**职责**：
- 评审当前方案/代码，输出结构化评审意见
- 判断是否通过（verdict）
- 可以请求人工介入（复杂/争议问题）

**对话模式行为**：
- 第 1 轮接收当前产物；第 2 轮起接收当前产物 + 上一轮 issue 列表（**不含上一轮自然语言评论**，减少自我锚定，ADR-014）+ 修改方的 issueResponses
- 输出 `dialogAction: 'approve' | 'request_changes' | 'request_human'`
- 第 2 轮起必须对上一轮每个 open 问题逐项给出 `verification`（问题跟踪闭环，见 4.5）
- `request_human`：问题复杂/有争议，需要人工决策

**通过标准（ADR-014 统一，由 `src/core/review-policy.ts` 程序化执行，不信任 LLM 自述）**：
1. `normalizeIssues`：severity 为 blocker/critical 的 issue 强制 `blocking=true`（LLM 漏标时自动修正）
2. `resolveDialogAction`：最终动作 = LLM 的 dialogAction 与结构化问题综合判定
   - LLM 说 approve 但仍有 open 的 blocking issue → 降级为 request_changes
   - LLM 说 request_changes 但已无 blocking issue（只剩建议项）→ 升级为 approve
   - request_human 直接生效
3. 即：**是否通过只看"是否存在 open 的 blocking issue"**；conclusion 字段仅作自然语言总结，不参与判定

### 4.3 DesignAgent（生成者 + 评审阶段的修改者，职责拆分）

**两类任务独立建模（ADR-014）**：
- `generate`（阶段3，从 0 到 1）：消费需求/故事/Figma，内部检索知识库，输出完整方案
- `revise`（阶段4对话循环内）：根据上一轮 issue 逐项修改，输出修订版 + issueResponses

两者使用**独立的输入/输出类型和独立方法**，不在一个 execute 中按 type 做 if 分发（避免 issue #32 的多模式分发问题）。

**revise 行为**：
- 接收评审意见 + 当前方案
- 针对每个 issue 给出回应（fixed / wont-fix / needs-discussion），不得遗漏
- 输出修改后的完整方案 + 修改说明
- 对于 `wont-fix` 的 issue，必须给出理由，由下一轮 Reviewer 裁决（accepted-wont-fix / rejected-wont-fix）

### 4.4 CodingAgent（编码者，CR 阶段的修改者）

与 DesignAgent 同理，generate（阶段5 TDD 生成）与 revise（阶段6对话循环内修改）独立建模：
- 根据 CR 意见修改代码
- 修改后重跑测试，确认通过
- 输出修改后的代码 + 测试结果 + issueResponses

### 4.5 问题跟踪闭环（ADR-014）

多轮对话最大的风险是"修改方说修了、评审方没逐项核对"。为此引入结构化问题状态机：

```
第1轮 Reviewer：issue 状态 = open
       │
       ▼
修改方 revise：逐项 issueResponses（fixed / wont-fix / needs-discussion）
       │
       ▼
第2轮 Reviewer：必须对每个上轮 open issue 给出 verification
       ├─ resolved            → issue.status = resolved（闭环）
       ├─ not-resolved        → 保持 open，继续阻塞
       ├─ accepted-wont-fix   → issue.status = wont-fix（认可不修复理由，闭环）
       └─ rejected-wont-fix   → 保持 open，要求修改方重新处理
```

**程序化保证（review-policy.findUnverifiedIssues）**：
- 第 N 轮（N≥2）校验：上一轮每个 open issue 必须在本轮出现且 `verification.round === N`
- 有遗漏 → 该轮输出无效，BaseAgent 按输出校验失败重试，不允许"跳过问题"
- issue 通过 issueId 跨轮关联，ID 重复由 validateReviewConsistency 拦截

这样评审是否闭环不再依赖 LLM 自觉，而是有结构化校验兜底。

---

## 五、Harness 调度逻辑

### 5.1 REVIEW 状态的特殊处理

在 `runExecutionLoop` 中，`DESIGN_REVIEWING` 和 `CODE_REVIEWING` 状态走对话循环分支：

```typescript
private async runReviewDialog(
  state: PipelineState,
  reviewType: 'design-review' | 'code-review',
): Promise<HarnessExecutionResult> {
  const maxRounds = this.config.maxReviewRounds ?? 3;
  const history: ReviewDialogHistory = {
    reviewType,
    maxRounds,
    rounds: [],
    finalVerdict: 'needs_human',
    finalVersion: 0,
    totalDurationMs: 0,
  };

  let currentArtifact = this.getCurrentArtifact(state);
  const dialogHistory: DialogMessage[] = [];
  const startTime = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    // 1. Reviewer 评审
    const reviewCtx = this.buildDialogContext(state, 'reviewer', round, maxRounds, dialogHistory, currentArtifact);
    const reviewRaw = await this.agents.review.executeDialog(reviewCtx);
    // 1.1 统一判定规则（ADR-014）：强制 blocker/critical 为 blocking，综合 LLM 动作得出最终动作
    const reviewResult = reviewRaw;
    reviewResult.structuredOutput.issues = normalizeIssues(reviewResult.structuredOutput.issues);
    // 1.2 问题跟踪闭环校验：第 2 轮起不得遗漏上轮 open 问题（遗漏按输出校验失败处理）
    const missing = findUnverifiedIssues(previousOpenIssues, reviewResult.structuredOutput.issues, round);
    if (missing.length > 0) throw new ReviewOutputError(`遗漏问题验证: ${missing.join(', ')}`);
    const action = resolveDialogAction(reviewResult.dialogAction, reviewResult.structuredOutput.issues);
    dialogHistory.push({ role: 'reviewer', content: reviewResult.reply, structuredOutput: reviewResult.structuredOutput, round, timestamp: new Date().toISOString() });

    // 2. 检查终止条件（以程序化动作 action 为准，而非 LLM 自述）
    if (action === 'approve') {
      history.finalVerdict = 'approved';
      history.rounds.push({ round, review: reviewResult.structuredOutput as ReviewResult, messages: [...dialogHistory], allBlockingResolved: true, durationMs: Date.now() - startTime });
      break;
    }

    if (action === 'request_human') {
      history.finalVerdict = 'needs_human';
      history.rounds.push({ round, review: reviewResult.structuredOutput as ReviewResult, messages: [...dialogHistory], allBlockingResolved: false, durationMs: Date.now() - startTime });
      return this.suspendForHuman(state, history);
    }

    // 3. request_changes：Designer/Coder 走 revise 独立方法（不是 generate）
    const reviserRole = reviewType === 'design-review' ? 'designer' : 'coder';
    const reviseCtx = this.buildDialogContext(state, reviserRole, round, maxRounds, dialogHistory, currentArtifact);
    const reviseResult = reviewType === 'design-review'
      ? await this.agents.design.revise(reviseCtx)
      : await this.agents.coding.revise(reviseCtx);
    dialogHistory.push({ role: reviserRole, content: reviseResult.reply, structuredOutput: reviseResult.structuredOutput, round, timestamp: new Date().toISOString() });

    // 4. 更新当前产物（产物版本 +1，流程版本 currentVersion 不变——评审内修改不是回退）
    currentArtifact = this.extractUpdatedArtifact(reviseResult);
    this.saveArtifact(state, currentArtifact);
    previousOpenIssues = reviewResult.structuredOutput.issues.filter(i => i.status === 'open');

    // 5. 记录这一轮
    history.rounds.push({
      round,
      review: reviewResult.structuredOutput as ReviewResult,
      revision: reviseResult.structuredOutput,
      messages: [...dialogHistory],
      allBlockingResolved: false,
      durationMs: Date.now() - startTime,
    });

    // 6. 弱介入窗口（可选，默认关闭）
    if (this.config.interruptAfterEachRound) {
      const shouldContinue = await this.onWeakIntervention?.(state.currentState, `第 ${round} 轮评审完成，是否继续？`, history);
      if (shouldContinue === false) {
        history.finalVerdict = 'needs_human';
        return this.suspendForHuman(state, history);
      }
    }
  }

  // 7. 达到最大轮次仍未通过
  if (history.finalVerdict !== 'approved') {
    history.finalVerdict = 'max_rounds_reached';
    history.totalDurationMs = Date.now() - startTime;
    this.saveReviewHistory(state, history);
    return this.suspendForHuman(state, history, `已达到最大评审轮次（${maxRounds}），需要人工决策`);
  }

  // 8. 通过，保存历史，进入下一阶段
  history.totalDurationMs = Date.now() - startTime;
  history.finalVersion = currentArtifact.version;
  this.saveReviewHistory(state, history);
  return this.continueToNextState(state);
}
```

### 5.2 配置项

```typescript
interface HarnessConfig {
  // ... 现有配置

  /** 评审阶段最大对话轮次（默认 3） */
  maxReviewRounds?: number;

  /** 每轮评审后是否暂停等人工（默认 false，只在终止条件时暂停） */
  interruptAfterEachRound?: boolean;

  /** 评审通过的标准（默认：无 blocking issue） */
  reviewPassCriteria?: {
    allowPassWithComments?: boolean;  // 默认 true
    maxMajorIssues?: number;          // 默认 Infinity
  };
}
```

---

## 六、产物管理

### 6.1 评审历史保存

评审历史作为独立产物保存，不覆盖被评审的方案/代码：

```
ArtifactStore:
  - design (v1, v2, v3...)        ← 方案的每个版本
  - design-review-history (v1)     ← 评审对话历史（只增不改）
  - code (v1, v2, v3...)           ← 代码的每个版本
  - code-review-history (v1)       ← CR 对话历史
```

### 6.2 版本递增

每轮 Designer/Coder 修改后，产物版本号 +1：
- 初始方案：design v1
- 第1轮修改后：design v2
- 第2轮修改后：design v3
- ...

**CodingPhaseResult（聚合产物）版本语义（#44 明确）**：
- CodingPhaseResult 整体版本 +1（每次 CR revise 后重新聚合时递增），初始编码完成时为 1
- 各故事 CodingResult 不独立维护版本，以聚合产物版本为准
- 聚合时 allFiles 按路径去重，同文件被多故事修改时保留最后版本，不做文件级版本冲突处理（v1 限制）
- ReviewDialogHistory.finalVersion 记录最终通过的 CodingPhaseResult.version

最终通过的版本记录在 `ReviewDialogHistory.finalVersion`。

### 6.3 Schema 扩展

在 `FrontendDesign` 和 `CodingPhaseResult` 中增加：

```typescript
interface FrontendDesign {
  // ... 现有字段

  /** 评审历史（多轮对话记录） */
  reviewHistory?: ReviewDialogHistory;
}

interface CodingPhaseResult {
  // ... 现有字段

  /** CR 历史（多轮对话记录） */
  reviewHistory?: ReviewDialogHistory;
}
```

---

## 七、Prompt 设计

### 7.1 Reviewer 对话 Prompt

**System Prompt**：
```
你是资深前端架构评审专家。你的任务是评审技术方案/代码，确保质量。

评审规则：
1. 严格按照评审维度检查（覆盖度、异常完整性、架构合理性等）
2. 每个问题必须标注严重程度：blocker / critical / major / minor / suggestion
   （注意：blocker/critical 会被系统强制视为 blocking，必须修复才能通过）
3. 如果问题复杂或有争议，选择 request_human
4. 第 2 轮起，必须对上一轮列出的每个 open 问题逐项给出 verification：
   resolved / not-resolved / accepted-wont-fix / rejected-wont-fix，不得遗漏

输出格式（严格 JSON）：
{
  "dialogAction": "approve" | "request_changes" | "request_human",
  "reply": "自然语言评审总结",
  "structuredOutput": {
    "conclusion": "pass" | "reject" | "pass-with-comments",
    "issues": [...],
    "summary": "..."
  }
}

通过标准（系统会程序化复核，你的 dialogAction 与问题列表矛盾时以问题列表为准）：
- 不存在 open 的 blocking 问题时才应输出 approve
```

**User Prompt（每轮）**：
```
当前轮次：第 {round} 轮 / 共 {maxRounds} 轮

【当前待评审产物】
{artifact_content}

【上一轮问题清单】（第 2 轮起，只给结构化 issue 列表，不给上轮自然语言评论，避免锚定）
{previous_issues}

【修改方逐项回应】（如果有）
{issue_responses}

请评审当前产物：第 2 轮起必须对每个上轮 open 问题给出 verification，然后输出评审结果。
```

### 7.2 Designer/Coder 对话 Prompt

**System Prompt**：
```
你是前端开发专家。根据评审意见修改方案/代码。

修改规则：
1. 针对每个 issue 必须给出回应：fixed / wont-fix / needs-discussion
2. wont-fix 必须给出理由
3. needs-discussion 的问题下一轮评审重点关注
4. 修改后输出完整的方案/代码（v1 全量）

输出格式（严格 JSON）：
{
  "dialogAction": "request_changes",
  "reply": "自然语言修改说明",
  "structuredOutput": {
    "changeSummary": "...",
    "changedSections": [...],
    "issueResponses": [...],
    "updatedDesign": {...}
  }
}
```

---

## 八、终止条件与兜底

| 条件 | 行为 |
|---|---|
| 程序化判定无 open 的 blocking issue（resolveDialogAction=approve） | 自动通过，进入下一阶段 |
| Reviewer `dialogAction === 'request_human'`（或程序化判定 request_human） | 立即暂停，等人工 |
| 第 N 轮（N≥2）遗漏上轮 open 问题的 verification | 该轮输出无效，按输出校验失败重试（问题跟踪闭环） |
| 达到 `maxReviewRounds` 仍未通过 | 暂停，等人工，附带最后一轮评审意见 |
| Designer/Coder 执行异常 | 重试 1 次，仍失败则暂停等人工 |
| Reviewer 输出解析失败 | BaseAgent 内部重试（现有机制），耗尽后暂停等人工 |
| 每轮结束后 `interruptAfterEachRound === true` | 触发弱介入回调，用户可选择继续或暂停 |

**人工恢复后的行为**：
- 人工可以直接修改方案/代码，然后 resume → 从当前轮次继续评审
- 人工可以要求回退到上一阶段
- 人工可以强制通过（跳过剩余评审）

---

## 九、与现有机制的关系

| 现有机制 | 关系 |
|---|---|
| 状态机 | REVIEW 状态内部嵌套对话循环，状态本身不变，循环结束后才转换 |
| 弱介入窗口 | 每轮后可选触发（默认关闭），终止条件时必触发 |
| 回退机制 | 人工可以在暂停时要求回退到 DESIGN_GENERATING（代码问题在对话内 revise，不回退 CODING） |
| 产物版本 | 每轮修改产物自身 version +1（单调递增）；流程版本 currentVersion 不变（评审内修改不是回退，ADR-014） |
| BaseAgent 重试 | 对话模式下，单次 LLM 调用失败仍走 BaseAgent 内部重试 |
| Harness 重试 | 对话循环不使用 Harness 层重试（每轮是独立的 Agent 调用） |

---

## 十、实施顺序

1. **统一判定规则**：~~review-policy（normalizeIssues/resolveDialogAction/findUnverifiedIssues）~~ ✅ 已完成（ADR-014）；本轮补充修改方侧闭环 `findUnansweredIssues`
2. **类型定义**：✅ 已完成（`src/types/review-dialog.ts`：DialogMessage/IssueResponse/DesignRevision/ReviewRound/ReviewDialogHistory；ArtifactStage 增 design-review-history/code-review-history）
3. **BaseAgent 扩展**：✅ 以泛型执行器 `runAgentCycle` 落地（未新增并行抽象类层级，execute 与 revise 共用同一套重试/日志骨架，避免强制所有 Agent 实现对话抽象）
4. **ReviewAgent 实现**：✅ 多轮参数化（输入带 round/previousIssues/issueResponses；round≥2 强制逐项 verification，遗漏判无效重试；支持 LLM 输出 dialogAction=request_human）
5. **DesignAgent revise 模式**：✅ 独立 public `revise()`（DesignReviseInput/DesignRevision，与 generate 分离；版本 +1、覆盖度/API 确认重算、逐项回应闭环校验）
6. **Harness 调度**：✅ `runDesignReviewDialog` 多轮循环 + DESIGN_REVIEWING 分支；history 每轮落盘、方案版本递增、暂停（pauseForHuman）/续跑（resume 从 history 恢复）、interruptAfterEachRound 弱介入、方案重生成清空下游评审
7. **产物管理**：✅ design 每轮版本递增、design-review 存最新、design-review-history 只增独立保存
8. **CodingAgent revise 模式**：⏳ 随 CodingAgent 落地（runReviewDialog 的 code-review 分支届时按同一模式接入）
9. **测试**：✅ 已完成（纯函数闭环、Agent 多轮、e2e 覆盖：自动修订通过 / 最大轮次暂停+人工放行 / request_human 暂停+续跑 / 弱介入回退后历史失效）

> 实现与本文档的两处务实偏差：①未引入并行的 executeDialog/AgentDialogContext 抽象，改为复用 runAgentCycle + 输入参数化 + 独立 revise 方法；②对话中途暂停复用"currentState 不变、status=waiting_human"（StateMachine.pauseForHuman/markRunning），未走 SUSPEND/RESUME 状态迁移。

---

## 十一、v1 范围

| 功能 | v1 | v2 |
|---|---|---|
| 多轮对话循环 | ✅ | - |
| Reviewer 结构化输出 | ✅ | - |
| Designer/Coder 修改方案/代码 | ✅ | - |
| 对话历史全量传递 | ✅ | - |
| 最大轮次限制 | ✅ | - |
| 人工介入（终止条件） | ✅ | - |
| 每轮弱介入窗口 | ✅（配置开关，默认关） | - |
| 评审历史产物保存 | ✅ | - |
| 产物版本递增 | ✅ | - |
| 问题跟踪闭环（逐项 verification + 遗漏拦截） | ✅（review-policy，ADR-014） | - |
| 统一判定（blocking 强制、动作冲突仲裁） | ✅（review-policy，ADR-014） | - |
| 对话历史摘要压缩 | ❌ | ✅ |
| Designer 增量修改（只输出 diff） | ❌ | ✅ |
| 结构化 diff 验证（自动比对修改前后产物） | ❌（v1 靠 Reviewer 逐项 verification） | ✅ |
| 多人评审（多个 Reviewer） | ❌ | ✅ |
