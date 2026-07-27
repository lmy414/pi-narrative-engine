// tests/prompts.test.ts
// P0-3+6 knowledge mapper 提示词单测（2026-07-27）
// 验证 buildKnowledgeMapperSystemPrompt / buildKnowledgeMapperUserMessage 的输出结构
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildKnowledgeMapperSystemPrompt,
  buildKnowledgeMapperUserMessage,
} from "../src/prompts.ts";

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
