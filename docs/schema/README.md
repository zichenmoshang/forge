# Schema 总览

> **注意**：Schema 的 TypeScript 定义在 `src/types/`，本目录只保留说明文档。
> 代码中通过 `import { ... } from '../../types'` 引用。

## Schema 列表

| 说明文档 | 代码位置 | 定义 | 对应阶段 | 状态 |
|---|---|---|---|---|
| [00-state-machine.md](00-state-machine.md) | `src/types/state.ts` | 全局状态机、PipelineState | Harness核心 | 已定义 |
| — | `src/types/requirement.ts` | StructuredRequirement | 阶段1输出 | 已定义 |
| — | `src/types/user-story.ts` | UserStorySet | 阶段2输出 | 已定义 |
| — | `src/types/frontend-design.ts` | FrontendDesignDoc | 阶段3输出 | 已定义 |
| — | `src/types/coding-task.ts` | CodingTask / CodingResult / CodingPhaseResult | 阶段5输入/输出 | 已定义 |
| — | `src/types/review-and-delivery.ts` | ReviewResult / DeliveryResult | 阶段4/6/7输出 | 已定义 |

## 状态机要点（ADR-014 更新）

- **15个状态**：在 v2 的 14 状态基础上新增 CANCELLED（人工取消终态）；顺序为 设计→评审→API确认→编码（API 确认位于评审之后，确认稳定版契约）
- **3个硬卡点**：REQUIREMENT_CLARIFICATION、API_CONFIRMATION、DELIVERY_CONFIRMATION
- **弱介入窗口**：故事生成后、方案评审通过后、CR通过后、CODING 部分成功时，Harness 设窗口，人工可介入，超时自动继续（CODING 部分成功不自动推进）
- **SUSPENDED 语义收敛**：只用于运行时外部依赖问题/评审达最大轮次；Agent 未实现直接 FAILED；硬卡点等待用 waiting_human
- **SUSPENDED可恢复**：记录 suspendedFromState，恢复后回到该状态重新执行
- **回退重新确认**：回退后目标状态之后的所有确认和评审必须重新执行
- **CODING部分失败**：单个故事失败不阻塞继续下一个；全部成功→CR，部分成功→弱介入窗口人工决策，全部失败→FAILED

## 产物流转关系

```
PRD文档
  │
  ▼
[阶段1] 需求分析Agent → StructuredRequirement
  │
  ▼
[阶段2] 需求分析Agent → UserStorySet
  │
  ▼ （弱介入窗口）
[阶段3] 方案设计Agent → FrontendDesignDoc
  │
  ▼ （API确认硬卡点）
[阶段4] 评审Agent → ReviewResult (design-review)
  │
  ▼ （弱介入窗口）
[阶段5] 编码Agent（按故事逐条）→ CodingResult[] → CodingPhaseResult
  │
  ▼
[阶段6] 评审Agent → ReviewResult (code-review)
  │
  ▼ （弱介入窗口）
[阶段7] 交付Agent → DeliveryResult
  │
  ▼ （交付确认硬卡点）
COMPLETED
```

## 关键设计原则

1. **产物不可变**：每次生成新版本，不覆盖旧版本
2. **上下游严格通过Schema通信**：Harness负责Schema校验，不符合触发重试
3. **可追溯**：每个产物有 id、instanceId、version，从代码可追溯到原始需求
4. **CodingTask是派生产物**：Harness从FrontendDesignDoc提取单故事相关部分组装
5. **CodingPhaseResult是汇总产物**：所有故事的CodingResult聚合，含总体统计和失败故事
6. **评审意见含checklist**：ReviewResult.checklist 字段承载详细检查结果

## 待补充

以下Schema在实现对应阶段时补充：

- [ ] Agent 输入输出的通用信封格式（错误码、元数据）
- [ ] LLM Provider 的请求/响应格式（已在 src/llm/provider.ts 定义基础版）
- [ ] 知识库检索的请求/响应格式
- [ ] 代码索引检索的请求/响应格式
- [ ] Figma 解析的数据格式
- [ ] 可观测性的 span / metric 数据格式

## 验证方式

Schema定义完成后，用真实PRD走一遍人工验证：
1. 拿一个真实需求，人工按Schema填写各阶段产物
2. 检查是否有字段不够用、有冗余、或语义不清
3. 根据验证结果调整Schema
