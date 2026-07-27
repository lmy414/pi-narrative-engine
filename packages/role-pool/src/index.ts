// packages/role-pool/src/index.ts
/**
 * @pi/role-pool 子包入口
 *
 * 角色代理池：将事件指令 + 演员表串行演绎为结构化输出。
 *
 * 架构定位（与 @pi/world-graph、@pi/renderer、@pi/novel-importer 一致）：
 * - workspace 子包（private: true，独立开发）
 * - 通过 narrative-engine 扩展暴露 pi 工具（role_interact 等）
 * - 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync
 *
 * 角色规则集.md 是角色池的 AGENTS.md：
 * - 纯自由文本，原样注入 system prompt 开头
 * - 每次调用重读，不缓存
 */

// Re-export 类型
export type {
  SillyTavernCard,
  FactSnapshot,
  CastMember,
  InteractCommand,
  RoleAgentOutput,
  StateChange,
  PriorAction,
  InteractResult,
  InteractHooks,
  RoleLlmCaller,
  RoleCtx,
} from "./types.ts";

// Re-export 规则集加载
export { loadRoleRuleSet } from "./rule-loader.ts";

// Re-export 提示词模板（供调试/扩展）
export { buildSystemPrompt, buildUserMessage } from "./prompts.ts";

// Re-export 核心编排函数
export { interact } from "./role-pool.ts";

// Re-export 调度器转换函数（对上统一 API）
export {
  toRoleOutputs,
  extractStateChanges,
  extractRelations,
  type RelationUpdate,
} from "./transforms.ts";
