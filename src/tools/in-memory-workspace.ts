import type { Workspace, WorkspaceFile } from './types';

/** 统一为 POSIX 风格相对路径，避免 Windows 反斜杠造成同一文件两份 key */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

/** 内存文件工作区：进程内 Map 存储，不落盘，用于 v1 与单测 */
export class InMemoryWorkspace implements Workspace {
  private files = new Map<string, string>();

  writeFile(path: string, content: string): void {
    const key = normalizePath(path);
    if (!key) throw new Error('workspace.writeFile: 路径不能为空');
    this.files.set(key, content);
  }

  writeFiles(files: WorkspaceFile[]): void {
    for (const f of files) this.writeFile(f.path, f.content);
  }

  readFile(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }

  exists(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  listFiles(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  clear(): void {
    this.files.clear();
  }
}
