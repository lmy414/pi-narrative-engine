// tests/checker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHAPTER_VERSION_MARKER,
} from "@pi/renderer";
import { checkNarrative } from "../src/checker.ts";
import type { RenderLlmCaller } from "@pi/renderer";

function makeMockLlm(response: string): RenderLlmCaller {
  return async () => response;
}

test("checkNarrative: 返回结构化检查结果", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");

    const content = [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "林墨推开门。",
      "",
      "<!-- event: evt_002 -->",
      "",
      "他拿出手机打电话。",
      "",
    ].join("\n");
    await writeFile(chapterPath, content, "utf8");

    await writeFile(path.join(dir, "规则集.md"), "禁止词：手机", "utf8");

    const mockLlm = makeMockLlm(JSON.stringify({
      violations: [
        { location: "evt_002", rule: "禁止词：手机", text: "他拿出手机打电话", severity: "error" },
      ],
      suggestions: [
        { location: "evt_002", issue: "包含禁止词", suggestion: "改为「他抽出信筒」" },
      ],
    }));

    const result = await checkNarrative(
      { target: "chapter", chapterPath },
      { llm: mockLlm, novelCwd: dir },
    );

    assert.ok(result.violations);
    assert.ok(result.suggestions);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, "禁止词：手机");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: target=latest 只检查最新事件", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");

    const content = [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "第一段。",
      "",
      "<!-- event: evt_002 -->",
      "",
      "第二段。",
      "",
    ].join("\n");
    await writeFile(chapterPath, content, "utf8");
    await writeFile(path.join(dir, "规则集.md"), "无特殊规则", "utf8");

    const calls: string[] = [];
    const mockLlm: RenderLlmCaller = async (_sys, user) => {
      calls.push(user);
      return JSON.stringify({ violations: [], suggestions: [] });
    };

    await checkNarrative(
      { target: "latest", chapterPath },
      { llm: mockLlm, novelCwd: dir },
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("第二段"), "应只包含最新事件文本");
    assert.ok(!calls[0].includes("第一段"), "不应包含旧事件文本");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: target=range 检查区间", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");

    const content = [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "第一段。",
      "",
      "<!-- event: evt_002 -->",
      "",
      "第二段。",
      "",
      "<!-- event: evt_003 -->",
      "",
      "第三段。",
      "",
    ].join("\n");
    await writeFile(chapterPath, content, "utf8");
    await writeFile(path.join(dir, "规则集.md"), "无特殊规则", "utf8");

    const calls: string[] = [];
    const mockLlm: RenderLlmCaller = async (_sys, user) => {
      calls.push(user);
      return JSON.stringify({ violations: [], suggestions: [] });
    };

    await checkNarrative(
      { target: "range", chapterPath, startEventId: "evt_001", endEventId: "evt_003" },
      { llm: mockLlm, novelCwd: dir },
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("第一段"));
    assert.ok(calls[0].includes("第二段"));
    assert.ok(!calls[0].includes("第三段"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
