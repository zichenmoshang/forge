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

按实例分文件：
```
data/instances/{instance_id}/logs/
├── pipeline.log      # 流程级日志
├── llm.log           # LLM 调用详细日志
└── error.log         # 错误日志
```

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

v1 存在 PostgreSQL `spans` 表，通过 instance_id 查完整调用链。

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

v1 存 PostgreSQL `metrics` 表，流程结束时聚合写入。查看方式：
- CLI 命令：`forge stats --instance xxx`、`forge stats --overview`
- 简单 HTML 统计页面（可选）

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
| 第一层：日志 | Logger（结构化日志 + LLM 调用记录） | ✅ 已实现 |
| 第二层：链路追踪 | Tracer（span 记录） | ⏳ 待实现（按需补充） |
| 第三层：指标 | MetricsCollector | ⏳ 待实现（按需补充） |
| 第四层：质量与成本分析 | 质量评估、成本追踪 | ⏳ 待实现（v1 后期） |

当前 Logger 已支持：分级输出（debug/info/warn/error）、JSON Lines 格式、LLM 调用完整 prompt/response 记录、按实例分文件（data/instances/{id}/logs/pipeline.log + llm-calls.log）、console + 文件双通道、写入失败 console.warn 降级。
