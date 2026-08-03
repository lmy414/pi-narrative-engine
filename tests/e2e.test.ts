import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "underworld-graph";
import { Embedder } from "../src/embedder.ts";
import { Search } from "../src/search.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createImportTools } from "../src/chat/import-tools.ts";

test("createImportTools：注册 2 个唯一工具且全部提供 promptSnippet", () => {
  const tools = createImportTools({
    cwd: process.cwd(),
    wg: {} as WorldGraph,
    embedder: {} as Embedder,
    currentStoryTime: "ch001.ev001",
    setCurrentStoryTime() {},
  });
  assert.deepEqual(tools.map(t => t.name), ["import_novel", "import_character_card"]);
  assert.ok(tools.every(t => t.promptSnippet));
});

test("createImportTools：2 个工具均可执行并保持项目状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-tools-"));
  const cardPath = join(dir, "card.json");
  writeFileSync(cardPath, JSON.stringify({ name: "林冲", description: "豹子头" }), "utf8");
  const storyTimes: string[] = [];
  const wg = {
    listStoryTimes: async () => ["ch003.ev007"],
    processEvent: async () => {},
    setVisibility: async () => {},
  } as unknown as WorldGraph;
  const pipelineCalls: unknown[] = [];
  const tools = createImportTools({
    cwd: dir,
    wg,
    embedder: {} as Embedder,
    currentStoryTime: "ch001.ev001",
    setCurrentStoryTime(value) { storyTimes.push(value); },
    runImportPipeline: async options => {
      pipelineCalls.push(options);
      return { entityCount: 1, eventCount: 1, relationCount: 0, visibilityCount: 0, worldGraphDir: dir, dumpPath: join(dir, "dump.json") };
    },
  });
  const params: Record<string, Record<string, unknown>> = {
    import_novel: { epubPath: join(dir, "novel.epub") },
    import_character_card: { cardPath, entityId: "e_lin_chong" },
  };
  for (const tool of tools) {
    const result = await tool.execute(tool.name, params[tool.name]!, undefined, undefined, {} as never);
    assert.ok(Array.isArray(result.content), `${tool.name} 应返回 content`);
    assert.ok("details" in result, `${tool.name} 应返回 details`);
  }
  assert.equal(pipelineCalls.length, 1);
  assert.deepEqual(storyTimes, ["ch003.ev007", "ch001.ev001"]);
});

test("完整工作流：创建实体 → 关系 → 事件 → 可见性 → 检索", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  // CI 稳定性：不实例化真实 Embedder（bge-small-zh 需从 HuggingFace 下载，
  // 429 rate limit 偶发失败），改用 stub 跑全链路；检索断言走 fulltext 模式
  // （搜 Fact.searchable 字段，不依赖向量质量）。
  // 零向量保持维度合法（typegraph 要求 512 维有限数数组）；fulltext 模式不读向量值
  const zeroVec = () => new Array(512).fill(0);
  const embedder = {
    embed: async () => zeroVec(),
    embedEntity: async () => zeroVec(),
    embedFact: async () => zeroVec(),
    embedBatch: async () => [zeroVec()],
  } as unknown as Embedder;
  const search = new Search(wg, embedder);

  // 1. 创建 Macbeth + Duncan + Inverness
  await wg.birthEntity("macbeth", "character", { name: "Macbeth", title: "Thane" }, "act1-scene1");
  await wg.birthEntity("duncan", "character", { name: "Duncan", title: "King" }, "act1-scene1");
  await wg.birthEntity("inverness", "location", { name: "Inverness", type: "castle" }, "act1-scene1");

  // 2. addRelation(macbeth, inverness, located_in)
  await wg.addRelation("macbeth", "inverness", "located_in", "act1-scene1");

  // 3. processEvent(change: duncan 的 title 改为 dead)
  // 先获取 duncan 的 title declarationId
  const duncanSnap = await wg.getEntityAt("duncan", "act1-scene1");
  const titleDecl = duncanSnap!.properties.find(p => p.property === "title")!;
  await wg.processEvent({
    eventId: "evt-1",
    type: "change",
    storyTime: "act2-scene1",
    entityId: "duncan",
    causedBy: undefined,
    invalidated: [{ declarationId: titleDecl.declarationId, property: "title" }],
    newFacts: [{
      entityId: "duncan",
      property: "status",
      value: "dead",
      modality: "fact",
    }],
  });

  // 4. 验证 bi-temporal：act1-scene1 时 duncan title 是 King，act2-scene1 时 status 是 dead
  const duncanAct1 = await wg.getEntityAt("duncan", "act1-scene1");
  assert.ok(duncanAct1!.properties.find(p => p.property === "title" && p.value === "King"), "act1 应有 title=King");

  const duncanAct2 = await wg.getEntityAt("duncan", "act2-scene1");
  assert.ok(duncanAct2!.properties.find(p => p.property === "status" && p.value === "dead"), "act2 应有 status=dead");

  // 5. inferVisibility + character_view
  await wg.inferVisibility("act1-scene1");
  const macbethView = await wg.getCharacterView("macbeth", "act2-scene1");
  // macbeth 在 inverness，应能看到 inverness 相关的声明（具体可见性取决于 character-view 实现）
  assert.ok(Array.isArray(macbethView), "character_view 应返回数组");

  // 6. reembedAll + world_query（fulltext 模式：不依赖向量，命中 Fact 的 searchable 字段）
  await wg.reembedAll(embedder);
  const results = await search.search("Duncan", { topK: 5, storyTime: "act2-scene1", mode: "fulltext" });
  assert.ok(results.length > 0, "检索 Duncan 应有结果");
  assert.ok(results.find(r => r.entityId === "duncan"), "应命中 duncan");

  // 7. getAllEvents 验证事件链
  const events = await wg.getAllEvents();
  assert.ok(events.length >= 1, "应有事件记录");

  wg.close();
});
