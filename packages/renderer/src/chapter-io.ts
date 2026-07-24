/**
 * chapter-io.ts — 章节文件读写 + 锚点定位
 *
 * 章节文件格式约定：
 * - 首行固定 <!-- engine v0.01 -->（版本标记）
 * - 每个事件渲染产物前插入 <!-- event: <eventId> --> 锚点
 * - 锚点后空一行，接正文
 *
 * 示例：
 *   <!-- engine v0.01 -->
 *
 *   <!-- event: evt_001 -->
 *
 *   林墨推开酒馆的门。
 *
 *   <!-- event: evt_002 -->
 *
 *   「师弟，许久不见。」
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 章节文件版本标记（首行固定） */
export const CHAPTER_VERSION_MARKER = "<!-- engine v0.01 -->";

/** 事件锚点前缀（如 <!-- event: evt_001 -->） */
export const EVENT_ANCHOR_PREFIX = "<!-- event:";

/**
 * 确保章节文件存在：不存在则创建并写入版本标记，已存在则不覆盖
 */
export async function ensureChapterFile(chapterPath: string): Promise<void> {
  try {
    await fs.access(chapterPath);
    // 文件已存在，不覆盖
    return;
  } catch {
    // 文件不存在，创建目录并写入版本标记
    await fs.mkdir(path.dirname(chapterPath), { recursive: true });
    await fs.writeFile(chapterPath, CHAPTER_VERSION_MARKER + "\n", "utf8");
  }
}

/**
 * 读取整个章节文件内容
 */
export async function readChapter(chapterPath: string): Promise<string> {
  return await fs.readFile(chapterPath, "utf8");
}

/**
 * 在文件末尾追加事件锚点 + 渲染文本
 *
 * 格式：
 *   <!-- event: <eventId> -->
 *
 *   <text>
 *
 */
export async function appendToChapter(
  chapterPath: string,
  eventId: string,
  text: string,
): Promise<void> {
  await ensureChapterFile(chapterPath);
  const existing = await readChapter(chapterPath);

  // 确保文本末尾有换行
  const normalizedText = text.endsWith("\n") ? text : text + "\n";

  // 拼接：如果现有内容末尾没有空行，补一个
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";

  const block = `${separator}<!-- event: ${eventId} -->\n\n${normalizedText}`;
  await fs.writeFile(chapterPath, existing + block, "utf8");
}

/**
 * 重写指定锚点区间的内容
 *
 * 定位规则：
 * - 找到 <!-- event: <anchorEventId> --> 锚点
 * - 重写该锚点到下一锚点（或文件末尾）之间的内容
 * - 锚点本身保留，只替换锚点后的正文
 *
 * @param chapterPath 章节文件路径
 * @param anchorEventId 要重写的目标事件 ID
 * @param newText 新的正文文本
 */
export async function modifyChapterSection(
  chapterPath: string,
  anchorEventId: string,
  newText: string,
): Promise<void> {
  const content = await readChapter(chapterPath);
  const anchor = `<!-- event: ${anchorEventId} -->`;

  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`锚点 ${anchor} 未找到`);
  }

  // 锚点后的起始位置
  const afterAnchor = anchorIdx + anchor.length;

  // 查找下一个锚点
  const nextAnchorIdx = content.indexOf(EVENT_ANCHOR_PREFIX, afterAnchor);

  // 确保新文本末尾有换行
  const normalizedText = newText.endsWith("\n") ? newText : newText + "\n";

  // 构建新内容：锚点前部分 + 锚点 + 新正文 + 下一锚点开始的部分
  const before = content.slice(0, afterAnchor);
  let after: string;
  if (nextAnchorIdx === -1) {
    // 没有下一锚点，替换到文件末尾
    after = `\n\n${normalizedText}`;
  } else {
    // 有下一锚点，保留从下一锚点开始的内容
    after = `\n\n${normalizedText}\n${content.slice(nextAnchorIdx)}`;
  }

  await fs.writeFile(chapterPath, before + after, "utf8");
}

/**
 * 读取章节文件中指定锚点区间的文本
 *
 * @param chapterPath 章节文件路径
 * @param startEventId 起始锚点事件 ID
 * @param endEventId 结束锚点事件 ID（不包含，缺省时读到下一锚点前或文件末尾）
 */
export async function readChapterSection(
  chapterPath: string,
  startEventId?: string,
  endEventId?: string,
): Promise<string> {
  const content = await readChapter(chapterPath);

  if (!startEventId) {
    return content;
  }

  const startAnchor = `<!-- event: ${startEventId} -->`;
  const startIdx = content.indexOf(startAnchor);
  if (startIdx === -1) {
    throw new Error(`锚点 ${startAnchor} 未找到`);
  }

  const afterStart = startIdx + startAnchor.length;

  if (endEventId) {
    const endAnchor = `<!-- event: ${endEventId} -->`;
    const endIdx = content.indexOf(endAnchor, afterStart);
    if (endIdx === -1) {
      // 结束锚点不存在，读到末尾
      return content.slice(startIdx);
    }
    return content.slice(startIdx, endIdx);
  }

  // 无 endEventId：从 startIdx 读到下一锚点前（或 EOF）
  const nextAnchorIdx = content.indexOf(EVENT_ANCHOR_PREFIX, afterStart);
  if (nextAnchorIdx === -1) {
    return content.slice(startIdx);
  }
  return content.slice(startIdx, nextAnchorIdx);
}
