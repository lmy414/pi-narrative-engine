import type { WorldGraph } from "./world-graph.ts";
import type { VisibilityDeclaration, StateDeclaration, Modality } from "./types.ts";

const INFINITY = "Infinity";

/**
 * character_view 五步过滤（飞书文档"步骤 5"）
 * 1. 查询 storyTime 时刻所有有效 StateDeclaration
 * 2. 查询 characterId 在 storyTime 时刻的所有 VisibilityDeclaration
 * 3. 取 visibility.validFrom 与 declaration.validFrom 的 max 作为有效起点
 * 4. 取 visibility.validTo 与 declaration.validTo 的 min 作为有效终点
 * 5. 过滤 state === "known" && start <= storyTime < end && modalityFilter 命中
 *
 * 注意：validTo = "Infinity" 表示未闭合，字符串比较 'I' < 'a' 会导致误判，
 * 故 min(validTo) 与 storyTime < end 均需特殊处理 Infinity。
 */
export async function characterView(
  wg: WorldGraph,
  characterId: string,
  storyTime: string,
  opts: { modalityFilter?: Modality[] } = {},
): Promise<StateDeclaration[]> {
  const allDecls = await wg.getAllDeclarationsAt(storyTime);
  const visDecls = await wg.getVisibilityForCharacter(characterId, storyTime);
  const modalityFilter = opts.modalityFilter;

  const visible: StateDeclaration[] = [];
  for (const decl of allDecls) {
    const vis = visDecls.find((v) => v.declarationId === decl.declarationId);
    if (!vis) continue;
    if (vis.state !== "known") continue;
    const start = vis.validFrom > decl.validFrom ? vis.validFrom : decl.validFrom;
    // min(validTo)：Infinity 视为大于任何有限值
    const end = vis.validTo === INFINITY
      ? decl.validTo
      : (decl.validTo === INFINITY
        ? vis.validTo
        : (vis.validTo < decl.validTo ? vis.validTo : decl.validTo));
    if (!(start <= storyTime && (end === INFINITY || storyTime < end))) continue;
    if (modalityFilter && !modalityFilter.includes(decl.modality)) continue;
    visible.push(decl);
  }
  return visible;
}

/**
 * 基础设施关系推断（飞书文档"步骤 6"）
 * 遍历 storyTime 时刻所有 located_in 关系
 * 对每条关系，把 target 实体的所有有效声明标记为 source 角色可见
 * validFrom 取角色进入时间和声明时间中较晚者
 */
export async function inferVisibility(wg: WorldGraph, storyTime: string): Promise<void> {
  const allRels = await wg.getAllRelationsAt(storyTime);
  const locatedIn = allRels.filter((r) => r.label === "located_in");
  for (const rel of locatedIn) {
    const targetDecls = await wg.getEntityAt(rel.targetId, storyTime);
    if (!targetDecls) continue;
    for (const decl of targetDecls.properties) {
      const validFrom = rel.validFrom > decl.validFrom ? rel.validFrom : decl.validFrom;
      if (validFrom > storyTime) continue;
      await wg.setVisibility(rel.sourceId, decl.declarationId, {
        state: "known",
        confidence: 1,
        source: "witnessed",
        validFrom,
        isExplicit: false,
      });
    }
  }
}
