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
  { declarationId: "d1", entityId: "linchong", property: "mood", description: "愤怒", modality: "fact", validFrom: "ch-1" },
  { declarationId: "d2", entityId: "linchong", property: "location", description: "山神庙", modality: "fact", validFrom: "ch-1" },
];

const mockMember: CastMember = {
  characterId: "linchong",
  staticCard: mockCard,
  dynamicFacts: mockFacts,
};

// v3（2026-08-09，D8）：角色规则集收回引擎自维护——内置段 + 外部参数兼容

test("buildSystemPrompt: 内置角色扮演规则（D8 引擎自维护）", () => {
  const prompt = buildSystemPrompt(mockMember, "");
  assert.ok(prompt.includes("角色扮演规则（引擎自维护）"), "应含内置规则标题");
  assert.ok(prompt.includes("用角色的知识、性格、目标驱动行动"), "含扮演原则");
  assert.ok(prompt.includes("state_changes 属性名词表"), "含 state_changes 词表");
  assert.ok(prompt.includes("relation_update 关系标签词表"), "含 relation 词表");
  assert.ok(prompt.includes("动态层（当前状态）是最新事实"), "含静态/动态层说明");
  assert.ok(prompt.includes("以动态层为准"), "含动态优先规则");
});

test("buildSystemPrompt: 外部规则集非空时定界附加（参数兼容）", () => {
  const prompt = buildSystemPrompt(mockMember, "# 角色规则集\n- 第一人称思考");
  assert.ok(prompt.includes("─── 角色规则集开始 ───"), "应含定界起始标记");
  assert.ok(prompt.includes("第一人称思考"), "附加内容原文出现");
  assert.ok(prompt.includes("─── 角色规则集结束 ───"), "应含定界结束标记");
});

test("buildSystemPrompt: 外部规则集为空时不输出定界段", () => {
  const prompt = buildSystemPrompt(mockMember, "");
  assert.ok(!prompt.includes("角色规则集开始"), "空规则集不应有定界段");
});

test("buildSystemPrompt: 规则集为空时不报错", () => {
  const prompt = buildSystemPrompt(mockMember, "");
  assert.ok(prompt.length > 0);
});

// ============================================================================
// executionHints 透传（Pending Gap #14 已完成）
// ============================================================================

test("buildSystemPrompt: executionHints 注入到末尾独立段落", () => {
  const prompt = buildSystemPrompt(mockMember, "规则集内容", "林冲要显得绝望");
  assert.ok(prompt.includes("用户特殊要求"), "应包含用户特殊要求段落标题");
  assert.ok(prompt.includes("林冲要显得绝望"), "应包含 executionHints 内容");
});

test("buildSystemPrompt: 无 executionHints 时不显示段落", () => {
  const prompt = buildSystemPrompt(mockMember, "规则集");
  assert.ok(!prompt.includes("用户特殊要求"), "无 executionHints 时不应有该段落");
});

test("buildSystemPrompt: executionHints 为空字符串时不显示段落", () => {
  const prompt = buildSystemPrompt(mockMember, "规则集", "");
  assert.ok(!prompt.includes("用户特殊要求"), "空字符串时不应有该段落");
});

test("buildSystemPrompt: executionHints 为纯空白时不显示段落", () => {
  const prompt = buildSystemPrompt(mockMember, "规则集", "   \n   ");
  assert.ok(!prompt.includes("用户特殊要求"), "纯空白时不应有该段落");
});

test("buildSystemPrompt: executionHints 在静态/动态提醒之后", () => {
  const prompt = buildSystemPrompt(mockMember, "规则集", "特殊要求");
  const conflictIdx = prompt.indexOf("以动态层为准");
  const hintsIdx = prompt.indexOf("特殊要求");
  assert.ok(conflictIdx > 0, "应包含静态/动态提醒");
  assert.ok(hintsIdx > conflictIdx, "executionHints 应在静态/动态提醒之后");
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

// ----------------------------------------------------------------------------
// 归属与历史标注（2026-07-25 审计 P1/P2）
// ----------------------------------------------------------------------------

test("buildUserMessage: 动态层渲染属主名（P1 归属）", () => {
  const member: CastMember = {
    characterId: "linchong",
    staticCard: mockMember.staticCard,
    dynamicFacts: [
      { declarationId: "d1", entityId: "linchong", property: "mood", description: "愤怒", modality: "fact", validFrom: "ch-1", ownerName: "林冲" },
      { declarationId: "d2", entityId: "luqian", property: "plan", description: "火烧草料场", modality: "hypothesis", validFrom: "ch-1", ownerName: "陆谦" },
    ],
  };
  const cmd: InteractCommand = { eventInstruction: "测试", storyTime: "ch-1", cast: [member] };
  const msg = buildUserMessage(cmd, member, []);
  assert.ok(msg.includes("- [林冲] mood: 愤怒（fact）"), "应渲染自身属主名");
  assert.ok(msg.includes("- [陆谦] plan: 火烧草料场（hypothesis）"), "应渲染他人属主名");
});

test("buildUserMessage: 无 ownerName 时兑底 entityId", () => {
  const msg = buildUserMessage(
    { eventInstruction: "测试", storyTime: "ch-1", cast: [mockMember] },
    mockMember,
    [],
  );
  assert.ok(msg.includes("- [linchong] mood: 愤怒（fact）"), "应兑底 entityId");
});

test("buildUserMessage: 已闭合声明标注（旧）（P2 历史/当前区分）", () => {
  const member: CastMember = {
    characterId: "linchong",
    staticCard: mockMember.staticCard,
    dynamicFacts: [
      { declarationId: "d1", entityId: "linchong", property: "mood", description: "放松", modality: "fact", validFrom: "ch-1", validTo: "ch-2", ownerName: "林冲" },
      { declarationId: "d2", entityId: "linchong", property: "mood", description: "愤怒", modality: "fact", validFrom: "ch-2", validTo: "Infinity", ownerName: "林冲" },
    ],
  };
  const cmd: InteractCommand = { eventInstruction: "测试", storyTime: "ch-2", cast: [member] };
  const msg = buildUserMessage(cmd, member, []);
  assert.ok(msg.includes("- [林冲] mood: 放松（fact·旧）"), "已闭合应标注旧");
  assert.ok(msg.includes("- [林冲] mood: 愤怒（fact）"), "未闭合不应标注");
});

test("buildUserMessage: 检索 label 渲染为分组小标题（审计偏差 2）", () => {
  const member: CastMember = {
    characterId: "linchong",
    staticCard: mockMember.staticCard,
    dynamicFacts: [
      { declarationId: "d1", entityId: "linchong", property: "mood", description: "愤怒", modality: "fact", validFrom: "ch-1", ownerName: "林冲", label: "林冲的可见状态" },
      { declarationId: "d2", entityId: "luqian", property: "plan", description: "火烧草料场", modality: "hypothesis", validFrom: "ch-1", ownerName: "陆谦", label: "陆谦的阴谋" },
      { declarationId: "d3", entityId: "linchong", property: "location", description: "山神庙", modality: "fact", validFrom: "ch-1", ownerName: "林冲" },
    ],
  };
  const cmd: InteractCommand = { eventInstruction: "测试", storyTime: "ch-1", cast: [member] };
  const msg = buildUserMessage(cmd, member, []);
  assert.ok(msg.includes("【林冲的可见状态】"), "应渲染第一个 label 小标题");
  assert.ok(msg.includes("【陆谦的阴谋】"), "应渲染第二个 label 小标题");
  const idx1 = msg.indexOf("【林冲的可见状态】");
  const idx2 = msg.indexOf("【陆谦的阴谋】");
  const idx3 = msg.indexOf("location: 山神庙");
  assert.ok(idx1 < idx2 && idx2 < idx3, "小标题应按出现顺序分组，无 label 的排最后");
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
