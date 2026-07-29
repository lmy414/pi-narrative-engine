/**
 * shared.ts — 工具域间共享的 schema 与常量
 *
 * 跨多个工具域使用的 TypeBox schema 集中放这里，避免循环依赖。
 * 单一域使用的 schema 留在该域的 tools 文件内。
 */

import { Type } from "typebox";

/**
 * 角色池结构化输出 schema（render_append / render_modify / render_preview 共用）
 *
 * 字段定义来自 @pi/role-pool 的 RoleAgentOutput，但工具入参用 plain object，
 * 由调用方（主会话/调度器）拼装。
 */
export const RoleOutputSchema = Type.Array(Type.Object({
  actor: Type.String(),
  action: Type.String(),
  target: Type.Optional(Type.String()),
  emotion: Type.Optional(Type.String()),
  relation_update: Type.Optional(Type.Array(Type.Object({
    target: Type.String(),
    label: Type.String(),
  }))),
  thought: Type.Optional(Type.String()),
  knowledge_gained: Type.Optional(Type.Array(Type.String())),
}));
