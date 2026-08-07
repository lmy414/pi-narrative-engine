// tests/write.test.ts
/**
 * writeToGraph causedBy 链完整性测试（🔴-C 2026-08-08）
 *
 * 背景：buildCausedByChain 给链上每个事件（含后续被跳过的）分配 eventId，
 * 被跳过的事件（entity_hint 无法解析 / 重复 birth / 未 birth death / 已 dead
 * 重复 death）不写 events.jsonl——若后续事件 causedBy 仍指向被跳事件，
 * 日志即出现悬空前驱（内核 0.1.2 traceBack 静默截断因果链，0.2.0 起抛错）。
 *
 * 修复：writeToGraph 维护 lastWrittenEventId，跳过不更新、成功写入才更新，
 * 后续事件 causedBy 重链到最近实际写入事件。
 *
 * 断言（真实 WorldGraph + 临时目录，参照 underworld-graph tests/events.test.ts）：
 * - 正常链：日志 causedBy 逐级衔接、首事件无 causedBy
 * - 三条跳过路径：日志无任何悬空 causedBy
 * - 已 dead 重复 death：catch 分支不更新 lastWrittenEventId，日志仍完整
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGraph } from "underworld-graph";
import type { ChapterResult, EventHint, ResolveResult } from "../src/types.ts";
import { buildCausedByChain, writeToGraph } from "../src/write.ts";

/** 断言日志中不存在悬空 causedBy（🔴-C 的核心不变量） */
function assertNoDanglingCausedBy(events: Array<{ eventId: string; causedBy?: string }>): void {
  const ids = new Set(events.map((e) => e.eventId));
  for (const ev of events) {
    assert.ok(
      ev.causedBy === undefined || ids.has(ev.causedBy),
      `事件 ${ev.eventId} 的 causedBy="${ev.causedBy}" 悬空（日志中不存在该前驱）`,
    );
  }
}

function ev(storyTime: string, type: "birth" | "change" | "death", entityHint: string, extra: Partial<EventHint> = {}): EventHint {
  return { storyTime, type, entity_hint: entityHint, ...extra };
}

function makeResolveResult(): ResolveResult {
  return {
    canonicalMap: new Map([
      ["甲", "ent_a"],
      ["乙", "ent_b"],
      ["丙", "ent_c"],
    ]),
    aliasIndex: [],
  };
}

async function withWorldGraph(fn: (wg: WorldGraph) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "importer-write-test-"));
  try {
    const wg = await WorldGraph.create({
      dbPath: join(dir, "world.db"),
      eventLogPath: join(dir, "events.jsonl"),
    });
    try {
      await fn(wg);
    } finally {
      wg.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function writeChain(
  wg: WorldGraph,
  events: EventHint[],
  resolveResult: ResolveResult,
): Promise<string[]> {
  const warnings: string[] = [];
  const chain = buildCausedByChain([{ chapterId: 1, title: "第1章", events }] as ChapterResult[]);
  const result = await writeToGraph(chain, [], [], {
    wg,
    resolveResult,
    autoInferVisibility: false,
    onWarning: (msg) => warnings.push(msg),
  });
  return warnings;
}

test("正常链：birth→change→death 日志 causedBy 逐级衔接", async () => {
  await withWorldGraph(async (wg) => {
    await writeChain(wg, [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character", summary: "甲出场" }),
      ev("ch001.ev002", "change", "甲", { new_facts: [{ property: "位置", value: "客栈", modality: "fact" }] }),
      ev("ch001.ev003", "death", "甲"),
    ], makeResolveResult());

    const log = await wg.getAllEvents();
    assert.equal(log.length, 3);
    assert.equal(log[0]!.causedBy, undefined, "首事件不应有 causedBy");
    assert.equal(log[1]!.causedBy, log[0]!.eventId, "第二个事件应指向第一个事件");
    assert.equal(log[2]!.causedBy, log[1]!.eventId, "第三个事件应指向第二个事件");
  });
});

test("重复 birth：第二次被跳过，后续事件重链到第一次 birth", async () => {
  await withWorldGraph(async (wg) => {
    const warnings = await writeChain(wg, [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character" }),
      ev("ch001.ev002", "birth", "甲", { entity_type: "character" }), // 重复 birth → 跳过
      ev("ch001.ev003", "change", "甲", { new_facts: [{ property: "位置", value: "客栈", modality: "fact" }] }),
    ], makeResolveResult());

    assert.ok(warnings.some((w) => w.includes("跳过重复 birth")), "应产生重复 birth 警告");
    const log = await wg.getAllEvents();
    assert.equal(log.length, 2, "重复 birth 不应写入日志");
    assert.equal(log[1]!.causedBy, log[0]!.eventId, "change 应重链到第一次 birth（而非被跳过的第二次）");
    assertNoDanglingCausedBy(log);
  });
});

test("未 birth 发 death：death 被跳过，后续事件重链不悬空", async () => {
  await withWorldGraph(async (wg) => {
    const warnings = await writeChain(wg, [
      ev("ch001.ev001", "death", "乙"), // 乙未 birth → 跳过
      ev("ch001.ev002", "birth", "甲", { entity_type: "character" }),
      ev("ch001.ev003", "change", "甲", { new_facts: [{ property: "位置", value: "客栈", modality: "fact" }] }),
    ], makeResolveResult());

    assert.ok(warnings.some((w) => w.includes("未 birth")), "应产生未 birth 警告");
    const log = await wg.getAllEvents();
    assert.equal(log.length, 2, "未 birth 的 death 不应写入日志");
    assert.equal(log[0]!.causedBy, undefined, "第一个实际写入事件（birth）无 causedBy");
    assert.equal(log[1]!.causedBy, log[0]!.eventId, "change 重链到 birth");
    assertNoDanglingCausedBy(log);
  });
});

test("entity_hint 无法解析：事件被跳过，后续事件重链不悬空", async () => {
  await withWorldGraph(async (wg) => {
    const resolveResult = makeResolveResult();
    const warnings = await writeChain(wg, [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character" }),
      ev("ch001.ev002", "change", "丁"), // 丁不在 canonicalMap → 跳过
      ev("ch001.ev003", "birth", "乙", { entity_type: "character" }),
    ], resolveResult);

    assert.ok(warnings.some((w) => w.includes("未在 canonicalMap 中找到")), "应产生解析失败警告");
    const log = await wg.getAllEvents();
    assert.equal(log.length, 2, "无法解析的事件不应写入日志");
    assert.equal(log[1]!.causedBy, log[0]!.eventId, "乙的 birth 应重链到甲的 birth");
    assertNoDanglingCausedBy(log);
  });
});

test("已 dead 重复 death：catch 分支不更新 lastWrittenEventId，日志仍完整", async () => {
  await withWorldGraph(async (wg) => {
    const warnings = await writeChain(wg, [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character" }),
      ev("ch001.ev002", "death", "甲"),
      ev("ch001.ev003", "death", "甲"), // 已 dead → processEvent 抛错 → warn
      ev("ch001.ev004", "birth", "乙", { entity_type: "character" }),
    ], makeResolveResult());

    assert.ok(warnings.some((w) => w.includes("可能已 dead")), "应产生已 dead 警告");
    const log = await wg.getAllEvents();
    assert.ok(log.length >= 3, "birth/death 必在日志中（重复 death 可能已写日志行但 DB 回滚）");
    assertNoDanglingCausedBy(log);
  });
});

test("🟠-15: 同 property 多条未闭合声明全部闭合（不只最后一条）", async () => {
  await withWorldGraph(async (wg) => {
    // 先 birth（内核 change 不创建实体），再写两条未闭合声明
    // （内核 change 不自动闭合，模拟导入遗留的多未闭合状态）
    await wg.processEvent({
      eventId: "evt_birth",
      type: "birth",
      storyTime: "ch001.ev000",
      entityId: "ent_a",
      entityType: "character",
      summary: "测试实体",
    });
    await wg.processEvent({
      eventId: "evt_a",
      type: "change",
      storyTime: "ch001.ev001",
      entityId: "ent_a",
      newFacts: [{ entityId: "ent_a", property: "位置", value: "旧1", modality: "fact" }],
    });
    await wg.processEvent({
      eventId: "evt_b",
      type: "change",
      storyTime: "ch001.ev002",
      entityId: "ent_a",
      newFacts: [{ entityId: "ent_a", property: "位置", value: "旧2", modality: "fact" }],
    });
    // 导入器写入第三条 change（同 property）→ 自动闭合应闭**全部**未闭合声明
    const events: EventHint[] = [
      ev("ch001.ev003", "change", "甲", {
        new_facts: [{ property: "位置", value: "新", modality: "fact" }],
      }),
    ];
    const resolveResult = makeResolveResult();
    const chain = buildCausedByChain([{ chapterId: 1, title: "第1章", events }] as ChapterResult[]);
    await writeToGraph(chain, [], [], { wg, resolveResult, autoInferVisibility: false });

    // ch001.ev003 时刻只剩一条未闭合（新值）
    const snap = await wg.getEntityAt("ent_a", "ch001.ev003");
    assert.ok(snap, "实体应存在");
    const open = snap!.properties.filter((p) => p.property === "位置");
    assert.equal(open.length, 1, "同 property 多条未闭合应全部闭合，只剩新声明");
    assert.equal(open[0]!.value, "新");
  });
});
