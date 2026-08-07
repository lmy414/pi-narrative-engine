// tests/validate.test.ts
/**
 * 阶段 8 P0 校验语义测试（🔴-D + 🔴-C 2026-08-08）
 *
 * 🔴-D：getAllEntities 只返回存活实体（内核按 validTo > storyTime 过滤），
 * 死亡/退场实体的 change Fact 若按终态快照判断必然假阳性——P0 改为
 * 「现存 ∪ 曾 birth」语义（writeResult.birthedEntityIds，随 WriteResult 返回）。
 *
 * 🔴-C：阶段 8 新增日志级 causedBy 完整性校验（wg.getAllEvents 读 events.jsonl），
 * 悬空前驱直接 P0 阻断（内核 0.2.x 起遇悬空会抛错，必须前置拦截）。
 *
 * 断言：
 * 1. 含死亡角色的导入（birth→change→death）P0 通过（修复前假阳性）
 * 2. change 引用从未 birth 的实体仍报 P0（防过度放松）
 * 3. 日志存在悬空 causedBy 时报 P0（日志校验生效）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldGraph } from "underworld-graph";
import type { ChapterResult, EventHint, ResolveResult } from "../src/types.ts";
import { buildCausedByChain, writeToGraph } from "../src/write.ts";
import { validateGraph, type ValidationContext } from "../src/validate.ts";

function ev(storyTime: string, type: "birth" | "change" | "death", entityHint: string, extra: Partial<EventHint> = {}): EventHint {
  return { storyTime, type, entity_hint: entityHint, ...extra };
}

function makeResolveResult(extra: Array<[string, string]> = []): ResolveResult {
  return {
    canonicalMap: new Map([
      ["甲", "ent_a"],
      ["乙", "ent_b"],
      ["丁", "ent_d"],
      ...extra,
    ]),
    aliasIndex: [],
  };
}

function zeroWriteResult(birthedEntityIds: string[] = []) {
  return {
    eventCount: 0,
    relationCount: 0,
    visibilityCount: 0,
    skippedInvalidated: 0,
    skippedVisibilities: 0,
    deduplicatedFacts: 0,
    skippedRelations: 0,
    skippedEvents: 0,
    birthedEntityIds,
    chapterEventCounts: {},
  };
}

async function withWorldGraph(fn: (wg: WorldGraph) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "importer-validate-test-"));
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

test("含死亡角色的导入 P0 通过（🔴-D：曾 birth 语义，不再假阳性）", async () => {
  await withWorldGraph(async (wg) => {
    const events: EventHint[] = [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character", summary: "甲出场" }),
      ev("ch001.ev002", "change", "甲", { new_facts: [{ property: "位置", value: "客栈", modality: "fact" }] }),
      ev("ch001.ev003", "death", "甲"), // 甲死亡 → getAllEntities 终态不含甲
    ];
    const resolveResult = makeResolveResult();
    const chain = buildCausedByChain([{ chapterId: 1, title: "第1章", events }] as ChapterResult[]);
    const writeResult = await writeToGraph(chain, [], [], {
      wg,
      resolveResult,
      autoInferVisibility: false,
    });

    const validation = await validateGraph({
      chapters: [],
      chapterResults: [],
      chain,
      resolveResult,
      writeResult,
      wg,
    } satisfies ValidationContext);

    assert.equal(validation.p0Passed, true, `死亡实体导入不应假阳性，P0 错误: ${validation.p0Errors.join("; ")}`);
    assert.ok(
      !validation.p0Errors.some((e) => e.includes("ent_a")),
      "甲的 change Fact 不应报 entityId 不存在（甲曾 birth）",
    );
  });
});

test("change 引用从未 birth 的实体仍报 P0（防过度放松）", async () => {
  await withWorldGraph(async (wg) => {
    // 空库 + 手工 chain：丁在 canonicalMap 中但从未 birth（birthedEntityIds 不含）
    const events: EventHint[] = [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character" }),
      ev("ch001.ev002", "change", "甲", {
        new_facts: [{ property: "位置", value: "城外", modality: "fact", target_hint: "丁" }],
      }),
    ];
    const resolveResult = makeResolveResult();
    const chain = buildCausedByChain([{ chapterId: 1, title: "第1章", events }] as ChapterResult[]);

    const validation = await validateGraph({
      chapters: [],
      chapterResults: [],
      chain,
      resolveResult,
      writeResult: zeroWriteResult(["ent_a"]), // 只 birth 过甲
      wg,
    } satisfies ValidationContext);

    assert.equal(validation.p0Passed, false);
    assert.ok(
      validation.p0Errors.some((e) => e.includes("ent_d") && e.includes("曾 birth 集合")),
      `应报丁未 birth，实际: ${validation.p0Errors.join("; ")}`,
    );
  });
});

test("日志悬空 causedBy 报 P0（🔴-C：阶段 8 日志完整性校验）", async () => {
  await withWorldGraph(async (wg) => {
    // 手工写入悬空链：evt_2 的 causedBy 指向不存在的 evt_missing
    await wg.processEvent({ eventId: "evt_1", type: "birth", storyTime: "ch001.ev001", entityId: "ent_a" });
    await wg.processEvent({
      eventId: "evt_2",
      type: "birth",
      storyTime: "ch001.ev002",
      entityId: "ent_b",
      causedBy: "evt_missing",
    });

    const validation = await validateGraph({
      chapters: [],
      chapterResults: [],
      chain: [],
      resolveResult: makeResolveResult(),
      writeResult: zeroWriteResult(),
      wg,
    } satisfies ValidationContext);

    assert.equal(validation.p0Passed, false);
    assert.ok(
      validation.p0Errors.some((e) => e.includes("evt_2") && e.includes("evt_missing") && e.includes("悬空")),
      `应报日志悬空 causedBy，实际: ${validation.p0Errors.join("; ")}`,
    );
  });
});

test("🟠-16: 空章节（events=[]）报 P0 无事件覆盖", async () => {
  await withWorldGraph(async (wg) => {
    const validation = await validateGraph({
      chapters: [{ chapterId: 1, title: "第一章", content: "" }],
      chapterResults: [{ chapterId: 1, title: "第一章", events: [] }], // 空事件条目（stages 空章节跳过场景）
      chain: [],
      resolveResult: makeResolveResult(),
      writeResult: zeroWriteResult(),
      wg,
    } satisfies ValidationContext);

    assert.equal(validation.p0Passed, false);
    assert.ok(
      validation.p0Errors.some((e) => e.includes("无事件覆盖") && e.includes("第一章")),
      `空章节应报 P0 无事件覆盖，实际: ${validation.p0Errors.join("; ")}`,
    );
  });
});

test("🟠-16: 所有章节均有事件时无章节完整性错误", async () => {
  await withWorldGraph(async (wg) => {
    const events: EventHint[] = [
      ev("ch001.ev001", "birth", "甲", { entity_type: "character" }),
    ];
    const resolveResult = makeResolveResult();
    const chain = buildCausedByChain([{ chapterId: 1, title: "第一章", events }] as ChapterResult[]);
    const validation = await validateGraph({
      chapters: [{ chapterId: 1, title: "第一章", content: "x" }],
      chapterResults: [{ chapterId: 1, title: "第一章", events }],
      chain,
      resolveResult,
      writeResult: zeroWriteResult(["ent_a"]),
      wg,
    } satisfies ValidationContext);

    assert.ok(
      !validation.p0Errors.some((e) => e.includes("无事件覆盖")),
      `有事件覆盖的章不应报完整性错误，实际: ${validation.p0Errors.join("; ")}`,
    );
  });
});
