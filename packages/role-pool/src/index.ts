// packages/role-pool/src/index.ts
/**
 * @pi/role-pool 子包入口
 *
 * 角色代理池：将事件指令 + 演员表串行演绎为结构化输出。
 *
 * 架构定位（与 underworld-graph、@pi/renderer、@pi/novel-importer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（role_interact 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 角色规则集.md 是角色池的 AGENTS.md：
 * - 纯自由文本，原样注入 system prompt 开头
 * - 每次调用重读，不缓存
 *
 * 软隔离约定（2026-07-29）：
 * - 无前缀 = 公共 API（scheduler 子包与扩展层引用）
 * - _ 前缀 = 包内部实现，不保证稳定
 */

// ============ 公共 API ============

// Re-export 核心编排函数
export { interact } from "./role-pool.ts";

// Re-export 调度器转换函数（对上统一 API）
export {
  toRoleOutputs,
  extractStateChanges,
  extractRelations,
} from "./transforms.ts";

// Re-export 规则集加载
export { loadRoleRuleSet } from "./rule-loader.ts";

// Re-export 类型（scheduler 子包与扩展层引用）
export type {
  CastMember,
  InteractCommand,
  InteractHooks,
  InteractResult,
  RoleAgentOutput,
  RoleLlmCaller,
  StateChange,
} from "./types.ts";

// ============ 内部导出（_ 前缀，软隔离） ============

export type {
  SillyTavernCard as _SillyTavernCard,
  FactSnapshot as _FactSnapshot,
  PriorAction as _PriorAction,
  RoleCtx as _RoleCtx,
} from "./types.ts";

export type { RelationUpdate as _RelationUpdate } from "./transforms.ts";

// Re-export 提示词模板（仅调试/扩展用，非稳定 API）
export {
  buildSystemPrompt as _buildSystemPrompt,
  buildUserMessage as _buildUserMessage,
  BUILTIN_ROLE_RULES as _BUILTIN_ROLE_RULES,
} from "./prompts.ts";
