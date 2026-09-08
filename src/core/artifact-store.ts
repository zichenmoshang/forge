/**
 * 产物存储接口
 *
 * 最小可用版使用内存实现，后续可替换为文件系统或 PostgreSQL。
 */

import type { ArtifactStage } from '../types/state';

/** 产物记录 */
export interface ArtifactRecord {
  id: string;
  stage: ArtifactStage;
  instanceId: string;
  version: number;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

/** 产物存储接口 */
export interface ArtifactStore {
  /** 保存产物，返回产物 ID */
  save(stage: ArtifactStage, instanceId: string, data: unknown): string;
  /** 获取产物 */
  get<T>(stage: ArtifactStage, instanceId: string): T | undefined;
  /** 获取产物记录 */
  getRecord(stage: ArtifactStage, instanceId: string): ArtifactRecord | undefined;
  /** 获取某实例的所有产物 */
  list(instanceId: string): ArtifactRecord[];
  /** 删除产物 */
  remove(stage: ArtifactStage, instanceId: string): boolean;
}

/**
 * 内存产物存储（最小可用版）
 *
 * 进程重启后数据丢失，仅用于开发和测试。
 * 生产环境应替换为文件系统或 PostgreSQL 实现。
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private store = new Map<string, ArtifactRecord>();

  private key(stage: ArtifactStage, instanceId: string): string {
    return `${instanceId}:${stage}`;
  }

  save(stage: ArtifactStage, instanceId: string, data: unknown): string {
    const now = new Date().toISOString();
    const existing = this.store.get(this.key(stage, instanceId));

    const record: ArtifactRecord = {
      id: existing?.id ?? `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stage,
      instanceId,
      version: existing ? existing.version + 1 : 1,
      data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.store.set(this.key(stage, instanceId), record);
    return record.id;
  }

  get<T>(stage: ArtifactStage, instanceId: string): T | undefined {
    const record = this.store.get(this.key(stage, instanceId));
    return record?.data as T | undefined;
  }

  getRecord(stage: ArtifactStage, instanceId: string): ArtifactRecord | undefined {
    return this.store.get(this.key(stage, instanceId));
  }

  list(instanceId: string): ArtifactRecord[] {
    return [...this.store.values()].filter((r) => r.instanceId === instanceId);
  }

  remove(stage: ArtifactStage, instanceId: string): boolean {
    return this.store.delete(this.key(stage, instanceId));
  }
}
