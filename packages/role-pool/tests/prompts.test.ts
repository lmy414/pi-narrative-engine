import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildUserMessage } from "../src/prompts.ts";
import type { CastMember, InteractCommand, PriorAction, SillyTavernCard, FactSnapshot } from "../src/types.ts";

const mockCard: SillyTavernCard = {
  name: "林冲",
  description: "豹头环眼，燕颔虎须，八十万禁军教头",
  personality: "隐忍、重义、刚烈",
};

const mockFacts: FactSnapshot[] = [
  { declarationId: "d1", entityId: "linchong", property: "mood", value: "愤怒", modality: "fact", validFrom: "ch-1" },
  { declarationId: "d2", entityId: "linchong", property: "location", value: "山神庙", modality: "fact", validFrom: "ch-1" },
];

const mockMember: CastMember = {
  characterId: "linchong",
  staticCard: mockCard,
  dynamicFacts: mockFacts,
};

test("buildSystemPrompt: 包含规则集全文", () => {
  const prompt = buildSystemPrompt(mockMember, "# 角色规则集\n- 第一人称思考");
  assert.ok(prompt.includes("# 角色规则集"));
  assert.ok(prompt.includes("第一人称思考"));
});

test("buildSystemPrompt: 包含静态/动态冲突提醒", () => {
  const prompt = buildSystemPrompt(mockMember, "");
  assert.ok(prompt.includes("动态层"), "应包含动态层提醒");
  assert.ok(prompt.includes("以动态层为准"), "应包含动态优先规则");
});

test("buildSystemPrompt: 规则集为空时不报错", () => {
  const prompt = buildSystemPrompt(mockMember, "");
  assert.ok(prompt.length > 0);
});

test("buildUserMessage: 角色信息在前，事件指令在末尾", () => {
  const cmd: InteractCommand = {
    eventInstruction: "林冲走进山神庙",
    storyTime: "ch-2",
    cast: [mockMember],
  };
  const msg = buildUserMessage(cmd, mockMember, []);
  const cardPos = msg.indexOf("林冲");
  const eventPos = msg.indexOf("林冲走进山神庙");
  // 角色卡中的"林冲"应出现在事件指令之前
  assert.ok(cardPos < eventPos, "角色信息应在事件指令之前");
});

test("buildUserMessage: 包含静态层 JSON", () => {
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [mockMember],
  };
  const msg = buildUserMessage(cmd, mockMember, []);
  assert.ok(msg.includes('"name": "林冲"'), "应包含角色卡 JSON");
  assert.ok(msg.includes("隐忍"), "应包含 personality");
});

test("buildUserMessage: 包含动态层事实", () => {
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [mockMember],
  };
  const msg = buildUserMessage(cmd, mockMember, []);
  assert.ok(msg.includes("mood"), "应包含 mood 属性");
  assert.ok(msg.includes("愤怒"), "应包含 mood 值");
  assert.ok(msg.includes("山神庙"), "应包含 location 值");
});

test("buildUserMessage: 先动者行动在事件指令之前", () => {
  const cmd: InteractCommand = {
    eventInstruction: "武松进场",
    storyTime: "ch-2",
    cast: [mockMember],
  };
  const priorActions: PriorAction[] = [
    { actor: "林冲", action: "举杯行礼", target: "师父" },
  ];
  const msg = buildUserMessage(cmd, mockMember, priorActions);
  const priorPos = msg.indexOf("举杯行礼");
  const eventPos = msg.indexOf("武松进场");
  assert.ok(priorPos < eventPos, "先动者行动应在事件指令之前");
  assert.ok(priorPos >= 0, "应包含先动者行动");
});

test("buildUserMessage: 无先动者时不显示该区块", () => {
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [mockMember],
  };
  const msg = buildUserMessage(cmd, mockMember, []);
  assert.ok(!msg.includes("[先动者行动]"), "无先动者时不应显示该区块");
});

test("buildUserMessage: 末尾包含 tool call 强制要求", () => {
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [mockMember],
  };
  const msg = buildUserMessage(cmd, mockMember, []);
  assert.ok(msg.includes("character_action"), "应包含工具名");
  assert.ok(msg.includes("不要返回纯文本"), "应包含强制 tool call 要求");
});
