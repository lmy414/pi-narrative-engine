import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "underworld-graph";
import { Embedder } from "../src/embedder.ts";
import { Search } from "../src/search.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

test("完整工作流：创建实体 → 关系 → 事件 → 可见性 → 检索", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  const embedder = new Embedder();
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

  // 6. reembedAll + world_query
  await wg.reembedAll(embedder);
  const results = await search.search("Duncan", { topK: 5, storyTime: "act2-scene1" });
  assert.ok(results.length > 0, "检索 Duncan 应有结果");
  assert.ok(results.find(r => r.entityId === "duncan"), "应命中 duncan");

  // 7. getAllEvents 验证事件链
  const events = await wg.getAllEvents();
  assert.ok(events.length >= 1, "应有事件记录");

  wg.close();
});
