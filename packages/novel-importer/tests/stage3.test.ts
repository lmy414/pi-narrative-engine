/**
 * stage3.test.ts — Task 5 单元测试：阶段 3 章节事件流生成
 *
 * 覆盖：
 * - buildChapterEventsPrompt：含章节序号、标题、实体清单、章节全文
 * - generateChapterEvents：mock LLM 返回 birth + change 事件
 * - schema 校验失败重试：缺 storyTime / birth 缺 entity_type / change 无 new_facts&invalidated
 * - generateAllChapterEvents：并行限流、错误聚合
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityHint, EventHint, LlmToolCaller } from "../src/types.ts";
import type { Chapter } from "../src/epub.ts";

// ============================================================================
// 测试辅助
// ============================================================================

function makeChapter(id: number, title: string, content: string): Chapter {
  return { chapterId: id, title, content };
}

function makeEntity(name: string, type: EntityHint["type"]): EntityHint {
  return { name, type, aliases: [], first_seen_chapter: 1, brief: "" };
}

function makeBirthEvent(
  storyTime: string,
  entityHint: string,
  entityType: EntityHint["type"],
): EventHint {
  return {
    storyTime,
    type: "birth",
    entity_hint: entityHint,
    entity_type: entityType,
    summary: `${entityHint} 摘要`,
    new_facts: [
      { property: "name", value: entityHint, modality: "fact" },
    ],
    invalidated: [],
    narrative_summary: `${entityHint} 登场`,
  };
}

function makeChangeEvent(
  storyTime: string,
  entityHint: string,
): EventHint {
  return {
    storyTime,
    type: "change",
    entity_hint: entityHint,
    new_facts: [
      { property: "mood", value: "开心", modality: "fact" },
    ],
    invalidated: [
      { property: "mood" },
    ],
    narrative_summary: `${entityHint} 心情变化`,
  };
}

function makeMockCaller(events: EventHint[]): LlmToolCaller {
  return async () => ({ events });
}

// ============================================================================
// buildChapterEventsPrompt
// ============================================================================

test("buildChapterEventsPrompt: 含章节序号和标题", async () => {
  const { buildChapterEventsPrompt } = await import("../src/prompts.ts");
  const ch = makeChapter(3, "相遇", "酒寄彩叶站在校门口。");
  const prompt = buildChapterEventsPrompt(ch, []);
  assert.ok(prompt.includes("章节序号: 3"));
  assert.ok(prompt.includes("章节标题: 相遇"));
});

test("buildChapterEventsPrompt: 含实体清单 JSON", async () => {
  const { buildChapterEventsPrompt } = await import("../src/prompts.ts");
  const ch = makeChapter(1, "测试", "内容");
  const inv = [makeEntity("酒寄彩叶", "character")];
  const prompt = buildChapterEventsPrompt(ch, inv);
  assert.ok(prompt.includes("酒寄彩叶"));
  assert.ok(prompt.includes("character"));
});

test("buildChapterEventsPrompt: 含章节全文", async () => {
  const { buildChapterEventsPrompt } = await import("../src/prompts.ts");
  const content = "这是章节的内容，主角登场了。";
  const ch = makeChapter(1, "测试", content);
  const prompt = buildChapterEventsPrompt(ch, []);
  assert.ok(prompt.includes(content));
});

test("buildChapterEventsPrompt: 含工具调用说明", async () => {
  const { buildChapterEventsPrompt } = await import("../src/prompts.ts");
  const ch = makeChapter(1, "测试", "内容");
  const prompt = buildChapterEventsPrompt(ch, []);
  assert.ok(prompt.includes("submit_chapter_events"));
});

test("buildChapterEventsPrompt: storyTime 示例含正确章号", async () => {
  const { buildChapterEventsPrompt } = await import("../src/prompts.ts");
  const ch = makeChapter(5, "测试", "内容");
  const prompt = buildChapterEventsPrompt(ch, []);
  assert.ok(prompt.includes("ch005.ev003"));
});

// ============================================================================
// generateChapterEvents 正常路径
// ============================================================================

test("generateChapterEvents: mock 返回 birth 事件", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "相遇", "酒寄彩叶登场。");
  const events = [makeBirthEvent("ch001.ev001", "酒寄彩叶", "character")];
  const result = await generateChapterEvents(ch, [], makeMockCaller(events));
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "birth");
  assert.equal(result[0].entity_hint, "酒寄彩叶");
  assert.equal(result[0].entity_type, "character");
});

test("generateChapterEvents: mock 返回 birth + change 事件", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "相遇", "彩叶登场后心情变化。");
  const events = [
    makeBirthEvent("ch001.ev001", "酒寄彩叶", "character"),
    makeChangeEvent("ch001.ev002", "酒寄彩叶"),
  ];
  const result = await generateChapterEvents(ch, [], makeMockCaller(events));
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "birth");
  assert.equal(result[1].type, "change");
});

test("generateChapterEvents: 单次调用即成功（不重试）", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  let callCount = 0;
  const caller: LlmToolCaller = async () => {
    callCount++;
    return { events: [makeBirthEvent("ch001.ev001", "A", "character")] };
  };
  await generateChapterEvents(ch, [], caller);
  assert.equal(callCount, 1);
});

// ============================================================================
// generateChapterEvents schema 校验失败重试
// ============================================================================

test("generateChapterEvents: 缺 storyTime 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent = { ...makeBirthEvent("", "A", "character") } as EventHint;
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章 LLM 调用失败/,
  );
});

test("generateChapterEvents: birth 缺 entity_type 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "ch001.ev001",
    type: "birth",
    entity_hint: "A",
    summary: "A 摘要",
    new_facts: [{ property: "name", value: "A", modality: "fact" }],
    invalidated: [],
  };
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: birth 缺 summary 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "ch001.ev001",
    type: "birth",
    entity_hint: "A",
    entity_type: "character",
    new_facts: [{ property: "name", value: "A", modality: "fact" }],
    invalidated: [],
  };
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: change 事件无 new_facts&invalidated 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "ch001.ev001",
    type: "change",
    entity_hint: "A",
    new_facts: [],
    invalidated: [],
  };
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: events 为空数组重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const caller: LlmToolCaller = async () => ({ events: [] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: events 长度超过 50 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const events: EventHint[] = [];
  for (let i = 1; i <= 51; i++) {
    events.push(makeBirthEvent(`ch001.ev${String(i).padStart(3, "0")}`, `E${i}`, "character"));
  }
  const caller: LlmToolCaller = async () => ({ events });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: new_facts 缺 modality 重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "ch001.ev001",
    type: "birth",
    entity_hint: "A",
    entity_type: "character",
    summary: "A 摘要",
    new_facts: [{ property: "name", value: "A" }] as EventHint["new_facts"],
    invalidated: [],
  };
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: 校验失败时重试且第二次成功", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "",
    type: "birth",
    entity_hint: "A",
    entity_type: "character",
    summary: "A 摘要",
    new_facts: [{ property: "name", value: "A", modality: "fact" }],
    invalidated: [],
  };
  const goodEvent = makeBirthEvent("ch001.ev001", "A", "character");
  let callCount = 0;
  const caller: LlmToolCaller = async () => {
    callCount++;
    return { events: callCount === 1 ? [badEvent] : [goodEvent] };
  };
  const result = await generateChapterEvents(ch, [], caller);
  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].storyTime, "ch001.ev001");
});

test("generateChapterEvents: 重试时 prompt 含错误提示", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "",
    type: "birth",
    entity_hint: "A",
    entity_type: "character",
    summary: "A 摘要",
    new_facts: [{ property: "name", value: "A", modality: "fact" }],
    invalidated: [],
  };
  let lastPromptReceived = "";
  let callCount = 0;
  const caller: LlmToolCaller = async (prompt) => {
    callCount++;
    lastPromptReceived = prompt; // 保留最后一次（重试时）的 prompt
    return { events: [badEvent] };
  };
  await assert.rejects(() => generateChapterEvents(ch, [], caller), /阶段 3 第 1 章/);
  // 应该调用了 3 次（首次 + 重试 2 次）
  assert.strictEqual(callCount, 3, `应调用 3 次，实际 ${callCount} 次`);
  // 重试时的 prompt 应该含错误提示
  assert.ok(lastPromptReceived.includes("上次输出校验失败"), "重试时 prompt 应含错误提示");
});

test("generateChapterEvents: 非法 storyTime 格式", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const badEvent: EventHint = {
    storyTime: "ch1.ev1",
    type: "birth",
    entity_hint: "A",
    entity_type: "character",
    summary: "A 摘要",
    new_facts: [{ property: "name", value: "A", modality: "fact" }],
    invalidated: [],
  };
  const caller: LlmToolCaller = async () => ({ events: [badEvent] });
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: 未返回 events 数组抛错", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  const caller: LlmToolCaller = async () => ({});
  await assert.rejects(
    () => generateChapterEvents(ch, [], caller),
    /阶段 3 第 1 章/,
  );
});

test("generateChapterEvents: LLM 抛错重试", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const ch = makeChapter(1, "测试", "内容");
  let callCount = 0;
  const caller: LlmToolCaller = async () => {
    callCount++;
    if (callCount === 1) throw new Error("network error");
    return { events: [makeBirthEvent("ch001.ev001", "A", "character")] };
  };
  const result = await generateChapterEvents(ch, [], caller);
  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
});

// ============================================================================
// generateAllChapterEvents 并行限流
// ============================================================================

test("generateAllChapterEvents: 多章节并行", async () => {
  const { generateAllChapterEvents } = await import("../src/stages.ts");
  const chapters = [
    makeChapter(1, "第一章", "内容1"),
    makeChapter(2, "第二章", "内容2"),
    makeChapter(3, "第三章", "内容3"),
  ];
  const caller: LlmToolCaller = async (prompt) => {
    // 🟠-14（2026-08-08）：章号一致性校验要求 storyTime 章号与当前章一致——
    // 从 prompt 提取「章节序号」生成对应 storyTime（此前 mock 恒返回 ch001 会误触发校验）
    const m = (prompt ?? "").match(/章节序号: (\d+)/);
    const ch = m ? Number(m[1]) : 1;
    return {
      events: [makeBirthEvent(`ch${String(ch).padStart(3, "0")}.ev001`, "A", "character")],
    };
  };
  const results = await generateAllChapterEvents(chapters, [], caller, 2);
  assert.equal(results.length, 3);
  assert.equal(results[0].chapterId, 1);
  assert.equal(results[1].chapterId, 2);
  assert.equal(results[2].chapterId, 3);
});

test("generateAllChapterEvents: 单章失败时整体抛错", async () => {
  const { generateAllChapterEvents } = await import("../src/stages.ts");
  const chapters = [
    makeChapter(1, "第一章", "内容1"),
    makeChapter(2, "第二章", "内容2"),
  ];
  const caller: LlmToolCaller = async () => {
    throw new Error("LLM error");
  };
  await assert.rejects(
    () => generateAllChapterEvents(chapters, [], caller, 2),
    /阶段 3 章节事件流生成失败/,
  );
});

test("generateAllChapterEvents: 并发数限制", async () => {
  const { generateAllChapterEvents } = await import("../src/stages.ts");
  const chapters = Array.from({ length: 5 }, (_, i) =>
    makeChapter(i + 1, `第${i + 1}章`, `内容${i + 1}`),
  );
  let activeCount = 0;
  let maxActive = 0;
  const caller: LlmToolCaller = async (prompt) => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    // 模拟延迟
    await new Promise((r) => setTimeout(r, 10));
    activeCount--;
    // 🟠-14：storyTime 章号与当前章一致（同多章节并行用例）
    const m = (prompt ?? "").match(/章节序号: (\d+)/);
    const ch = m ? Number(m[1]) : 1;
    return {
      events: [makeBirthEvent(`ch${String(ch).padStart(3, "0")}.ev001`, "A", "character")],
    };
  };
  await generateAllChapterEvents(chapters, [], caller, 2);
  assert.ok(maxActive <= 2, `expected maxActive <= 2, got ${maxActive}`);
});

test("generateAllChapterEvents: 空章节数组", async () => {
  const { generateAllChapterEvents } = await import("../src/stages.ts");
  const caller: LlmToolCaller = async () => ({ events: [] });
  const results = await generateAllChapterEvents([], [], caller, 3);
  assert.equal(results.length, 0);
});

// ============ 🟠-14 storyTime 唯一性与章号一致性（2026-08-08） ============

test("generateChapterEvents: 同章重复 storyTime 拒绝（🟠-14）", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const chapter = makeChapter(1, "第一章", "内容");
  const caller: LlmToolCaller = async () => ({
    events: [
      makeBirthEvent("ch001.ev001", "A", "character"),
      makeBirthEvent("ch001.ev001", "B", "character"), // 同章重复
    ],
  });
  await assert.rejects(
    () => generateChapterEvents(chapter, [], caller),
    /storyTime 重复/,
    "同章重复 storyTime 应拒绝（阶段 7 会静默去重丢数据）",
  );
});

test("generateChapterEvents: 章号与当前章不一致拒绝（🟠-14）", async () => {
  const { generateChapterEvents } = await import("../src/stages.ts");
  const chapter = makeChapter(1, "第一章", "内容");
  const caller: LlmToolCaller = async () => ({
    events: [makeBirthEvent("ch002.ev001", "A", "character")], // 第 1 章输出 ch002
  });
  await assert.rejects(
    () => generateChapterEvents(chapter, [], caller),
    /章号 2 与当前章 1 不一致/,
    "跨章错序 storyTime 应拒绝（破坏 bi-temporal 单调性）",
  );
});
