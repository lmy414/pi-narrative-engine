// src/index.ts
/**
 * @pi/renderer 子包入口
 *
 * 渲染器子包：将叙事指令+角色池结构化数据渲染为指定文风格式的文本。
 *
 * 架构定位（与 @pi/world-graph、@pi/novel-importer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（render_append 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 规则集.md 是渲染器的 AGENTS.md：
 * - 纯自由文本，原样注入渲染器用户消息末尾
 * - 每次渲染重读，不缓存
 */

// Re-export 类型
export type {
  RoleOutput,
  RenderTextCommand,
  RenderFileCommand,
  RenderResult,
  RenderLlmCaller,
  RenderCtx,
} from "./types.ts";

// Re-export 规则集加载
export { loadRuleSet } from "./rule-loader.ts";

// Re-export 章节文件读写（供检验工具/调度器复用）
export {
  readChapter,
  readChapterSection,
  appendToChapter,
  modifyChapterSection,
  ensureChapterFile,
  CHAPTER_VERSION_MARKER,
  EVENT_ANCHOR_PREFIX,
} from "./chapter-io.ts";

// Re-export 提示词模板（供调试/扩展）
export {
  RENDERER_SYSTEM_PROMPT,
  buildUserMessage,
} from "./prompts.ts";

// Re-export 核心渲染函数
export {
  renderText,
  renderToFile,
} from "./renderer.ts";
