# 全局状态机

Harness 的核心是一个显式状态机。每个状态定义：进入条件、执行动作、退出条件、异常处理、回退目标。

## 设计原则

1. **每个状态有明确执行动作**：要么调用 Agent，要么是硬卡点等人工输入。没有"纯标记"状态。
2. **硬卡点 vs 弱介入分离**：状态机只体现硬卡点（必须人工输入才能继续）。弱介入的确认窗口由 Harness 调度层实现，不占独立状态。
3. **回退后重新走确认**：回退到某状态后，该状态之后的所有确认/评审环节必须重新执行。
4. **SUSPENDED 可恢复**：记录挂起前状态，恢复后回到该状态重新执行。
5. **SUSPENDED 语义收敛（ADR-014）**：SUSPENDED 只用于运行时原因（外部依赖不可用、评审达最大轮次等需人工决策）；"Agent 未实现"属于开发期错误，直接 FAILED 不再挂起；硬卡点等待用 `status=waiting_human` 表达，不进入 SUSPENDED。
6. **先评审后确认 API（ADR-014）**：API_CONFIRMATION 位于 DESIGN_REVIEWING 之后，人工确认的是经过 AI 评审的稳定契约。

## 状态列表

| 状态 | 类型 | 说明 | 执行动作 |
|---|---|---|---|
| `INIT` | 瞬时 | 初始状态 | 接收 PRD，创建流程实例 |
| `REQUIREMENT_PARSING` | Agent执行 | 解析 PRD | 调用需求分析 Agent 解析 PRD |
| `REQUIREMENT_CLARIFICATION` | 硬卡点 | 需求澄清 | 生成澄清问题 → 挂起等人工回答 → 多轮循环 → 澄清充分后执行冻结动作 → 退出 |
| `STORIES_GENERATING` | Agent执行 | 生成用户故事 | 调用需求分析 Agent 拆故事 + AC，自检 INVEST |
| `DESIGN_GENERATING` | Agent执行 | 生成技术方案 | 调用方案设计 Agent：技术栈→Figma→组件→API契约→异常补齐（Agent 内部检索知识库） |
| `DESIGN_REVIEWING` | Agent执行 | 方案评审（多轮对话） | 调用评审 Agent 与 Designer 多轮对话评审 |
| `API_CONFIRMATION` | 硬卡点 | API 契约确认 | 评审通过后，挂起等人工确认/修改 API 契约 |
| `CODING` | Agent执行 | TDD 编码 | 调用编码 Agent，按故事逐条 TDD 循环 |
| `CODE_REVIEWING` | Agent执行 | 代码 CR（多轮对话） | 调用评审 Agent 与 Coder 多轮对话做 CR + 测试有效性 + 设计还原度 |
| `DELIVERING` | Agent执行 | PR 交付 | 调用交付 Agent：创建分支→代码落地→构建验证→创建 PR |
| `DELIVERY_CONFIRMATION` | 硬卡点 | 最终交付确认 | 挂起等人工确认交付物，确认后完成 |
| `COMPLETED` | 终态 | 完成 | 记录最终状态，通知用户 |
| `FAILED` | 终态 | 失败 | 兜底后仍失败（含 Agent 未实现等开发期错误），记录错误，通知人工 |
| `CANCELLED` | 终态 | 人工取消 | 人工主动终止，不可恢复，产物保留备查（ADR-014 新增） |
| `SUSPENDED` | 挂起 | 外部依赖不可用/评审达最大轮次等运行时原因 | 保留状态，等待恢复 |

**状态数：15个**（ADR-014：新增 CANCELLED；API_CONFIRMATION 顺序调整到 DESIGN_REVIEWING 之后）

## 弱介入确认窗口（Harness 调度层，非状态）

以下节点 Agent 执行完成后，Harness 设置 30 秒确认窗口：

| 节点 | 窗口内人工可做什么 | 超时行为 |
|---|---|---|
| STORIES_GENERATING 完成 | 介入修改故事、要求重新生成 | 自动进入 DESIGN_GENERATING |
| DESIGN_REVIEWING 通过 | 要求回退修改方案、追加评审意见 | 自动进入 API_CONFIRMATION |
| CODE_REVIEWING 通过 | 要求回退修改代码、追加 CR 意见 | 自动进入 DELIVERING |
| CODING 部分故事失败 | 决定继续 CR / 回退 / 暂停排查 | 不自动推进（必须人工决策，ADR-014） |

窗口内人工介入 → 流程进入 SUSPENDED（waitingFor 记录介入原因），人工处理完后恢复执行。

## 状态流转图

### 正常路径

```
INIT
  ↓
REQUIREMENT_PARSING
  ↓ 解析成功
REQUIREMENT_CLARIFICATION ←──┐
  ↓ 澄清充分（含冻结动作）     │ 发现新问题，重新澄清
STORIES_GENERATING ──────────┘ 回退：需求不清
  ↓ 生成通过（弱介入窗口，超时自动进）
DESIGN_GENERATING ←──────────┐
  ↓ 方案生成完成              │
DESIGN_REVIEWING ────────────┘ 回退：评审不通过（方案性问题）
  ↓ 评审通过（多轮对话，弱介入窗口）
API_CONFIRMATION             │ 确认时发现方案缺陷 → 回退 DESIGN_GENERATING
  ↓ API 人工确认通过
CODING
  ↓ 编码完成
CODE_REVIEWING
  ↓ CR 通过（多轮对话，弱介入窗口；代码问题在对话内 revise，仅方案性问题回退 DESIGN_GENERATING）
DELIVERING
  ↓ 交付成功
DELIVERY_CONFIRMATION
  ↓ 人工确认
COMPLETED
```

### 回退矩阵

| 当前状态 | 回退到 | 触发条件 | 回退后需重新走 |
|---|---|---|---|
| `STORIES_GENERATING` | `REQUIREMENT_CLARIFICATION` | 需求描述不足，无法拆出可测试的故事 | 澄清→故事→设计→评审→API确认 |
| `DESIGN_GENERATING` | `STORIES_GENERATING` | 某故事 AC 模糊/矛盾/不可实现 | 故事→设计→评审→API确认 |
| `DESIGN_REVIEWING` | `DESIGN_GENERATING` | 评审不通过，方案有缺陷（对话循环外的回退） | 设计→评审→API确认 |
| `API_CONFIRMATION` | `DESIGN_GENERATING` | 人工确认时发现 API 方案缺陷 | 设计→评审→API确认 |
| `CODING` | `DESIGN_GENERATING` | 写代码时发现方案不可行或遗漏关键场景 | 设计→评审→API确认→编码 |
| `CODE_REVIEWING` | `DESIGN_GENERATING` | 方案性问题（架构、接口、覆盖度）；代码问题在对话内 revise，不回退 CODING | 设计→评审→API确认→编码→CR |

**回退规则**：
- 回退后从目标状态重新执行，后续产物全部重新生成（v1 不做增量补丁）
- 每次回退产物版本号 +1
- 回退目标状态之后的**所有确认和评审环节必须重新执行**（不能用旧确认覆盖新产物）

### SUSPENDED 流转

```
运行状态 ──外部依赖不可用/评审达最大轮次等运行时原因──→ SUSPENDED
SUSPENDED ──人工恢复/外部条件就绪──→ suspendedFromState（挂起前的状态）
```

**SUSPENDED 语义边界（ADR-014 收敛）**：
- ✅ 属于 SUSPENDED：外部工具/依赖暂时不可用（如 Figma API 超时、代码执行环境异常）、评审对话达到最大轮次需人工决策
- ❌ 不属于 SUSPENDED：硬卡点等待（用 `status=waiting_human`，状态本身不变）；Agent 未实现（开发期错误，直接 FAILED）；人工主动终止（CANCELLED）

**SUSPENDED 恢复规则**：
- 状态数据中记录 `suspendedFromState`（挂起前的状态）
- 恢复时回到 `suspendedFromState`，重新执行该状态的动作
- 重试计数：如果挂起原因是外部问题（如 API key 失效）且人工已修复，重置该状态重试计数；否则继续累计
- 挂起期间产物和上下文保留，不清理

### 异常终态与取消

```
任何运行状态 ──兜底失败──→ FAILED（终态，不可恢复，需新建实例重跑）
任何非终态   ──人工主动终止──→ CANCELLED（终态，不可恢复，产物保留备查）
```

终态共三个：COMPLETED / FAILED / CANCELLED，终态下不允许任何状态转换。

## 硬卡点（3个，必须人工输入才能继续）

| 状态 | 等待什么 | 位置说明 | 超时处理 |
|---|---|---|---|
| `REQUIREMENT_CLARIFICATION` | 澄清问题的回答 | 阶段1后 | 可配置超时，超时挂起为 SUSPENDED |
| `API_CONFIRMATION` | API 契约的确认/修改 | **阶段4评审通过后**（ADR-014 调整，确认稳定版契约） | 同上 |
| `DELIVERY_CONFIRMATION` | 最终交付物确认 | 阶段7后 | 同上 |

硬卡点的多轮循环：
- REQUIREMENT_CLARIFICATION：人工回答后，Agent 判断是否充分，不充分则生成新问题继续等
- API_CONFIRMATION：人工可修改契约，修改后直接确认（不需要重新生成方案）
- DELIVERY_CONFIRMATION：人工确认后完成，或要求回退修改

## CODING 内部子状态机

`CODING` 是复合状态，内部按用户故事逐条执行 TDD 循环。Harness 层面只暴露 `CODING`，内部子状态由编码 Agent 管理，但 Harness 跟踪进度：

```
CODING (当前故事索引: i)
  ├─ 选择第 i 个故事（按依赖关系排序）
  ├─ 生成测试用例
  ├─ 运行测试 → 确认失败（红）
  ├─ 生成最小实现
  ├─ 运行测试 → 确认通过（绿）
  ├─ 重构
  ├─ i++，下一个故事
  └─ 全部完成 → 退出 CODING
```

Harness 状态数据保存：`currentStoryIndex`、`totalStories`、`retryCount`。

**单个故事失败处理**：
- 测试失败重试达上限（默认5次）→ 标记该故事 `failed`，记录失败原因
- 继续下一个故事（不阻塞整体流程）
- 全部故事处理完后退出 CODING

**CODING 出口条件（ADR-014 明确）**：
- 全部故事成功 → 进入 CODE_REVIEWING
- 部分成功部分失败 → 触发弱介入窗口，人工决定继续 CR（失败故事交付时列为 incomplete）/回退/暂停
- 全部失败 → FAILED，通知人工（不进入 CR）

## 异常处理

### 通用异常

| 异常 | 处理 |
|---|---|
| LLM 调用失败 | 自动重试（指数退避，最多3次） |
| Agent 输出不符合 Schema | BaseAgent 内部自动重试（最多2次），仍失败则 FAILED（业务失败不再叠加 Harness 重试） |
| 工具调用失败（知识库/代码执行/Figma） | 重试1次，仍失败且影响主流程则 SUSPENDED 等人工（外部依赖问题），不影响主流程则降级继续并记录 |
| 对应 Agent 未实现 | 直接 FAILED（开发期错误，ADR-014 不再 SUSPENDED） |
| 重试超限（外部依赖类） | 进入 SUSPENDED，通知人工 |

### 阶段级失败

| 场景 | 处理 |
|---|---|
| 澄清多轮（默认5轮）后仍不充分 | SUSPENDED，通知人工需求质量有问题 |
| 方案评审3轮不通过 | SUSPENDED，通知人工方案有根本性问题 |
| CR 3轮不通过 | SUSPENDED，通知人工 |
| CODING 全部故事失败 | FAILED，通知人工 |
| 人工主动终止 | CANCELLED |

## 状态数据

```typescript
interface PipelineState {
  instanceId: string;
  currentState: PipelineStateName;
  status: 'running' | 'waiting_human' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  currentVersion: number;              // 流程版本号，回退 +1（与产物自身 version 独立）
  currentStoryIndex?: number;          // CODING 阶段用
  totalStories?: number;
  retryCount: Partial<Record<PipelineStateName, number>>;
  suspendedFromState?: PipelineStateName; // SUSPENDED时记录挂起前状态
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601
  suspendedReason?: string;
  waitingFor?: string;                 // 等待人工输入的说明
  /** 各阶段产物ID，产物在对应阶段完成后才存在，因此为 Partial */
  artifactIds: Partial<Record<ArtifactStage, string>>;
}

// 状态动作：ADVANCE | FALLBACK | SUSPEND | RESUME | FAIL | CANCEL | COMPLETE
```

## 状态持久化与恢复

> ✅ **实现状态（#82 已落地）**：每次状态变更时经 StateMachine.onStateChange 回调写 `state.json`
> （FileSystemArtifactStore），Harness 构造时检测快照并 `continueFromSnapshot`，CLI `--resume <instanceId>` 续跑；
> 数据库写入为目标态（v2）。

- 目标态：每次状态变更时，原子写入数据库 + `state.json` 快照
- Harness 重启时，扫描所有 `status` 不属于 completed / failed / cancelled 的实例
- `status = suspended` → 保持挂起，等人工恢复
- `status = waiting_human` → 保持等待，等人工输入
- `status = running` → 从 `currentState` 恢复：该状态产物已存在则跳过，否则重新执行
- 产物不可变，重复执行安全（生成新版本而非覆盖）
