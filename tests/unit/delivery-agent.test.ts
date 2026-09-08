/**
 * DeliveryAgent 单元测试
 *
 * 测试场景：
 * 1. 正常交付（代码修改场景）
 * 2. 新项目初始化
 * 3. 构建失败
 * 4. Git 操作失败
 * 5. 输入校验失败
 * 6. LLM 失败时使用兜底 PR 描述
 */

import { describe, it, expect, vi } from 'vitest';
import { DeliveryAgent } from '../../src/agents/delivery-agent';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/llm/provider';
import type { DeliveryConfig } from '../../src/config/schema';
import type { CodingPhaseResult } from '../../src/types/coding-task';
import type { ReviewResult } from '../../src/types/review-and-delivery';
import type { DeliveryAgentInput } from '../../src/core/context-manager';
import type {
  FileSystemClient,
  ProjectState,
  WriteFileResult,
  GitClient,
  BuildRunner,
  BuildResult,
} from '../../src/tools/delivery';

// ============================================================
// Mock 工具
// ============================================================

function createMockLLM(response: string): { provider: LLMProvider; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'mock-llm',
    complete: vi.fn().mockImplementation(async (request: LLMRequest) => {
      calls.push(request);
      return {
        content: response,
        model: 'mock-model',
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 100,
        finishReason: 'stop',
      } as LLMResponse;
    }),
  };
  return { provider, calls };
}

function createMockFileSystem(options?: {
  projectState?: Partial<ProjectState>;
  writeResults?: WriteFileResult[];
  writeShouldFail?: boolean;
}): FileSystemClient {
  const defaultState: ProjectState = {
    exists: true,
    isDirectory: true,
    hasPackageJson: true,
    hasSrcDir: true,
    hasGit: true,
    inferredScenario: 'code-modification',
  };
  return {
    inspectProject: vi.fn().mockResolvedValue({ ...defaultState, ...options?.projectState }),
    writeFile: vi.fn().mockImplementation(async (_projectPath: string, relativePath: string) => {
      if (options?.writeShouldFail) throw new Error('write failed');
      const result: WriteFileResult = { relativePath, operation: 'add', size: 100 };
      return result;
    }),
    readFile: vi.fn().mockResolvedValue(null),
    fileExists: vi.fn().mockResolvedValue(false),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    initNewProject: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockGitClient(options?: {
  commitShouldFail?: boolean;
  branchShouldFail?: boolean;
}): GitClient {
  return {
    isGitAvailable: vi.fn().mockResolvedValue(true),
    init: vi.fn().mockResolvedValue({ success: true }),
    configUser: vi.fn().mockResolvedValue({ success: true }),
    createBranch: vi.fn().mockImplementation(async (_projectPath: string, branchName: string) => {
      if (options?.branchShouldFail) return { success: false, branchName, error: 'branch failed' };
      return { success: true, branchName };
    }),
    add: vi.fn().mockResolvedValue({ success: true }),
    commit: vi.fn().mockImplementation(async (_projectPath: string, message: string) => {
      if (options?.commitShouldFail) return { success: false, error: 'commit failed' };
      return {
        success: true,
        commit: {
          hash: 'abc123def456',
          message,
          author: 'forge-bot',
          createdAt: '2026-09-06T00:00:00Z',
        },
      };
    }),
    status: vi.fn().mockResolvedValue({
      currentBranch: 'feature/test',
      stagedCount: 3,
      modifiedCount: 0,
      untrackedCount: 0,
      hasChanges: true,
    }),
    getCurrentBranch: vi.fn().mockResolvedValue('feature/test'),
    isRepo: vi.fn().mockResolvedValue(true),
  };
}

function createMockBuildRunner(options?: { shouldFail?: boolean }): BuildRunner {
  return {
    detectPackageManager: vi.fn().mockResolvedValue('npm' as const),
    detectBuildCommand: vi.fn().mockResolvedValue('npm run build'),
    runBuild: vi.fn().mockImplementation(async (): Promise<BuildResult> => {
      if (options?.shouldFail) {
        return {
          success: false,
          packageManager: 'npm',
          command: 'npm run build',
          output: '',
          error: 'build error',
          durationMs: 5000,
        };
      }
      return {
        success: true,
        packageManager: 'npm',
        command: 'npm run build',
        output: 'build success',
        durationMs: 3000,
      };
    }),
  };
}

// ============================================================
// 测试数据
// ============================================================

const mockCoding: CodingPhaseResult = {
  id: 'coding-1',
  instanceId: 'instance-1',
  designDocId: 'design-1',
  totalStories: 2,
  successStoryIds: ['story-1', 'story-2'],
  partialStoryIds: [],
  failedStories: [],
  results: [],
  overallTestStats: { totalTests: 10, passedTests: 10, failedTests: 0, passRate: 1 },
  allFiles: [
    {
      path: 'src/components/Login.tsx',
      type: 'component',
      operation: 'create',
      summary: '登录组件',
      content: 'export function Login() {}',
    },
    {
      path: 'src/components/Login.test.tsx',
      type: 'test',
      operation: 'create',
      summary: '登录组件测试',
      content: "test('login', () => {})",
    },
  ],
  overallStatus: 'all-success',
  version: 1,
  completedAt: '2026-09-06T00:00:00Z',
};

const mockCodeReview: ReviewResult = {
  conclusion: 'pass',
  summary: '代码质量良好',
  issues: [],
  overallPassed: true,
};

const mockDeliveryConfig: DeliveryConfig = {
  targetProjectPath: '/tmp/test-project',
  scenario: undefined,
  git: {
    remoteUrl: '',
    baseBranch: 'main',
    branchPrefix: 'feature/forge',
    userName: 'forge-bot',
    userEmail: 'forge-bot@test.com',
  },
  build: { enabled: true, command: '', timeoutMs: 300000, installDeps: false },
};

function createDeliveryInput(overrides?: Partial<DeliveryAgentInput>): DeliveryAgentInput {
  return {
    type: 'deliver',
    coding: mockCoding,
    codeReview: mockCodeReview,
    requirementTitle: '用户登录系统',
    instanceId: 'instance-1',
    ...overrides,
  };
}

// ============================================================
// 测试
// ============================================================

describe('DeliveryAgent', () => {
  describe('正常交付（代码修改场景）', () => {
    it('应该完成代码落盘、构建验证、Git 提交和 PR 描述生成', async () => {
      const { provider, calls } = createMockLLM('## 用户登录系统\n\n### 变更概述\n实现登录功能');
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner();

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput(),
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBe('success');
      expect(result.data?.scenario).toBe('code-modification');
      expect(result.data?.changes.filesAdded).toBe(2);
      expect(result.data?.git.commits).toHaveLength(1);
      expect(result.data?.pullRequest.description).toContain('用户登录系统');
      expect(result.data?.buildVerification.passed).toBe(true);
      expect(result.data?.completedStories).toEqual(['story-1', 'story-2']);

      // 验证工具层调用
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
      expect(git.createBranch).toHaveBeenCalledWith(
        '/tmp/test-project',
        'feature/forge/instance-1',
        'main',
      );
      expect(git.add).toHaveBeenCalledTimes(1);
      expect(git.commit).toHaveBeenCalledTimes(1);
      expect(build.runBuild).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1); // LLM 调用 1 次（PR 描述生成）
    });
  });

  describe('新项目初始化', () => {
    it('应该初始化项目结构后再落盘', async () => {
      const { provider } = createMockLLM('## 新项目\n\n初始化完成');
      const fs = createMockFileSystem({
        projectState: {
          exists: true,
          isDirectory: true,
          hasPackageJson: false,
          hasSrcDir: false,
          hasGit: false,
          inferredScenario: 'new-project',
        },
      });
      const git = createMockGitClient();
      // 新项目场景下 isRepo 返回 false，触发 git init
      git.isRepo = vi.fn().mockResolvedValue(false);
      const build = createMockBuildRunner();

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: { ...mockDeliveryConfig, scenario: 'new-project' },
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.scenario).toBe('new-project');
      expect(fs.initNewProject).toHaveBeenCalledTimes(1);
      expect(git.init).toHaveBeenCalledTimes(1); // 新项目需要 git init
    });
  });

  describe('构建失败', () => {
    it('构建失败时交付状态为 partial，记录 knownIssues', async () => {
      const { provider } = createMockLLM('## 登录系统\n\n构建失败');
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner({ shouldFail: true });

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput(),
      });

      expect(result.success).toBe(true); // partial 不算失败
      expect(result.data?.status).toBe('partial');
      expect(result.data?.buildVerification.passed).toBe(false);
      expect(result.data?.knownIssues).toBeDefined();
      expect(result.data?.knownIssues?.some((i) => i.includes('构建验证失败'))).toBe(true);
    });
  });

  describe('Git 操作失败', () => {
    it('Git 提交失败时记录 knownIssues，不影响代码落盘', async () => {
      const { provider } = createMockLLM('## 登录系统\n\nGit 失败');
      const fs = createMockFileSystem();
      const git = createMockGitClient({ commitShouldFail: true });
      const build = createMockBuildRunner();

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('partial');
      expect(result.data?.git.commits).toHaveLength(0);
      expect(result.data?.knownIssues?.some((i) => i.includes('git commit'))).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledTimes(2); // 代码仍然落盘
    });
  });

  describe('输入校验失败', () => {
    it('缺少 coding 产物时返回失败', async () => {
      const { provider } = createMockLLM('');
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner();

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput({ coding: undefined as unknown as CodingPhaseResult }),
      });

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_CODING_RESULT')).toBe(true);
      expect(fs.writeFile).not.toHaveBeenCalled(); // 不执行后续操作
    });
  });

  describe('LLM 失败时使用兜底 PR 描述', () => {
    it('LLM 调用失败时使用默认模板生成 PR 描述', async () => {
      const calls: LLMRequest[] = [];
      const provider: LLMProvider = {
        name: 'mock-llm',
        complete: vi.fn().mockImplementation(async (request: LLMRequest) => {
          calls.push(request);
          throw new Error('LLM unavailable');
        }),
      };
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner();

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('partial'); // LLM 失败记为 knownIssues
      expect(result.data?.pullRequest.description).toContain('用户登录系统');
      expect(result.data?.pullRequest.description).toContain('Forge'); // 兜底模板包含 Forge
      expect(result.data?.knownIssues?.some((i) => i.includes('PR 描述生成失败'))).toBe(true);
    });
  });

  describe('文件缺少 content', () => {
    it('跳过缺少 content 的文件，记录 knownIssues', async () => {
      const { provider } = createMockLLM('## 登录');
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner();

      const codingWithMissingContent: CodingPhaseResult = {
        ...mockCoding,
        allFiles: [
          {
            path: 'src/components/Login.tsx',
            type: 'component',
            operation: 'create',
            summary: '登录组件',
            content: 'export function Login() {}',
          },
          {
            path: 'src/components/Missing.tsx',
            type: 'component',
            operation: 'create',
            summary: '缺少内容',
          }, // 无 content
        ],
      };

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput({ coding: codingWithMissingContent }),
      });

      expect(result.success).toBe(true);
      expect(result.data?.changes.filesAdded).toBe(1); // 只写入 1 个
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(result.data?.knownIssues?.some((i) => i.includes('缺少 content'))).toBe(true);
    });
  });

  describe('有失败故事时', () => {
    it('交付状态为 partial，incompleteStories 记录失败故事', async () => {
      const { provider } = createMockLLM('## 登录');
      const fs = createMockFileSystem();
      const git = createMockGitClient();
      const build = createMockBuildRunner();

      const codingWithFailed: CodingPhaseResult = {
        ...mockCoding,
        successStoryIds: ['story-1'],
        partialStoryIds: [],
        failedStories: [{ storyId: 'story-2', reason: '测试无法通过' }],
        overallStatus: 'partial-success',
      };

      const agent = new DeliveryAgent(provider, {
        deliveryConfig: mockDeliveryConfig,
        fileSystemClient: fs,
        gitClient: git,
        buildRunner: build,
      });

      const result = await agent.execute({
        instanceId: 'instance-1',
        stage: 'delivery',
        input: createDeliveryInput({ coding: codingWithFailed }),
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('partial');
      expect(result.data?.completedStories).toEqual(['story-1']);
      expect(result.data?.incompleteStories).toHaveLength(1);
      expect(result.data?.incompleteStories?.[0].storyId).toBe('story-2');
      expect(result.data?.incompleteStories?.[0].reason).toBe('测试无法通过');
    });
  });
});
