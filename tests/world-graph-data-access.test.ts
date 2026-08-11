// tests/world-graph-data-access.test.ts
/**
 * WorldGraphDataAccess 统一数据管道单测
 *
 * 覆盖（完备性硬要求，见执行计划 Task 2）：
 * 1. 透传抽样：mock Port，验证方法原样转发（参数/返回值）。
 * 2. 正常推断：真实 wg 内存实例，located_in + target 声明 → known/witnessed/isExplicit:false，
 *    validFrom = max(rel.validFrom, decl.validFrom)。
 * 3. 幂等：同一 storyTime 调两次，第二次不产生新可见性记录。
 * 4. 撤销回填：closeVisibility 后再推断，新记录 validFrom = storyTime（不回填到撤销区间之前）。
 * 5. recordedAsOf 透传：mock Port 断言三个读取方法都收到 opts；写调用不带。
 * 6. 对照测例：dataAccess.inferVisibilityAt 与仓库 wg.inferVisibility 结果一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGraph } from "underworld-graph";
import { createWorldGraphAdapter } from "../src/ports/adapters.ts";
import { WorldGraphDataAccess } from "../src/data/world-graph-data-access.ts";
import type { WorldGraphPort } from "../src/ports/types.ts";

/** 建一个含 target 声明 + located_in 关系的真实 wg（返回 wg 与关键 storyTime） */
async function buildLocatedInGraph(): Promise<{
  wg: WorldGraph;
  targetId: string;
  charId: string;
  declId: string;
  declTime: string;
  relTime: string;
}> {
  const wg = await WorldGraph.create({
    dbPath: join(tmpdir(), `wg-da-test-${Date.now()}-${Math.random()}.db`),
    eventLogPath: join(tmpdir(), `wg-da-events-${Date.now()}-${Math.random()}.jsonl`),
  });
  const charId = "ent_char_a";
  const targetId = "ent_loc_a";
  const declTime = "ch001.ev001";
  const relTime = "ch002.ev001";
  await wg.processEvent({
    eventId: "ev_birth_loc",
    type: "birth", storyTime: declTime, entityId: targetId,
    source: "engine", entityType: "location", summary: "客栈",
  });
  await wg.processEvent({
    eventId: "ev_fact_loc",
    type: "change", storyTime: declTime, entityId: targetId, source: "engine",
    newFacts: [{ entityId: targetId, property: "位置", description: "客栈", modality: "fact" }],
  });
  await wg.processEvent({
    eventId: "ev_birth_char",
    type: "birth", storyTime: declTime, entityId: charId,
    source: "engine", entityType: "character", summary: "林冲",
  });
  await wg.addRelation(charId, targetId, "located_in", relTime);
  const declId = `decl-${targetId}-位置-${declTime}`;
  return { wg, targetId, charId, declId, declTime, relTime };
}

/** 销毁 wg 的临时文件目录 */
function cleanup(wg: WorldGraph): void {
  try {
    wg.close();
  } finally {
    // 临时文件随系统临时目录清除；此处无需显式 rm（db 文件正被释放）
  }
}

// ---------------------------------------------------------------------------
// 1. 透传抽样（mock Port）
// ---------------------------------------------------------------------------

function makeMockPort(): {
  port: WorldGraphPort;
  readCalls: Record<string, unknown[]>;
  writeCalls: Record<string, unknown[]>;
} {
  const readCalls: Record<string, unknown[]> = {};
  const writeCalls: Record<string, unknown[]> = {};
  const port = {
    getEntityAt: async (...a: unknown[]) => (readCalls.getEntityAt = a, { entityId: "e", type: "location", name: "", aliases: [], summary: "", validFrom: "t", validTo: "Infinity", properties: [] }),
    getCharacterView: async (...a: unknown[]) => (readCalls.getCharacterView = a, []),
    getRelations: async (...a: unknown[]) => (readCalls.getRelations = a, []),
    getAllDeclarationsAt: async (...a: unknown[]) => (readCalls.getAllDeclarationsAt = a, []),
    listStoryTimes: async (...a: unknown[]) => (readCalls.listStoryTimes = a, []),
    getAllRelationsAt: async (...a: unknown[]) => (readCalls.getAllRelationsAt = a, []),
    getVisibilityForDeclaration: async (...a: unknown[]) => (readCalls.getVisibilityForDeclaration = a, []),
    getAllEntities: async (...a: unknown[]) => (readCalls.getAllEntities = a, []),
    getAllEvents: async (...a: unknown[]) => (readCalls.getAllEvents = a, []),
    recordedNow: async (...a: unknown[]) => (readCalls.recordedNow = a, undefined),
    getEntityHistory: async (...a: unknown[]) => (readCalls.getEntityHistory = a, { entities: [], facts: [] }),
    getRelationHistory: async (...a: unknown[]) => (readCalls.getRelationHistory = a, []),
    traceCauses: async (...a: unknown[]) => (readCalls.traceCauses = a, []),
    processEvent: async (...a: unknown[]) => (writeCalls.processEvent = a, undefined),
    birthEntity: async (...a: unknown[]) => (writeCalls.birthEntity = a, undefined),
    killEntity: async (...a: unknown[]) => (writeCalls.killEntity = a, undefined),
    updateEntitySummary: async (...a: unknown[]) => (writeCalls.updateEntitySummary = a, undefined),
    addRelation: async (...a: unknown[]) => (writeCalls.addRelation = a, undefined),
    closeRelation: async (...a: unknown[]) => (writeCalls.closeRelation = a, undefined),
    setVisibility: async (...a: unknown[]) => (writeCalls.setVisibility = a, undefined),
    closeVisibility: async (...a: unknown[]) => (writeCalls.closeVisibility = a, undefined),
    updateFactEmbedding: async (...a: unknown[]) => (writeCalls.updateFactEmbedding = a, undefined),
  } as unknown as WorldGraphPort;
  return { port, readCalls, writeCalls };
}

test("透传抽样：读/写方法原样转发（参数保留）", async () => {
  const { port, readCalls, writeCalls } = makeMockPort();
  const da = WorldGraphDataAccess.create(port);

  await da.getAllEntities("t", { recordedAsOf: "r1" });
  assert.deepEqual(readCalls.getAllEntities, ["t", { recordedAsOf: "r1" }]);

  await da.getEntityHistory("e1", { recordedAsOf: "r1" });
  assert.deepEqual(readCalls.getEntityHistory, ["e1", { recordedAsOf: "r1" }]);

  await da.getRelationHistory(undefined, { recordedAsOf: "r1" });
  assert.deepEqual(readCalls.getRelationHistory, [undefined, { recordedAsOf: "r1" }]);

  await da.getAllRelationsAt("t", { recordedAsOf: "r1" });
  assert.deepEqual(readCalls.getAllRelationsAt, ["t", { recordedAsOf: "r1" }]);

  await da.birthEntity("e1", "character", { name: "甲" }, "t");
  assert.deepEqual(writeCalls.birthEntity, ["e1", "character", { name: "甲" }, "t"]);

  await da.updateEntitySummary("e1", "摘要", "t");
  assert.deepEqual(writeCalls.updateEntitySummary, ["e1", "摘要", "t"]);

  await da.killEntity("e1", "t");
  assert.deepEqual(writeCalls.killEntity, ["e1", "t"]);

  await da.closeVisibility("c1", "d1", "t");
  assert.deepEqual(writeCalls.closeVisibility, ["c1", "d1", "t"]);
});

// ---------------------------------------------------------------------------
// 2. 正常推断（真实 wg）
// ---------------------------------------------------------------------------

test("正常推断：located_in → target 声明可见，validFrom = max(rel, decl)", async () => {
  const { wg, charId, declId, declTime, relTime } = await buildLocatedInGraph();
  try {
    const da = WorldGraphDataAccess.create(createWorldGraphAdapter(wg));
    await da.inferVisibilityAt(relTime);

    const vis = await wg.getVisibilityForDeclaration(declId);
    assert.equal(vis.length, 1);
    assert.equal(vis[0].characterId, charId);
    assert.equal(vis[0].state, "known");
    assert.equal(vis[0].source, "witnessed");
    assert.equal(vis[0].isExplicit, false);
    assert.equal(vis[0].confidence, 1);
    // validFrom = max(rel.validFrom=relTime, decl.validFrom=declTime)
    assert.equal(vis[0].validFrom, relTime > declTime ? relTime : declTime);
  } finally {
    cleanup(wg);
  }
});

// ---------------------------------------------------------------------------
// 3. 幂等
// ---------------------------------------------------------------------------

test("幂等：同一 storyTime 调两次，第二次不产生新可见性记录", async () => {
  const { wg, declId, relTime } = await buildLocatedInGraph();
  try {
    const da = WorldGraphDataAccess.create(createWorldGraphAdapter(wg));
    await da.inferVisibilityAt(relTime);
    const afterFirst = await wg.getVisibilityForDeclaration(declId);
    assert.equal(afterFirst.length, 1);

    await da.inferVisibilityAt(relTime);
    const afterSecond = await wg.getVisibilityForDeclaration(declId);
    assert.equal(afterSecond.length, 1, "第二次推断不应重复产生可见性记录");
  } finally {
    cleanup(wg);
  }
});

// ---------------------------------------------------------------------------
// 4. 撤销回填保护
// ---------------------------------------------------------------------------

test("撤销回填：closeVisibility 后再推断，新记录 validFrom = storyTime", async () => {
  const { wg, charId, declId, relTime } = await buildLocatedInGraph();
  try {
    const da = WorldGraphDataAccess.create(createWorldGraphAdapter(wg));
    await da.inferVisibilityAt(relTime);
    // 在 ch003 撤销可见性
    await wg.closeVisibility(charId, declId, "ch003.ev001");
    // 在 ch004 再次推断：新记录 validFrom 应取推断时刻，不回填到撤销区间之前
    await da.inferVisibilityAt("ch004.ev001");

    const vis = await wg.getVisibilityForDeclaration(declId);
    assert.equal(vis.length, 2);
    // 第一条：撤销前（validTo = ch003.ev001）
    assert.equal(vis[0].validTo, "ch003.ev001");
    // 第二条：撤销后回填为推断时刻
    assert.equal(vis[1].validFrom, "ch004.ev001");
    assert.equal(vis[1].validTo, "Infinity");
  } finally {
    cleanup(wg);
  }
});

// ---------------------------------------------------------------------------
// 5. recordedAsOf 透传
// ---------------------------------------------------------------------------

test("recordedAsOf 透传：三个读取收到 opts，写调用不带", async () => {
  const { port, readCalls, writeCalls } = makeMockPort();
  const da = WorldGraphDataAccess.create(port);

  // 让 getAllRelationsAt 返回一条 located_in，getEntityAt 返回带声明的实体
  readCalls.getAllRelationsAt = [];
  (port as unknown as { getAllRelationsAt: (t: string, o?: unknown) => Promise<unknown[]> }).getAllRelationsAt = async (t, o) => {
    readCalls.getAllRelationsAt = [t, o];
    return [{ relationId: "r1", sourceId: "c1", targetId: "e1", label: "located_in", description: "", validFrom: "t", validTo: "Infinity" }];
  };
  (port as unknown as { getEntityAt: (e: string, t: string, o?: unknown) => Promise<unknown> }).getEntityAt = async (e, t, o) => {
    readCalls.getEntityAt = [e, t, o];
    return { entityId: "e1", type: "location", name: "", aliases: [], summary: "", validFrom: "t", validTo: "Infinity", properties: [{ declarationId: "d1", entityId: "e1", property: "p", description: "", modality: "fact", validFrom: "t", validTo: "Infinity" }] };
  };
  (port as unknown as { getVisibilityForDeclaration: (d: string, t?: string, o?: unknown) => Promise<unknown[]> }).getVisibilityForDeclaration = async (d, t, o) => {
    readCalls.getVisibilityForDeclaration = [d, t, o];
    return [];
  };

  await da.inferVisibilityAt("t", { recordedAsOf: "r1" });

  assert.deepEqual(readCalls.getAllRelationsAt, ["t", { recordedAsOf: "r1" }]);
  assert.deepEqual(readCalls.getEntityAt, ["e1", "t", { recordedAsOf: "r1" }]);
  assert.deepEqual(readCalls.getVisibilityForDeclaration, ["d1", undefined, { recordedAsOf: "r1" }]);
  // 写调用 setVisibility 不带 recordedAsOf
  assert.ok(writeCalls.setVisibility);
  assert.equal(writeCalls.setVisibility[0], "c1");
  assert.equal(writeCalls.setVisibility[1], "d1");
  const setOpts = writeCalls.setVisibility[2] as Record<string, unknown>;
  assert.equal(setOpts.validFrom, "t");
  assert.equal(setOpts.source, "witnessed");
  assert.equal(setOpts.isExplicit, false);
  assert.ok(!("recordedAsOf" in setOpts), "写调用不应携带 recordedAsOf");
});

// ---------------------------------------------------------------------------
// 6. 对照测例：与仓库 wg.inferVisibility 结果一致
// ---------------------------------------------------------------------------

async function buildGraph(fn: (wg: WorldGraph, ids: { charId: string; targetId: string; declId: string }) => Promise<void>): Promise<WorldGraph> {
  const wg = await WorldGraph.create({
    dbPath: join(tmpdir(), `wg-da-compare-${Date.now()}-${Math.random()}.db`),
    eventLogPath: join(tmpdir(), `wg-da-compare-es-${Date.now()}-${Math.random()}.jsonl`),
  });
  const charId = "ent_char_b";
  const targetId = "ent_loc_b";
  const declTime = "ch001.ev001";
  const relTime = "ch002.ev001";
  await wg.processEvent({ eventId: "e1", type: "birth", storyTime: declTime, entityId: targetId, source: "engine", entityType: "location", summary: "茶楼" });
  await wg.processEvent({ eventId: "e2", type: "change", storyTime: declTime, entityId: targetId, source: "engine", newFacts: [{ entityId: targetId, property: "位置", description: "茶楼", modality: "fact" }] });
  await wg.processEvent({ eventId: "e3", type: "birth", storyTime: declTime, entityId: charId, source: "engine", entityType: "character", summary: "鲁智深" });
  await wg.addRelation(charId, targetId, "located_in", relTime);
  const declId = `decl-${targetId}-位置-${declTime}`;
  await fn(wg, { charId, targetId, declId });
  return wg;
}

test("对照测例：inferVisibilityAt 与仓库 wg.inferVisibility 可见性记录集合一致", async () => {
  const wgA = await buildGraph(async () => {});
  const wgB = await buildGraph(async () => {});
  try {
    const da = WorldGraphDataAccess.create(createWorldGraphAdapter(wgA));
    await da.inferVisibilityAt("ch002.ev001");
    await wgB.inferVisibility("ch002.ev001");

    const declId = "decl-ent_loc_b-位置-ch001.ev001";
    const visA = await wgA.getVisibilityForDeclaration(declId);
    const visB = await wgB.getVisibilityForDeclaration(declId);
    assert.equal(visA.length, visB.length);
    assert.deepEqual(visA, visB);
  } finally {
    cleanup(wgA);
    cleanup(wgB);
  }
});