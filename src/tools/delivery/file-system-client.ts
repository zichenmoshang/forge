/**
 * 文件系统客户端 - 交付阶段代码落盘
 *
 * 职责：
 * - 项目状态检查（存在性、package.json、src 目录、相关文件）
 * - 代码落盘（新建/覆盖文件、创建目录）
 * - 变更文件统计
 *
 * v1 默认实现：直接调用 Node.js fs
 * 可注入：测试时用 InMemoryFileSystemClient
 */

import * as fs from 'fs';
import * as path from 'path';

/** 项目状态检查结果 */
export interface ProjectState {
  /** 目标路径是否存在 */
  exists: boolean;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 是否有 package.json */
  hasPackageJson: boolean;
  /** 是否有 src 目录 */
  hasSrcDir: boolean;
  /** 是否有 .git 目录 */
  hasGit: boolean;
  /** package.json 内容（如果有） */
  packageJson?: Record<string, unknown>;
  /** 推断的交付场景 */
  inferredScenario: 'new-project' | 'new-module' | 'code-modification';
}

/** 写入文件结果 */
export interface WriteFileResult {
  /** 文件路径（相对项目根） */
  relativePath: string;
  /** 操作类型 */
  operation: 'add' | 'modify';
  /** 文件大小（字节） */
  size: number;
}

/** 文件系统客户端接口 */
export interface FileSystemClient {
  /** 检查项目状态 */
  inspectProject(projectPath: string): Promise<ProjectState>;
  /** 写入文件（自动创建目录） */
  writeFile(projectPath: string, relativePath: string, content: string): Promise<WriteFileResult>;
  /** 读取文件 */
  readFile(projectPath: string, relativePath: string): Promise<string | null>;
  /** 检查文件是否存在 */
  fileExists(projectPath: string, relativePath: string): Promise<boolean>;
  /** 创建目录 */
  ensureDir(projectPath: string, relativePath: string): Promise<void>;
  /** 初始化新项目基础结构 */
  initNewProject(projectPath: string, options: NewProjectOptions): Promise<void>;
}

/** 新项目初始化选项 */
export interface NewProjectOptions {
  /** 框架：react / vue / nextjs / other */
  framework: 'react' | 'vue' | 'nextjs' | 'other';
  /** 包管理器：npm / pnpm / yarn */
  packageManager: 'npm' | 'pnpm' | 'yarn';
  /** 构建工具：vite / webpack / other */
  buildTool: 'vite' | 'webpack' | 'other';
  /** 项目名称 */
  projectName: string;
  /** TypeScript 是否启用 */
  typescript: boolean;
}

/** 默认文件系统客户端：直接调用 Node.js fs */
export class DefaultFileSystemClient implements FileSystemClient {
  async inspectProject(projectPath: string): Promise<ProjectState> {
    const exists = fs.existsSync(projectPath);
    const isDirectory = exists && fs.statSync(projectPath).isDirectory();
    const hasPackageJson = isDirectory && fs.existsSync(path.join(projectPath, 'package.json'));
    const hasSrcDir = isDirectory && fs.existsSync(path.join(projectPath, 'src'));
    const hasGit = isDirectory && fs.existsSync(path.join(projectPath, '.git'));

    let packageJson: Record<string, unknown> | undefined;
    if (hasPackageJson) {
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
      } catch {
        // 解析失败，忽略
      }
    }

    // 推断交付场景
    let inferredScenario: ProjectState['inferredScenario'];
    if (!exists || !isDirectory || !hasPackageJson) {
      inferredScenario = 'new-project';
    } else if (!hasSrcDir) {
      inferredScenario = 'new-project';
    } else {
      // 有 package.json + src 目录，默认为代码修改
      // 新模块 vs 代码修改由上层根据变更文件路径进一步判断
      inferredScenario = 'code-modification';
    }

    return {
      exists,
      isDirectory,
      hasPackageJson,
      hasSrcDir,
      hasGit,
      packageJson,
      inferredScenario,
    };
  }

  async writeFile(
    projectPath: string,
    relativePath: string,
    content: string,
  ): Promise<WriteFileResult> {
    const fullPath = path.join(projectPath, relativePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const operation = fs.existsSync(fullPath) ? 'modify' : 'add';
    fs.writeFileSync(fullPath, content, 'utf-8');
    const size = Buffer.byteLength(content, 'utf-8');
    return { relativePath, operation, size };
  }

  async readFile(projectPath: string, relativePath: string): Promise<string | null> {
    const fullPath = path.join(projectPath, relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf-8');
  }

  async fileExists(projectPath: string, relativePath: string): Promise<boolean> {
    return fs.existsSync(path.join(projectPath, relativePath));
  }

  async ensureDir(projectPath: string, relativePath: string): Promise<void> {
    const fullPath = path.join(projectPath, relativePath);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  async initNewProject(projectPath: string, options: NewProjectOptions): Promise<void> {
    // 创建项目根目录
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }

    // 生成 package.json
    const packageJson = this.generatePackageJson(options);
    fs.writeFileSync(
      path.join(projectPath, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf-8',
    );

    // 创建基础目录结构
    const dirs = ['src', 'src/components', 'src/pages', 'src/utils', 'src/types', 'public'];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(projectPath, dir), { recursive: true });
    }

    // 生成基础配置文件
    if (options.typescript) {
      fs.writeFileSync(
        path.join(projectPath, 'tsconfig.json'),
        JSON.stringify(this.generateTsConfig(options), null, 2) + '\n',
        'utf-8',
      );
    }

    if (options.buildTool === 'vite') {
      fs.writeFileSync(
        path.join(projectPath, 'vite.config.ts'),
        this.generateViteConfig(options),
        'utf-8',
      );
    }

    // 生成入口文件
    const entryExt = options.typescript ? 'tsx' : 'jsx';
    fs.writeFileSync(
      path.join(projectPath, `src/main.${entryExt}`),
      this.generateEntry(options),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectPath, `src/App.${entryExt}`),
      this.generateApp(options),
      'utf-8',
    );

    // .gitignore
    fs.writeFileSync(
      path.join(projectPath, '.gitignore'),
      'node_modules\ndist\nbuild\n.env\n.env.local\n*.log\n.DS_Store\n',
      'utf-8',
    );
  }

  private generatePackageJson(options: NewProjectOptions): Record<string, unknown> {
    const deps: Record<string, string> = {};
    const devDeps: Record<string, string> = {};

    if (options.framework === 'react') {
      deps['react'] = '^18.2.0';
      deps['react-dom'] = '^18.2.0';
      devDeps['@types/react'] = '^18.2.0';
      devDeps['@types/react-dom'] = '^18.2.0';
    } else if (options.framework === 'vue') {
      deps['vue'] = '^3.4.0';
      devDeps['@vitejs/plugin-vue'] = '^5.0.0';
    } else if (options.framework === 'nextjs') {
      deps['next'] = '^14.0.0';
      deps['react'] = '^18.2.0';
      deps['react-dom'] = '^18.2.0';
    }

    if (options.buildTool === 'vite') {
      devDeps['vite'] = '^5.0.0';
      if (options.framework === 'react') {
        devDeps['@vitejs/plugin-react'] = '^4.2.0';
      }
    }

    if (options.typescript) {
      devDeps['typescript'] = '^5.3.0';
    }

    const scripts: Record<string, string> = {
      dev: options.buildTool === 'vite' ? 'vite' : 'webpack serve',
      build: options.buildTool === 'vite' ? 'vite build' : 'webpack build',
      preview: options.buildTool === 'vite' ? 'vite preview' : 'echo "preview not configured"',
    };

    return {
      name: options.projectName,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts,
      dependencies: deps,
      devDependencies: devDeps,
      packageManager: `${options.packageManager}@${this.getDefaultVersion(options.packageManager)}`,
    };
  }

  private getDefaultVersion(pm: string): string {
    switch (pm) {
      case 'pnpm':
        return '8.15.0';
      case 'yarn':
        return '1.22.0';
      default:
        return '10.2.0';
    }
  }

  private generateTsConfig(options: NewProjectOptions): Record<string, unknown> {
    return {
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx:
          options.framework === 'react' || options.framework === 'nextjs'
            ? 'react-jsx'
            : 'preserve',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ['src'],
    };
  }

  private generateViteConfig(options: NewProjectOptions): string {
    const pluginImport =
      options.framework === 'react'
        ? "import react from '@vitejs/plugin-react';\n"
        : options.framework === 'vue'
          ? "import vue from '@vitejs/plugin-vue';\n"
          : '';
    const pluginUse =
      options.framework === 'react' ? 'react()' : options.framework === 'vue' ? 'vue()' : '';

    return `import { defineConfig } from 'vite';\n${pluginImport}\nexport default defineConfig({\n  plugins: [${pluginUse}],\n});\n`;
  }

  private generateEntry(options: NewProjectOptions): string {
    if (options.framework === 'react') {
      return `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`;
    }
    if (options.framework === 'vue') {
      return `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './index.css';\n\ncreateApp(App).mount('#root');\n`;
    }
    return `// Entry point\nimport App from './App';\n\nApp();\n`;
  }

  private generateApp(options: NewProjectOptions): string {
    if (options.framework === 'react') {
      return `function App() {\n  return (\n    <div className="app">\n      <h1>Forge Generated Project</h1>\n    </div>\n  );\n}\n\nexport default App;\n`;
    }
    if (options.framework === 'vue') {
      return `<template>\n  <div class="app">\n    <h1>Forge Generated Project</h1>\n  </div>\n</template>\n\n<script setup lang="ts">\n</script>\n\n<style scoped>\n</style>\n`;
    }
    return `export default function App() {\n  console.log('Forge Generated Project');\n}\n`;
  }
}
