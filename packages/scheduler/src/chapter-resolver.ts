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
 *   正文/第<N>章-<title>.md
 *
 * 缺省 title 为"未命名"，主会话可后续重命名
 * 文件不存在时由 renderer.ensureChapterFile 自动创建（已实现）
 */

import path from "node:path";

/**
 * 从 storyTime 推断章节路径
 *
 * @param cwd 工作目录（小说项目根目录，含"正文/"子目录）
 * @param storyTime 故事时间，格式 ch<NNN>.ev<MMM>（如 ch009.ev003）
 * @returns 章节文件绝对路径
 * @throws {Error} storyTime 格式非法或章号越界（0 / >999）时抛错（不静默兜底）
 *
 * @example
 * resolveChapterPath("D:/novel", "ch009.ev003")
 * // => "D:/novel/正文/第9章-未命名.md"
 */
export function resolveChapterPath(cwd: string, storyTime: string): string {
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
  const 正文Dir = path.join(cwd, "正文");
  return path.join(正文Dir, `第${chapterNum}章-未命名.md`);
}
