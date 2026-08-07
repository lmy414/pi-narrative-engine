/**
 * chapter-edit.ts — 调度器内部的章节文本编辑工具
 *
 * 提供章节文件锚点级别的"插入"操作（renderer 未提供 insert 模式）。
 * 复用 renderer 导出的章节读写原语，不修改 renderer 代码。
 *
 * 设计依据：Pending Gap #4 — modify/insert 模式 + 回退机制
 * 约束：不动 renderer/world-graph 已完成模块的代码，只用其导出的 API
 *
 * 三种 intent 的章节文本处理：
 * - add：renderer.renderToFile(mode="append") — 已有，commit.ts 直接调
 * - modify：renderer.renderToFile(mode="modify", modifyAnchorEventId) — 已有，commit.ts 直接调
 * - insert：renderer.renderText 生成文本 + 本文件的 insertChapterSection 插入
 *   （renderer 无 insert 模式，调度器自行处理文件插入）
 */

import { promises as fs } from "node:fs";
import {
  readChapter,
  ensureChapterFile,
  EVENT_ANCHOR_PREFIX,
  withChapterFileLock,
} from "@pi/renderer";

/**
 * 在指定锚点之后插入新事件区块
 *
 * 定位规则：
 * - 找到 <!-- event: <afterEventId> --> 锚点
 * - 在该锚点所在区块（到下一锚点前或文件末尾）之后插入新区块
 * - 新区块格式：<!-- event: <newEventId> -->\n\n<text>
 *
 * 与 renderer.modifyChapterSection 的区别：
 * - modifyChapterSection：替换锚点区间内容（保留锚点，替换正文）
 * - insertChapterSection：保留锚点区间，在后面插入新区块
 *
 * @param chapterPath 章节文件路径
 * @param afterEventId 插入位置锚点事件 ID（新内容插在此事件区块之后）
 * @param newEventId 新事件 ID（用于新区块的锚点）
 * @param text 新事件正文
 *
 * @throws {Error} 若 afterEventId 锚点在文件中不存在
 */
export async function insertChapterSection(
  chapterPath: string,
  afterEventId: string,
  newEventId: string,
  text: string,
): Promise<void> {
  // 🟠-21（2026-08-08）：整文件读-改-写包进 renderer 共享 per-path 锁——
  // 与主会话 render_append/render_modify（同样经 withChapterFileLock）并发时
  // 串行化，不再静默丢区块（跨模块共享同一把锁）
  return withChapterFileLock(chapterPath, async () => {
    await ensureChapterFile(chapterPath);
    const content = await readChapter(chapterPath);

    const anchor = `<!-- event: ${afterEventId} -->`;
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx === -1) {
      throw new Error(
        `锚点 ${anchor} 未找到，无法在该事件之后插入`,
      );
    }
    // 🟡（2026-08-08）：锚点重复时拒绝（此前 indexOf 取首处静默错位——往
    // 错误区块后插入，用户以为插在目标事件后）
    if (content.indexOf(anchor, anchorIdx + anchor.length) !== -1) {
      throw new Error(
        `锚点 ${anchor} 在文件中重复出现，无法确定插入位置`,
      );
    }
    // 🟡 审计修正：新锚点 newEventId 防重（与 append 的 🟠-13 对称——insert
    // 复用既有 evt_ id 会制造双锚点孤儿区块）
    if (content.includes(`<!-- event: ${newEventId} -->`)) {
      throw new Error(
        `新事件 ID ${newEventId} 已在章节中存在锚点，拒绝重复插入: ${chapterPath}`,
      );
    }

    // 锚点之后开始查找下一个锚点
    const afterAnchor = anchorIdx + anchor.length;
    const nextAnchorIdx = content.indexOf(EVENT_ANCHOR_PREFIX, afterAnchor);

    // 标准化新文本（确保末尾换行）
    const normalizedText = text.endsWith("\n") ? text : text + "\n";
    const newBlock = `<!-- event: ${newEventId} -->\n\n${normalizedText}`;

    let newContent: string;
    if (nextAnchorIdx === -1) {
      // 无下一锚点：在文件末尾追加新区块（与 appendToChapter 分隔逻辑一致）
      const separator = content.endsWith("\n\n")
        ? ""
        : content.endsWith("\n")
          ? "\n"
          : "\n\n";
      newContent = content + separator + newBlock;
    } else {
      // 有下一锚点：在下一锚点之前插入新区块
      const before = content.slice(0, nextAnchorIdx);
      const after = content.slice(nextAnchorIdx);
      // 确保 before 末尾有空行分隔（before 末尾可能是 \n、\n\n 或无 \n）
      let sep: string;
      if (before.endsWith("\n\n")) {
        sep = "";
      } else if (before.endsWith("\n")) {
        sep = "\n";
      } else {
        sep = "\n\n";
      }
      // 新区块和下一锚点之间用 \n 分隔（使下一锚点前有空行）
      newContent = before + sep + newBlock + "\n" + after;
    }

    await fs.writeFile(chapterPath, newContent, "utf8");
  });
}
