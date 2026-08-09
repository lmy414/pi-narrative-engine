// tests/prompts.test.ts
// P0-3+6 knowledge mapper 提示词单测（2026-07-27）
// 验证 buildKnowledgeMapperSystemPrompt / buildKnowledgeMapperUserMessage 的输出结构
// v3（2026-08-09）：追加 planner 提示词测试（D7 内置化）
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildKnowledgeMapperSystemPrompt,
  buildKnowledgeMapperUserMessage,
  buildPlannerSystemPrompt,
} from "../src/prompts.ts";
import type { StructuredEvent } from "../src/types.ts";

// ============================================================================
// buildKnowledgeMapperSystemPrompt 测试
// ============================================================================

test("buildKnowledgeMapperSystemPrompt: 含任务/候选列表/映射规则/输出格式四段", () => {
  const prompt = buildKnowledgeMapperSystemPrompt();

  // 四个核心段落关键字
  assert.match(prompt, /# 任务/, "应含 # 任务 段");
  assert.match(prompt, /# 候选列表/, "应含 # 候选列表 段");
  assert.match(prompt, /# 映射规则/, "应含 # 映射规则 段");
  assert.match(prompt, /# 输出格式/, "应含 # 输出格式 段");
});

test("buildKnowledgeMapperSystemPrompt: 含 >=0.5 置信度阈值说明", () => {
  const prompt = buildKnowledgeMapperSystemPrompt();

  assert.match(prompt, />=0\.5/, "应含置信度阈值 >=0.5 说明");
});

test("buildKnowledgeMapperSystemPrompt: 含 declarationId=null 无匹配说明", () => {
  const prompt = buildKnowledgeMapperSystemPrompt();

  assert.match(prompt, /declarationId=null/, "应含无匹配时返回 null 的说明");
  assert.match(prompt, /表示无匹配/, "应含 null 语义说明");
});

test("buildKnowledgeMapperSystemPrompt: 含 JSON 数组输出格式说明", () => {
  const prompt = buildKnowledgeMapperSystemPrompt();

  assert.match(prompt, /JSON 数组/, "应说明输出为 JSON 数组");
  assert.match(prompt, /knowledge.*declarationId.*confidence/, "应含三字段说明");
});

// ============================================================================
// buildKnowledgeMapperUserMessage 测试
// ============================================================================

test("buildKnowledgeMapperUserMessage: 含 characterId/knowledgeItems/candidates 三段", () => {
  const msg = buildKnowledgeMapperUserMessage(
    "linchong",
    ["师父老了", "林冲有长枪"],
    [
      { declarationId: "decl-e_shi-mood-ch-1", entityId: "e_shi", property: "mood", value: "老迈" },
      { declarationId: "decl-e_lin-weapon-ch-1", entityId: "e_lin", property: "weapon", value: "长枪" },
    ],
  );

  // 三段关键字
  assert.match(msg, /# 角色/, "应含 # 角色 段");
  assert.match(msg, /# knowledge_gained 列表/, "应含 # knowledge_gained 列表 段");
  assert.match(msg, /# 候选 declarationId 列表/, "应含 # 候选 declarationId 列表 段");
});

test("buildKnowledgeMapperUserMessage: 含 characterId 值", () => {
  const msg = buildKnowledgeMapperUserMessage(
    "linchong",
    ["师父老了"],
    [{ declarationId: "d1", entityId: "e1", property: "mood", value: "老" }],
  );

  assert.ok(msg.includes("linchong"), "应含 characterId 值");
});

test("buildKnowledgeMapperUserMessage: 含 knowledgeItems 编号列表", () => {
  const msg = buildKnowledgeMapperUserMessage(
    "linchong",
    ["师父老了", "林冲有长枪"],
    [],
  );

  assert.match(msg, /1\. 师父老了/, "应含编号 1. 师父老了");
  assert.match(msg, /2\. 林冲有长枪/, "应含编号 2. 林冲有长枪");
});

test("buildKnowledgeMapperUserMessage: 含 candidates JSON 序列化", () => {
  const candidates = [
    { declarationId: "decl-e_shi-mood-ch-1", entityId: "e_shi", property: "mood", value: "老迈" },
  ];
  const msg = buildKnowledgeMapperUserMessage("linchong", ["师父老了"], candidates);

  // JSON.stringify 后应含 declarationId / entityId / property / value
  assert.ok(msg.includes("decl-e_shi-mood-ch-1"), "应含 declarationId");
  assert.ok(msg.includes("e_shi"), "应含 entityId");
  assert.ok(msg.includes("mood"), "应含 property");
  assert.ok(msg.includes("老迈"), "应含 value");
});

test("buildKnowledgeMapperUserMessage: 空 knowledgeItems 列表也能正常生成", () => {
  const msg = buildKnowledgeMapperUserMessage("linchong", [], []);

  // 不应抛错
  assert.match(msg, /# 角色/, "应含 # 角色 段");
  assert.match(msg, /# knowledge_gained 列表/, "应含 # knowledge_gained 列表 段（即使为空）");
});

// ============================================================================
// buildPlannerSystemPrompt 测试（v3 D7 内置化，2026-08-09）
// ============================================================================

const fakeEvent = {
  storyTime: "ch001.ev001",
  instruction: "测试事件",
  characterIds: ["e_a"],
  intent: "add",
} as StructuredEvent;

test("buildPlannerSystemPrompt: 内置检索策略 5 条（D7 引擎自维护）", () => {
  const prompt = buildPlannerSystemPrompt("", fakeEvent);
  assert.match(prompt, /检索策略（引擎自维护）/, "应含内置检索策略段");
  assert.match(prompt, /character_view/, "策略含 character_view");
  assert.match(prompt, /search_hybrid/, "策略含 search_hybrid");
  assert.match(prompt, /relations/, "策略含 relations");
  assert.match(prompt, /search_text/, "策略含 search_text");
  assert.match(prompt, /entity_snapshot/, "策略含 entity_snapshot");
});

test("buildPlannerSystemPrompt: 数量控制统一 3-8 条（用户钦定，原 5-15 删除）", () => {
  const prompt = buildPlannerSystemPrompt("", fakeEvent);
  assert.match(prompt, /3-8 条/, "建议值应为 3-8 条");
  assert.match(prompt, /宁精勿滥/, "应含宁精勿滥");
  assert.doesNotMatch(prompt, /5-15/, "原 5-15 建议应删除");
  assert.match(prompt, /硬上限 30 条/, "防上下文爆炸硬上限保留");
});

test("buildPlannerSystemPrompt: 信息差原则合并去重", () => {
  const prompt = buildPlannerSystemPrompt("", fakeEvent);
  assert.match(prompt, /内心独白/, "含内心独白隔离原则");
  assert.match(prompt, /宁少勿多/, "含宁少勿多元游戏原则");
  assert.match(prompt, /只 assignTo 知情者/, "含秘密只给知情者原则");
});

test("buildPlannerSystemPrompt: property 中文词表内置（D7 待确认项默认归引擎）", () => {
  const prompt = buildPlannerSystemPrompt("", fakeEvent);
  assert.match(prompt, /property 中文词表/, "应含词表段");
  assert.match(prompt, /信念\.关于_/, "含跨实体词表");
});

test("buildPlannerSystemPrompt: 外部规则集空串时跳过附加段", () => {
  const prompt = buildPlannerSystemPrompt("", fakeEvent);
  assert.doesNotMatch(prompt, /项目检索规则（附加）/, "空规则集不应有附加段");
});

test("buildPlannerSystemPrompt: 外部规则集非空时兼容附加（参数保留）", () => {
  const prompt = buildPlannerSystemPrompt("自定义规则内容", fakeEvent);
  assert.match(prompt, /项目检索规则（附加）/, "非空规则集应附加");
  assert.match(prompt, /自定义规则内容/, "附加内容原文出现");
});
