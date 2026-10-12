/**
 * 状态快照与文件系统产物存储（issue #82 状态持久化落地）
 *
 * v1 设计（不依赖 PostgreSQL）：
 * - 每次产物保存/状态变更，原子写入 data/instances/{instanceId}/ 下的文件；
 * - Harness 重启时若磁盘存在 state.json，则从快照恢复状态机与产物，可续跑；
 * - 进程崩溃（含机器重启）不丢失已完成进度，最坏从当前状态重跑当前阶段。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ArtifactStage, PipelineState } from '../types/state';
import type { ArtifactRecord, ArtifactStore } from './artifact-store';

/** 实例目录内产物子目录名 */
const ARTIFACTS_DIR = 'artifacts';
/** 实例目录内状态快照文件名 */
const STATE_FILE = 'state.json';

/**
 * 文件系统产物存储：内存 Map + 磁盘双写。
 *
 * 构造时扫描实例产物目录，把已落盘产物加载进内存；
 * 之后 get/list 直接从内存读（与内存版语义一致），save/remove 同步写盘。
 * 重启后产物自动恢复，Harness 的评审对话历史、需求、方案、代码均可续用。
 */
export class FileSystemArtifactStore implements ArtifactStore {
  private store = new Map<string, ArtifactRecord>();
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadFromDisk();
  }

  /** 构造时把磁盘上已存在的产物加载进内存 */
  private loadFromDisk(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.dir, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as ArtifactRecord;
        if (record && typeof record === 'object' && record.stage && record.instanceId) {
          this.store.set(this.key(record.instanceId, record.stage), record);
        }
      } catch {
        // 单个损坏文件不影响其余产物；保留文件供人工排查
      }
    }
  }

  private key(instanceId: string, stage: ArtifactStage): string {
    return `${instanceId}:${stage}`;
  }

  private filePath(instanceId: string, stage: ArtifactStage): string {
    return path.join(this.dir, `${stage}.json`);
  }

  /** 原子写：先写临时文件再 rename，避免写一半时崩溃留下损坏文件 */
  private writeFileAtomic(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 偶发目标被占用时回退直接写（全量内容，语义等价）
      fs.writeFileSync(file, content, 'utf-8');
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 临时文件残留不影响正确性，交由用户清理
      }
    }
  }

  save(stage: ArtifactStage, instanceId: string, data: unknown): string {
    const now = new Date().toISOString();
    const existing = this.store.get(this.key(instanceId, stage));

    const record: ArtifactRecord = {
      id: existing?.id ?? `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stage,
      instanceId,
      version: existing ? existing.version + 1 : 1,
      data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.store.set(this.key(instanceId, stage), record);
    this.writeFileAtomic(this.filePath(instanceId, stage), JSON.stringify(record, null, 2));
    return record.id;
  }

  get<T>(stage: ArtifactStage, instanceId: string): T | undefined {
    const record = this.store.get(this.key(instanceId, stage));
    return record?.data as T | undefined;
  }

  getRecord(stage: ArtifactStage, instanceId: string): ArtifactRecord | undefined {
    return this.store.get(this.key(instanceId, stage));
  }

  list(instanceId: string): ArtifactRecord[] {
    return [...this.store.values()].filter((r) => r.instanceId === instanceId);
  }

  remove(stage: ArtifactStage, instanceId: string): boolean {
    const deleted = this.store.delete(this.key(instanceId, stage));
    if (deleted) {
      try {
        fs.unlinkSync(this.filePath(instanceId, stage));
      } catch {
        // 文件已不存在也视为删除成功（内存已移除）
      }
    }
    return deleted;
  }
}

/**
 * 保存状态快照（原子写 state.json）。
 */
export function saveStateSnapshot(instanceDir: string, state: PipelineState): void {
  fs.mkdirSync(instanceDir, { recursive: true });
  const file = path.join(instanceDir, STATE_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 残留临时文件不影响正确性
    }
  }
}

/**
 * 加载状态快照；不存在或损坏时返回 undefined。
 */
export function loadStateSnapshot(instanceDir: string): PipelineState | undefined {
  const file = path.join(instanceDir, STATE_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as PipelineState;
    if (
      state &&
      typeof state === 'object' &&
      typeof state.instanceId === 'string' &&
      typeof state.currentState === 'string'
    ) {
      return state;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 判断快照是否为终态（COMPLETED/FAILED/CANCELLED 无需恢复） */
export function isTerminalSnapshot(state: PipelineState | undefined): boolean {
  if (!state) return false;
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state.currentState);
}

export { ARTIFACTS_DIR };
