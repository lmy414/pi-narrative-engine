import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "../src/world-graph.ts";

function withTempWg(fn: (wg: WorldGraph) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-cv-"));
    const wg = new WorldGraph({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try { await fn(wg); } finally { wg.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("characterView 返回角色已知声明（飞书文档步骤 8 Macbeth 示例）", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", { title: "Thane" }, "act1-scene1");
  await wg.birthEntity("ent-inverness", "location", { temp: "cold" }, "act1-scene1");
  await wg.addRelation("ent-macbeth", "ent-inverness", "located_in", "act1-scene1");
  await wg.processEvent({
    eventId: "evt-duncan-visit",
    type: "change",
    storyTime: "act1-scene4",
    entityId: "ent-inverness",
    newFacts: [{ entityId: "ent-inverness", property: "visitor", value: "Duncan", modality: "fact" }],
  });
  await wg.inferVisibility("act1-scene4");
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene4", { modalityFilter: ["fact"] });
  const visitorDecl = view.find((d: any) => d.property === "visitor");
  assert.ok(visitorDecl, "Macbeth 应通过 located_in 推断看到 Inverness 的 visitor 声明");
  assert.equal(visitorDecl.value, "Duncan");
}));

test("characterView 角色无可见性声明时返回空", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.birthEntity("ent-duncan", "character", { status: "alive" }, "act1-scene1");
  const view = await wg.getCharacterView("ent-macbeth", "act1-scene1");
  assert.equal(view.length, 0);
}));

test("characterView modalityFilter 过滤", withTempWg(async (wg) => {
  await wg.birthEntity("ent-macbeth", "character", {}, "act1-scene1");
  await wg.processEvent({
    eventId: "evt-belief",
    type: "change",
    storyTime: "act1-scene2",
    entityId: "ent-macbeth",
    invalidated: [],
    newFacts: [{ entityId: "ent-macbeth", property: "believes_prophecy", value: true, modality: "belief" }],
  });
  const snap2 = await wg.getEntityAt("ent-macbeth", "act1-scene2");
  for (const d of snap2!.properties) {
    await wg.setVisibility("ent-macbeth", d.declarationId, {
      state: "known", confidence: 1, source: "self",
      validFrom: "act1-scene1", isExplicit: true,
    });
  }
  const onlyFact = await wg.getCharacterView("ent-macbeth", "act1-scene2", { modalityFilter: ["fact"] });
  const onlyBelief = await wg.getCharacterView("ent-macbeth", "act1-scene2", { modalityFilter: ["belief"] });
  assert.ok(onlyFact.every((d: any) => d.modality === "fact"));
  assert.ok(onlyBelief.every((d: any) => d.modality === "belief"));
}));
