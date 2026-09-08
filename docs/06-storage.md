# 存储方案

## 总体方案

v1 用 **PostgreSQL + pgvector + 本地文件系统** 三件套，不引入更多组件。

| 存储 | 用途 |
|---|---|
| PostgreSQL | 流程状态、产物元数据、符号索引、span、指标、配置 |
| pgvector | 知识库向量、代码语义索引向量 |
| 本地文件系统 | 产物完整内容、代码文件、图片、日志、临时文件 |

## 数据分类与存储

| 数据类型 | 存储位置 | 说明 |
|---|---|---|
| 流程状态 | PostgreSQL | 实例表，当前状态、重试次数、挂起状态 |
| 产物元数据 | PostgreSQL | 产物表，关联实例、阶段、版本、文件路径 |
| 产物完整内容 | 文件系统 | 大文本（方案/代码）存文件，DB 存路径 |
| 版本历史 | PostgreSQL + 文件系统 | 每次生成新版本，不覆盖旧版本 |
| 人工介入记录 | PostgreSQL | 问题、回答、时间、超时状态 |
| 项目配置 | PostgreSQL | 技术栈、目录规范、团队约束 |
| 符号索引 | PostgreSQL | 项目ID、符号名、类型、文件路径、行号 |
| 向量索引 | pgvector | 知识库向量、代码语义向量 |
| 依赖关系图 | PostgreSQL | 文件间 import/export 关系 |
| 链路 span | PostgreSQL | 按实例查完整调用链 |
| 指标 | PostgreSQL | 定时聚合，成功率/耗时/token/成本 |
| LLM 调用记录 | PostgreSQL + 文件系统 | 元数据存 DB，完整 prompt/response 存文件 |
| 日志 | 文件系统 | 按实例分文件 |
| 临时文件 | 文件系统 | 测试运行产物、缓存，TTL 自动清理 |

## 目录结构

```
data/
├── instances/
│   └── {instance_id}/
│       ├── state.json              # 状态快照（崩溃恢复用）
│       ├── artifacts/
│       │   ├── v1/                 # 版本化
│       │   │   ├── 01-requirement.json
│       │   │   ├── 02-stories.json
│       │   │   ├── 03-design.md
│       │   │   ├── 04-review.json
│       │   │   ├── code/           # 生成的代码
│       │   │   └── 07-delivery.json
│       │   └── v2/                 # 回退后重新生成的版本
│       ├── figma/                  # 设计稿截图、比对图片
│       ├── test-runs/              # 测试运行临时文件
│       └── logs/                   # 运行日志
│           ├── pipeline.log
│           ├── llm.log
│           └── error.log
├── knowledge/
│   └── {source_id}/                # 知识库原始数据和索引缓存
└── projects/
    └── {project_id}/               # 项目代码索引缓存
```

## 关键设计原则

### 产物不可变，版本化存储

每次生成产物都是新版本，绝不覆盖旧版本：
- 回退时直接引用旧版本，零成本
- 任何时候都能追溯历史
- 出问题能对比版本差异
- 重新生成时创建新版本，DB 中版本指针前移

### 两套版本号（ADR-014 明确，不可混用）

| 版本 | 字段 | 递增时机 | 存储位置 |
|---|---|---|---|
| 流程版本 | `PipelineState.currentVersion` | 每次状态机回退 +1 | 实例状态 |
| 产物版本 | 各产物 `version` / artifact version | 每次重新生成或评审内修改 +1，**单调递增，不随回退重置** | 产物表/文件目录 vN |

示例：方案 v1→评审内修改 2 轮到 v3→回退（流程 v2）→重新生成方案为 v4（不重置为 v1）。
评审对话循环内的修改只增产物版本，不增流程版本（不是回退）。

### 状态与内容分离

- 状态、元数据、索引 → 数据库（查询、事务、恢复）
- 大文本、代码、图片 → 文件系统（高效存储，按路径读取）
- DB 存文件路径，不存文件内容

### 崩溃恢复

每个阶段开始和结束时，状态快照写入 `state.json` 和数据库。

Harness 重启时：
1. 读取所有未完成的流程实例（终态 completed / failed / cancelled 不恢复）
2. 从最后一个完成的阶段恢复
3. 未完成的阶段重新执行（产物不可变，重复执行安全）

### 临时数据自动清理

测试运行中间产物、缓存文件设置 TTL，定期清理，避免磁盘膨胀。

## pgvector 配置

### 向量维度

使用 **通义 Qwen3-Embedding**，输出 **1024 维**向量。

选择 1024 维的理由：
- pgvector 的甜点区，HNSW 索引性能好
- 区分度足够，中文场景召回率高
- 存储成本合理（每条向量约 4KB）
- 3072 维存储和计算成本翻倍，延迟明显增加
- 512 维区分度不够，中文场景召回率下降 10-15%

### 向量索引

使用 **HNSW** 索引（适合高并发、低延迟场景）：

```sql
CREATE INDEX knowledge_items_embedding_idx
ON knowledge_items
USING hnsw (embedding vector(1024))
WITH (m = 16, ef_construction = 64);
```

查询时设置 `ef_search = 40`（平衡精度和延迟）。

### 混合检索

- 向量检索：pgvector `<=>` 余弦距离
- 关键词检索：PostgreSQL 全文检索 `tsvector` + `tsquery`
- 元数据过滤：WHERE 条件 + 向量检索组合
- v2 增加 Rerank（LLM 二次筛选）

## 数据库核心表（初步）

### 流程相关

- `instances`：流程实例
- `artifacts`：产物元数据
- `artifact_versions`：产物版本
- `human_interventions`：人工介入记录
- `projects`：项目配置

### 代码索引相关

- `symbols`：代码符号索引
- `dependencies`：依赖关系图

### 可观测性相关

- `spans`：链路追踪 span
- `metrics`：聚合指标
- `llm_calls`：LLM 调用元数据

### 知识库相关

`knowledge_items` 表结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID | 主键 |
| type | VARCHAR(50) | 知识类型：api/component/model/design/spec/exception/pattern/doc/clarification/story |
| title | VARCHAR(500) | 标题/名称 |
| content | TEXT | 完整内容（结构化 JSON 或文本） |
| summary | VARCHAR(1000) | 摘要（用于检索结果展示） |
| embedding | vector(1024) | 向量（Qwen3-Embedding） |
| source | VARCHAR(100) | 来源：code/pr/feishu/manual |
| source_ref | VARCHAR(500) | 来源引用（文件路径/PR号/飞书文档ID） |
| project_scope | VARCHAR(100) | 项目范围：global/{project_id} |
| tech_stack | VARCHAR(100) | 技术栈标签（react/vue/...） |
| business_domain | VARCHAR(100) | 业务域标签 |
| weight | FLOAT | 动态权重（0-1），影响检索排序 |
| status | VARCHAR(20) | 状态：active/deprecated/removed |
| version | INT | 版本号 |
| created_at | TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMP | 更新时间 |
| last_used_at | TIMESTAMP | 最后被引用时间（用于过期检测） |
| usage_count | INT | 被引用次数 |

索引：
- `embedding`：HNSW 向量索引
- `(type, status)`：组合索引，按类型和状态过滤
- `(tech_stack, business_domain)`：元数据过滤索引
- `content`：GIN 全文检索索引（关键词检索）

## 后续演进

| 场景 | 升级方向 |
|---|---|
| 多实例部署、分布式 | 文件系统 → S3 兼容对象存储 |
| 向量数据量巨大（百万级） | pgvector → Qdrant/Milvus |
| 复杂图查询 | 关系型 → 图数据库（Neo4j） |
| 日志分析 | 文件日志 → Loki/ELK |
| 高频访问缓存 | 加 Redis 层 |

v1 不需要，三件套足够。

## TypeScript 生态

- PostgreSQL：`pg` / Prisma / Drizzle ORM
- pgvector：`pgvector` npm 包
- 文件系统：Node.js 原生 `fs/promises`
- LLM API：封装 `LLMProvider` 接口，多模型实现，配置切换
