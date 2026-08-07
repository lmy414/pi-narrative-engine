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

// 🟠-21 扩展（2026-08-08）：进程内 per-file 写锁——整文件读-改-写（append/modify）
// 与调度器 insertChapterSection 并发时后写者基于旧内容整体覆盖、先写者区块静默丢失。
// 本锁放 renderer 层并导出，scheduler 的 insert 复用同一把锁（跨模块共享）。
const fileLocks = new Map<string, Promise<unknown>>();

/**
 * 按文件路径串行化读-改-写操作（跨模块共享：append/modify/insert 同一把锁）
 *
 * 🟠-21 审计修正：锁键归一化（path.resolve + win32 盘符小写折叠）——同一文件
 * 在正斜杠/反斜杠、盘符大小写混合拼写下必须落入同一锁链，否则跨模块竞态
 * 仍可静默复现（LLM 将路径归一为正斜杠即触发）。
 */
export function withChapterFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  let key = path.resolve(filePath);
  if (process.platform === "win32") key = key.toLowerCase();
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  fileLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

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
  // 🟠-21 扩展：整文件读-改-写包进共享 per-path 锁（与 modify/insert 并发安全）
  return withChapterFileLock(chapterPath, async () => {
    await ensureChapterFile(chapterPath);
    const existing = await readChapter(chapterPath);

    // 🟠-13（2026-08-08）：append 防重——同 eventId 重复追加产生双锚点，
    // modify/read 永远命中首个、第二个区块成孤儿（LLM 复用 evt_ id 或失败重试时触发）。
    // 抛错让调用方感知（renderToFile 返回 error），不静默制造孤儿区块
    if (existing.includes(`<!-- event: ${eventId} -->`)) {
      throw new Error(`事件 ${eventId} 已在章节中存在锚点，拒绝重复追加: ${chapterPath}`);
    }
    // 🟠-13 审计修正：防御性格式校验——畸形 ID（含 " -->" / 换行）可伪造
    // 锚点子串绕过上方守卫（schema 层已收紧 pattern，此处兜底非 schema 调用方）
    if (!/^evt_[A-Za-z0-9_.-]+$/.test(eventId)) {
      throw new Error(`非法事件 ID（需 evt_ 前缀字母数字下划线点连字符）: ${JSON.stringify(eventId)}`);
    }

    // 确保文本末尾有换行
    const normalizedText = text.endsWith("\n") ? text : text + "\n";

    // 拼接：如果现有内容末尾没有空行，补一个
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";

    const block = `${separator}<!-- event: ${eventId} -->\n\n${normalizedText}`;
    await fs.writeFile(chapterPath, existing + block, "utf8");
  });
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
  // 🟠-21 扩展：整文件读-改-写包进共享 per-path 锁（与 append/insert 并发安全）
  return withChapterFileLock(chapterPath, async () => {
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
  });
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
