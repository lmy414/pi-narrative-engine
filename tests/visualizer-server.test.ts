/**
 * visualizer-server.test.ts — world-graph 可视化服务端集成测试
 *
 * 通过 startVisualizer({ wg, port: 0 }) 起真实 HTTP 服务，用 fetch 验证
 * 全部 /api 端点（读 + 写 + 错误路径）。不测静态文件（visualizer-ui 不在
 * 本测试范围内），uiDir 指向空 tmp 目录。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { WorldGraph } from "@pi/world-graph";
import { startVisualizer } from "../src/visualizer/server.ts";
import type { VisualizerServer } from "../src/visualizer/server.ts";

let dir: string;
let wg: WorldGraph;
let server: VisualizerServer;
let base: string;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}api${path}`, init);
  const json = (await res.json()) as {
    ok: boolean;
    data: any;
    error: { code: string; message: string } | null;
  };
  return { status: res.status, ...json };
}

async function postJson(path: string, body: unknown) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "viz-test-"));
  wg = await WorldGraph.create({
    dbPath: join(dir, "world.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });

  // 种子数据：两个实体（birth 经 processEvent，含 entityType/summary）、
  // 一次 change（闭合旧声明）、一条关系、一条可见性
  await wg.processEvent({
    eventId: "evt-birth-e1",
    type: "birth",
    storyTime: "t1",
    entityId: "e1",
    entityType: "character",
    summary: "主角",
    newFacts: [
      { entityId: "e1", property: "name", value: "阿明", modality: "fact" },
      { entityId: "e1", property: "mood", value: "平静", modality: "fact" },
    ],
  });
  await wg.processEvent({
    eventId: "evt-birth-e2",
    type: "birth",
    storyTime: "t1",
    entityId: "e2",
    entityType: "location",
    newFacts: [{ entityId: "e2", property: "name", value: "客栈", modality: "fact" }],
  });
  await wg.processEvent({
    eventId: "evt-change-mood",
    type: "change",
    storyTime: "t2",
    entityId: "e1",
    invalidated: [{ declarationId: "decl-e1-mood-t1", property: "mood" }],
    newFacts: [{ entityId: "e1", property: "mood", value: "愤怒", modality: "fact" }],
  });
  await wg.addRelation("e1", "e2", "located_in", "t1");
  await wg.setVisibility("e1", "decl-e2-name-t1", {
    state: "known",
    confidence: 1,
    source: "witnessed",
    validFrom: "t1",
    isExplicit: true,
  });

  const uiDir = join(dir, "empty-ui");
  mkdirSync(uiDir);
  server = await startVisualizer({ wg, search: null, port: 0, uiDir });
  base = server.url;
});

after(() => {
  server.close();
  wg.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 读端点
// ============================================================================

test("GET /api/status 返回 entityCount/eventCount/storyTimes", async () => {
  const r = await api("/status");
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.data.storyTimes, ["t1", "t2"]);
  assert.equal(r.data.entityCount, 2);
  assert.equal(r.data.eventCount, 3);
});

test("GET /api/graph 指定 storyTime 返回实体与关系", async () => {
  const r = await api("/graph?storyTime=t2");
  assert.equal(r.ok, true);
  assert.equal(r.data.entities.length, 2);
  assert.equal(r.data.relations.length, 1);
  assert.equal(r.data.relations[0].label, "located_in");
  const e1 = r.data.entities.find((e: any) => e.entityId === "e1");
  assert.equal(e1.summary, "主角");
  const mood = e1.properties.find((p: any) => p.property === "mood");
  assert.equal(mood.value, "愤怒", "t2 时刻应看到 change 后的新值");
});

test("GET /api/graph 缺 storyTime → 400 STORY_TIME_REQUIRED", async () => {
  const r = await api("/graph");
  assert.equal(r.status, 400);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "STORY_TIME_REQUIRED");
});

test("GET /api/entities/:id 返回快照；未知实体 404", async () => {
  const r = await api("/entities/e1?storyTime=t2");
  assert.equal(r.ok, true);
  assert.equal(r.data.entityId, "e1");

  const missing = await api("/entities/unknown?storyTime=t2");
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "ENTITY_NOT_FOUND");

  const noTime = await api("/entities/e1");
  assert.equal(noTime.status, 400);
  assert.equal(noTime.error?.code, "STORY_TIME_REQUIRED");
});

test("GET /api/entities/:id/history 含已闭合声明与关系历史", async () => {
  const r = await api("/entities/e1/history");
  assert.equal(r.ok, true);
  const oldMood = r.data.facts.find(
    (f: any) => f.property === "mood" && f.value === "平静",
  );
  assert.ok(oldMood, "历史应含旧 mood 声明");
  assert.equal(oldMood.validTo, "t2", "旧声明应已在 t2 闭合");
  assert.ok(
    r.data.relations.some((rel: any) => rel.label === "located_in"),
    "历史应含关系记录",
  );
});

test("GET /api/declarations/:declId/visibility 返回可见性记录", async () => {
  const r = await api("/declarations/decl-e2-name-t1/visibility?storyTime=t1");
  assert.equal(r.ok, true);
  assert.equal(r.data.visibility.length, 1);
  assert.equal(r.data.visibility[0].characterId, "e1");
  assert.equal(r.data.visibility[0].isExplicit, true);
});

test("GET /api/events 与 /api/events/:id/chain", async () => {
  const all = await api("/events");
  assert.equal(all.ok, true);
  assert.equal(all.data.events.length, 3);

  const chain = await api("/events/evt-change-mood/chain");
  assert.equal(chain.ok, true);
  assert.ok(
    chain.data.events.some((e: any) => e.eventId === "evt-change-mood"),
    "因果链应包含目标事件",
  );
});

test("GET /api/search 无 search 实例 → 501 SEARCH_UNAVAILABLE", async () => {
  const r = await api("/search?q=阿明&storyTime=t2");
  assert.equal(r.status, 501);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "SEARCH_UNAVAILABLE");
});

test("未知路由 404 NOT_FOUND", async () => {
  const r = await api("/no-such-route");
  assert.equal(r.status, 404);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "NOT_FOUND");
});

test("GET /api.js 走静态服务而非 API 路由（回归：/api 前缀误判）", async () => {
  const realUiDir = fileURLToPath(new URL("../visualizer-ui", import.meta.url));
  const s2 = await startVisualizer({ wg, search: null, port: 0, uiDir: realUiDir });
  try {
    const res = await fetch(`${s2.url}api.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Viz.api"), "应返回前端 api.js 源码");
  } finally {
    s2.close();
  }
});

// ============================================================================
// 写端点（顺序敏感：后续测试依赖此处产生的 t3 数据）
// ============================================================================

test("POST /api/events 应用 change，强制 source=user，旧声明闭合", async () => {
  const r = await postJson("/events", {
    eventId: "evt-user-edit",
    type: "change",
    storyTime: "t3",
    entityId: "e1",
    source: "engine", // 应被服务端强制覆盖为 "user"
    invalidated: [{ declarationId: "decl-e1-name-t1", property: "name" }],
    newFacts: [{ entityId: "e1", property: "name", value: "明明", modality: "fact" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.data.eventId, "evt-user-edit");

  // 新值生效
  const snap = await api("/entities/e1?storyTime=t3");
  const name = snap.data.properties.find((p: any) => p.property === "name");
  assert.equal(name.value, "明明");

  // 旧声明已闭合
  const history = await api("/entities/e1/history");
  const oldName = history.data.facts.find(
    (f: any) => f.property === "name" && f.value === "阿明",
  );
  assert.equal(oldName.validTo, "t3");

  // events.jsonl 中该事件 source === "user"
  const lines = readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n");
  const logged = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.eventId === "evt-user-edit");
  assert.ok(logged, "事件应已写入 events.jsonl");
  assert.equal(logged.source, "user", "source 应被强制覆盖为 user");
});

test("POST /api/relations 创建，/api/relations/close 闭合，includeClosed=1 可见", async () => {
  const add = await postJson("/relations", {
    sourceId: "e2",
    targetId: "e1",
    label: "hosts",
    storyTime: "t3",
  });
  assert.equal(add.ok, true);

  const atT3 = await api("/graph?storyTime=t3");
  assert.ok(atT3.data.relations.some((rel: any) => rel.label === "hosts"));

  const close = await postJson("/relations/close", {
    sourceId: "e2",
    targetId: "e1",
    label: "hosts",
    storyTime: "t4",
  });
  assert.equal(close.ok, true);

  const atT4 = await api("/graph?storyTime=t4");
  assert.ok(!atT4.data.relations.some((rel: any) => rel.label === "hosts"), "闭合后默认不返回");

  const withClosed = await api("/graph?storyTime=t4&includeClosed=1");
  const closed = withClosed.data.relations.find((rel: any) => rel.label === "hosts");
  assert.ok(closed, "includeClosed=1 应返回已闭合关系");
  assert.equal(closed.validTo, "t4");

  // 重复闭合 → 400 业务错误
  const again = await postJson("/relations/close", {
    sourceId: "e2",
    targetId: "e1",
    label: "hosts",
    storyTime: "t5",
  });
  assert.equal(again.status, 400);
  assert.equal(again.ok, false);
  assert.equal(again.error?.code, "BUSINESS_ERROR");
});

test("POST /api/visibility 设置，/api/visibility/close 闭合", async () => {
  const set = await postJson("/visibility", {
    characterId: "e1",
    declarationId: "decl-e1-mood-t2",
    confidence: 0.8,
    source: "rumor",
    storyTime: "t3",
  });
  assert.equal(set.ok, true);

  const atT3 = await api("/declarations/decl-e1-mood-t2/visibility?storyTime=t3");
  assert.equal(atT3.data.visibility.length, 1);
  assert.equal(atT3.data.visibility[0].confidence, 0.8);

  const close = await postJson("/visibility/close", {
    characterId: "e1",
    declarationId: "decl-e1-mood-t2",
    storyTime: "t4",
  });
  assert.equal(close.ok, true);

  const atT4 = await api("/declarations/decl-e1-mood-t2/visibility?storyTime=t4");
  assert.equal(atT4.data.visibility.length, 0, "闭合后该时刻不再可见");

  const allHistory = await api("/declarations/decl-e1-mood-t2/visibility");
  assert.equal(allHistory.data.visibility.length, 1, "不传 storyTime 返回含已闭合的全部历史");
  assert.equal(allHistory.data.visibility[0].validTo, "t4");
});

test("POST /api/entities/:id/summary 更新摘要", async () => {
  const r = await postJson("/entities/e2/summary", { summary: "主要场景" });
  assert.equal(r.ok, true);
  const snap = await api("/entities/e2?storyTime=t3");
  assert.equal(snap.data.summary, "主要场景");
});

test("POST /api/events 非法 body → 400 VALIDATION_ERROR", async () => {
  const r = await postJson("/events", {
    eventId: "evt-bad",
    type: "change",
    storyTime: "t3",
    entityId: "e1",
    newFacts: [{ entityId: "e1", property: "x", value: 1, modality: "not-a-modality" }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "VALIDATION_ERROR");
});
