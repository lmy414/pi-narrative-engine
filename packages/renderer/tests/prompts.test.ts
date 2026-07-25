// tests/prompts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RENDERER_SYSTEM_PROMPT,
  buildUserMessage,
} from "../src/prompts.ts";
import type { RenderTextCommand } from "../src/types.ts";

test("RENDERER_SYSTEM_PROMPT: 包含渲染器角色定义", () => {
  assert.ok(RENDERER_SYSTEM_PROMPT.includes("渲染器"), "应包含渲染器角色定义");
  assert.ok(RENDERER_SYSTEM_PROMPT.includes("正文"), "应包含正文输出约定");
  assert.ok(RENDERER_SYSTEM_PROMPT.includes("事件 ID"), "应包含不输出事件ID的约定");
});

test("buildUserMessage: 包含叙事指令", () => {
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-2",
    instruction: "林墨在酒馆遇见赵无极",
    payload: [{ actor: "林墨", action: "寒暄", emotion: "克制" }],
    context: "已有上文",
  };
  const ruleSet = "文风：白描为主";

  const msg = buildUserMessage(cmd, ruleSet);

  assert.ok(msg.includes("林墨在酒馆遇见赵无极"), "应包含叙事指令");
  assert.ok(msg.includes("（故事时间：ch-2）"), "应注入 storyTime（审计修复）");
});

test("buildUserMessage: 包含角色池数据", () => {
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-2",
    instruction: "测试",
    payload: [{ actor: "林墨", action: "寒暄", emotion: "克制" }],
    context: "",
  };
  const ruleSet = "";

  const msg = buildUserMessage(cmd, ruleSet);

  assert.ok(msg.includes("林墨"), "应包含角色 actor");
  assert.ok(msg.includes("寒暄"), "应包含角色 action");
});

test("buildUserMessage: 规则集在消息末尾（注意力最强）", () => {
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-2",
    instruction: "测试指令",
    payload: [],
    context: "已有上下文",
  };
  const ruleSet = "禁止词：手机、电脑";

  const msg = buildUserMessage(cmd, ruleSet);

  // 规则集应在消息末尾
  const ruleSetIdx = msg.lastIndexOf(ruleSet);
  const contextIdx = msg.lastIndexOf("已有上下文");
  assert.ok(ruleSetIdx > contextIdx, "规则集应在上下文之后");
  assert.ok(ruleSetIdx > msg.indexOf("测试指令"), "规则集应在叙事指令之后");
});

test("buildUserMessage: modify 模式包含目标锚点信息", () => {
  const cmd: RenderTextCommand = {
    mode: "modify",
    eventId: "evt_002",
    storyTime: "ch-2",
    instruction: "重写这段",
    payload: [],
    context: "旧文本",
    modifyAnchorEventId: "evt_001",
  };
  const ruleSet = "";

  const msg = buildUserMessage(cmd, ruleSet);

  assert.ok(msg.includes("evt_001"), "应包含 modifyAnchorEventId");
  assert.ok(msg.includes("重写"), "应提示这是重写模式");
});
