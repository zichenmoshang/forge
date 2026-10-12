/**
 * DocChunker（文档分块器）单元测试
 */

import { describe, it, expect } from 'vitest';
import { DocChunker } from '../../src/integrations/feishu/doc-chunker';

describe('DocChunker', () => {
  describe('基本功能', () => {
    it('空内容返回空数组', () => {
      const chunker = new DocChunker();
      const chunks = chunker.chunk('');
      expect(chunks).toEqual([]);
    });

    it('纯空白内容返回空数组', () => {
      const chunker = new DocChunker();
      const chunks = chunker.chunk('   \n\n  \n  ');
      expect(chunks).toEqual([]);
    });

    it('短文档不切分，返回一个块', () => {
      const chunker = new DocChunker({ maxChars: 1000 });
      const content = '这是一段简短的文档内容。';
      const chunks = chunker.chunk(content, '测试文档');
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(content);
      expect(chunks[0].title).toBe('测试文档');
      expect(chunks[0].index).toBe(0);
    });
  });

  describe('按标题切分', () => {
    it('Markdown 标题切分', () => {
      const chunker = new DocChunker({ maxChars: 1000, minChars: 5 });
      const content = `# 第一章

这是第一章的内容，包含足够多的文字以避免被合并。

## 1.1 小节

这是 1.1 小节的内容，也包含足够多的文字。

# 第二章

这是第二章的内容，同样包含足够多的文字以避免被合并。`;

      const chunks = chunker.chunk(content, '测试文档');
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // 第一个块应该包含第一章
      expect(chunks[0].content).toContain('第一章');
      // 最后一个块应该包含第二章
      expect(chunks[chunks.length - 1].content).toContain('第二章');
    });

    it('标题块携带标题信息', () => {
      const chunker = new DocChunker({ maxChars: 1000, minChars: 5 });
      const content = `# 技术方案

这是技术方案的概述，包含足够多的文字以避免被合并到其他块。

# 接口设计

这是接口设计的内容，也包含足够多的文字以避免被合并。`;

      const chunks = chunker.chunk(content);
      expect(chunks.length).toBe(2);
      expect(chunks[0].title).toBe('技术方案');
      expect(chunks[1].title).toBe('接口设计');
    });
  });

  describe('按段落切分（大文档）', () => {
    it('超过 maxChars 的 section 按段落切分', () => {
      const chunker = new DocChunker({ maxChars: 100, overlapChars: 10, minChars: 10 });
      // 生成一个长段落（每段超过 100 字符）
      const longParagraph = '这是一段很长的内容，用于测试分块功能是否正常工作。'.repeat(5);
      const content = `# 标题

${longParagraph}

${longParagraph}`;

      const chunks = chunker.chunk(content);
      expect(chunks.length).toBeGreaterThan(1);
      // 每个块的内容长度不超过 maxChars + 一些余量
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(200); // 允许一定余量
      }
    });

    it('块之间有重叠', () => {
      const chunker = new DocChunker({ maxChars: 50, overlapChars: 20, minChars: 5 });
      const content = 'A'.repeat(30) + '\n\n' + 'B'.repeat(30) + '\n\n' + 'C'.repeat(30);
      const chunks = chunker.chunk(content);
      expect(chunks.length).toBeGreaterThan(1);
      // 相邻块之间应该有内容重叠
      if (chunks.length >= 2) {
        const overlap = chunks[0].content.slice(-20);
        expect(chunks[1].content).toContain(overlap.slice(0, 5));
      }
    });
  });

  describe('小块合并', () => {
    it('过小的块合并到前一块', () => {
      const chunker = new DocChunker({ maxChars: 1000, minChars: 50 });
      const content = `# 第一章

这是第一章的内容，足够长。

# 第二章

短`;

      const chunks = chunker.chunk(content);
      // "短" 这个块应该被合并到前一块
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toContain('短');
    });
  });

  describe('偏移量', () => {
    it('块的 startOffset 和 endOffset 正确', () => {
      const chunker = new DocChunker({ maxChars: 1000 });
      const content = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
      const chunks = chunker.chunk(content);
      expect(chunks.length).toBe(1);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBeGreaterThan(0);
      expect(chunks[0].endOffset).toBeLessThanOrEqual(content.length + 5);
    });
  });

  describe('索引编号', () => {
    it('块索引从 0 开始连续编号', () => {
      const chunker = new DocChunker({ maxChars: 50, overlapChars: 10, minChars: 5 });
      const content = 'A'.repeat(100);
      const chunks = chunker.chunk(content);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });
});
