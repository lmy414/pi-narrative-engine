// packages/scheduler/src/index.ts
/**
 * @pi/scheduler 子包入口
 *
 * 调度器子包：把主会话、世界图、角色池、渲染器串起来。
 *
 * 架构定位（与 underworld-graph、@pi/role-pool、@pi/renderer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（scheduler_dispatch 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 调度器持有三种 LLM 调用器（plannerLlm / roleLlm / renderLlm）+ 一个 embedder，
 * 互不干扰，便于单测 mock 和生产环境分别配置。
 *
 * 详见 docs/plans/2026-07-25-scheduler-design.md
 *
 * 软隔离约定（2026-07-29）：
 * - 无前缀 = 公共 API（扩展层引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 */

// ============ 公共 API ============

// Re-export 默认 staticCard 加载器
export { defaultStaticCardLoader } from "./static-card-loader.ts";

// Re-export knowledge mapper 提示词模板（扩展层 knowledge-mapper-llm 引用）
export {
  buildKnowledgeMapperSystemPrompt,
  buildKnowledgeMapperUserMessage,
} from "./prompts.ts";

// Re-export 类型（扩展层引用）
export type {
  StructuredEvent,
  RetrievalPlan,
  RetrievalItem,
  PlannerLlmCaller,
  KnowledgeMapperLlmCaller,
  SchedulerCtx,
  SillyTavernCard,
} from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

// 章节锚点插入（commit.ts 内部使用；阶段 A 数据层 Ports 的 RendererPort 复用）
export { insertChapterSection as _insertChapterSection } from "./chapter-edit.ts";

// 章节路径推断（commit.ts 内部使用）
export { resolveChapterPath as _resolveChapterPath } from "./chapter-resolver.ts";

// planner 提示词模板（planner-llm 经相对路径引用，非跨包稳定 API）
export {
  buildPlannerSystemPrompt as _buildPlannerSystemPrompt,
  buildPlannerUserMessage as _buildPlannerUserMessage,
} from "./prompts.ts";

// 工具函数
export { randomId as _randomId, groupBy as _groupBy } from "./utils.ts";