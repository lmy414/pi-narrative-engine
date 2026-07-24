import { test } from "node:test";
import assert from "node:assert/strict";
import { interact } from "../src/role-pool.ts";
import type {
  CastMember,
  InteractCommand,
  RoleAgentOutput,
  RoleLlmCaller,
  SillyTavernCard,
} from "../src/types.ts";

// ============================================================================
// Mock LLM 调用器
// ============================================================================

function makeMockLlm(output: RoleAgentOutput): RoleLlmCaller {
  return async () => output;
}

function makeMockLlmRecorder(
  calls: Array<{ system: string; user: string }>,
  output: RoleAgentOutput,
): RoleLlmCaller {
  return async (systemPrompt, userMessage) => {
    calls.push({ system: systemPrompt, user: userMessage });
    return output;
  };
}

function makeFailingLlm(error: Error): RoleLlmCaller {
  return async () => {
    throw error;
  };
}

function makeCard(name: string): SillyTavernCard {
  return { name, description: `${name}的描述` };
}

function makeMember(id: string, name: string): CastMember {
  return { characterId: id, staticCard: makeCard(name), dynamicFacts: [] };
}

// ============================================================================
// 基础功能测试
// ============================================================================

test("interact: 单角色返回正确输出", async () => {
  const output: RoleAgentOutput = {
    characterId: "linchong",
    actor: "林冲",
    action: "举杯",
  };
  const mockLlm = makeMockLlm(output);
  const cmd: InteractCommand = {
    eventInstruction: "林冲举杯",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲")],
  };
  const result = await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].actor, "林冲");
  assert.equal(result.outputs[0].characterId, "linchong");
  assert.equal(result.errors.length, 0);
});

test("interact: 空 cast 返回空结果", async () => {
  const mockLlm = makeMockLlm({ characterId: "x", actor: "x", action: "y" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [],
  };
  const result = await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(result.outputs.length, 0);
  assert.equal(result.errors.length, 0);
});

test("interact: 串行顺序正确（N 次 LLM 调用）", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls, { characterId: "x", actor: "x", action: "y" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [
      makeMember("a", "角色A"),
      makeMember("b", "角色B"),
      makeMember("c", "角色C"),
    ],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(calls.length, 3, "应调用 3 次 LLM");
});

// ============================================================================
// PriorAction 累积测试
// ============================================================================

test("interact: 后动者收到先动者的 action", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const outputs = [
    { characterId: "linchong", actor: "林冲", action: "举杯行礼", target: "师父" },
    { characterId: "wusong", actor: "武松", action: "拍桌大笑" },
  ];
  let callIndex = 0;
  const mockLlm: RoleLlmCaller = async (system, user) => {
    calls.push({ system, user });
    return outputs[callIndex++];
  };
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲"), makeMember("wusong", "武松")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });

  // 第一个角色不应看到先动者行动
  assert.ok(!calls[0].user.includes("[先动者行动]"), "首个角色不应有先动者行动区块");

  // 第二个角色应看到第一个角色的 action
  assert.ok(calls[1].user.includes("举杯行礼"), "第二个角色应看到第一个角色的 action");
  assert.ok(calls[1].user.includes("林冲"), "第二个角色应看到第一个角色的 actor");
});

test("interact: PriorAction 不含 thought/emotion/state_changes", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const firstOutput: RoleAgentOutput = {
    characterId: "linchong",
    actor: "林冲",
    action: "举杯",
    thought: "心中暗想",
    emotion: "愤怒",
    state_changes: [{ entityId: "linchong", property: "mood", value: "怒", modality: "fact" }],
  };
  const secondOutput: RoleAgentOutput = {
    characterId: "wusong",
    actor: "武松",
    action: "笑",
  };
  let callIndex = 0;
  const mockLlm: RoleLlmCaller = async (system, user) => {
    calls.push({ system, user });
    return [firstOutput, secondOutput][callIndex++];
  };
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲"), makeMember("wusong", "武松")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });

  // 第二个角色的 user message 不应包含 thought/emotion/state_changes
  assert.ok(!calls[1].user.includes("心中暗想"), "不应传递 thought");
  assert.ok(!calls[1].user.includes("愤怒"), "不应传递 emotion");
  assert.ok(!calls[1].user.includes("mood"), "不应传递 state_changes");
});

// ============================================================================
// 错误处理测试
// ============================================================================

test("interact: 单角色失败时跳过且记录 errors", async () => {
  const okOutput: RoleAgentOutput = {
    characterId: "wusong",
    actor: "武松",
    action: "笑",
  };
  let callIndex = 0;
  const mockLlm: RoleLlmCaller = async () => {
    callIndex++;
    if (callIndex === 1) throw new Error("LLM 超时");
    return okOutput;
  };
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("a", "角色A"), makeMember("b", "角色B")],
  };
  const result = await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(result.outputs.length, 1, "应只有 1 个成功输出");
  assert.equal(result.outputs[0].actor, "武松");
  assert.equal(result.errors.length, 1, "应记录 1 个错误");
  assert.equal(result.errors[0].characterId, "a");
  assert.ok(result.errors[0].error.includes("LLM 超时"));
});

test("interact: 全部失败时返回空 outputs + 全部 errors", async () => {
  const mockLlm = makeFailingLlm(new Error("网络错误"));
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("a", "A"), makeMember("b", "B")],
  };
  const result = await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(result.outputs.length, 0);
  assert.equal(result.errors.length, 2);
});

test("interact: 失败角色不累积到 priorActions", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const okOutput: RoleAgentOutput = {
    characterId: "wusong",
    actor: "武松",
    action: "笑",
  };
  let callIndex = 0;
  const mockLlm: RoleLlmCaller = async (system, user) => {
    calls.push({ system, user });
    callIndex++;
    if (callIndex === 1) throw new Error("失败");
    return okOutput;
  };
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("a", "角色A"), makeMember("b", "角色B")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });
  // 第二个角色不应看到失败角色的行动（因为失败角色没产出 action）
  assert.ok(!calls[1].user.includes("[先动者行动]"), "不应包含失败角色的行动");
});

// ============================================================================
// 规则集注入测试
// ============================================================================

test("interact: 规则集注入 system prompt", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls, { characterId: "x", actor: "x", action: "y" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("a", "A")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "# 角色规则集\n- 第一人称思考" });
  assert.ok(calls[0].system.includes("# 角色规则集"), "system prompt 应包含规则集");
  assert.ok(calls[0].system.includes("第一人称思考"), "system prompt 应包含规则集内容");
});

// ============================================================================
// characterId 透传测试（2026-07-25 解决 Pending Gap #2）
// ============================================================================

test("interact: user message 包含当前角色的 entityId", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls, { characterId: "linchong", actor: "林冲", action: "举杯" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.ok(calls[0].user.includes("[你的 entityId]"), "user message 应包含 [你的 entityId] 标题");
  assert.ok(calls[0].user.includes("linchong"), "user message 应包含 characterId 值");
});

test("interact: user message 包含本场角色名单", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls, { characterId: "linchong", actor: "林冲", action: "举杯" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲"), makeMember("luqian", "陆谦")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.ok(calls[0].user.includes("[本场角色名单]"), "user message 应包含 [本场角色名单] 标题");
  assert.ok(calls[0].user.includes("linchong: 林冲"), "名单应包含自己");
  assert.ok(calls[0].user.includes("luqian: 陆谦"), "名单应包含其他角色");
  assert.ok(calls[0].user.includes("（你）"), "名单应标注当前角色");
});

test("interact: user message 末尾包含 characterId 填写规则", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls, { characterId: "linchong", actor: "林冲", action: "举杯" });
  const cmd: InteractCommand = {
    eventInstruction: "测试",
    storyTime: "ch-1",
    cast: [makeMember("linchong", "林冲")],
  };
  await interact(cmd, { llm: mockLlm, ruleSet: "" });
  assert.ok(calls[0].user.includes("characterId 字段填你自己的 entityId"), "应提示 characterId 填什么");
  assert.ok(calls[0].user.includes("relation_update.target 填对方角色的 characterId"), "应提示 target 填什么");
  assert.ok(calls[0].user.includes("不要填名字") || calls[0].user.includes("不是名字"), "应明确禁止填名字");
});
