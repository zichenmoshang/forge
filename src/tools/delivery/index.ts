/**
 * 交付阶段工具层导出
 *
 * 包含：
 * - FileSystemClient：文件系统操作（项目状态检查、代码落盘、新项目初始化）
 * - GitClient：Git 操作（init、branch、add、commit、status）
 * - BuildRunner：构建验证（包管理器检测、构建命令执行）
 */

export {
  DefaultFileSystemClient,
  type FileSystemClient,
  type ProjectState,
  type WriteFileResult,
  type NewProjectOptions,
} from './file-system-client';

export {
  DefaultGitClient,
  generateCommitMessage,
  type GitClient,
  type GitCommit,
  type GitOperationResult,
  type CreateBranchResult,
  type CommitResult,
  type GitStatus,
} from './git-client';

export {
  DefaultBuildRunner,
  type BuildRunner,
  type BuildResult,
  type BuildOptions,
  type PackageManager,
} from './build-runner';
