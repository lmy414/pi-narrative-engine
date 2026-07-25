/**
 * chapter-resolver.ts — 章节路径推断
 *
 * 从 storyTime 推断章节文件路径
 *
 * storyTime 支持两种格式（2026-07-25 统一，审计 Q3）：
 * - 运行时口述格式：ch-<N>（如 ch-2）
 * - 导入器事件格式：ch<NNN>.ev<MMM>（如 ch009.ev003，取章节号 9）
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
 * @param storyTime 故事时间，格式 ch-<N>（如 ch-2）
 * @returns 章节文件绝对路径
 *
 * @example
 * resolveChapterPath("D:/novel", "ch-2")
 * // => "D:/novel/正文/第2章-未命名.md"
 *
 * resolveChapterPath("D:/novel", "ch009.ev003")
 * // => "D:/novel/正文/第9章-未命名.md"
 *
 * resolveChapterPath("D:/novel", "invalid")
 * // => "D:/novel/正文/第1章-未命名.md"（兜底用第 1 章）
 */
export function resolveChapterPath(cwd: string, storyTime: string): string {
  // 双格式兼容：ch-<N> 或 ch<NNN>.ev<MMM>
  const match = storyTime.match(/^ch-?(\d+)(?:\.ev\d+)?$/);
  const chapterNum = match ? parseInt(match[1], 10) : 1;
  const 正文Dir = path.join(cwd, "正文");
  return path.join(正文Dir, `第${chapterNum}章-未命名.md`);
}
