// tests/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlannerSystemPrompt, buildPlannerUserMessage } from "../src/prompts.ts";
import type { StructuredEvent } from "../src/types.ts";

function makeMockEvent(overrides: Partial<StructuredEvent> = {}): StructuredEvent {
  return {
    storyTime: "ch-2",
    instruction: "林冲在山神庙与陆谦对峙",
    characterIds: ["linchong", "luqian"],
    ...overrides,
  };
}

// ============================================================================
// buildPlannerSystemPrompt
// ============================================================================

test("buildPlannerSystemPrompt: 包含规则集全文", () => {
  const event = makeMockEvent();
  const prompt = buildPlannerSystemPrompt("这是 planner 规则集内容", event);
  assert.ok(prompt.includes("这是 planner 规则集内容"));
});

test("buildPlannerSystemPrompt: 包含检索能力清单", () => {
  const event = makeMockEvent();
  const prompt = buildPlannerSystemPrompt("", event);
  assert.ok(prompt.includes("character_view"));
  assert.ok(prompt.includes("entity_snapshot"));
  assert.ok(prompt.includes("relations"));
  assert.ok(prompt.includes("search_text"));
  assert.ok(prompt.includes("search_vector"));
  assert.ok(prompt.includes("search_hybrid"));
});

test("buildPlannerSystemPrompt: 包含任务说明", () => {
  const event = makeMockEvent();
  const prompt = buildPlannerSystemPrompt("", event);
  assert.ok(prompt.includes("retrieval_plan"));
  assert.ok(prompt.includes("assignTo"));
  assert.ok(prompt.includes("信息差"));
});

test("buildPlannerSystemPrompt: 包含检索数量建议", () => {
  const event = makeMockEvent();
  const prompt = buildPlannerSystemPrompt("", event);
  assert.ok(prompt.includes("5-15"));
  assert.ok(prompt.includes("30"));
});

// ============================================================================
// buildPlannerUserMessage
// ============================================================================

test("buildPlannerUserMessage: 包含事件指令", () => {
  const event = makeMockEvent({ instruction: "林冲喝酒" });
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("林冲喝酒"));
});

test("buildPlannerUserMessage: 包含故事时间", () => {
  const event = makeMockEvent({ storyTime: "ch-5" });
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("ch-5"));
});

test("buildPlannerUserMessage: 包含参与角色清单", () => {
  const event = makeMockEvent({ characterIds: ["linchong", "luqian", "wang"] });
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("- linchong"));
  assert.ok(msg.includes("- luqian"));
  assert.ok(msg.includes("- wang"));
});

test("buildPlannerUserMessage: 包含执行建议", () => {
  const event = makeMockEvent({ executionHints: "林冲要显得特别绝望" });
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("林冲要显得特别绝望"));
});

test("buildPlannerUserMessage: 无 executionHints 时显示无特殊要求", () => {
  const event = makeMockEvent();
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("无特殊要求"));
});

test("buildPlannerUserMessage: 单角色", () => {
  const event = makeMockEvent({ characterIds: ["linchong"] });
  const msg = buildPlannerUserMessage(event);
  assert.ok(msg.includes("- linchong"));
});
