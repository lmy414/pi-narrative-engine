// tests/retrieve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRetrievalItem } from "../src/retrieve.ts";
import type { SchedulerCtx, RetrievalItem, FactSnapshot } from "../src/types.ts";
import type { WorldGraph } from "@pi/world-graph";

// ============================================================================
// Mock WorldGraph
// 调度器只用到以下 wg API：
// - getCharacterView(characterId, storyTime, opts)
// - getEntityAt(entityId, storyTime)
// - getRelations(entityId, storyTime)
// - search.fulltext(nodeKind, options)
// - search.vector(nodeKind, options)
// - search.hybrid(nodeKind, options)
// 用最小实现满足单测，避免依赖真实 SQLite/TypeGraph
// ============================================================================

interface MockState {
  characterViews: Map<string, FactSnapshot[]>;
  entities: Map<string, {
    summary: string;
    properties: FactSnapshot[];
    validFrom: string;
  }>;
  relations: Map<string, Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    validFrom: string;
  }>>;
  fulltextHits: Map<string, Array<{ node: Record<string, unknown>; score: number; rank: number }>>;
  vectorHits: Map<string, Array<{ node: Record<string, unknown>; score: number; rank: number }>>;
  hybridHits: Map<string, Array<{ node: Record<string, unknown>; score: number; rank: number }>>;
  embedderCalls: string[];
}

function makeMockWg(state: MockState): WorldGraph {
  // 窄化类型断言：单测只用到调度器调用的几个方法
  return {
    async getCharacterView(characterId: string, storyTime: string) {
      void storyTime;
      return state.characterViews.get(characterId) ?? [];
    },
    async getEntityAt(entityId: string, storyTime: string) {
      void storyTime;
      const e = state.entities.get(entityId);
      if (!e) return undefined;
      return {
        entityId,
        type: "character",
        summary: e.summary,
        properties: e.properties,
        validFrom: e.validFrom,
      };
    },
    async getRelations(entityId: string, storyTime: string) {
      void storyTime;
      return state.relations.get(entityId) ?? [];
    },
    search: {
      async fulltext(nodeKind: string, options: { query?: string; limit?: number }) {
        const key = `${nodeKind}:${options.query ?? ""}`;
        return state.fulltextHits.get(key) ?? [];
      },
      async vector(nodeKind: string, options: { fieldPath?: string; queryEmbedding?: number[]; limit?: number }) {
        void options.queryEmbedding;
        const key = `${nodeKind}:${options.fieldPath ?? "embedding"}`;
        return state.vectorHits.get(key) ?? [];
      },
      async hybrid(nodeKind: string, options: { vector?: { fieldPath?: string }; fulltext?: { query?: string }; limit?: number }) {
        const key = `${nodeKind}:${options.fulltext?.query ?? ""}`;
        return state.hybridHits.get(key) ?? [];
      },
    },
  } as unknown as WorldGraph;
}

function makeMockCtx(state: MockState): SchedulerCtx {
  return {
    wg: makeMockWg(state),
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({ characterId: "", actor: "", action: "" }),
    renderLlm: async () => "",
    embedder: {
      async embed(text: string) {
        state.embedderCalls.push(text);
        // 返回 512 维 0 向量（单测不关心真实向量）
        return new Array(512).fill(0);
      },
      async embedEntity(_snap: unknown) {
        return new Array(512).fill(0);
      },
      async embedFact(_decl: unknown) {
        return new Array(512).fill(0);
      },
    },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: "/tmp",
    staticCardLoader: async () => ({ name: "", description: "" }),
  };
}

function makeFactSnapshot(declarationId: string, entityId: string, property: string, value: unknown): FactSnapshot {
  return {
    declarationId,
    entityId,
    property,
    value,
    valueText: typeof value === "string" ? value : JSON.stringify(value),
    modality: "fact",
    validFrom: "ch-1",
  };
}

// ============================================================================
// character_view
// ============================================================================

test("character_view: 返回 wg.getCharacterView 的结果", async () => {
  const state: MockState = {
    characterViews: new Map([
      ["linchong", [
        makeFactSnapshot("d1", "linchong", "mood", "怒"),
        makeFactSnapshot("d2", "linchong", "location", "山神庙"),
      ]],
    ]),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "character_view",
    params: { entityId: "linchong" },
    assignTo: ["linchong"],
    label: "林冲的可见状态",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.equal(result![0].property, "mood");
  assert.equal(result![1].property, "location");
});

test("character_view: entityId 缺失返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "character_view",
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

test("character_view: 角色无可见声明返回空数组", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "character_view",
    params: { entityId: "unknown" },
    assignTo: ["unknown"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.ok(Array.isArray(result));
  assert.equal(result!.length, 0);
});

// ============================================================================
// entity_snapshot
// ============================================================================

test("entity_snapshot: 返回实体的 properties + summary 作为 fact", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map([
      ["tavern", {
        summary: "山神庙旁的小酒馆",
        properties: [
          makeFactSnapshot("d3", "tavern", "name", "杏花村"),
          makeFactSnapshot("d4", "tavern", "owner", "王老板"),
        ],
        validFrom: "ch-0",
      }],
    ]),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "entity_snapshot",
    params: { entityId: "tavern" },
    assignTo: ["linchong"],
    label: "酒馆快照",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  // 2 个 properties + 1 个 summary fact
  assert.equal(result!.length, 3);
  const summaryFact = result!.find((f) => f.property === "summary");
  assert.ok(summaryFact);
  assert.equal(summaryFact!.value, "山神庙旁的小酒馆");
});

test("entity_snapshot: 实体不存在返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "entity_snapshot",
    params: { entityId: "not_exist" },
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

test("entity_snapshot: entityId 缺失返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "entity_snapshot",
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

// ============================================================================
// relations
// ============================================================================

test("relations: 返回关系列表并转 FactSnapshot", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map([
      ["linchong", [
        { relationId: "r1", sourceId: "linchong", targetId: "luqian", label: "仇敌", validFrom: "ch-1" },
        { relationId: "r2", sourceId: "linchong", targetId: "tavern", label: "located_in", validFrom: "ch-1" },
      ]],
    ]),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "relations",
    params: { entityId: "linchong" },
    assignTo: ["linchong"],
    label: "林冲的关系",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.equal(result![0].property, "relation.仇敌");
  assert.equal(result![0].value, "luqian");
  assert.equal(result![0].valueText, "仇敌");
  assert.equal(result![1].property, "relation.located_in");
  assert.equal(result![1].value, "tavern");
});

test("relations: entityId 缺失返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "relations",
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

// ============================================================================
// search_text
// ============================================================================

test("search_text: 调 wg.search.fulltext 并转 FactSnapshot", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map([
      ["Fact:酒馆", [
        {
          node: {
            declarationId: "d10",
            entityId: "tavern",
            property: "name",
            value: "杏花村",
            valueText: "杏花村",
            modality: "fact",
            validFrom: "ch-1",
          },
          score: 1.0,
          rank: 1,
        },
      ]],
    ]),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "search_text",
    params: { query: "酒馆", nodeType: "Fact", limit: 5 },
    assignTo: ["linchong"],
    label: "酒馆搜索结果",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 1);
  assert.equal(result![0].declarationId, "d10");
  assert.equal(result![0].entityId, "tavern");
  assert.equal(result![0].property, "name");
  assert.equal(result![0].value, "杏花村");
});

test("search_text: query 缺失返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "search_text",
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

test("search_text: nodeType 缺省为 Fact", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map([
      ["Fact:keyword", [
        {
          node: {
            declarationId: "d11",
            entityId: "e1",
            property: "p1",
            value: "v1",
            modality: "fact",
            validFrom: "ch-1",
          },
          score: 1.0,
          rank: 1,
        },
      ]],
    ]),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_text",
    params: { query: "keyword" },
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.ok(result);
  assert.equal(result!.length, 1);
});

// ============================================================================
// search_vector
// ============================================================================

test("search_vector: 调用 embedder 把 query 转 queryEmbedding", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map([
      ["Entity:embedding", [
        {
          node: {
            entityId: "tavern",
            summary: "山神庙旁的小酒馆",
          },
          score: 0.92,
          rank: 1,
        },
      ]],
    ]),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_vector",
    params: { query: "酒馆", nodeType: "Entity", fieldPath: "embedding" },
    assignTo: ["linchong"],
    label: "酒馆向量检索",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  // 验证 embedder 被调用过
  assert.equal(state.embedderCalls.length, 1);
  assert.equal(state.embedderCalls[0], "酒馆");
  // 验证返回结果（Entity 节点：summary 作为 fact）
  assert.ok(result);
  assert.equal(result!.length, 1);
  assert.equal(result![0].property, "summary");
  assert.equal(result![0].value, "山神庙旁的小酒馆");
});

test("search_vector: query 缺失返回 null", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "search_vector",
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

// ============================================================================
// 防御：Relation/Visibility 无 embedding 字段（审计实测：planner 误输出导致整场崩）
// ============================================================================

test("search_vector: nodeType=Relation 跳过不崩（无 embedding 字段）", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "search_vector",
    params: { query: "朋友关系", nodeType: "Relation" },
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null, "Relation 无 embedding，应跳过返回 null");
});

test("search_hybrid: nodeType=Visibility 跳过不崩", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item: RetrievalItem = {
    type: "search_hybrid",
    params: { query: "可见性", nodeType: "Visibility" },
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

test("search_hybrid: 同时调用 embedder 和 fulltext", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map([
      ["Fact:林冲", [
        {
          node: {
            declarationId: "d20",
            entityId: "linchong",
            property: "mood",
            value: "怒",
            valueText: "怒",
            modality: "fact",
            validFrom: "ch-1",
          },
          score: 0.88,
          rank: 1,
        },
      ]],
    ]),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_hybrid",
    params: { query: "林冲", nodeType: "Fact", fieldPath: "embedding" },
    assignTo: ["linchong"],
    label: "林冲混合检索",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.equal(state.embedderCalls.length, 1);
  assert.equal(state.embedderCalls[0], "林冲");
  assert.ok(result);
  assert.equal(result!.length, 1);
  assert.equal(result![0].declarationId, "d20");
});

// ============================================================================
// 边界场景
// ============================================================================

test("未知 type 返回 null（不抛错）", async () => {
  const ctx = makeMockCtx({
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  });
  const item = {
    type: "unknown_type" as never,
    params: {},
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(result, null);
});

// ============================================================================
// P0-1 未来事实过滤（2026-07-27 修复）
// search_* 返回的节点 validFrom > storyTime 时应被过滤，避免未来事实泄漏
// ============================================================================

test("search_text: 不返回 validFrom > storyTime 的未来 Fact", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map([
      ["Fact:酒馆", [
        // 过去 Fact
        {
          node: {
            declarationId: "d_past",
            entityId: "tavern",
            property: "name",
            value: "杏花村",
            valueText: "杏花村",
            modality: "fact",
            validFrom: "ch-1",
          },
          score: 1.0,
          rank: 1,
        },
        // 当前 Fact
        {
          node: {
            declarationId: "d_now",
            entityId: "tavern",
            property: "owner",
            value: "王老板",
            valueText: "王老板",
            modality: "fact",
            validFrom: "ch-2",
          },
          score: 0.9,
          rank: 2,
        },
        // 未来 Fact（应被过滤）
        {
          node: {
            declarationId: "d_future",
            entityId: "tavern",
            property: "status",
            value: "烧毁",
            valueText: "烧毁",
            modality: "fact",
            validFrom: "ch-5",
          },
          score: 0.8,
          rank: 3,
        },
      ]],
    ]),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_text",
    params: { query: "酒馆", nodeType: "Fact" },
    assignTo: ["linchong"],
    label: "酒馆搜索",
  };
  // storyTime = "ch-2"，d_future 的 validFrom="ch-5" 应被过滤
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 2, "应只返回过去+当前两条，未来 Fact 被过滤");
  const ids = result!.map((f) => f.declarationId).sort();
  assert.deepEqual(ids, ["d_now", "d_past"]);
});

test("search_vector: Entity validFrom > storyTime 被过滤", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map([
      ["Entity:embedding", [
        // 过去实体
        {
          node: {
            entityId: "tavern",
            summary: "山神庙旁的小酒馆",
            validFrom: "ch-0",
          },
          score: 0.92,
          rank: 1,
        },
        // 未来才诞生的实体（应被过滤）
        // 注：validFrom 用 "ch-99" 保证字典序 > "ch-2"（与同文件 search_hybrid 用例一致；
        // 项目零填充约定是 ch{NNN}，但既有测试用例沿用 ch-N 简写，需注意字典序）
        {
          node: {
            entityId: "future_tavern",
            summary: "新开的酒馆",
            validFrom: "ch-99",
          },
          score: 0.85,
          rank: 2,
        },
      ]],
    ]),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_vector",
    params: { query: "酒馆", nodeType: "Entity", fieldPath: "embedding" },
    assignTo: ["linchong"],
    label: "酒馆向量检索",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 1, "未来实体应被过滤");
  assert.equal(result![0].entityId, "tavern");
});

test("search_hybrid: 混合时态 Fact 只返回 storyTime 之前的", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map(),
    vectorHits: new Map(),
    hybridHits: new Map([
      ["Fact:林冲", [
        {
          node: {
            declarationId: "d_past",
            entityId: "linchong",
            property: "mood",
            value: "怒",
            valueText: "怒",
            modality: "fact",
            validFrom: "ch-1",
          },
          score: 0.88,
          rank: 1,
        },
        {
          node: {
            declarationId: "d_future",
            entityId: "linchong",
            property: "mood",
            value: "释然",
            valueText: "释然",
            modality: "fact",
            validFrom: "ch-99",
          },
          score: 0.85,
          rank: 2,
        },
      ]],
    ]),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_hybrid",
    params: { query: "林冲", nodeType: "Fact", fieldPath: "embedding" },
    assignTo: ["linchong"],
    label: "林冲混合检索",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-2");
  assert.ok(result);
  assert.equal(result!.length, 1, "未来 Fact 应被过滤");
  assert.equal(result![0].declarationId, "d_past");
});

test("search_text: 无 validFrom 的节点不报错（兜底 storyTime）", async () => {
  const state: MockState = {
    characterViews: new Map(),
    entities: new Map(),
    relations: new Map(),
    fulltextHits: new Map([
      ["Fact:keyword", [
        {
          node: {
            declarationId: "d_no_valid",
            entityId: "e1",
            property: "p1",
            value: "v1",
            valueText: "v1",
            modality: "fact",
            // validFrom 缺失
          },
          score: 1.0,
          rank: 1,
        },
      ]],
    ]),
    vectorHits: new Map(),
    hybridHits: new Map(),
    embedderCalls: [],
  };
  const ctx = makeMockCtx(state);
  const item: RetrievalItem = {
    type: "search_text",
    params: { query: "keyword", nodeType: "Fact" },
    assignTo: ["c1"],
    label: "test",
  };
  const result = await executeRetrievalItem(ctx, item, "ch-1");
  assert.ok(result);
  assert.equal(result!.length, 1, "无 validFrom 不应被过滤");
  assert.equal(result![0].validFrom, "ch-1", "兜底为 storyTime");
});

// ============================================================================
// P0-2 recordedAsOf 透传（2026-07-27 修复）
// character_view / entity_snapshot / relations 透传 opts.recordedAsOf 给 wg API
// search_* 不支持，console.warn 降级但不崩
// ============================================================================

test("character_view: 透传 recordedAsOf 给 wg.getCharacterView", async () => {
  // 独立 mock：记录 opts 参数
  const calls: Array<{ characterId: string; storyTime: string; opts: any }> = [];
  const mockWg = {
    getCharacterView: async (characterId: string, storyTime: string, opts?: any) => {
      calls.push({ characterId, storyTime, opts });
      return [];
    },
  } as unknown as WorldGraph;
  const ctx: SchedulerCtx = {
    wg: mockWg,
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({ characterId: "", actor: "", action: "" }),
    renderLlm: async () => "",
    embedder: {
      embed: async () => [],
      embedEntity: async () => [],
      embedFact: async () => [],
    },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: "/tmp",
    staticCardLoader: async () => ({ name: "", description: "" }),
  };
  const item: RetrievalItem = {
    type: "character_view",
    params: { entityId: "linchong", recordedAsOf: "tx-2026-07-27T10:00:00Z" },
    assignTo: ["linchong"],
    label: "test",
  };
  await executeRetrievalItem(ctx, item, "ch-2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.recordedAsOf, "tx-2026-07-27T10:00:00Z");
});

test("entity_snapshot: 透传 recordedAsOf", async () => {
  const calls: Array<{ entityId: string; storyTime: string; opts: any }> = [];
  const mockWg = {
    getEntityAt: async (entityId: string, storyTime: string, opts?: any) => {
      calls.push({ entityId, storyTime, opts });
      return undefined;
    },
  } as unknown as WorldGraph;
  const ctx: SchedulerCtx = {
    wg: mockWg,
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({ characterId: "", actor: "", action: "" }),
    renderLlm: async () => "",
    embedder: {
      embed: async () => [],
      embedEntity: async () => [],
      embedFact: async () => [],
    },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: "/tmp",
    staticCardLoader: async () => ({ name: "", description: "" }),
  };
  const item: RetrievalItem = {
    type: "entity_snapshot",
    params: { entityId: "tavern", recordedAsOf: "tx-test" },
    assignTo: ["c1"],
    label: "test",
  };
  await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.recordedAsOf, "tx-test");
});

test("relations: 透传 recordedAsOf", async () => {
  const calls: Array<{ entityId: string; storyTime: string; opts: any }> = [];
  const mockWg = {
    getRelations: async (entityId: string, storyTime: string, opts?: any) => {
      calls.push({ entityId, storyTime, opts });
      return [];
    },
  } as unknown as WorldGraph;
  const ctx: SchedulerCtx = {
    wg: mockWg,
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({ characterId: "", actor: "", action: "" }),
    renderLlm: async () => "",
    embedder: {
      embed: async () => [],
      embedEntity: async () => [],
      embedFact: async () => [],
    },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: "/tmp",
    staticCardLoader: async () => ({ name: "", description: "" }),
  };
  const item: RetrievalItem = {
    type: "relations",
    params: { entityId: "linchong", recordedAsOf: "tx-rel" },
    assignTo: ["linchong"],
    label: "test",
  };
  await executeRetrievalItem(ctx, item, "ch-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.recordedAsOf, "tx-rel");
});

test("search_text: 带 recordedAsOf 时打印警告但不崩", async () => {
  // 捕获 console.warn
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const ctx = makeMockCtx({
      characterViews: new Map(),
      entities: new Map(),
      relations: new Map(),
      fulltextHits: new Map([
        ["Fact:keyword", [
          {
            node: {
              declarationId: "d1",
              entityId: "e1",
              property: "p1",
              value: "v1",
              valueText: "v1",
              modality: "fact",
              validFrom: "ch-1",
            },
            score: 1.0,
            rank: 1,
          },
        ]],
      ]),
      vectorHits: new Map(),
      hybridHits: new Map(),
      embedderCalls: [],
    });
    const item: RetrievalItem = {
      type: "search_text",
      params: { query: "keyword", nodeType: "Fact", recordedAsOf: "tx-test" },
      assignTo: ["c1"],
      label: "test",
    };
    const result = await executeRetrievalItem(ctx, item, "ch-1");
    // 验证警告被调用
    assert.ok(warnings.some((w) => w.includes("recordedAsOf")), "应有 recordedAsOf 警告");
    // 验证结果正常返回（不崩）
    assert.ok(result);
    assert.equal(result!.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
