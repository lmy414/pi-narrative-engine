// tests/renderer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderText, renderToFile } from "../src/renderer.ts";
import type { RenderLlmCaller, RenderTextCommand, RenderFileCommand } from "../src/types.ts";

// ============================================================================
// Mock LLM 调用器
// ============================================================================

function makeMockLlm(response: string): RenderLlmCaller {
  return async () => response;
}

function makeMockLlmRecorder(calls: Array<{ system: string; user: string }>): RenderLlmCaller {
  return async (systemPrompt, userMessage) => {
    calls.push({ system: systemPrompt, user: userMessage });
    return "mock 渲染文本";
  };
}

// ============================================================================
// renderText 测试
// ============================================================================

test("renderText: 返回 LLM 生成的文本", async () => {
  const mockLlm = makeMockLlm("林墨推开门，雨丝落在肩上。");
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-1",
    instruction: "林墨进入酒馆",
    payload: [{ actor: "林墨", action: "进入", target: "酒馆" }],
    context: "",
  };

  const result = await renderText(cmd, { llm: mockLlm, ruleSet: "文风：白描" });

  assert.equal(result, "林墨推开门，雨丝落在肩上。");
});

test("renderText: LLM 调用时传入系统提示词和用户消息", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const mockLlm = makeMockLlmRecorder(calls);
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-1",
    instruction: "测试指令",
    payload: [],
    context: "已有上下文",
  };

  await renderText(cmd, { llm: mockLlm, ruleSet: "禁止词：手机" });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.includes("渲染器"), "系统提示词应包含渲染器角色");
  assert.ok(calls[0].user.includes("测试指令"), "用户消息应包含叙事指令");
  assert.ok(calls[0].user.includes("禁止词：手机"), "用户消息应包含规则集");
});

test("renderText: 规则集为空时不报错", async () => {
  const mockLlm = makeMockLlm("文本");
  const cmd: RenderTextCommand = {
    mode: "append",
    eventId: "evt_001",
    storyTime: "ch-1",
    instruction: "测试",
    payload: [],
    context: "",
  };

  const result = await renderText(cmd, { llm: mockLlm, ruleSet: "" });
  assert.equal(result, "文本");
});

// ============================================================================
// renderToFile 测试
// ============================================================================

test("renderToFile: append 模式写入章节文件", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const mockLlm = makeMockLlm("林墨推开门。");
    const chapterPath = path.join(dir, "第1章-测试.md");
    const cmd: RenderFileCommand = {
      mode: "append",
      chapterPath,
      eventId: "evt_001",
      storyTime: "ch-1",
      instruction: "林墨进入酒馆",
      payload: [{ actor: "林墨", action: "进入", target: "酒馆" }],
    };

    const result = await renderToFile(cmd, { llm: mockLlm, ruleSet: "" });

    assert.ok(result.ok);
    assert.equal(result.mode, "append");
    assert.equal(result.eventId, "evt_001");

    const content = await readFile(chapterPath, "utf8");
    assert.ok(content.includes("<!-- engine v0.01 -->"), "应包含版本标记");
    assert.ok(content.includes("<!-- event: evt_001 -->"), "应包含事件锚点");
    assert.ok(content.includes("林墨推开门。"), "应包含渲染文本");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderToFile: append 模式追加到已有章节", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const mockLlm = makeMockLlm("第二段。");
    const chapterPath = path.join(dir, "第1章-测试.md");
    const cmd1: RenderFileCommand = {
      mode: "append",
      chapterPath,
      eventId: "evt_001",
      storyTime: "ch-1",
      instruction: "第一段",
      payload: [],
    };
    const cmd2: RenderFileCommand = {
      mode: "append",
      chapterPath,
      eventId: "evt_002",
      storyTime: "ch-1",
      instruction: "第二段",
      payload: [],
    };

    await renderToFile(cmd1, { llm: makeMockLlm("第一段。"), ruleSet: "" });
    await renderToFile(cmd2, { llm: mockLlm, ruleSet: "" });

    const content = await readFile(chapterPath, "utf8");
    assert.ok(content.includes("第一段。"));
    assert.ok(content.includes("第二段。"));
    assert.ok(content.indexOf("evt_001") < content.indexOf("evt_002"), "事件顺序应正确");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderToFile: modify 模式重写指定锚点", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const chapterPath = path.join(dir, "第1章-测试.md");

    // 先 append 两个事件
    await renderToFile(
      { mode: "append", chapterPath, eventId: "evt_001", storyTime: "ch-1", instruction: "旧文本", payload: [] },
      { llm: makeMockLlm("旧的第一段。"), ruleSet: "" },
    );
    await renderToFile(
      { mode: "append", chapterPath, eventId: "evt_002", storyTime: "ch-1", instruction: "第二段", payload: [] },
      { llm: makeMockLlm("第二段。"), ruleSet: "" },
    );

    // modify evt_001
    const result = await renderToFile(
      { mode: "modify", chapterPath, eventId: "evt_001", storyTime: "ch-1", instruction: "重写", payload: [], modifyAnchorEventId: "evt_001" },
      { llm: makeMockLlm("新的第一段。"), ruleSet: "" },
    );

    assert.ok(result.ok);
    assert.equal(result.mode, "modify");

    const content = await readFile(chapterPath, "utf8");
    assert.ok(content.includes("新的第一段。"), "应包含新文本");
    assert.ok(!content.includes("旧的第一段。"), "不应包含旧文本");
    assert.ok(content.includes("第二段。"), "后续段落应保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderToFile: modify 锚点不存在时返回错误", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const chapterPath = path.join(dir, "第1章-测试.md");
    await renderToFile(
      { mode: "append", chapterPath, eventId: "evt_001", storyTime: "ch-1", instruction: "第一段", payload: [] },
      { llm: makeMockLlm("第一段。"), ruleSet: "" },
    );

    const result = await renderToFile(
      { mode: "modify", chapterPath, eventId: "evt_999", storyTime: "ch-1", instruction: "重写", payload: [], modifyAnchorEventId: "evt_999" },
      { llm: makeMockLlm("新文本"), ruleSet: "" },
    );

    assert.ok(!result.ok);
    assert.ok(result.error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
