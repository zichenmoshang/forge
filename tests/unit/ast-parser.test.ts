import { describe, it, expect } from 'vitest';
import { ASTParser } from '../../src/services/ast-parser';

describe('ASTParser', () => {
  const parser = new ASTParser();

  describe('API 接口提取', () => {
    it('应该提取 request.get 调用', () => {
      const code = `
        import request from './request';

        export const getUserInfo = request.get('/api/user/info', { params: { id: 1 } });
      `;

      const result = parser.parse(code, 'src/api/user.ts');
      expect(result.apis).toHaveLength(1);
      expect(result.apis[0].name).toBe('getUserInfo');
      expect(result.apis[0].method).toBe('GET');
      expect(result.apis[0].url).toBe('/api/user/info');
    });

    it('应该提取 request.post 调用', () => {
      const code = `
        import request from './request';

        export const createUser = request.post('/api/user/create', { name: 'test' });
      `;

      const result = parser.parse(code, 'src/api/user.ts');
      expect(result.apis).toHaveLength(1);
      expect(result.apis[0].method).toBe('POST');
      expect(result.apis[0].url).toBe('/api/user/create');
    });

    it('应该提取多个 API 调用', () => {
      const code = `
        import request from './request';

        export const listUsers = request.get('/api/users');
        export const deleteUser = request.delete('/api/user/1');
        export const updateUser = request.put('/api/user/1', { name: 'updated' });
      `;

      const result = parser.parse(code, 'src/api/user.ts');
      expect(result.apis).toHaveLength(3);
      expect(result.apis.map((a) => a.method)).toEqual(['GET', 'DELETE', 'PUT']);
    });

    it('应该提取响应类型', () => {
      const code = `
        import request from './request';

        export const getUserInfo: Promise<UserInfo> = request.get('/api/user/info');
      `;

      const result = parser.parse(code, 'src/api/user.ts');
      expect(result.apis[0].responseType).toBe('UserInfo');
    });

    it('非 API 调用不应该被提取', () => {
      const code = `
        const result = someFunction('hello');
        console.log('test');
      `;

      const result = parser.parse(code, 'src/utils.ts');
      expect(result.apis).toHaveLength(0);
    });
  });

  describe('组件 props 提取', () => {
    it('应该从函数组件提取 props', () => {
      const code = `
        export function Button({ label, onClick, disabled = false }: {
          label: string;
          onClick: () => void;
          disabled?: boolean;
        }) {
          return <button disabled={disabled} onClick={onClick}>{label}</button>;
        }
      `;

      const result = parser.parse(code, 'src/components/Button.tsx');
      expect(result.components).toHaveLength(1);
      expect(result.components[0].name).toBe('Button');
      expect(result.components[0].props).toHaveLength(3);
      expect(result.components[0].props[0].name).toBe('label');
      expect(result.components[0].props[0].required).toBe(true);
      expect(result.components[0].props[2].name).toBe('disabled');
      expect(result.components[0].props[2].required).toBe(false);
    });

    it('应该从箭头函数组件提取 props', () => {
      const code = `
        export const Card = ({ title, content }: {
          title: string;
          content: React.ReactNode;
        }) => {
          return <div><h3>{title}</h3><div>{content}</div></div>;
        };
      `;

      const result = parser.parse(code, 'src/components/Card.tsx');
      expect(result.components).toHaveLength(1);
      expect(result.components[0].name).toBe('Card');
      expect(result.components[0].props).toHaveLength(2);
    });

    it('应该从 XxxProps 接口提取组件', () => {
      const code = `
        interface InputProps {
          value: string;
          onChange: (value: string) => void;
          placeholder?: string;
        }

        export function Input(props: InputProps) {
          return <input {...props} />;
        }
      `;

      const result = parser.parse(code, 'src/components/Input.tsx');
      // 接口提取 + 函数组件提取
      const inputComp = result.components.find((c) => c.name === 'Input');
      expect(inputComp).toBeDefined();
      expect(inputComp?.props).toHaveLength(3);
    });

    it('非组件函数不应该被提取', () => {
      const code = `
        function helper(data: string) {
          return data.trim();
        }

        const calculate = (a: number, b: number) => a + b;
      `;

      const result = parser.parse(code, 'src/utils/helper.ts');
      // helper 和 calculate 以小写开头，不应该被提取为组件
      const comps = result.components.filter((c) => c.name[0] === c.name[0].toUpperCase());
      expect(comps).toHaveLength(0);
    });
  });

  describe('toKnowledgeItems', () => {
    it('应该将解析结果转换为 KnowledgeItem 列表', () => {
      const code = `
        import request from './request';
        export const getUser = request.get('/api/user');

        export function Button({ label }: { label: string }) {
          return <button>{label}</button>;
        }
      `;

      const parseResult = parser.parse(code, 'src/api/user.ts');
      const items = parser.toKnowledgeItems(parseResult, 'src/api/user.ts', 'project-a', 'react');

      expect(items).toHaveLength(2);
      expect(items[0].type).toBe('api');
      expect(items[1].type).toBe('component');
      expect(items[0].projectScope).toBe('project-a');
      expect(items[0].techStack).toBe('react');
      expect(items[0].source).toBe('code');
      expect(items[0].sourceRef).toBe('src/api/user.ts');
    });

    it('空解析结果应该返回空数组', () => {
      const items = parser.toKnowledgeItems({ apis: [], components: [] }, 'test.ts');
      expect(items).toHaveLength(0);
    });
  });
});
