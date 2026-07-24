/**
 * transforms.ts — 调度器转换函数
 *
 * 角色池输出（RoleAgentOutput）→ 调度器下游所需的结构化数据：
 * - toRoleOutputs: 投影为渲染器格式（去掉 state_changes 和 characterId，保留渲染器需要的字段）
 * - extractStateChanges: 提取所有 state_changes（扁平化，结构兼容 world_event_apply 的 newFacts）
 * - extractRelations: 提取所有 relation_update（关联 characterId 作为 source，供 world_relation_add）
 *
 * 设计原则：
 * - 纯函数，无副作用，无 LLM 调用
 * - 不做实体消解（role-pool prompt 已让 LLM 直接输出 characterId）
 * - 不做可见性推断（knowledge_gained 的自然语言→declarationId 需 LLM，由调度器处理）
 *
 * 2026-07-25 解决 Pending Gap #2：
 * - extractRelations 的 source 改用 RoleAgentOutput.characterId（不再用 actor 名字）
 * - relation_update.target 由 LLM 直接输出对方 characterId（不再需要"消解"）
 */

import type { RoleAgentOutput, StateChange } from "./types.ts";

/**
 * 带来源的关系变更（供 world_relation_add）
 * source 取自 RoleAgentOutput.characterId
 * target 取自 relation_update.target（LLM 直接输出 characterId）
 */
export interface RelationUpdate {
  source: string;
  target: string;
  label: string;
}

/**
 * 投影为渲染器格式：去掉 state_changes 和 characterId
 *
 * 渲染器只需要 actor（名字）等可读字段，不需要 characterId（调度器专用）。
 * 返回类型用 Omit 表达，结构上兼容 @pi/renderer 的 RoleOutput，
 * 调度器可直接传给 render_append / render_modify / render_preview。
 *
 * @param outputs 角色池原始输出
 */
export function toRoleOutputs(
  outputs: RoleAgentOutput[],
): Omit<RoleAgentOutput, "state_changes" | "characterId">[] {
  return outputs.map(({ state_changes: _omit, characterId: _omit2, ...rest }) => rest);
}

/**
 * 提取所有角色的 state_changes，扁平化为一个数组
 *
 * 返回结构兼容 world_event_apply 的 newFacts 字段
 * （StateChange 与 newFacts 元素结构一致：entityId/property/value/modality）
 *
 * @param outputs 角色池原始输出
 */
export function extractStateChanges(outputs: RoleAgentOutput[]): StateChange[] {
  const facts: StateChange[] = [];
  for (const out of outputs) {
    if (out.state_changes) {
      for (const change of out.state_changes) {
        facts.push(change);
      }
    }
  }
  return facts;
}

/**
 * 提取所有角色的 relation_update，关联 characterId 作为 source
 *
 * 返回结构供 world_relation_add 使用（需 sourceId + targetId + label）。
 * source 取自 RoleAgentOutput.characterId（LLM 直接输出，无需消解）
 * target 取自 relation_update.target（LLM 直接输出对方 characterId，无需消解）
 *
 * @param outputs 角色池原始输出
 */
export function extractRelations(outputs: RoleAgentOutput[]): RelationUpdate[] {
  const rels: RelationUpdate[] = [];
  for (const out of outputs) {
    if (out.relation_update) {
      for (const rel of out.relation_update) {
        rels.push({
          source: out.characterId,
          target: rel.target,
          label: rel.label,
        });
      }
    }
  }
  return rels;
}
