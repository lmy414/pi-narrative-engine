/**
 * transforms.ts — 调度器转换函数
 *
 * 角色池输出（RoleAgentOutput）→ 调度器下游所需的结构化数据：
 * - toRoleOutputs: 投影为渲染器格式（去掉 state_changes，保留 7 字段）
 * - extractStateChanges: 提取所有 state_changes（扁平化，结构兼容 world_event_apply 的 newFacts）
 * - extractRelations: 提取所有 relation_update（关联 actor 作为 source，供 world_relation_add）
 *
 * 设计原则：
 * - 纯函数，无副作用，无 LLM 调用
 * - 不做实体消解（target 是名字还是 ID 由调度器判断）
 * - 不做可见性推断（knowledge_gained 的自然语言→declarationId 需 LLM，由调度器处理）
 */

import type { RoleAgentOutput, StateChange } from "./types.ts";

/**
 * 带来源的关系变更（供 world_relation_add）
 * source 取自 RoleAgentOutput.actor
 */
export interface RelationUpdate {
  source: string;
  target: string;
  label: string;
}

/**
 * 投影为渲染器格式：去掉 state_changes，保留其余 7 字段
 *
 * 返回类型用 Omit 表达，结构上兼容 @pi/renderer 的 RoleOutput，
 * 调度器可直接传给 render_append / render_modify / render_preview。
 *
 * @param outputs 角色池原始输出
 */
export function toRoleOutputs(
  outputs: RoleAgentOutput[],
): Omit<RoleAgentOutput, "state_changes">[] {
  return outputs.map(({ state_changes: _omit, ...rest }) => rest);
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
 * 提取所有角色的 relation_update，关联 actor 作为 source
 *
 * 返回结构供 world_relation_add 使用（需 sourceId + targetId + label）。
 * 注意：source/target 是角色名（actor 字段），调度器需自行解析为 entityId。
 *
 * @param outputs 角色池原始输出
 */
export function extractRelations(outputs: RoleAgentOutput[]): RelationUpdate[] {
  const rels: RelationUpdate[] = [];
  for (const out of outputs) {
    if (out.relation_update) {
      for (const rel of out.relation_update) {
        rels.push({
          source: out.actor,
          target: rel.target,
          label: rel.label,
        });
      }
    }
  }
  return rels;
}
