/**
 * search.ts — SDK StoreSearch 薄包装
 *
 * 复用 @nicia-ai/typegraph 的 fulltext + vector + hybrid 三级检索。
 * 去掉旧 Fuse.js + 自实现向量缓存。
 */
import type { WorldGraph, EntitySnapshot, EntityType } from "underworld-graph";
import type { Embedder } from "./embedder.ts";

export interface EntitySearchResult {
  entityId: string;
  type: EntityType;
  score: number;              // 0-1，越高越相关
  matchType: "fulltext" | "vector" | "hybrid";
  snapshot: EntitySnapshot;   // 实体快照（含 properties）
}

export class Search {
  constructor(
    private wg: WorldGraph,
    private embedder: Embedder | null,
  ) {}

  async search(query: string, opts?: {
    topK?: number;
    typeFilter?: EntityType;
    storyTime?: string;
    mode?: "fulltext" | "vector" | "hybrid";
  }): Promise<EntitySearchResult[]> {
    const mode = opts?.mode ?? "hybrid";
    if (mode === "fulltext") return this.fulltext(query, opts);
    // 🟡（2026-08-08）：embedder 缺失（forceFulltext 模式）时 hybrid/vector 兜底
    // fulltext——防御性（当前 world_query 仅在有 embedder 的主会话注册，理论不可达，
    // 但 registry 可能以 null embedder 构造 Search）
    if (!this.embedder) return this.fulltext(query, opts);
    if (mode === "vector") return this.vector(query, opts);
    return this.hybrid(query, opts);
  }

  async fulltext(query: string, opts?: { topK?: number; storyTime?: string }): Promise<EntitySearchResult[]> {
    const limit = opts?.topK ?? 10;
    const storyTime = opts?.storyTime;
    if (!storyTime) throw new Error("storyTime is required for search results");
    // 搜 Fact 节点（property + valueText 是 searchable 字段）
    const hits = await this.wg.search.fulltext("Fact", { query, limit });
    // 从 Fact hit 提取 entityId，去重，关联到 Entity 快照
    return this.resolveEntitiesFromFacts(hits, storyTime, "fulltext");
  }

  async vector(query: string, opts?: { topK?: number; storyTime?: string }): Promise<EntitySearchResult[]> {
    const limit = opts?.topK ?? 10;
    const storyTime = opts?.storyTime;
    if (!storyTime) throw new Error("storyTime is required for search results");
    // query 文本 → 向量
    const queryEmbedding = await this.embedder.embed(query);
    // 搜 Entity 节点（embedding 字段）
    const hits = await this.wg.search.vector("Entity", {
      fieldPath: "embedding",
      queryEmbedding,
      limit,
    });
    // 从 Entity hit 提取 entityId，关联到快照
    return this.resolveEntitiesFromEntities(hits, storyTime, "vector");
  }

  async hybrid(query: string, opts?: { topK?: number; storyTime?: string }): Promise<EntitySearchResult[]> {
    const limit = opts?.topK ?? 10;
    const storyTime = opts?.storyTime;
    if (!storyTime) throw new Error("storyTime is required for search results");
    const queryEmbedding = await this.embedder.embed(query);
    // hybrid 搜 Fact（同时有 searchable 和 embedding 字段）
    const hits = await this.wg.search.hybrid("Fact", {
      vector: { fieldPath: "embedding", queryEmbedding },
      fulltext: { query },
      limit,
    });
    return this.resolveEntitiesFromFacts(hits, storyTime, "hybrid");
  }

  /**
   * 从 Fact hit 列表提取 entityId，去重，关联到 Entity 快照
   * 同一 Entity 多个 Fact 命中时，合并取最高 score
   */
  private async resolveEntitiesFromFacts(
    hits: readonly { node: { entityId: string }; score: number }[],
    storyTime: string,
    matchType: "fulltext" | "vector" | "hybrid",
  ): Promise<EntitySearchResult[]> {
    const entityIdToScore = new Map<string, number>();
    for (const hit of hits) {
      const entityId = hit.node.entityId;
      const prev = entityIdToScore.get(entityId) ?? -Infinity;
      entityIdToScore.set(entityId, Math.max(prev, hit.score));
    }
    const results: EntitySearchResult[] = [];
    for (const [entityId, score] of entityIdToScore) {
      const snap = await this.wg.getEntityAt(entityId, storyTime);
      if (snap) {
        results.push({
          entityId: snap.entityId,
          type: snap.type,
          score,
          matchType,
          snapshot: snap,
        });
      }
    }
    // 按 score 降序
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * 从 Entity hit 列表提取 entityId，关联到快照
   */
  private async resolveEntitiesFromEntities(
    hits: readonly { node: { entityId: string }; score: number }[],
    storyTime: string,
    matchType: "fulltext" | "vector" | "hybrid",
  ): Promise<EntitySearchResult[]> {
    const results: EntitySearchResult[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const entityId = hit.node.entityId;
      if (seen.has(entityId)) continue;
      seen.add(entityId);
      const snap = await this.wg.getEntityAt(entityId, storyTime);
      if (snap) {
        results.push({
          entityId: snap.entityId,
          type: snap.type,
          score: hit.score,
          matchType,
          snapshot: snap,
        });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }
}
