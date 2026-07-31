// tests/agent-tools.test.ts
/**
 * 子代理世界图/章节工具单测（A4 验收）
 *
 * mock OrchestratorPorts，断言：
 * - 只读/写工具的参数映射与 ports 调用正确
 * - 角色受限变体按可见声明过滤（entity_get_limited / query_limited）
 * - 渲染器 chapter_write 三分支（add/modify/insert）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorPorts } from "../src/orchestrator/assembly.ts";
import {
  createEntityGetTool,
  createEventApplyTool,
  createVisibilitySetTool,
  createRelationAddTool,
  createLimitedEntityGetTool,
  createLimitedQueryTool,
} from "../src/agents/world-tools.ts";
import {
  createChapterReadTool,
  createChapterWriteTool,
} from "../src/agents/chapter-tools.ts";

interface MockPorts {
  ports: OrchestratorPorts;
  calls: Record<string, unknown[]>;
  /** 受控返回值（测试可预置） */
  set: {
    snapshot?: unknown;
    view?: unknown[];
    relations?: unknown[];
    searchResults?: unknown[];
    chapterContent?: string;
  };
}

/** 构造 mock ports：各方法记录调用参数，返回值受控（执行时读 set） */
function makeMockPorts(): MockPorts {
  const calls: Record<string, unknown[]> = {};
  const set: MockPorts["set"] = {};
  /** 受控返回值映射：方法名 → set 字段 */
  const controlled: Record<string, () => unknown> = {
    getEntityAt: () => set.snapshot,
    getCharacterView: () => set.view,
    getRelations: () => set.relations,
    search: () => set.searchResults,
    readChapter: () => set.chapterContent,
    listStoryTimes: () => ["ch001.ev001"],
  };
  function track(name: string) {
    return (...args: unknown[]) => {
      calls[name] = args;
      const get = controlled[name];
      return Promise.resolve(get ? get() : undefined);
    };
  }
  const worldGraph = {
    getEntityAt: track("getEntityAt"),
    getCharacterView: track("getCharacterView"),
    getRelations: track("getRelations"),
    getAllDeclarationsAt: track("getAllDeclarationsAt"),
    listStoryTimes: track("listStoryTimes"),
    traceCauses: track("traceCauses"),
    processEvent: track("processEvent"),
    addRelation: track("addRelation"),
    closeRelation: track("closeRelation"),
    setVisibility: track("setVisibility"),
    closeVisibility: track("closeVisibility"),
    inferVisibility: track("inferVisibility"),
    updateFactEmbedding: track("updateFactEmbedding"),
  };
  const search = { search: track("search") };
  const renderer = {
    ensureChapterFile: track("ensureChapterFile"),
    readChapter: track("readChapter"),
    readChapterSection: track("readChapterSection"),
    appendToChapter: track("appendToChapter"),
    modifyChapterSection: track("modifyChapterSection"),
    insertChapterSection: track("insertChapterSection"),
  };
  const ports = {
    worldGraph: worldGraph as never,
    search: search as never,
    renderer: renderer as never,
  } as OrchestratorPorts;
  return { ports, calls, set };
}

test("world_entity_get：storyTime 缺省取最新时间点", async () => {
  const m = makeMockPorts();
  m.set.snapshot = { entityId: "ent_a", type: "character", properties: [] };
  const tool = createEntityGetTool(m.ports);
  const result = await tool.execute("1", { entityId: "ent_a" });
  assert.deepEqual(m.calls.listStoryTimes, []);
  assert.deepEqual(m.calls.getEntityAt, ["ent_a", "ch001.ev001"]);
  assert.equal(result.details.snapshot.entityId, "ent_a");
});

test("world_event_apply：processEvent 收到正确事件（source=engine）", async () => {
  const m = makeMockPorts();
  const tool = createEventApplyTool(m.ports);
  await tool.execute("1", {
    eventId: "evt_x",
    type: "change",
    storyTime: "ch001.ev001",
    entityId: "ent_a",
    newFacts: [{ entityId: "ent_a", property: "mood", value: "怒", modality: "fact" }],
  });
  const evt = m.calls.processEvent[0] as Record<string, unknown>;
  assert.equal(evt.eventId, "evt_x");
  assert.equal(evt.type, "change");
  assert.equal(evt.source, "engine");
  assert.equal((evt.newFacts as unknown[]).length, 1);
});

test("world_visibility_set：setVisibility 收到正确 opts", async () => {
  const m = makeMockPorts();
  const tool = createVisibilitySetTool(m.ports);
  await tool.execute("1", {
    characterId: "char_a",
    declarationId: "decl-1",
    confidence: 0.9,
    source: "experienced",
    validFrom: "ch001.ev001",
  });
  const [charId, declId, opts] = m.calls.setVisibility as [string, string, Record<string, unknown>];
  assert.equal(charId, "char_a");
  assert.equal(declId, "decl-1");
  assert.equal(opts.state, "known");
  assert.equal(opts.confidence, 0.9);
  assert.equal(opts.source, "experienced");
  assert.equal(opts.isExplicit, true);
});

test("world_relation_add：addRelation 收到 source/target/label/storyTime", async () => {
  const m = makeMockPorts();
  const tool = createRelationAddTool(m.ports);
  await tool.execute("1", {
    sourceId: "char_a",
    targetId: "char_b",
    label: "friend",
    storyTime: "ch001.ev001",
  });
  assert.deepEqual(m.calls.addRelation, ["char_a", "char_b", "friend", "ch001.ev001"]);
});

test("entity_get_limited：properties 按角色可见声明过滤", async () => {
  const m = makeMockPorts();
  m.set.snapshot = {
    entityId: "ent_a",
    type: "character",
    properties: [
      { declarationId: "decl-1", property: "mood", value: "怒" },
      { declarationId: "decl-2", property: "location", value: "梁山" },
    ],
  };
  m.set.view = [{ declarationId: "decl-1" }];
  const tool = createLimitedEntityGetTool(m.ports, "char_a");
  const result = await tool.execute("1", { entityId: "ent_a", storyTime: "ch001.ev001" });
  const snap = result.details.snapshot as { properties: unknown[] };
  assert.equal(snap.properties.length, 1);
  assert.equal((snap.properties[0] as { declarationId: string }).declarationId, "decl-1");
});

test("query_limited：检索结果按可见声明交集过滤", async () => {
  const m = makeMockPorts();
  m.set.searchResults = [
    { entityId: "ent_a", score: 0.9, snapshot: { entityId: "ent_a", properties: [{ declarationId: "decl-1" }] } },
    { entityId: "ent_b", score: 0.8, snapshot: { entityId: "ent_b", properties: [{ declarationId: "decl-9" }] } },
  ];
  m.set.view = [{ declarationId: "decl-1" }];
  const tool = createLimitedQueryTool(m.ports, "char_a");
  const result = await tool.execute("1", { query: "林冲", storyTime: "ch001.ev001" });
  const filtered = result.details.results as { entityId: string }[];
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].entityId, "ent_a");
});

test("chapter_read：读章节全文透传", async () => {
  const m = makeMockPorts();
  m.set.chapterContent = "<!-- engine v0.01 -->\n正文";
  const tool = createChapterReadTool(m.ports);
  const result = await tool.execute("1", { chapterPath: "chapters/ch001.md" });
  assert.deepEqual(m.calls.readChapter, ["chapters/ch001.md"]);
  assert.equal(result.details.content, "<!-- engine v0.01 -->\n正文");
});

test("chapter_write：add 分支走 appendToChapter", async () => {
  const m = makeMockPorts();
  const tool = createChapterWriteTool(m.ports);
  await tool.execute("1", {
    chapterPath: "chapters/ch001.md",
    mode: "add",
    eventId: "evt_1",
    text: "正文内容",
  });
  assert.deepEqual(m.calls.appendToChapter, ["chapters/ch001.md", "evt_1", "正文内容"]);
  assert.equal(m.calls.modifyChapterSection, undefined);
  assert.equal(m.calls.insertChapterSection, undefined);
});

test("chapter_write：modify 分支走 modifyChapterSection", async () => {
  const m = makeMockPorts();
  const tool = createChapterWriteTool(m.ports);
  await tool.execute("1", {
    chapterPath: "chapters/ch001.md",
    mode: "modify",
    eventId: "evt_2",
    text: "修改后正文",
    targetEventId: "evt_1",
  });
  assert.deepEqual(m.calls.modifyChapterSection, ["chapters/ch001.md", "evt_1", "修改后正文"]);
});

test("chapter_write：insert 分支走 insertChapterSection", async () => {
  const m = makeMockPorts();
  const tool = createChapterWriteTool(m.ports);
  await tool.execute("1", {
    chapterPath: "chapters/ch001.md",
    mode: "insert",
    eventId: "evt_2",
    text: "插入正文",
    targetEventId: "evt_1",
  });
  assert.deepEqual(m.calls.insertChapterSection, ["chapters/ch001.md", "evt_1", "evt_2", "插入正文"]);
});

test("chapter_write：modify/insert 缺 targetEventId 返回错误不写入", async () => {
  const m = makeMockPorts();
  const tool = createChapterWriteTool(m.ports);
  const result = await tool.execute("1", {
    chapterPath: "chapters/ch001.md",
    mode: "modify",
    eventId: "evt_2",
    text: "正文",
  });
  assert.equal(result.details.ok, false);
  assert.equal(m.calls.modifyChapterSection, undefined);
});
