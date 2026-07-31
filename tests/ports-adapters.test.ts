// tests/ports-adapters.test.ts
/**
 * 数据层 Ports 适配器单测（A1 验收）
 *
 * 覆盖：6 个适配器的方法映射与参数透传。
 * - wg / search / embedder 用 mock（薄包装只透传）
 * - ruleset / memory / renderer 用临时目录做真实文件操作（读文件返回空串、写章节再读回）
 * - rolePool 断言未接线抛错
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorldGraphAdapter,
  createSearchAdapter,
  createEmbedderAdapter,
  createFileRulesetAdapter,
  createMemoryAdapter,
  createRendererAdapter,
  createRolePoolAdapter,
} from "../src/ports/adapters.ts";

/** mock wg：记录调用参数并返回固定值 */
function makeMockWg() {
  const calls: Record<string, unknown[]> = {};
  function track(name: string) {
    return (...args: unknown[]) => {
      calls[name] = args;
      if (name === "getEntityAt") return Promise.resolve(null);
      if (name === "getCharacterView") return Promise.resolve([]);
      if (name === "getRelations") return Promise.resolve([]);
      if (name === "getAllDeclarationsAt") return Promise.resolve([]);
      if (name === "listStoryTimes") return Promise.resolve(["ch001.ev001"]);
      if (name === "getAllEvents") return Promise.resolve([]);
      return Promise.resolve();
    };
  }
  const wg = {
    getEntityAt: track("getEntityAt"),
    getCharacterView: track("getCharacterView"),
    getRelations: track("getRelations"),
    getAllDeclarationsAt: track("getAllDeclarationsAt"),
    listStoryTimes: track("listStoryTimes"),
    processEvent: track("processEvent"),
    addRelation: track("addRelation"),
    setVisibility: track("setVisibility"),
    updateFactEmbedding: track("updateFactEmbedding"),
    getAllEvents: track("getAllEvents"),
  };
  return { wg, calls };
}

test("WorldGraphPort 适配器：方法透传 + 参数保留", async () => {
  const { wg, calls } = makeMockWg();
  const port = createWorldGraphAdapter(wg as never);

  await port.getEntityAt("ent_a", "ch001.ev001", { recordedAsOf: "r1" });
  assert.deepEqual(calls.getEntityAt, ["ent_a", "ch001.ev001", { recordedAsOf: "r1" }]);

  await port.getCharacterView("char_a", "ch001.ev001", {
    modalityFilter: ["fact"],
    recordedAsOf: "r1",
  });
  assert.deepEqual(calls.getCharacterView, [
    "char_a",
    "ch001.ev001",
    { modalityFilter: ["fact"], recordedAsOf: "r1" },
  ]);

  await port.getRelations("ent_a", "ch001.ev001");
    assert.deepEqual(calls.getRelations.slice(0, 2), ["ent_a", "ch001.ev001"]);

  await port.getAllDeclarationsAt("ch001.ev001");
  assert.deepEqual(calls.getAllDeclarationsAt, ["ch001.ev001"]);

  const times = await port.listStoryTimes();
  assert.deepEqual(times, ["ch001.ev001"]);

  await port.processEvent({ eventId: "evt_x", type: "change", storyTime: "ch001.ev001", entityId: "ent_a" });
  assert.equal(calls.processEvent[0].eventId, "evt_x");

  await port.addRelation("char_a", "char_b", "friend", "ch001.ev001");
  assert.deepEqual(calls.addRelation, ["char_a", "char_b", "friend", "ch001.ev001"]);

  await port.setVisibility("char_a", "decl-1", {
    state: "known",
    confidence: 1,
    source: "experienced",
    validFrom: "ch001.ev001",
    isExplicit: true,
  });
  assert.equal(calls.setVisibility[0], "char_a");
  assert.equal(calls.setVisibility[1], "decl-1");

  await port.updateFactEmbedding("decl-1", [0.1, 0.2]);
  assert.deepEqual(calls.updateFactEmbedding, ["decl-1", [0.1, 0.2]]);
});

test("SearchPort 适配器：search 透传", async () => {
  const calls: unknown[] = [];
  const search = {
    search: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([]);
    },
  };
  const port = createSearchAdapter(search as never);
  await port.search("林冲", { topK: 5, storyTime: "ch001.ev001", mode: "hybrid" });
  assert.deepEqual(calls[0], ["林冲", { topK: 5, storyTime: "ch001.ev001", mode: "hybrid" }]);
});

test("EmbedderPort 适配器：三个方法透传", async () => {
  const calls: string[] = [];
  const emb = {
    embed: async (t: string) => (calls.push(`embed:${t}`), [1]),
    embedEntity: async (s: unknown) => (calls.push(`embedEntity:${String(s)}`), [2]),
    embedFact: async (d: unknown) => (calls.push(`embedFact:${String(d)}`), [3]),
  };
  const port = createEmbedderAdapter(emb as never);
  await port.embed("文本");
  await port.embedEntity({ entityId: "e" } as never);
  await port.embedFact({ declarationId: "d" } as never);
  assert.deepEqual(calls, ["embed:文本", "embedEntity:[object Object]", "embedFact:[object Object]"]);
});

test("RulesetPort 适配器：文件缺失时返回空串", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ports-ruleset-"));
  try {
    const port = createFileRulesetAdapter();
    const planner = await port.loadPlanner(dir);
    const role = await port.loadRole(dir);
    const render = await port.loadRender(dir);
    assert.equal(planner, "");
    assert.equal(role, "");
    assert.equal(render, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("MemoryPort 适配器：load 文件缺失返回空串，update 空项目不抛错", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ports-memory-"));
  try {
    const { wg } = makeMockWg();
    const port = createMemoryAdapter(wg as never);
    const loaded = await port.load(dir);
    assert.equal(loaded, "");
    // mock wg.getAllEvents 返回空 → updateMemory 直接 return
    await port.update(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("RendererPort 适配器：ensure/append/read/modify/insert 真实文件操作", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ports-renderer-"));
  const chapter = path.join(dir, "ch001.md");
  try {
    const port = createRendererAdapter();

    await port.ensureChapterFile(chapter);
    const before = await fs.readFile(chapter, "utf8");
    assert.ok(before.includes("<!-- engine v0.01 -->"), "新建章节含版本标记");

    // append：追加锚点区块
    await port.appendToChapter(chapter, "evt_1", "第一段正文\n");
    const afterAppend = await port.readChapter(chapter);
    assert.ok(afterAppend.includes("<!-- event: evt_1 -->"));
    assert.ok(afterAppend.includes("第一段正文"));

    // modify：重写锚点区间正文
    await port.modifyChapterSection(chapter, "evt_1", "修改后的正文\n");
    const afterModify = await port.readChapter(chapter);
    assert.ok(afterModify.includes("修改后的正文"));
    assert.ok(!afterModify.includes("第一段正文"));

    // insert：在 evt_1 之后插入新区块
    await port.insertChapterSection(chapter, "evt_1", "evt_2", "插入的正文\n");
    const afterInsert = await port.readChapter(chapter);
    assert.ok(afterInsert.includes("<!-- event: evt_2 -->"));
    assert.ok(afterInsert.includes("插入的正文"));

    // readChapterSection：读锚点区间
    const section = await port.readChapterSection(chapter, "evt_2");
    assert.ok(section.includes("插入的正文"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("RolePoolPort 适配器：未接线时 interact 抛错", async () => {
  const port = createRolePoolAdapter();
  await assert.rejects(
    () => port.interact({ eventInstruction: "x", storyTime: "ch001.ev001", cast: [] }, { llm: async () => { throw new Error("unused"); }, ruleSet: "" }),
    /未接线/,
  );
});
