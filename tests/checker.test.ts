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
      { llm: mockLlm, ruleSet: "禁止词：手机", cwd: dir },
    );

    assert.ok(result.violations);
    assert.ok(result.suggestions);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, "禁止词：手机");
    assert.equal(result.violations[0].severity, "error");
    assert.equal(result.violations[0].location, "evt_002");
    assert.equal(result.violations[0].text, "他拿出手机打电话");
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].suggestion, "改为「他抽出信筒」");
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

    const calls: string[] = [];
    const mockLlm: RenderLlmCaller = async (_sys, user) => {
      calls.push(user);
      return JSON.stringify({ violations: [], suggestions: [] });
    };

    await checkNarrative(
      { target: "latest", chapterPath },
      { llm: mockLlm, ruleSet: "无特殊规则", cwd: dir },
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

    const calls: string[] = [];
    const mockLlm: RenderLlmCaller = async (_sys, user) => {
      calls.push(user);
      return JSON.stringify({ violations: [], suggestions: [] });
    };

    await checkNarrative(
      { target: "range", chapterPath, startEventId: "evt_001", endEventId: "evt_003" },
      { llm: mockLlm, ruleSet: "无特殊规则", cwd: dir },
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("第一段"));
    assert.ok(calls[0].includes("第二段"));
    assert.ok(!calls[0].includes("第三段"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: target=full 无 chapterPath 时抛错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const mockLlm = makeMockLlm(JSON.stringify({ violations: [], suggestions: [] }));
    await assert.rejects(
      checkNarrative(
        { target: "full" },
        { llm: mockLlm, ruleSet: "", cwd: dir },
      ),
      /target=full 时需要 chapterPath/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: target=range 缺 startEventId 时抛错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");
    await writeFile(chapterPath, [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "第一段。",
      "",
    ].join("\n"), "utf8");

    const mockLlm = makeMockLlm(JSON.stringify({ violations: [], suggestions: [] }));

    await assert.rejects(
      checkNarrative(
        { target: "range", chapterPath },
        { llm: mockLlm, ruleSet: "", cwd: dir },
      ),
      /target=range 时需要 startEventId/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: LLM 返回非 JSON 时返回空结果带 error 字段", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");
    await writeFile(chapterPath, [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "林墨推开门。",
      "",
    ].join("\n"), "utf8");

    const nonJsonResponse = "这不是 JSON，只是一段自然语言。";
    const mockLlm = makeMockLlm(nonJsonResponse);

    const result = await checkNarrative(
      { target: "chapter", chapterPath },
      { llm: mockLlm, ruleSet: "无特殊规则", cwd: dir },
    );

    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.suggestions, []);
    assert.ok(result.error, "应有 error 字段");
    assert.ok(result.error!.includes("LLM 返回非 JSON"), "error 应包含说明");
    assert.ok(result.error!.includes("这不是 JSON"), "error 应包含响应片段前 100 字符");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: target=latest 文件无锚点时返回全文", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const 正文Dir = path.join(dir, "正文");
    await mkdir(正文Dir, { recursive: true });
    const chapterPath = path.join(正文Dir, "第1章-测试.md");

    const content = [
      CHAPTER_VERSION_MARKER,
      "",
      "这是第一段。",
      "",
      "这是第二段。",
      "",
      "这是第三段。",
      "",
    ].join("\n");
    await writeFile(chapterPath, content, "utf8");

    const calls: string[] = [];
    const mockLlm: RenderLlmCaller = async (_sys, user) => {
      calls.push(user);
      return JSON.stringify({ violations: [], suggestions: [] });
    };

    await checkNarrative(
      { target: "latest", chapterPath },
      { llm: mockLlm, ruleSet: "无特殊规则", cwd: dir },
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("这是第一段"), "无锚点时应返回全文（含第一段）");
    assert.ok(calls[0].includes("这是第二段"), "无锚点时应返回全文（含第二段）");
    assert.ok(calls[0].includes("这是第三段"), "无锚点时应返回全文（含第三段）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkNarrative: 越界 chapterPath 拒绝（🔴-A）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const mockLlm = makeMockLlm(JSON.stringify({ violations: [], suggestions: [] }));
    await assert.rejects(
      checkNarrative(
        { target: "chapter", chapterPath: "../outside.md" },
        { llm: mockLlm, ruleSet: "", cwd: dir },
      ),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "PATH_ESCAPE", `应抛 PATH_ESCAPE，实际: ${err.message}`);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
