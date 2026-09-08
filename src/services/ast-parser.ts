/**
 * AST Parser（代码反解析）
 *
 * 使用 TypeScript Compiler API 从代码中提取结构化知识：
 * - API 接口定义（URL、method、参数、响应类型）
 * - 组件 props 定义（名称、类型、是否必填）
 *
 * v1 实现基本提取，v2 可扩展数据模型、状态管理、依赖关系等。
 */

import * as ts from 'typescript';
import type { KnowledgeItem } from '../types/knowledge';

/** 提取的 API 接口信息 */
export interface ApiInfo {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'UNKNOWN';
  url: string;
  paramsType?: string;
  responseType?: string;
  description?: string;
}

/** 提取的组件 props 信息 */
export interface ComponentInfo {
  name: string;
  props: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string;
  }>;
  description?: string;
}

/** 解析结果 */
export interface ParseResult {
  apis: ApiInfo[];
  components: ComponentInfo[];
}

export class ASTParser {
  /**
   * 解析 TypeScript/JavaScript 文件内容
   * @param content 文件内容
   * @param filePath 文件路径（用于生成 ID 和来源引用）
   */
  parse(content: string, filePath: string): ParseResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true, // setParentNodes
    );

    const apis: ApiInfo[] = [];
    const components: ComponentInfo[] = [];

    this.visitNode(sourceFile, apis, components, sourceFile);

    return { apis, components };
  }

  /**
   * 将解析结果转换为 KnowledgeItem 列表
   * @param result 解析结果
   * @param filePath 文件路径
   * @param projectScope 项目范围
   * @param techStack 技术栈
   */
  toKnowledgeItems(
    result: ParseResult,
    filePath: string,
    projectScope: string = 'global',
    techStack?: string,
  ): KnowledgeItem[] {
    const items: KnowledgeItem[] = [];
    const now = new Date().toISOString();

    for (const api of result.apis) {
      const content = JSON.stringify(api, null, 2);
      items.push({
        id: `api-${this.sanitizeId(filePath)}-${api.name}`,
        type: 'api',
        title: `${api.method} ${api.url} (${api.name})`,
        content,
        summary: `${api.method} ${api.url} - 参数: ${api.paramsType || '未知'}, 响应: ${api.responseType || '未知'}`,
        source: 'code',
        sourceRef: filePath,
        projectScope,
        techStack,
        weight: 0.9, // 代码来源权重高
        status: 'active',
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
      });
    }

    for (const comp of result.components) {
      const content = JSON.stringify(comp, null, 2);
      const propsSummary = comp.props
        .map((p) => `${p.name}${p.required ? '*' : ''}: ${p.type}`)
        .join(', ');
      items.push({
        id: `component-${this.sanitizeId(filePath)}-${comp.name}`,
        type: 'component',
        title: `组件: ${comp.name}`,
        content,
        summary: `${comp.name} 组件，props: ${propsSummary || '无'}`,
        source: 'code',
        sourceRef: filePath,
        projectScope,
        techStack,
        weight: 0.9,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
      });
    }

    return items;
  }

  /** 递归遍历 AST 节点 */
  private visitNode(
    node: ts.Node,
    apis: ApiInfo[],
    components: ComponentInfo[],
    sourceFile: ts.SourceFile,
  ): void {
    // 提取 API 接口：识别 request.get/post/put/delete 调用
    if (ts.isCallExpression(node)) {
      const api = this.tryExtractApiCall(node, sourceFile);
      if (api) apis.push(api);
    }

    // 提取组件 props：识别函数组件的 props 参数类型
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) {
      const comp = this.tryExtractComponent(node, sourceFile);
      if (comp) components.push(comp);
    }

    // 提取接口定义中的组件 props
    if (ts.isInterfaceDeclaration(node)) {
      const comp = this.tryExtractComponentFromInterface(node, sourceFile);
      if (comp) components.push(comp);
    }

    ts.forEachChild(node, (child) => {
      this.visitNode(child, apis, components, sourceFile);
    });
  }

  /** 尝试从函数调用中提取 API 接口 */
  private tryExtractApiCall(node: ts.CallExpression, sourceFile: ts.SourceFile): ApiInfo | null {
    // 匹配模式：request.get(url, params) 或 http.post(url, data)
    const expression = node.expression;

    if (!ts.isPropertyAccessExpression(expression)) return null;

    const methodName = expression.name.text.toLowerCase();
    const validMethods = ['get', 'post', 'put', 'delete', 'patch'];
    if (!validMethods.includes(methodName)) return null;

    // 检查第一个参数是否是字符串字面量（URL）
    if (node.arguments.length === 0) return null;
    const firstArg = node.arguments[0];
    if (!ts.isStringLiteral(firstArg)) return null;

    // 获取函数名（如果是 const xxx = request.get(...)）
    let apiName = 'anonymous';
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      apiName = parent.name.text;
    }

    // 提取响应类型（从类型注解或 JSDoc）
    let responseType: string | undefined;

    // 从变量声明的类型注解中提取
    if (parent && ts.isVariableDeclaration(parent) && parent.type) {
      const typeText = parent.type.getText(sourceFile);
      // 简单匹配 Promise<ResponseType>
      const match = typeText.match(/Promise<([^>]+)>/);
      if (match) responseType = match[1];
    }

    return {
      name: apiName,
      method: methodName.toUpperCase() as ApiInfo['method'],
      url: firstArg.text,
      responseType,
    };
  }

  /** 尝试从函数组件中提取组件信息 */
  private tryExtractComponent(
    node: ts.FunctionDeclaration | ts.ArrowFunction,
    sourceFile: ts.SourceFile,
  ): ComponentInfo | null {
    // 函数名（函数声明）或变量名（箭头函数）
    let compName = '';
    if (ts.isFunctionDeclaration(node) && node.name) {
      compName = node.name.text;
    } else if (ts.isArrowFunction(node)) {
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        compName = parent.name.text;
      }
    }

    if (!compName) return null;
    // 组件名通常以大写开头
    if (compName[0] !== compName[0].toUpperCase()) return null;

    // 提取 props（第一个参数的类型注解）
    const props: ComponentInfo['props'] = [];
    if (node.parameters.length > 0) {
      const firstParam = node.parameters[0];
      if (firstParam.type && ts.isTypeLiteralNode(firstParam.type)) {
        for (const member of firstParam.type.members) {
          if (ts.isPropertySignature(member) && member.name) {
            props.push({
              name: member.name.getText(sourceFile),
              type: member.type?.getText(sourceFile) || 'any',
              required: !member.questionToken,
            });
          }
        }
      }
    }

    return { name: compName, props };
  }

  /** 尝试从接口定义中提取组件 props（如 interface ButtonProps {...}） */
  private tryExtractComponentFromInterface(
    node: ts.InterfaceDeclaration,
    sourceFile: ts.SourceFile,
  ): ComponentInfo | null {
    const interfaceName = node.name.text;

    // 匹配 XxxProps 模式
    if (!interfaceName.endsWith('Props')) return null;

    const compName = interfaceName.replace(/Props$/, '');
    const props: ComponentInfo['props'] = [];

    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) {
        props.push({
          name: member.name.getText(sourceFile),
          type: member.type?.getText(sourceFile) || 'any',
          required: !member.questionToken,
        });
      }
    }

    return { name: compName, props };
  }

  /** 生成安全的 ID 片段 */
  private sanitizeId(filePath: string): string {
    return filePath
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }
}
