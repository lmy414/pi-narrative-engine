/**
 * chapter-resolver.ts — 章节路径推断
 *
 * 从 storyTime 推断章节文件路径
 *
 * 🟠-22（2026-08-08）：storyTime 只接受引擎统一格式 ch<NNN>.ev<MMM>
 * （与顶层 src/chat/scheduler-tools.ts validateStoryTime 的 `^ch\d{3}\.ev\d{3}$`
 * 一致；章号范围 1-999 与 importer parseStoryTime 对齐）——旧实现还接受
 * 运行时口述格式 ch-<N>（两套格式集并存），且解析失败静默兜底第 1 章
 * （污染 `第1章-未命名.md`）。解析失败或章号越界抛错。
 *
 * 章节文件命名（与 renderer 设计一致）：
 *   <chaptersDir>/第<N>章-<title>.md
 *
 * 缺省 title 为"未命名"，主会话可后续重命名
 * 文件不存在时由 renderer.ensureChapterFile 自动创建（已实现）
 *
 * v3（2026-08-09）：chaptersDir 参数消费 novel.json 的 chaptersDir 字段——
 * 缺省 "正文" 保持兼容；禁止含 `..` 段的目录名（防路径逃逸出项目根）。
 */

import path from "node:path";

/**
 * 从 storyTime 推断章节路径
 *
 * @param cwd 工作目录（小说项目根目录，含章节目录）
 * @param storyTime 故事时间，格式 ch<NNN>.ev<MMM>（如 ch009.ev003）
 * @param chaptersDir 章节目录（相对 cwd，来自 novel.json，缺省 "正文"）
 * @returns 章节文件绝对路径
 * @throws {Error} storyTime 格式非法或章号越界（0 / >999）、chaptersDir 含 `..` 段时抛错
 *
 * @example
 * resolveChapterPath("D:/novel", "ch009.ev003")
 * // => "D:/novel/正文/第9章-未命名.md"
 */
export function resolveChapterPath(
  cwd: string,
  storyTime: string,
  chaptersDir = "正文",
): string {
  // v3（2026-08-09）：chaptersDir 来自 novel.json（用户可编辑），防 `..` 段逃逸出项目根
  if (chaptersDir.split(/[\\/]/).includes("..")) {
    throw new Error(`非法章节目录（不得含 .. 段）: ${JSON.stringify(chaptersDir)}`);
  }
  // 🟠-22（2026-08-08）：只接受引擎统一格式 ch<NNN>.ev<MMM>
  // （与 scheduler-tools validateStoryTime 的 `^ch\d{3}\.ev\d{3}$` 一致）——
  // 旧实现还接受 ch-<N> 口述格式（两套格式集并存），且解析失败静默兜底第 1 章
  // （污染 正文/第1章-未命名.md）。解析失败抛错。
  const match = storyTime.match(/^ch(\d{3})\.ev(\d{3})$/);
  if (!match) {
    throw new Error(
      `非法 storyTime（需 ch<NNN>.ev<MMM>，如 ch009.ev003）: ${JSON.stringify(storyTime)}`,
    );
  }
  const chapterNum = parseInt(match[1], 10);
  // 🟠-22 审计修正：章号范围 1-999（与 importer parseStoryTime 对齐——
  // ch000 会产出 `第0章-未命名.md` 错文件污染，正是本修复要消灭的问题）
  if (chapterNum < 1 || chapterNum > 999) {
    throw new Error(`storyTime 章号越界（需 1-999）: ${JSON.stringify(storyTime)}`);
  }
  const chapterDir = path.join(cwd, chaptersDir);
  return path.join(chapterDir, `第${chapterNum}章-未命名.md`);
}
