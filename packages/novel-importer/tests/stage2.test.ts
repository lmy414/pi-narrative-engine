/**
 * stage2.test.ts — Task 4 单元测试
 *
 * 覆盖：
 * - buildEntityInventoryPrompt 构造正确（含每章前 1500 字样本）
 * - scanEntitiesGlobal 正常路径：mock LLM 返回实体清单
 * - schema 校验失败 → 重试 1 次
 * - 重试后仍失败 → 抛错
 * - LLM 未调用工具 / 未返回 entities → 抛错
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chapter } from "../src/epub.ts";
import type { EntityHint, LlmToolCaller } from "../src/types.ts";

// ============================================================================
// 测试辅助
// ============================================================================

function makeChapter(
  chapterId: number,
  title: string,
  content: string,
): Chapter {
  return { chapterId, title, content };
}

function makeValidEntity(overrides: Partial<EntityHint> = {}): EntityHint {
  return {
    name: "酒寄彩叶",
    type: "character",
    aliases: ["彩叶"],
    first_seen_chapter: 1,
    brief: "主角",
    ...overrides,
  };
}

// ============================================================================
// buildEntityInventoryPrompt
// ============================================================================

test("buildEntityInventoryPrompt: 包含每章标题和前 1500 字", async () => {
  const { buildEntityInventoryPrompt } = await import("../src/prompts.ts");
  const chapters = [
    makeChapter(1, "相遇", "A".repeat(2000)),
    makeChapter(2, "竹林", "B".repeat(500)),
  ];
  const prompt = buildEntityInventoryPrompt(chapters);
  assert.ok(prompt.includes("第1章 相遇"));
  assert.ok(prompt.includes("第2章 竹林"));
  // 第1章截取 1500 字
  assert.ok(prompt.includes("前1500字"));
  // 第2章不足 1500 字，截取实际长度
  assert.ok(prompt.includes("前500字"));
});

test("buildEntityInventoryPrompt: 含工具调用说明", async () => {
  const { buildEntityInventoryPrompt } = await import("../src/prompts.ts");
  const chapters = [makeChapter(1, "测试", "测试内容")];
  const prompt = buildEntityInventoryPrompt(chapters);
  assert.ok(prompt.includes("submit_entity_inventory"));
  assert.ok(prompt.includes("character | location | item | concept"));
});

test("buildEntityInventoryPrompt: 含输入输出示意", async () => {
  const { buildEntityInventoryPrompt } = await import("../src/prompts.ts");
  const chapters = [makeChapter(1, "测试", "测试内容")];
  const prompt = buildEntityInventoryPrompt(chapters);
  assert.ok(prompt.includes("输入示意"));
  assert.ok(prompt.includes("输出示意"));
});

test("buildEntityInventoryPrompt: 空章节数组也能构造（不含样本）", async () => {
  const { buildEntityInventoryPrompt } = await import("../src/prompts.ts");
  const prompt = buildEntityInventoryPrompt([]);
  // 空章节时 samples 为空字符串，但 prompt 框架仍然存在
  assert.ok(prompt.includes("submit_entity_inventory"));
});

// ============================================================================
// scanEntitiesGlobal — 正常路径
// ============================================================================

test("scanEntitiesGlobal: mock LLM 返回实体清单 → 返回 EntityHint[]", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [
    makeChapter(1, "相遇", "酒寄彩叶站在校门口。"),
    makeChapter(2, "竹林", "竹林深处传来声响。"),
  ];
  const mockEntities: EntityHint[] = [
    makeValidEntity({ name: "酒寄彩叶", type: "character", aliases: ["彩叶"], first_seen_chapter: 1, brief: "主角" }),
    makeValidEntity({ name: "校门口", type: "location", aliases: [], first_seen_chapter: 1, brief: "学校入口" }),
    makeValidEntity({ name: "竹林", type: "location", aliases: [], first_seen_chapter: 2, brief: "第2章场景" }),
  ];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    return { entities: mockEntities };
  };
  const result = await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 1);
  assert.equal(result.length, 3);
  assert.equal(result[0].name, "酒寄彩叶");
  assert.equal(result[1].type, "location");
});

test("scanEntitiesGlobal: 单次调用即成功（无重试）", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    return { entities: [makeValidEntity()] };
  };
  await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 1);
});

// ============================================================================
// scanEntitiesGlobal — schema 校验失败 → 重试
// ============================================================================

test("scanEntitiesGlobal: 缺 name → 校验失败重试 1 次后成功", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const badEntities = [{ type: "character", aliases: [], first_seen_chapter: 1, brief: "" }];
  const goodEntities = [makeValidEntity()];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    if (callCount === 1) return { entities: badEntities };
    return { entities: goodEntities };
  };
  const result = await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
});

test("scanEntitiesGlobal: 非法 type → 校验失败重试", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const badEntities = [{ name: "X", type: "unknown_type", aliases: [], first_seen_chapter: 1, brief: "x" }];
  const goodEntities = [makeValidEntity()];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    if (callCount === 1) return { entities: badEntities };
    return { entities: goodEntities };
  };
  const result = await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 2);
  assert.equal(result[0].type, "character");
});

test("scanEntitiesGlobal: first_seen_chapter < 1 → 校验失败", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const badEntities = [{ name: "X", type: "character", aliases: [], first_seen_chapter: 0, brief: "x" }];
  const goodEntities = [makeValidEntity()];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    if (callCount === 1) return { entities: badEntities };
    return { entities: goodEntities };
  };
  await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 2);
});

test("scanEntitiesGlobal: 重试 2 次仍失败 → 抛错", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const badEntities = [{ type: "character", aliases: [], first_seen_chapter: 1, brief: "" }];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    return { entities: badEntities };
  };
  await assert.rejects(
    () => scanEntitiesGlobal(chapters, mockCaller),
    /重试 1 次后仍失败/,
  );
  assert.equal(callCount, 2);
});

// ============================================================================
// scanEntitiesGlobal — 异常路径
// ============================================================================

test("scanEntitiesGlobal: LLM 未返回 entities 数组 → 抛错", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const mockCaller: LlmToolCaller = async () => ({});
  await assert.rejects(
    () => scanEntitiesGlobal(chapters, mockCaller),
    /未返回 entities/,
  );
});

test("scanEntitiesGlobal: entities 非数组 → 抛错", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const mockCaller: LlmToolCaller = async () => ({ entities: "not an array" });
  await assert.rejects(
    () => scanEntitiesGlobal(chapters, mockCaller),
    /未返回 entities/,
  );
});

test("scanEntitiesGlobal: LLM 抛错 → 重试后仍抛错", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    throw new Error("LLM 调用失败");
  };
  await assert.rejects(
    () => scanEntitiesGlobal(chapters, mockCaller),
    /重试 1 次后仍失败/,
  );
  assert.equal(callCount, 2);
});

test("scanEntitiesGlobal: 第一次 LLM 抛错，第二次成功", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  let callCount = 0;
  const goodEntities = [makeValidEntity()];
  const mockCaller: LlmToolCaller = async () => {
    callCount++;
    if (callCount === 1) throw new Error("网络错误");
    return { entities: goodEntities };
  };
  const result = await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
});

test("scanEntitiesGlobal: 重试时 prompt 含上次错误提示", async () => {
  const { scanEntitiesGlobal } = await import("../src/stages.ts");
  const chapters = [makeChapter(1, "测试", "测试")];
  const badEntities = [{ type: "character", aliases: [], first_seen_chapter: 1, brief: "" }];
  const goodEntities = [makeValidEntity()];
  const receivedPrompts: string[] = [];
  let callCount = 0;
  const mockCaller: LlmToolCaller = async (prompt) => {
    callCount++;
    receivedPrompts.push(prompt);
    if (callCount === 1) return { entities: badEntities };
    return { entities: goodEntities };
  };
  await scanEntitiesGlobal(chapters, mockCaller);
  assert.equal(receivedPrompts.length, 2);
  // 第一次不含错误提示
  assert.ok(!receivedPrompts[0].includes("上次输出校验失败"));
  // 第二次含错误提示
  assert.ok(receivedPrompts[1].includes("上次输出校验失败"));
  assert.ok(receivedPrompts[1].includes("name 缺失"));
});
