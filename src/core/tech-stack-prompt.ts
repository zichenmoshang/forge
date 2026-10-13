/**
 * 新项目技术栈反问（纯逻辑，无 LLM / IO 依赖）。
 *
 * 交付阶段初始化新项目前：先结合知识库经验给出推荐，再向人工确认技术栈；
 * 人工可直接回车采用推荐，或按 key=value 覆盖部分字段。
 * 自动确认（非交互）模式下调用方拿不到回答时，完全采用推荐。
 */

import type { NewProjectOptions } from '../tools/delivery/file-system-client';

/** 技术栈推荐（默认推荐项 + 推荐依据） */
export interface TechStackRecommendation {
  framework: NewProjectOptions['framework'];
  packageManager: NewProjectOptions['packageManager'];
  buildTool: NewProjectOptions['buildTool'];
  typescript: boolean;
  /** 推荐依据（检索到的团队知识摘要），展示给人工 */
  reasons: string[];
}

/** 默认推荐（无知识库命中时的团队基线） */
export const DEFAULT_TECH_STACK_RECOMMENDATION: TechStackRecommendation = {
  framework: 'react',
  packageManager: 'npm',
  buildTool: 'vite',
  typescript: true,
  reasons: ['团队默认基线：React + TypeScript + Vite + npm'],
};

/** 构造反问文案 */
export function buildTechStackQuestion(
  rec: TechStackRecommendation,
  projectName: string,
): string {
  return [
    `检测到需要初始化新项目「${projectName}」，请确认技术栈（直接回车采用推荐，或输入要修改的字段）。`,
    '',
    `推荐技术栈（依据：${rec.reasons.join('；') || '团队默认基线'}）：`,
    `  1) framework（框架） = ${rec.framework}`,
    `  2) packageManager     = ${rec.packageManager}`,
    `  3) buildTool（构建）  = ${rec.buildTool}`,
    `  4) typescript         = ${rec.typescript}`,
    '',
    '直接回车全部采用；或输入如 "framework=vue, packageManager=pnpm" 覆盖。',
    '可选值：framework=react/vue/nextjs/other；packageManager=npm/pnpm/yarn；buildTool=vite/webpack/other；typescript=true/false。',
  ].join('\n');
}

const FRAMEWORKS = ['react', 'vue', 'nextjs', 'other'] as const;
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
const BUILD_TOOLS = ['vite', 'webpack', 'other'] as const;

function pick<T extends readonly string[]>(
  allowed: T,
  raw: string,
): T[number] | undefined {
  const v = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

export interface ParsedTechStack extends NewProjectOptions {
  /** 未识别/非法的输入项（提示人工，已回退推荐） */
  ignored: string[];
}

/**
 * 解析人工回答：空回答 / undefined → 完全采用推荐；
 * 否则解析 key=value（逗号/分号/换行分隔），合法值覆盖、非法值忽略并保留推荐。
 * projectName 由调用方在返回结果上填充。
 */
export function parseTechStackAnswer(
  rec: TechStackRecommendation,
  answer: string | undefined,
): ParsedTechStack {
  const merged: NewProjectOptions = {
    framework: rec.framework,
    packageManager: rec.packageManager,
    buildTool: rec.buildTool,
    typescript: rec.typescript,
    projectName: '',
  };
  const ignored: string[] = [];

  if (answer && answer.trim()) {
    const pairs = answer.split(/[,;\n]/);
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      const value = pair.slice(eq + 1).trim().toLowerCase();
      switch (key) {
        case 'framework': {
          const v = pick(FRAMEWORKS, value);
          if (v) merged.framework = v;
          else ignored.push(`framework=${value}`);
          break;
        }
        case 'packagemanager':
        case 'pm': {
          const v = pick(PACKAGE_MANAGERS, value);
          if (v) merged.packageManager = v;
          else ignored.push(`packageManager=${value}`);
          break;
        }
        case 'buildtool':
        case 'build': {
          const v = pick(BUILD_TOOLS, value);
          if (v) merged.buildTool = v;
          else ignored.push(`buildTool=${value}`);
          break;
        }
        case 'typescript':
        case 'ts': {
          if (/^(true|1|yes|y)$/.test(value)) merged.typescript = true;
          else if (/^(false|0|no|n)$/.test(value)) merged.typescript = false;
          else ignored.push(`typescript=${value}`);
          break;
        }
        default:
          ignored.push(`${key}=${value}`);
      }
    }
  }

  return { ...merged, ignored };
}
