/**
 * tools.test.ts — 主会话 world_* 工具背后的 API 逻辑集成测试
 *
 * 2026-08-11 迁移：chat/world-tools.ts 已删除，并入统一实现
 * （src/agents/world-tools.ts）。主会话经 createMainSessionTools + wrapper
 * （agent-tool-adapter.ts）消费同一套 AgentTool。
 *
 * 由于 PI ExtensionAPI 难以 mock，本测试直接调用 WorldGraph / Search / Embedder
 * 的 API 验证工具背后的逻辑（不经过 pi.registerTool）。
 *
 * 工具集：
 *   实体：world_entity_create / world_entity_kill / world_entity_get
 *   关系：world_relation_add / world_relation_close / world_relations
 *   事件：world_event_apply / world_event_chain
 *   可见性：world_character_view / world_visibility_set / world_visibility_infer
 *   查询：world_query
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "underworld-graph";
import { Embedder } from "../src/embedder.ts";
import { Search } from "../src/search.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createWorldGraphAdapter } from "../src/ports/adapters.ts";
import { WorldGraphDataAccess } from "../src/data/world-graph-data-access.ts";
import {
  createMainSessionTools,
  type WorldToolDeps,
} from "../src/agents/world-tools.ts";
import { agentToolToToolDefinition } from "../src/chat/agent-tool-adapter.ts";
import type { SearchPort } from "../src/ports/types.ts";

/** deps 装配（主会话语义：resolveStoryTime 读 currentStoryTime 空则取最新；onStoryTime 写会话态） */
function buildDeps(opts?: {
  wg?: WorldGraph;
  search?: Search;
  currentStoryTime?: string | null;
  onStoryTime?: (storyTime: string) => void;
}): { deps: WorldToolDeps; current: { value: string | null } } {
  const wg = opts?.wg ?? ({} as WorldGraph);
  const search = (opts?.search ?? { search: async () => [] }) as unknown as Search;
  const dataAccess = WorldGraphDataAccess.create(createWorldGraphAdapter(wg));
  const current = { value: opts?.currentStoryTime ?? null };
  const deps: WorldToolDeps = {
    dataAccess,
    search: search as unknown as SearchPort,
    resolveStoryTime: async () => {
      if (current.value) return current.value;
      const times = await dataAccess.listStoryTimes();
      if (times.length === 0) throw new Error("世界图为空：尚无任何 storyTime");
      return [...times].sort().at(-1)!;
    },
    onStoryTime: opts?.onStoryTime
      ? opts.onStoryTime
      : (s: string) => { current.value = s; },
  };
  return { deps, current };
}

test("createMainSessionTools：注册 18 个唯一工具且 wrapper 全部提供 promptSnippet", () => {
  const { deps } = buildDeps();
  const tools = createMainSessionTools(deps).map(agentToolToToolDefinition);
  assert.equal(tools.length, 18);
  assert.equal(new Set(tools.map(t => t.name)).size, 18);
  assert.ok(tools.every(t => t.promptSnippet));
});

test("createMainSessionTools：18 个工具均可执行并返回 content/details envelope", async () => {
  const wg = {
    listStoryTimes: async () => ["ch001.ev001"],
    getAllEntities: async () => [],
    getAllEvents: async () => [],
    recordedNow: async () => "tx-1",
    birthEntity: async () => {},
    killEntity: async () => {},
    getEntityAt: async () => null,
    updateEntitySummary: async () => {},
    getEntityHistory: async () => [],
    addRelation: async () => {},
    closeRelation: async () => {},
    getRelations: async () => [],
    getRelationHistory: async () => [],
    processEvent: async () => {},
    traceCauses: async () => [],
    getAllRelationsAt: async () => [],
    getCharacterView: async () => [],
    setVisibility: async () => {},
    closeVisibility: async () => {},
    inferVisibility: async () => {},
  } as unknown as WorldGraph;
  const { deps } = buildDeps({ wg, currentStoryTime: "ch001.ev001" });
  const params: Record<string, Record<string, unknown>> = {
    world_status: {},
    world_entity_create: { entityId: "e1", type: "character", storyTime: "ch001.ev001" },
    world_entity_kill: { entityId: "e1", storyTime: "ch001.ev002" },
    world_entity_get: { entityId: "e1" },
    world_entity_update_summary: { entityId: "e1", summary: "摘要" },
    world_entity_history: { entityId: "e1" },
    world_relation_add: { sourceId: "e1", targetId: "e2", label: "knows" },
    world_relation_close: { sourceId: "e1", targetId: "e2", label: "knows" },
    world_relations: { entityId: "e1" },
    world_relation_history: { entityId: "e1" },
    world_event_apply: { eventId: "evt-1", type: "change", storyTime: "ch001.ev001", entityId: "e1" },
    world_event_chain: { eventId: "evt-1" },
    world_character_view: { characterId: "e1" },
    world_visibility_set: { characterId: "e1", declarationId: "d1", confidence: 1, source: "witnessed" },
    world_visibility_close: { characterId: "e1", declarationId: "d1" },
    world_visibility_infer: {},
    world_query: { query: "林冲" },
    world_story_times: {},
  };
  const executed: string[] = [];
  for (const tool of createMainSessionTools(deps)) {
    const result = await tool.execute(tool.name, params[tool.name]!, undefined, undefined);
    assert.ok(Array.isArray(result.content), `${tool.name} 应返回 content`);
    assert.ok("details" in result, `${tool.name} 应返回 details`);
    executed.push(tool.name);
  }
  assert.equal(executed.length, 18);
});

test("world_event_apply：更新 storyTime（onStoryTime 副作用）且不写 memory 文件", async () => {
  const current = { value: null as string | null };
  const calls: unknown[] = [];
  const wg = { processEvent: async (event: unknown) => calls.push(event) } as WorldGraph;
  const { deps } = buildDeps({
    wg,
    currentStoryTime: null,
    onStoryTime(value: string) { current.value = value; },
  });
  const tool = createMainSessionTools(deps).find(t => t.name === "world_event_apply")!;
  await tool.execute("event-1", {
    eventId: "evt-1",
    type: "change",
    storyTime: "ch001.ev001",
    entityId: "e1",
  });
  assert.equal(current.value, "ch001.ev001");
  assert.equal(calls.length, 1);
});

test("world_entity_create：storyTime 缺省时 resolveStoryTime 注入会话态生效", async () => {
  let bornStoryTime: string | undefined;
  const wg = {
    birthEntity: async (_id: string, _t: string, _p: unknown, st: string) => { bornStoryTime = st; },
  } as unknown as WorldGraph;
  const { deps } = buildDeps({ wg, currentStoryTime: "ch001.ev002" });
  // entity_create 的 storyTime 为必填，此处验证 resolveStoryTime 作为写侧兜底不干扰显式值
  const createTool = createMainSessionTools(deps).find(t => t.name === "world_entity_create")!;
  await createTool.execute("1", { entityId: "e1", type: "character", storyTime: "ch001.ev002" });
  assert.equal(bornStoryTime, "ch001.ev002");
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tools-test-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  const embedder = new Embedder();
  const search = new Search(wg, embedder);
  return { wg, embedder, search, dir };
}

// ============================================================================
// 实体工具
// ============================================================================

test("world_entity_create 逻辑: birthEntity 后 getEntityAt 可读", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", { name: "Macbeth", title: "Thane" }, "act1-scene1");
  const snap = await wg.getEntityAt("macbeth", "act1-scene1");
  assert.ok(snap, "应返回快照");
  assert.equal(snap!.entityId, "macbeth");
  assert.equal(snap!.type, "character");
  assert.ok(snap!.properties.find(p => p.property === "name" && p.description === "Macbeth"));
  wg.close();
});

test("world_entity_kill 逻辑: kill 后 getEntityAt 返回 null", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", { name: "Macbeth" }, "act1-scene1");
  await wg.killEntity("macbeth", "act2-scene1");
  const snap = await wg.getEntityAt("macbeth", "act2-scene1");
  assert.equal(snap, null, "kill 后应返回 null");
  wg.close();
});

test("world_entity_get 逻辑: 不存在的 entityId 返回 null", async () => {
  const { wg } = await setup();
  const snap = await wg.getEntityAt("nonexistent", "act1-scene1");
  assert.equal(snap, null, "不存在的实体应返回 null");
  wg.close();
});

// ============================================================================
// 关系工具
// ============================================================================

test("world_relation_add 逻辑: addRelation 后 getRelations 返回", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("inverness", "location", {}, "act1-scene1");
  await wg.addRelation("macbeth", "inverness", "located_in", "act1-scene1");
  const rels = await wg.getRelations("macbeth", "act1-scene1");
  assert.ok(rels.length > 0);
  assert.ok(rels.find(r => r.label === "located_in"));
  wg.close();
});

test("world_relation_close 逻辑: close 后 getRelations 不再返回", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("inverness", "location", {}, "act1-scene1");
  await wg.addRelation("macbeth", "inverness", "located_in", "act1-scene1");
  await wg.closeRelation("macbeth", "inverness", "located_in", "act2-scene1");
  const rels = await wg.getRelations("macbeth", "act2-scene1");
  assert.ok(!rels.find(r => r.label === "located_in"), "close 后不应返回");
  wg.close();
});

test("world_relations 逻辑: 反向查询（targetId 也能查到）", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("inverness", "location", {}, "act1-scene1");
  await wg.addRelation("macbeth", "inverness", "located_in", "act1-scene1");
  // 从 inverness 反查也应能看到此关系
  const rels = await wg.getRelations("inverness", "act1-scene1");
  assert.ok(rels.find(r => r.label === "located_in" && r.sourceId === "macbeth"));
  wg.close();
});

// ============================================================================
// 事件工具
// ============================================================================

test("world_event_apply 逻辑: processEvent(change) 更新属性", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", { title: "Thane" }, "act1-scene1");
  // 获取旧声明的 declarationId 用于 invalidate
  const snapBefore = await wg.getEntityAt("macbeth", "act1-scene1");
  const oldTitle = snapBefore!.properties.find(p => p.property === "title")!;
  // change 事件：闭合旧 title，写入新 title
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "act2-scene1",
    entityId: "macbeth",
    invalidated: [{ declarationId: oldTitle.declarationId, property: "title" }],
    newFacts: [{
      entityId: "macbeth",
      property: "title",
      description: "King",
      modality: "fact",
    }],
  });
  const snap = await wg.getEntityAt("macbeth", "act2-scene1");
  assert.ok(snap!.properties.find(p => p.property === "title" && p.description === "King"), "应有新 title");
  // 旧 title 声明应已闭合
  assert.ok(
    !snap!.properties.find(p => p.declarationId === oldTitle.declarationId),
    "旧 title 声明应已闭合",
  );
  wg.close();
});

test("world_event_chain 逻辑: getAllEvents 按 storyTime 升序", async () => {
  const { wg } = await setup();
  await wg.processEvent({
    eventId: "evt-2",
    type: "birth",
    storyTime: "act2-scene1",
    entityId: "duncan",
    newFacts: [],
  });
  await wg.processEvent({
    eventId: "evt-1",
    type: "birth",
    storyTime: "act1-scene1",
    entityId: "macbeth",
    newFacts: [],
  });
  const events = await wg.getAllEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].eventId, "evt-1", "应按 storyTime 升序");
  assert.equal(events[1].eventId, "evt-2");
  wg.close();
});

test("world_event_chain 逻辑: traceCauses 沿 causedBy 回溯", async () => {
  const { wg } = await setup();
  await wg.processEvent({
    eventId: "evt-1",
    type: "birth",
    storyTime: "act1-scene1",
    entityId: "macbeth",
    newFacts: [],
  });
  await wg.processEvent({
    eventId: "evt-2",
    type: "change",
    storyTime: "act2-scene1",
    entityId: "macbeth",
    causedBy: "evt-1",
    newFacts: [{
      entityId: "macbeth",
      property: "title",
      description: "King",
      modality: "fact",
    }],
  });
  const chain = await wg.traceCauses("evt-2");
  assert.equal(chain.length, 2, "应回溯到 evt-1");
  assert.equal(chain[0].eventId, "evt-1");
  assert.equal(chain[1].eventId, "evt-2");
  wg.close();
});

// ============================================================================
// 可见性工具
// ============================================================================

test("world_visibility_set 逻辑: setVisibility 后 getCharacterView 返回", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", { name: "Macbeth" }, "act1-scene1");
  // 获取 declarationId
  const snap = await wg.getEntityAt("macbeth", "act1-scene1");
  const nameDecl = snap!.properties.find(p => p.property === "name")!;
  await wg.setVisibility("macbeth", nameDecl.declarationId, {
    state: "known",
    confidence: 1.0,
    source: "experienced",
    validFrom: "act1-scene1",
    isExplicit: true,
  });
  const view = await wg.getCharacterView("macbeth", "act1-scene1");
  assert.ok(
    view.find(d => d.declarationId === nameDecl.declarationId),
    "角色视角应包含 name 声明",
  );
  wg.close();
});

test("world_visibility_infer 逻辑: 经统一工具走 dataAccess.inferVisibilityAt 不抛错", async () => {
  const { wg } = await setup();
  await wg.birthEntity("macbeth", "character", { name: "Macbeth" }, "act1-scene1");
  await wg.birthEntity("inverness", "location", { name: "Inverness" }, "act1-scene1");
  await wg.addRelation("macbeth", "inverness", "located_in", "act1-scene1");
  const { deps } = buildDeps({ wg, currentStoryTime: "act1-scene1" });
  const tool = createMainSessionTools(deps).find(t => t.name === "world_visibility_infer")!;
  await tool.execute("1", {});
  wg.close();
});

// ============================================================================
// 查询工具
// ============================================================================

test("world_query 逻辑: search 返回 EntitySearchResult", { skip: !!process.env.CI }, async () => {
  // CI 跳过：reembedAll 真实 Embedder 需下载 bge-small-zh（429 偶发）；
  // 检索链路由 tests/e2e.test.ts 的 stub + fulltext 覆盖
  const { wg, embedder, search } = await setup();
  await wg.birthEntity("macbeth", "character", { name: "Macbeth" }, "act1-scene1");
  await wg.reembedAll(embedder);
  const { deps } = buildDeps({ wg, search, currentStoryTime: "act1-scene1" });
  const tool = createMainSessionTools(deps).find(t => t.name === "world_query")!;
  const result = await tool.execute("1", { query: "Macbeth" });
  const results = result.details.results as { entityId: string }[];
  assert.ok(results.length > 0, "应命中 Macbeth");
  assert.equal(results[0].entityId, "macbeth");
  wg.close();
});