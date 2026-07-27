// packages/scheduler/src/index.ts
/**
 * @pi/scheduler 子包入口
 *
 * 调度器子包：把主会话、世界图、角色池、渲染器串起来。
 *
 * 架构定位（与 @pi/world-graph、@pi/role-pool、@pi/renderer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（scheduler_dispatch 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 调度器持有三种 LLM 调用器（plannerLlm / roleLlm / renderLlm）+ 一个 embedder，
 * 互不干扰，便于单测 mock 和生产环境分别配置。
 *
 * 详见 docs/plans/2026-07-25-scheduler-design.md
 */

// Re-export 核心编排函数
export { plan } from "./plan.ts";
export { commit } from "./commit.ts";

// Re-export 缓存与 discard（discard 是 plan.ts 不直接导出的对外接口）
export {
  discard,
  getPlan,
  setPlan,
  deletePlan,
  resetPlanCache,
  planCacheSize,
  loadAllPlans,
  removePlansDir,
} from "./cache.ts";

// Re-export 检索执行器
export { executeRetrievalItem } from "./retrieve.ts";

// Re-export 章节路径推断
export { resolveChapterPath } from "./chapter-resolver.ts";

// Re-export 默认 staticCard 加载器
export { defaultStaticCardLoader } from "./static-card-loader.ts";

// Re-export planner 提示词模板 + knowledge mapper 提示词（P0-3+6，2026-07-27）
export {
  buildPlannerSystemPrompt,
  buildPlannerUserMessage,
  buildKnowledgeMapperSystemPrompt,
  buildKnowledgeMapperUserMessage,
} from "./prompts.ts";

// Re-export 工具函数
export { randomId, groupBy } from "./utils.ts";

// Re-export 调试事件总线（2026-07-27 新增）
export { startSpan, newTraceId } from "./debug.ts";

// Re-export 类型
export type {
  SillyTavernCard,
  FactSnapshot,
  StructuredEvent,
  RetrievalPlan,
  RetrievalItem,
  PlannerLlmCaller,
  KnowledgeMapperLlmCaller,
  PlanResult,
  PlanOutput,
  CommitResult,
  SchedulerCtx,
  DispatchPlanOutput,
  DispatchYoloOutput,
} from "./types.ts";

export type { DebugBus, DebugSpan, DebugEvent } from "./debug.ts";
