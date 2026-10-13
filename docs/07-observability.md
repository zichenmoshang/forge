# 可观测性方案

## 设计原则

AI 系统比传统系统更需要可观测性——输出不确定，出了问题必须能追溯到"当时输入了什么、模型返回了什么、为什么做了这个决策"。

可观测性是横切关注点，在 Harness 和基础设施层统一封装，Agent 不需要写日志代码。

## 四层体系

```
┌─────────────────────────────────────┐
│  第四层：质量与成本分析                │
│  产物质量评估、成本追踪、Prompt 版本管理 │
├─────────────────────────────────────┤
│  第三层：指标（Metrics）              │
│  成功率、耗时、token 消耗、评审通过率   │
├─────────────────────────────────────┤
│  第二层：链路追踪（Traces）           │
│  流程实例完整调用链、每步输入输出       │
├─────────────────────────────────────┤
│  第一层：日志（Logs）                 │
│  结构化日志、LLM 调用记录、错误日志     │
└─────────────────────────────────────┘
```

## 第一层：结构化日志

### 日志类型

| 类型 | 内容 | 级别 |
|---|---|---|
| 流程状态流转 | 实例ID、状态变化、触发原因 | info |
| Agent 调用 | Agent 名、输入摘要、输出摘要、耗时、重试次数 | info |
| LLM 调用 | 模型、完整 prompt、完整 response、token、耗时、参数 | debug |
| 工具调用 | 工具名、参数、结果摘要、耗时 | debug |
| 人工介入 | 挂起原因、等待时长、用户输入摘要 | info |
| 回退 | 回退路径、原因 | warn |
| 错误与重试 | 错误信息、堆栈、重试次数、最终结果 | warn/error |

### 日志格式

每条日志必须带：
```json
{
  "timestamp": "2026-09-01T10:00:00Z",
  "trace_id": "inst_abc123",
  "instance_id": "inst_abc123",
  "stage": "design",
  "agent": "design-agent",
  "level": "info",
  "message": "Agent completed",
  "duration_ms": 12500,
  "data": {}
}
```

**关键：LLM 调用的 prompt 和 response 必须完整记录**，这是 AI 系统调试的基础。

### 存储

按实例分文件（CLI 统一布局，`{output}/{project}/` 即实例目录）：
```
{instanceDir}/
├── logs/
│   ├── pipeline.log      # 流程级日志（结构化 JSON Lines，含 traceId/stage/agent）
│   ├── llm-calls.log     # LLM 调用完整 prompt/response/token/耗时
│   └── error.log         # 错误日志
├── test-failures/        # 测试环境异常失败现场（#11）
│   └── tdd-{timestamp}/  # 完整临时目录快照 + error.txt
├── artifacts/            # 各阶段产物
├── state.json            # 状态快照（--resume）
├── trace-id.txt          # 全流程根 traceId
└── run-summary.json      # 终态指标汇总（#13）
```

### 失败现场保留（#11）

子进程测试的两类失败必须区分：

| 失败类型 | 含义 | 处理 |
|---|---|---|
| **断言失败** | vitest 真实运行，用例不通过 | TDD 红绿循环的正常输入，失败信息喂回 LLM 修复，不保留现场 |
| **环境异常** | vitest 不存在 / spawn 失败 / 超时 / 无有效输出 | 临时目录完整拷贝到 `test-failures/tdd-{timestamp}/` 并写 `error.txt`，再降级静态推断 |

环境异常的现场（测试文件、vitest 配置、错误原因）是排查"为什么子进程跑不起来"的直接证据，
不会随临时目录清理而丢失。CodingAgent 的 red/green 测试执行日志同时记录
`runner`（static/scriptable/subprocess）、`environment`、`degraded`（是否已降级）与 `outputSummary`，
避免"真实执行静默降级为静态推断"而无感知。

### PARSE_ERROR 原始输出（#12）

LLM 输出格式漂移导致 JSON 解析失败时，日志记录 `rawLength` 与 `rawContentHead`（前 2000 字符），
并提示按 traceId 查 `llm-calls.log` 获取完整原文——不再只记"解析失败"而无法看到模型实际返回了什么。

## 第二层：链路追踪

每个流程实例是一条完整 trace，每个阶段是一个 span：

```
trace: inst_abc123 (总耗时 5min)
├── span: requirement (30s)
│   ├── span: llm-call (15s, 2000 tokens)
│   └── span: llm-call (10s, 1500 tokens)
├── span: stories (20s)
├── span: design (60s)
│   ├── span: knowledge-search (2s)
│   ├── span: figma-parse (5s)
│   └── span: llm-call (50s, 8000 tokens)
├── span: review (15s)
├── span: coding (3min, 含挂起2min)
│   ├── span: test-run (30s, 失败)
│   ├── span: test-run (20s, 通过)
│   └── ...
└── span: delivery (20s)
```

每个 span 记录：阶段名、开始/结束时间、状态（成功/失败/回退/挂起）、输入摘要、输出产物路径、错误信息。

> ✅ **实现状态（traceId 已落地）**：v1 以 **traceId 全链路透传**实现日志层追踪——
> Harness 构造时生成 UUID 作为全流程根 traceId，独立持久化到 `{instanceDir}/trace-id.txt`
>（快照恢复后 traceId 保持一致），注入每个 AgentContext 与全部 LLM 请求；
> 所有结构化日志（含 BaseAgent 重试/预算/解析失败、CodingAgent 红绿测试执行、降级分支）均带 traceId。
> 目标态 PostgreSQL `spans` 表（按 instance_id 查 span 树）为 v2。
>
> **排障路径**：按 traceId 聚合 `pipeline.log` 时间线 → 按 traceId 查 `llm-calls.log` 完整 prompt/response
> → 环境异常时查 `test-failures/tdd-*/` 失败现场（测试文件 + error.txt）。

## 第三层：指标

### 核心指标

| 指标 | 说明 | 维度 |
|---|---|---|
| 流程成功率 | 成功走完的比例 | 按需求类型、项目 |
| 流程平均耗时 | 端到端时间 | 按阶段拆分 |
| 各阶段耗时分布 | P50/P95/P99 | 按阶段 |
| 回退率 | 发生回退的流程比例 | 按回退路径 |
| 人工介入率 | 需要人工介入的比例 | 按介入点 |
| Agent 成功率 | 每个 Agent 成功比例 | 按 Agent |
| LLM 调用次数 | 总调用量 | 按模型、按 Agent |
| Token 消耗 | 输入/输出 token | 按模型、按 Agent、按阶段 |
| 估算成本 | token 换算费用 | 按模型、按流程实例 |
| 评审通过率 | 一次通过比例 | 方案评审/代码 CR |
| 测试通过率 | 生成代码测试通过比例 | 按故事 |
| 设计还原度 | 图片比对相似度 | 按页面 |

### 存储与展示

> ✅ **实现状态（MetricsCollector 已落地，#13）**：`src/observability/metrics.ts`——
> Harness 创建单例并注入每个 AgentContext，BaseAgent 在每次 LLM 调用成功后按
> **stage/agent 双维度**聚合：调用次数、失败数、prompt/completion/total tokens、累计耗时；
> 流程终态（COMPLETED/FAILED/CANCELLED）原子落盘 `{instanceDir}/run-summary.json`，
> 并在 CLI 终态输出摘要（总调用/总 token/总耗时 + 按阶段明细）。
>
> run-summary.json 是性能基准（#87：各阶段耗时/token 基线，用于发现回归）与成本核算的数据源；
> 与 TokenBudgetTracker（预算控制，事前阻断）互补。
>
> 目标态（v2）：PostgreSQL `metrics` 表、`forge stats` 命令、跨实例 P50/P95/P99 聚合。
- CLI 命令（v2）：`forge stats --instance xxx`、`forge stats --overview`
- 简单 HTML 统计页面（v2，可选）

不需要 Prometheus/Grafana，指标体系稳定后再上。

## 第四层：质量与成本分析

### 产物质量可追溯

每个产物记录：
- 生成时间、模型版本、prompt 版本
- 输入摘要、输出产物路径
- 关联的评审结果（通过/打回、打回原因）
- 关联的测试结果（通过率、失败用例）

可统计：
- 哪个 Agent 的产物经常被打回
- 哪类需求容易出问题
- prompt 改版后质量变化

### Prompt 版本管理

每个 Agent 的 prompt 纳入版本管理，每次 LLM 调用记录用的版本。优化 prompt 时可对比：
- 输出质量（评审通过率）
- token 消耗
- 耗时

### 成本追踪（事后）

- 每个流程实例累计 token 和估算成本
- 每个阶段成本分布（通常编码阶段最高）
- 可设置单流程成本阈值，超过时告警
- 模型分级：简单任务用便宜模型，复杂任务用好模型

### 预算控制（事前，ADR-014）

事后告警只能发现超支，无法阻止。因此增加前置预算控制：

- 配置项 `budget.maxTokensPerRun`（单流程实例 token 总量上限，0=不限）、`budget.maxTokensPerCall`（单次调用兜底，防 prompt 异常膨胀）
- Harness 维护实例级累计 token（来自每次 LLMResponse 的 totalTokens），**每次调用 LLM 前检查**：
  - 本次预估 + 累计 > 预算 → 不发起调用，暂停流程等人工（SUSPENDED，说明已消耗/预算/当前阶段）
- 评审多轮对话是成本高发区（默认最多 3 轮 × 2 角色），预算检查同样作用于对话循环
- HarnessConfig 暴露 `maxTokensPerRun` 便捷字段；v1 只做硬上限暂停，不做模型自动降级（v2）

## 实现方式

统一封装，不散落在 Agent 里：

```
┌─────────────────────────────────────────┐
│              Harness                     │
│  · 流程状态流转自动记录日志和 span         │
│  · Agent 调用自动埋点（耗时/重试/结果）    │
│  · 流程结束自动聚合指标                  │
├─────────────────────────────────────────┤
│           LLM Provider 层                │
│  · 每次调用自动记录 prompt/response/token │
│  · 自动记录耗时和错误                    │
├─────────────────────────────────────────┤
│           Tool Layer                    │
│  · 工具调用自动记录参数/结果/耗时         │
└─────────────────────────────────────────┘
```

## v1 范围

| 必须有 | 后续做 |
|---|---|
| 结构化日志（流程+Agent+错误） | Prometheus/Grafana 可视化 |
| LLM 调用完整记录 | 分布式追踪系统（Jaeger） |
| 流程状态持久化（可查所有实例） | 实时 dashboard |
| 链路 span 存储（按实例查完整链路） | Prompt A/B 测试框架 |
| 基本指标（成功率/耗时/token/成本） | 产物质量自动评分 |
| 成本统计（按实例/阶段） | 成本告警和预算控制 |

## 实现状态

| 层级 | 组件 | 状态 |
|---|---|---|
| 第一层：日志 | Logger（结构化日志 + LLM 调用记录） | ✅ 已实现（全日志带 traceId/stage；PARSE_ERROR 记录原始输出片段，#12） |
| 第二层：链路追踪 | traceId 全链路透传（trace-id.txt + 日志聚合） | ✅ v1 已实现（span 树/PostgreSQL 为 v2） |
| 第二层：失败现场 | test-failures/ 环境异常现场保留 | ✅ 已实现（#11，仅环境异常；断言失败不保留） |
| 第三层：指标 | MetricsCollector（run-summary.json） | ✅ 已实现（#13，stage/agent 双维度；跨实例聚合为 v2） |
| 第四层：质量与成本分析 | 质量评估、成本追踪 | ⏳ 待实现（v1 后期） |
| 预算控制（ADR-014 前置） | TokenBudgetTracker（#39） | ✅ 已实现：maxTokensPerRun / maxTokensPerCall，Agent 调用前后检查，超限暂停流程 |

当前 Logger 已支持：分级输出（debug/info/warn/error）、JSON Lines 格式、LLM 调用完整 prompt/response 记录、按实例分文件（pipeline.log + llm-calls.log + error.log）、console + 文件双通道、写入失败 console.warn 降级。
