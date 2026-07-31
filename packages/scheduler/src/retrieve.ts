/**
 * retrieve.ts — 检索项执行器
 *
 * 设计文档 §3.1 executeRetrievalItem 的实现
 *
 * 按 RetrievalItem.type 派发到对应 world-graph API：
 * - character_view  → wg.getCharacterView(entityId, storyTime)
 * - entity_snapshot → wg.getEntityAt(entityId, storyTime)
 * - relations       → wg.getRelations(entityId, storyTime)
 * - search_text     → wg.search.fulltext(nodeType ?? "Fact", { query, limit })
 * - search_vector   → ctx.embedder.embed(query) → wg.search.vector(nodeType ?? "Entity", { fieldPath, queryEmbedding, limit })
 * - search_hybrid   → ctx.embedder.embed(query) → wg.search.hybrid(nodeType ?? "Fact", { vector, fulltext, limit })
 *
 * 检索结果统一转换为 FactSnapshot[] 格式，便于下游 dynamicFacts 拼装
 *
 * [2026-07-25 修正] 原设计文档假设 search API 是 `search.fulltext(query, limit)`，
 * 实际真实 API 是 `search.fulltext(nodeKind, options)`，需要 nodeKind 第一参数。
 * 此外 vector/hybrid 需要 queryEmbedding（512 维数值向量），planner LLM 输出的
 * 自然语言 query 必须经 ctx.embedder 转 embedding。
 *
 * nodeType 缺省值参考 src/search.ts 现成模式：
 * - search_text 默认搜 "Fact"（property/valueText 是 searchable 字段）
 * - search_vector 默认搜 "Entity"（embedding 字段）
 * - search_hybrid 默认搜 "Fact"（同时有 searchable 和 embedding 字段）
 */

import type { WorldGraph } from "underworld-graph";
import type { StateDeclaration } from "underworld-graph";
import type { FactSnapshot, RetrievalItem, SchedulerCtx } from "./types.ts";
import { randomId } from "./utils.ts";

/**
 * StoreSearch hit 的结构（窄化类型）
 *
 * 真实返回是 { node: NodeProps; score: number; rank: number }[]
 * 其中 NodeProps 是节点 schema 的 props 对象（Record<string, unknown>）
 *
 * 调度器只关心 node.entityId（Entity/Fact/Relation 节点都有此字段），
 * 其他字段按 nodeType 不同提取，使用窄化类型断言避免 any 满天飞。
 *
 * 参考：src/search.ts 的 resolveEntitiesFromFacts 用了同样模式
 */
interface SearchHit {
  node: {
    entityId?: string;
    declarationId?: string;
    property?: string;
    value?: unknown;
    valueText?: string;
    modality?: "fact" | "belief" | "hypothesis";
    validFrom?: string;
    sourceId?: string;
    targetId?: string;
    label?: string;
    summary?: string;
    type?: string;
    [key: string]: unknown;
  };
  score: number;
  rank: number;
}

/**
 * 按 RetrievalItem 执行单条检索（pi 工具机制的实现层）
 *
 * @param ctx 调度器上下文（含 wg + embedder）
 * @param item 检索项
 * @param storyTime 故事时间
 * @returns FactSnapshot[] 或 null（必填字段缺失时返回 null 跳过该项）
 */
export async function executeRetrievalItem(
  ctx: SchedulerCtx,
  item: RetrievalItem,
  storyTime: string,
): Promise<FactSnapshot[] | null> {
  switch (item.type) {
    // ---------------------------------------------------------------
    // character_view：某角色可见的所有状态声明
    // ---------------------------------------------------------------
    case "character_view": {
      if (!item.params.entityId) return null;
      // P0-2 修复：透传 recordedAsOf 给 wg.getCharacterView
      const opts: { modalityFilter?: ("fact" | "belief" | "hypothesis")[]; recordedAsOf?: string } = {};
      if (item.params.modalityFilter) opts.modalityFilter = item.params.modalityFilter;
      if (item.params.recordedAsOf) opts.recordedAsOf = item.params.recordedAsOf;
      const decls = await ctx.wg.getCharacterView(
        item.params.entityId,
        storyTime,
        opts,
      );
      return decls.map((d) => stateDeclToFact(d));
    }

    // ---------------------------------------------------------------
    // entity_snapshot：某实体的完整快照（含所有属性，不管可见性）
    // ---------------------------------------------------------------
    case "entity_snapshot": {
      if (!item.params.entityId) return null;
      // P0-2 修复：透传 recordedAsOf 给 wg.getEntityAt
      const snap = await ctx.wg.getEntityAt(
        item.params.entityId,
        storyTime,
        item.params.recordedAsOf ? { recordedAsOf: item.params.recordedAsOf } : undefined,
      );
      if (!snap) return null;
      // Entity 快照转 FactSnapshot：
      // - summary 作为一条 fact（property="summary"）
      // - properties 数组逐条转 FactSnapshot
      const facts: FactSnapshot[] = snap.properties.map((p) => stateDeclToFact(p));
      if (snap.summary) {
        facts.push({
          declarationId: `snap-${snap.entityId}-summary-${storyTime}`,
          entityId: snap.entityId,
          property: "summary",
          value: snap.summary,
          valueText: snap.summary,
          modality: "fact",
          validFrom: snap.validFrom,
        });
      }
      return facts;
    }

    // ---------------------------------------------------------------
    // relations：某实体的关系列表
    // ---------------------------------------------------------------
    case "relations": {
      if (!item.params.entityId) return null;
      // P0-2 修复：透传 recordedAsOf 给 wg.getRelations
      const rels = await ctx.wg.getRelations(
        item.params.entityId,
        storyTime,
        item.params.recordedAsOf ? { recordedAsOf: item.params.recordedAsOf } : undefined,
      );
      // 关系列表转 FactSnapshot：
      // - property 用 `relation.${label}`（避免与状态声明的 property 命名空间冲突）
      // - value 用 targetId
      // - valueText 用 label（角色提示词展示用）
      return rels.map((r) => ({
        declarationId: r.relationId,
        entityId: r.sourceId,
        property: `relation.${r.label}`,
        value: r.targetId,
        valueText: r.label,
        modality: "fact",
        validFrom: r.validFrom,
      }));
    }

    // ---------------------------------------------------------------
    // search_text：全文检索
    // ---------------------------------------------------------------
    case "search_text": {
      if (!item.params.query) return null;
      // P0-2 修复：search_* 暂不支持 recordedAsOf（store.search 是 SDK 透传，无事务时间视图）
      if (item.params.recordedAsOf) {
        console.warn(
          "[retrieve] search_text 暂不支持 recordedAsOf，忽略该参数（store.search 不支持事务时间视图）",
        );
      }
      const nodeType = item.params.nodeType ?? "Fact";
      const hits = await ctx.wg.search.fulltext(nodeType, {
        query: item.params.query,
        limit: item.params.limit ?? 10,
      });
      return hitsToFactSnapshots(hits as readonly SearchHit[], nodeType, storyTime);
    }

    // ---------------------------------------------------------------
    // search_vector：向量检索
    // 需要 ctx.embedder 把 query 转 queryEmbedding
    // ---------------------------------------------------------------
    case "search_vector": {
      if (!item.params.query) return null;
      // P0-2 修复：search_* 暂不支持 recordedAsOf
      if (item.params.recordedAsOf) {
        console.warn(
          "[retrieve] search_vector 暂不支持 recordedAsOf，忽略该参数（store.search 不支持事务时间视图）",
        );
      }
      const nodeType = item.params.nodeType ?? "Entity";
      // 防御：schema 只有 Entity/Fact 声明了 embedding 字段，
      // planner LLM 误输出 Relation/Visibility 时跳过该项而非崩掉整场戏
      if (nodeType !== "Entity" && nodeType !== "Fact") {
        console.warn(
          `[scheduler] search_vector 不支持 nodeType=${nodeType}（无 embedding 字段），跳过该检索项`,
        );
        return null;
      }
      const fieldPath = item.params.fieldPath ?? "embedding";
      // query → queryEmbedding（512 维向量）
      const queryEmbedding = await ctx.embedder.embed(item.params.query);
      const hits = await ctx.wg.search.vector(nodeType, {
        fieldPath,
        queryEmbedding,
        limit: item.params.limit ?? 10,
      });
      return hitsToFactSnapshots(hits as readonly SearchHit[], nodeType, storyTime);
    }

    // ---------------------------------------------------------------
    // search_hybrid：混合检索（全文 + 向量）
    // 需要 ctx.embedder 把 query 转 queryEmbedding
    // ---------------------------------------------------------------
    case "search_hybrid": {
      if (!item.params.query) return null;
      // P0-2 修复：search_* 暂不支持 recordedAsOf
      if (item.params.recordedAsOf) {
        console.warn(
          "[retrieve] search_hybrid 暂不支持 recordedAsOf，忽略该参数（store.search 不支持事务时间视图）",
        );
      }
      const nodeType = item.params.nodeType ?? "Fact";
      // 防御：同 search_vector，hybrid 含向量分量，Relation/Visibility 无 embedding 字段
      if (nodeType !== "Entity" && nodeType !== "Fact") {
        console.warn(
          `[scheduler] search_hybrid 不支持 nodeType=${nodeType}（无 embedding 字段），跳过该检索项`,
        );
        return null;
      }
      const fieldPath = item.params.fieldPath ?? "embedding";
      const queryEmbedding = await ctx.embedder.embed(item.params.query);
      const hits = await ctx.wg.search.hybrid(nodeType, {
        vector: { fieldPath, queryEmbedding },
        fulltext: { query: item.params.query },
        limit: item.params.limit ?? 10,
      });
      return hitsToFactSnapshots(hits as readonly SearchHit[], nodeType, storyTime);
    }
  }
  // 兜底：未知 type 返回 null（避免 switch 漏 case 抛错）
  return null;
}

/**
 * StateDeclaration → FactSnapshot 直接映射
 * 两个结构基本一致，仅 valueText 可选性差异（FactSnapshot 也设为可选）
 */
function stateDeclToFact(d: StateDeclaration): FactSnapshot {
  return {
    declarationId: d.declarationId,
    entityId: d.entityId,
    property: d.property,
    value: d.value,
    valueText: d.valueText,
    modality: d.modality,
    validFrom: d.validFrom,
    validTo: d.validTo,
  };
}

/**
 * StoreSearch hit 列表 → FactSnapshot[] 转换
 *
 * 按 nodeType 不同提取不同字段：
 * - Fact 节点：declarationId / entityId / property / value / valueText / modality / validFrom
 * - Entity 节点：summary 作为一条 fact（property="summary"）
 * - Relation 节点：relationId / sourceId / label / targetId
 * - Visibility 节点：暂时只取 declarationId / characterId（property="visibility"）
 *
 * 未识别字段不抛错，仅跳过（避免 planner LLM 输出意外 nodeType 导致崩）
 */
function hitsToFactSnapshots(
  hits: readonly SearchHit[],
  nodeType: string,
  storyTime: string,
): FactSnapshot[] {
  const facts: FactSnapshot[] = [];
  for (const hit of hits) {
    const node = hit.node;
    if (!node) continue;

    if (nodeType === "Fact") {
      // Fact 节点：直接提取 StateDeclaration 字段
      if (!node.declarationId || !node.entityId || !node.property) continue;
      // P0-1 修复：拦截未来事实（validFrom > storyTime 的 Fact 不应被检索到）
      // 注：validFrom 缺失时走兜底 storyTime（保持原行为）
      if (node.validFrom && node.validFrom > storyTime) continue;
      facts.push({
        declarationId: node.declarationId,
        entityId: node.entityId,
        property: node.property,
        value: node.value,
        valueText: node.valueText,
        modality: node.modality ?? "fact",
        validFrom: node.validFrom ?? storyTime,
        validTo: typeof node.validTo === "string" ? node.validTo : undefined,
      });
    } else if (nodeType === "Entity") {
      // Entity 节点：summary 作为一条 fact
      if (!node.entityId) continue;
      // P0-1 修复：拦截未来才诞生的实体（validFrom > storyTime）
      // 注：过滤读 node.validFrom；FactSnapshot.validFrom 仍用 storyTime 兜底（保持现状）
      if (node.validFrom && node.validFrom > storyTime) continue;
      facts.push({
        declarationId: `search-${nodeType}-${node.entityId}-${randomId(6)}`,
        entityId: node.entityId,
        property: "summary",
        value: node.summary ?? "",
        valueText: node.summary ?? "",
        modality: "fact",
        validFrom: storyTime,
      });
    } else if (nodeType === "Relation") {
      // Relation 节点：转 FactSnapshot（property=`relation.${label}`）
      if (!node.sourceId || !node.label) continue;
      // P0-1 修复：拦截未来才建立的关系
      if (node.validFrom && node.validFrom > storyTime) continue;
      facts.push({
        declarationId: `search-${nodeType}-${node.sourceId}-${node.label}-${randomId(6)}`,
        entityId: node.sourceId,
        property: `relation.${node.label}`,
        value: node.targetId ?? "",
        valueText: node.label,
        modality: "fact",
        validFrom: storyTime,
      });
    } else if (nodeType === "Visibility") {
      // Visibility 节点：转 FactSnapshot（property="visibility"）
      if (!node.entityId) continue;
      // P0-1 修复：拦截未来才写入的可见性记录
      if (node.validFrom && node.validFrom > storyTime) continue;
      facts.push({
        declarationId: `search-${nodeType}-${node.entityId}-${randomId(6)}`,
        entityId: node.entityId,
        property: "visibility",
        value: (node as Record<string, unknown>).declarationId ?? "",
        valueText: JSON.stringify((node as Record<string, unknown>).state ?? ""),
        modality: "fact",
        validFrom: storyTime,
      });
    }
    // 其他 nodeType：跳过（不抛错）
  }
  return facts;
}
