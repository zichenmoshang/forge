# Forge

从需求PRD到高质量前端代码的自动化智能体。

## 项目定位

Forge 接收需求 PRD 文档，自动完成需求澄清、用户故事拆解、前端技术方案设计、TDD 代码生成、代码评审，最终以 PR 形式交付可运行的前端代码。

核心目标：把"PRD → 可运行代码"这条链路自动化，每个阶段产物作为下一阶段的唯一输入，阶段间设质量门禁，支持回退和人工介入。

## 核心能力

- 需求解析与多轮澄清
- 用户故事与验收标准拆解
- 前端技术方案设计（含 Figma 消费、API 契约、异常场景补齐）
- TDD 驱动代码生成（测试先行，mock 接口测试）
- AI 方案评审与代码 CR
- PR 自动交付（支持新项目/新模块/代码修改三种场景）

## 技术栈

- 实现语言：TypeScript
- LLM：通过 API 配置接入，支持多模型切换
- 存储：PostgreSQL + pgvector + 本地文件系统
- 架构：Harness（中央编排器）+ 专业 Agent

## 文档导航

| 文档 | 内容 |
|---|---|
| [项目概述](docs/01-overview.md) | 目标、范围、核心概念、关键决策 |
| [流程设计](docs/02-pipeline.md) | 7 阶段完整流程、回退机制、人工介入点 |
| [架构设计](docs/03-architecture.md) | Harness 架构、Agent 分工、状态机 |
| [知识库方案](docs/04-knowledge-base.md) | 代码反解析、无人工打标、自动化质量保证 |
| [代码索引方案](docs/05-code-index.md) | 现有项目符号索引、语义索引、依赖图 |
| [存储方案](docs/06-storage.md) | 分层存储、版本管理、崩溃恢复 |
| [可观测性](docs/07-observability.md) | 日志、链路追踪、指标、成本追踪 |
| [评审多轮对话](docs/08-review-dialog.md) | 方案评审/代码CR阶段的角色驱动对话循环设计 |
| [开发规范](docs/coding-standards.md) | 代码质量、配置管理、测试规范、审查 Checklist（沉淀自七轮问题修复） |
| [决策记录](docs/decisions/) | 关键技术决策的 ADR |

## 项目状态

设计阶段完成，工程基础设施已搭建，需求分析、方案设计、方案多轮评审、编码（单故事 TDD + 逐故事循环）、代码 CR 多轮（Reviewer↔Coder）、交付（场景判定+新项目初始化+代码落盘+构建验证+Git+PR描述）六个 Agent 与 Harness、知识库、质量门、可替换编码工具层、可替换交付工具层已实现。共 315 个测试全部通过（交付 Agent 落地后）。

**已实现**：
- 全局状态机（15 状态含 CANCELLED、回退、挂起恢复；顺序为 设计→评审→API确认→编码）+ 42 个单元测试
- LLM Provider 层（OpenAI 实现、重试、可观测性集成）+ 12 个单元测试
- 结构化 Logger（按实例分文件，LLM 调用完整记录）
- 配置层（zod 校验、dotenv、类型统一、budget 预算配置）+ 14 个单元测试
- Agent 基类（模板方法、泛型执行器 runAgentCycle 供 generate/revise/多阶段复用、检索增强、searchKnowledge 多路检索、共享 JSON 提取）+ 20 个单元测试
- 需求分析 Agent（需求澄清 + 用户故事拆解 + 多轮 followup，INVEST 自评+程序校验）+ 16 个单元测试
- 方案设计 Agent（generate 三路知识库检索 + revise 评审内修订：版本递增、覆盖度重算、逐项回应闭环）+ 15 个单元测试
- 方案评审 Agent（多轮 review-design，强制 blocking、resolvedAction 程序化仲裁、第 N 轮逐项 verification 闭环、request_human）+ 10 个单元测试
- 代码 CR Agent（ReviewAgent review-code 分支：八维度 CR + CodingAgent.revise 针对性修改+重跑测试+逐项回应，多轮对话复用 #42 模式）+ 9 个单元测试（review 5 + revise 4）
- 编码 Agent（单故事 red/green/fix TDD：red 必失败反假测试、AC 测试覆盖程序校验、green 上限修复、needsDesignFallback、CR 内 revise）+ 10 个单元测试
- 可替换编码工具层（Workspace/TestRunner 接口、InMemoryWorkspace、StaticTestRunner 静态推断、ScriptableTestRunner）+ 8 个单元测试；编码纯函数 planner/aggregator/validation + 13 个单元测试
- Harness 编排器（状态机调度、方案评审多轮对话、逐故事编码与 #40 部分成功出口、代码 CR 多轮对话、弱介入含超时、回退、取消、多轮澄清、暂停/续跑、全局上下文注入、instanceId 回填）+ 15 个单元测试
- ContextManager（产物装配含逐故事编码任务/评审/交付输入，ADR-014 后不做知识库检索）+ 18 个单元测试
- 需求冻结质量门 freeze-checklist + 方案覆盖度 design-coverage（均按产物实际计算，不硬编码）+ 11 个单元测试
- 知识库基础设施（KnowledgeService 单例、多项目 scope 隔离、向量存储、AST 解析、Embedding、CLI）+ 54 个单元测试
- 评审统一判定 review-policy（强制 blocking、动作仲裁、评审方/修改方双侧问题闭环校验）+ 20 个单元测试
- 端到端集成测试（含多轮评审、编码逐故事 TDD、代码 CR 多轮 request_changes 修订后通过/request_human 暂停续跑/最大轮次接受、交付阶段 DELIVERY_CONFIRMATION 硬卡点）+ 24 个测试
- 交付 Agent（场景判定自动推断+新项目初始化+代码落盘+构建验证+Git 本地操作+PR 描述 LLM 生成+兜底模板，可替换 FileSystem/Git/Build 工具层）+ 8 个单元测试

**下一步**：真实子进程测试执行器（v2）、远程 PR 创建（v2）、设计还原度图片比对（v2）。
