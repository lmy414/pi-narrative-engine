// src/index.ts
/**
 * @pi/renderer 子包入口
 *
 * 渲染器子包：将叙事指令+角色池结构化数据渲染为指定文风格格式的文本。
 *
 * 架构定位（与 @pi/world-graph、@pi/novel-importer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（render_append 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 规则集.md 是渲染器的 AGENTS.md：
 * - 纯自由文本，原样注入渲染器用户消息末尾
 * - 每次渲染重读，不缓存
 *
 * 软隔离约定（2026-07-29）：
 * - 无前缀 = 公共 API（scheduler 子包与扩展层引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 */

// ============ 公共 API ============

// Re-export 核心渲染函数
export {
  renderText,
  renderToFile,
} from "./renderer.ts";

// Re-export 规则集加载
export { loadRuleSet } from "./rule-loader.ts";

// Re-export 章节文件读写（供 scheduler/检验工具复用）
export {
  readChapter,
  readChapterSection,
  ensureChapterFile,
  CHAPTER_VERSION_MARKER,
  EVENT_ANCHOR_PREFIX,
} from "./chapter-io.ts";

// Re-export 类型（scheduler 子包与扩展层引用）
export type {
  RoleOutput,
  RenderTextCommand,
  RenderFileCommand,
  RenderResult,
  RenderLlmCaller,
} from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// 章节文件修改（仅本包 renderer.ts 内部使用）
export {
  appendToChapter as _appendToChapter,
  modifyChapterSection as _modifyChapterSection,
} from "./chapter-io.ts";

// 提示词模板常量与构造（仅调试/扩展用，非稳定 API）
export {
  RENDERER_SYSTEM_PROMPT as _RENDERER_SYSTEM_PROMPT,
  buildUserMessage as _buildUserMessage,
} from "./prompts.ts";

// 渲染上下文类型（仅本包内部使用）
export type { RenderCtx as _RenderCtx } from "./types.ts";
