/**
 * underworld-graph 契约金丝雀测试（预案 P2，2026-08-08 升级专项落地）
 *
 * 目的：对**已安装版本**断言引擎用到的每个方法签名与返回结构。
 * 下次包升级（安装新版本）时，本测试即红——静默破坏变显式。
 * 修改包版本前必须同步更新本文件。
 *
 * 覆盖范围：引擎实际使用的 API 面（src/、packages/、scripts/ 的调用点清单见
 * docs/plans/2026-08-08-underworld-graph-0.3.0-upgrade.md §三）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGraph } from "underworld-graph";
import type {
  EntitySnapshot,
  EventRecord,
  EventRecordInput,
  StateDeclaration,
} from "underworld-graph";

function tempWorld() {
  const dir = mkdtempSync(join(tmpdir(), "wg-contract-"));
  return {
    dir,
    async create() {
      return WorldGraph.create({ dbPath: join(dir, "world.db"), eventLogPath: join(dir, "events.jsonl") });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("契约：类型面——StateDeclaration 含 description 必填，无 value/valueText", () => {
  // 0.3.0：value/valueText 双轨删除 → description（string，searchable）
  const decl: StateDeclaration = {
    declarationId: "decl-1",
    entityId: "ent-1",
    property: "名字",
    description: "测试",
    modality: "fact",
    validFrom: "ch001.ev001",
    validTo: "Infinity",
  };
  assert.equal(typeof decl.description, "string");
  // @ts-expect-error 0.3.0 起 value 键不存在（升级即红）
  decl.value = "x";
  // @ts-expect-error 0.3.0 起 valueText 键不存在（升级即红）
  decl.valueText = "x";
});

test("契约：类型面——EntitySnapshot 含 name/aliases 快照", () => {
  const snap: EntitySnapshot = {
    entityId: "ent-1",
    type: "character",
    name: "测试",
    aliases: [],
    summary: "",
    validFrom: "ch001.ev001",
    validTo: "Infinity",
    properties: [],
  };
  assert.equal(typeof snap.name, "string");
  assert.ok(Array.isArray(snap.aliases));
});

test("契约：签名面——updateEntitySummary 三参必填（0.2.0 D5）", async () => {
  const w = tempWorld();
  try {
    const wg = await w.create();
    await wg.birthEntity("ent-1", "character", { 名字: "测试" }, "ch001.ev001");
    await wg.updateEntitySummary("ent-1", "新摘要", "ch001.ev001");
    const snap = await wg.getEntityAt("ent-1", "ch001.ev001");
    assert.equal(snap?.summary, "新摘要");
    await wg.close();
  } finally {
    w.cleanup();
  }
});

test("契约：签名面——traceCauses 对不存在 eventId 返回 null（0.2.0 D7）", async () => {
  const w = tempWorld();
  try {
    const wg = await w.create();
    const result = await wg.traceCauses("evt_not_exist");
    assert.equal(result, null);
    await wg.close();
  } finally {
    w.cleanup();
  }
});

test("契约：数据面——newFacts 用 description 键写入，实体 name 快照从「名字」同步（0.3.0）", async () => {
  const w = tempWorld();
  const wg = await w.create();
  // value 键被 zod 剥离 → description 缺失 → 抛错（契约错误显式拒绝，而非静默写坏数据）
  await assert.rejects(
    () => wg.processEvent({
      eventId: "evt-1",
      type: "birth",
      storyTime: "ch001.ev001",
      entityId: "ent-1",
      entityType: "character",
      source: "user",
      summary: "测试实体",
      // @ts-expect-error 0.3.0 起 value 键不存在（升级即红）
      newFacts: [{ entityId: "ent-1", property: "名字", value: "旧", modality: "fact" }],
    } as EventRecordInput),
    /description/,
  );
  const snap = await wg.getEntityAt("ent-1", "ch001.ev001");
  assert.equal(snap, null, "value 键写入的事件不应产生实体");

  // 正确写法：description 键 + 中文「名字」→ name 快照自动同步
  await wg.processEvent({
    eventId: "evt-2",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "ent-2",
    entityType: "character",
    source: "user",
    summary: "快照同步验证",
    newFacts: [{ entityId: "ent-2", property: "名字", description: "测试角色", modality: "fact" }],
  });
  const snap2 = await wg.getEntityAt("ent-2", "ch001.ev001");
  assert.equal(snap2?.name, "测试角色", "birth 带「名字」property → Entity.name 快照自动同步");
  assert.ok(snap2?.properties.some((p) => p.property === "名字" && p.description === "测试角色"));
  await wg.close();
  w.cleanup();
});

test("契约：签名面——addRelation 支持 opts.description（0.3.0）", async () => {
  const w = tempWorld();
  try {
    const wg = await w.create();
    await wg.birthEntity("ent-a", "character", { 名字: "甲" }, "ch001.ev001");
    await wg.birthEntity("ent-b", "character", { 名字: "乙" }, "ch001.ev001");
    await wg.addRelation("ent-a", "ent-b", "认识", "ch001.ev001", { description: "两人是同学" });
    const rels = await wg.getAllRelationsAt("ch001.ev001");
    assert.equal(rels.length, 1);
    assert.equal(rels[0]?.label, "认识");
    assert.equal(rels[0]?.description, "两人是同学");
    await wg.close();
  } finally {
    w.cleanup();
  }
});

test("契约：签名面——processEvent 入参 EventRecordInput 的 newFacts 元素必含 description", () => {
  const input: EventRecordInput = {
    eventId: "evt-x",
    type: "change",
    storyTime: "ch001.ev001",
    entityId: "ent-1",
    newFacts: [{ entityId: "ent-1", property: "心情", description: "平静", modality: "fact" }],
  };
  assert.ok(Array.isArray(input.newFacts));
  const f = input.newFacts![0]!;
  assert.equal(typeof f.description, "string");
  // @ts-expect-error 0.3.0 起 newFacts 元素无 value 键（升级即红）
  f.value = "x";
});

test("契约：事件日志——EventRecord 与 StateDeclaration 形状同源（0.3.0 后无 value 字段）", async () => {
  const w = tempWorld();
  try {
    const wg = await w.create();
    await wg.processEvent({
      eventId: "evt-1",
      type: "birth",
      storyTime: "ch001.ev001",
      entityId: "ent-1",
      entityType: "character",
      summary: "t",
      newFacts: [{ entityId: "ent-1", property: "名字", description: "甲", modality: "fact" }],
    });
    const events: EventRecord[] = await wg.getAllEvents();
    const birth = events.find((e) => e.eventId === "evt-1");
    assert.ok(birth);
    const fact = birth.newFacts?.[0];
    assert.ok(fact);
    assert.equal(typeof fact.description, "string");
    assert.equal("value" in fact, false, "EventRecord.newFacts 元素不应含 value");
    await wg.close();
  } finally {
    w.cleanup();
  }
});
