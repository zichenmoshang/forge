/**
 * 知识库类型定义
 *
 * KnowledgeItem 是所有检索结果的统一格式，Agent 根据 type 字段分类处理。
 */

/** 知识类型 */
export type KnowledgeType =
  | 'api' // API 接口
  | 'component' // 组件用法
  | 'model' // 数据模型
  | 'design' // 技术方案
  | 'spec' // 代码规范
  | 'exception' // 异常处理模式
  | 'pattern' // 高频代码模式
  | 'doc' // 技术文档（飞书 wiki）
  | 'clarification' // 历史澄清问题
  | 'story'; // 历史用户故事

/** 知识来源 */
export type KnowledgeSource = 'code' | 'pr' | 'feishu' | 'manual';

/** 知识条目状态 */
export type KnowledgeItemStatus = 'active' | 'deprecated' | 'removed';

/** 知识库条目（统一格式） */
export interface KnowledgeItem {
  id: string;
  type: KnowledgeType;
  title: string;
  /** 完整内容（结构化 JSON 字符串或文本） */
  content: string;
  /** 摘要（用于 prompt 注入，比 content 短） */
  summary: string;
  source: KnowledgeSource;
  /** 来源引用（文件路径/PR号/飞书文档ID） */
  sourceRef: string;
  /** global=团队通用，其他=项目特定 */
  projectScope: 'global' | string;
  /** 技术栈标签（react/vue/...） */
  techStack?: string;
  /** 业务域标签 */
  businessDomain?: string;
  /** 动态权重（0-1），影响检索排序 */
  weight: number;
  status: KnowledgeItemStatus;
  /** 向量（由 VectorStore 管理，KnowledgeService 不直接操作） */
  embedding?: number[];
  /** 检索时的相关性得分（由检索方法填充，入库时为空） */
  relevanceScore?: number;
  createdAt: string;
  updatedAt: string;
  /** 最后被引用时间（用于过期检测） */
  lastUsedAt?: string;
  /** 被引用次数 */
  usageCount: number;
}

/** 检索过滤器 */
export interface KnowledgeFilter {
  /** 按知识类型过滤 */
  types?: KnowledgeType[];
  /** 按来源过滤 */
  sources?: KnowledgeSource[];
  /** 按项目范围过滤（'global' 或具体项目 ID） */
  projectScope?: string;
  /** 按技术栈过滤 */
  techStack?: string;
  /** 按业务域过滤 */
  businessDomain?: string;
  /** 最低权重 */
  minWeight?: number;
  /** 是否包含已废弃/已移除的（默认 false，只查 active） */
  includeDeprecated?: boolean;
}

/** 入库结果 */
export interface IndexResult {
  total: number;
  success: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
  itemIds: string[];
}

/** 文件变更（用于增量更新） */
export interface FileChange {
  path: string;
  /** added / modified / deleted */
  action: 'added' | 'modified' | 'deleted';
  /** 文件内容（added/modified 时有） */
  content?: string;
  /** 项目范围（删除时用于精确匹配） */
  projectScope?: string;
}

/** 知识库状态统计 */
export interface KnowledgeStatus {
  totalItems: number;
  byType: Partial<Record<KnowledgeType, number>>;
  bySource: Partial<Record<KnowledgeSource, number>>;
  activeCount: number;
  deprecatedCount: number;
  removedCount: number;
  lastSyncAt: string;
  lastRebuildAt?: string;
}

/** 知识文档（用于手动入库/飞书同步） */
export interface KnowledgeDocument {
  type: KnowledgeType;
  title: string;
  content: string;
  summary?: string;
  source: KnowledgeSource;
  sourceRef: string;
  projectScope?: string;
  techStack?: string;
  businessDomain?: string;
}
