/**
 * 文档分块器（DocChunker）
 *
 * 将长文档切分为适合向量化检索的小块。
 *
 * 分块策略：
 * 1. 优先按标题层级切分（# / ## / ###）
 * 2. 如果某块超过最大大小，再按段落切分
 * 3. 块之间有重叠（overlap），保持上下文连贯性
 *
 * 飞书 raw_content 输出的纯文本，标题可能带 "#" 标记，也可能不带。
 * 本分块器兼容两种情况。
 */

/** 分块配置 */
export interface ChunkConfig {
  /** 每块最大字符数，默认 1000 */
  maxChars?: number;
  /** 块之间重叠字符数，默认 100 */
  overlapChars?: number;
  /** 最小块字符数（小于此值的块会被合并到前一块），默认 50 */
  minChars?: number;
}

/** 文档块 */
export interface DocumentChunk {
  /** 块索引（从 0 开始） */
  index: number;
  /** 块标题（如果按标题切分，为该块所属标题） */
  title?: string;
  /** 块内容 */
  content: string;
  /** 块在原文中的起始位置 */
  startOffset: number;
  /** 块在原文中的结束位置 */
  endOffset: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<ChunkConfig> = {
  maxChars: 1000,
  overlapChars: 100,
  minChars: 50,
};

/**
 * 文档分块器
 */
export class DocChunker {
  private config: Required<ChunkConfig>;

  constructor(config?: ChunkConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 将文档内容切分为块
   * @param content 文档纯文本内容
   * @param documentTitle 文档标题（用于生成块标题）
   */
  chunk(content: string, documentTitle?: string): DocumentChunk[] {
    if (!content || content.trim().length === 0) {
      return [];
    }

    // 第一步：按标题层级初步切分
    const sections = this.splitByHeadings(content, documentTitle);

    // 第二步：对超过最大大小的 section 按段落二次切分
    const chunks: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
      if (section.content.length <= this.config.maxChars) {
        // section 大小合适，直接作为一个块
        chunks.push({
          index: chunkIndex++,
          title: section.title,
          content: section.content,
          startOffset: section.startOffset,
          endOffset: section.endOffset,
        });
      } else {
        // section 过大，按段落切分
        const subChunks = this.splitByParagraphs(
          section.content,
          section.title,
          section.startOffset,
        );
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            index: chunkIndex++,
          });
        }
      }
    }

    // 第三步：合并过小的块到前一块
    return this.mergeSmallChunks(chunks);
  }

  /**
   * 按标题层级切分文档
   * 识别 Markdown 标题（# / ## / ###）和飞书 raw_content 中的标题行
   */
  private splitByHeadings(
    content: string,
    documentTitle?: string,
  ): Array<{ title?: string; content: string; startOffset: number; endOffset: number }> {
    const lines = content.split('\n');
    const sections: Array<{
      title?: string;
      content: string;
      startOffset: number;
      endOffset: number;
    }> = [];

    let currentTitle: string | undefined = documentTitle;
    let currentLines: string[] = [];
    let currentStartOffset = 0;
    let offset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLength = line.length + 1; // +1 for '\n'

      // 检测标题行
      const heading = this.detectHeading(line);

      if (heading && currentLines.length > 0) {
        // 保存当前 section
        const sectionContent = currentLines.join('\n').trim();
        if (sectionContent.length > 0) {
          sections.push({
            title: currentTitle,
            content: sectionContent,
            startOffset: currentStartOffset,
            endOffset: offset,
          });
        }
        currentLines = [];
        currentStartOffset = offset;
      }

      if (heading) {
        currentTitle = heading;
      } else {
        currentLines.push(line);
      }

      offset += lineLength;
    }

    // 保存最后一个 section
    const lastContent = currentLines.join('\n').trim();
    if (lastContent.length > 0) {
      sections.push({
        title: currentTitle,
        content: lastContent,
        startOffset: currentStartOffset,
        endOffset: offset,
      });
    }

    // 如果没有检测到任何标题，整个文档作为一个 section
    if (sections.length === 0 && content.trim().length > 0) {
      sections.push({
        title: documentTitle,
        content: content.trim(),
        startOffset: 0,
        endOffset: content.length,
      });
    }

    return sections;
  }

  /**
   * 检测一行是否为标题
   * 支持：
   * - Markdown 标题：# / ## / ### / ####
   * - 飞书 raw_content 中的标题：行首无特殊标记但行尾无标点且较短（启发式）
   */
  private detectHeading(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    // Markdown 标题
    const markdownMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (markdownMatch) {
      return markdownMatch[2].trim();
    }

    // 飞书 raw_content 标题启发式检测：
    // - 行长度 <= 50
    // - 行尾无标点符号（。！？，；：、）
    // - 不以数字或特殊字符开头
    // - 不是空行
    if (
      trimmed.length <= 50 &&
      !/[。！？，；：、.!?,;:]$/.test(trimmed) &&
      !/^[\d\-*+>=]/.test(trimmed) &&
      trimmed.length >= 2
    ) {
      // 进一步判断：如果这行看起来像标题（不含空格分隔的长句）
      if (!/\s{2,}/.test(trimmed) && trimmed.split(' ').length <= 8) {
        return trimmed;
      }
    }

    return null;
  }

  /**
   * 按段落切分过大的 section
   * 段落之间用空行分隔
   */
  private splitByParagraphs(
    content: string,
    sectionTitle: string | undefined,
    baseOffset: number,
  ): Omit<DocumentChunk, 'index'>[] {
    const paragraphs = content.split(/\n\s*\n/);
    const chunks: Omit<DocumentChunk, 'index'>[] = [];

    let currentContent = '';
    let currentStart = baseOffset;
    let offset = baseOffset;

    for (const paragraph of paragraphs) {
      const paraLength = paragraph.length + 2; // +2 for '\n\n'

      // 如果单个段落超过 maxChars，先按字符硬切分
      const segments =
        paragraph.length > this.config.maxChars
          ? this.splitByChars(paragraph, this.config.maxChars)
          : [paragraph];

      for (const segment of segments) {
        if (
          currentContent.length + segment.length > this.config.maxChars &&
          currentContent.length > 0
        ) {
          // 当前块已满，保存并开始新块
          chunks.push({
            title: sectionTitle,
            content: currentContent.trim(),
            startOffset: currentStart,
            endOffset: offset,
          });

          // 新块包含前一块的重叠部分
          const overlap = this.getOverlap(currentContent);
          currentContent = overlap;
          currentStart = offset - overlap.length;
        }

        currentContent += (currentContent ? '\n\n' : '') + segment;
      }
      offset += paraLength;
    }

    // 保存最后一块
    if (currentContent.trim().length > 0) {
      chunks.push({
        title: sectionTitle,
        content: currentContent.trim(),
        startOffset: currentStart,
        endOffset: offset,
      });
    }

    return chunks;
  }

  /**
   * 按字符数硬切分长文本
   */
  private splitByChars(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const segments: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      segments.push(text.slice(i, i + maxChars));
    }
    return segments;
  }

  /**
   * 获取前一块的重叠内容（取末尾 overlapChars 个字符，尽量在段落边界截断）
   */
  private getOverlap(content: string): string {
    if (content.length <= this.config.overlapChars) {
      return content;
    }

    const start = content.length - this.config.overlapChars;
    let overlap = content.slice(start);

    // 尽量在换行符处截断，避免截断单词
    const firstNewline = overlap.indexOf('\n');
    if (firstNewline > 0 && firstNewline < this.config.overlapChars / 2) {
      overlap = overlap.slice(firstNewline + 1);
    }

    return overlap;
  }

  /**
   * 合并过小的块到前一块
   */
  private mergeSmallChunks(chunks: DocumentChunk[]): DocumentChunk[] {
    if (chunks.length <= 1) return chunks;

    const merged: DocumentChunk[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      if (merged.length > 0 && chunk.content.length < this.config.minChars) {
        // 合并到前一块
        const prev = merged[merged.length - 1];
        prev.content = `${prev.content}\n\n${chunk.content}`;
        prev.endOffset = chunk.endOffset;
      } else {
        merged.push({ ...chunk });
      }
    }

    // 重新编号
    return merged.map((chunk, index) => ({ ...chunk, index }));
  }
}
