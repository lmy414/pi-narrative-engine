// tests/render-tools.test.ts
/**
 * 主会话渲染工具路径防护单测（🔴-A 2026-08-08）
 *
 * 断言：
 * - render_append / render_modify / render_preview / render_check 四个工具
 *   对越界 chapterPath（.. 逃逸 / 项目外绝对路径）抛 PATH_ESCAPE
 * - 界内相对/绝对路径不触发 PATH_ESCAPE（append 经注入式 createLlmCaller
 *   写入真实临时文件，不触网络）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRenderTools, type RenderToolsProvider } from "../src/chat/render-tools.ts";

/** 构造 provider：llmStore 只在"真正渲染"时被读取（越界用例不触达） */
function makeProvider(cwd: string, renderedText = "林墨推开门。"): RenderToolsProvider {
  return {
    cwd,
    llmStore: {
      getModel: () => ({ provider: "test", id: "mock" }) as never,
      getApiKey: () => "sk-test",
      getHeaders: () => undefined,
    },
    createLlmCaller: () => async () => renderedText,
  };
}

async function makeTools(): Promise<{ tools: ToolDefinition[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "render-tools-test-"));
  return { tools: createRenderTools(makeProvider(dir)), dir };
}

async function assertPathEscape(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: Error & { code?: string }) => {
    assert.equal(err.code, "PATH_ESCAPE", `应抛 PATH_ESCAPE，实际: ${err.message}`);
    return true;
  });
}

test("render_append: 越界 chapterPath（.. 逃逸）拒绝", async () => {
  const { tools, dir } = await makeTools();
  try {
    const tool = tools.find((t) => t.name === "render_append")!;
    await assertPathEscape(() =>
      tool.execute("1", {
        chapterPath: "../outside.md",
        eventId: "evt_1",
        storyTime: "ch001.ev001",
        instruction: "测试",
        payload: [],
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render_append: 项目外绝对路径拒绝", async () => {
  const { tools, dir } = await makeTools();
  try {
    const outside = join(tmpdir(), "render-tools-outside", "x.md");
    const tool = tools.find((t) => t.name === "render_append")!;
    await assertPathEscape(() =>
      tool.execute("1", {
        chapterPath: outside,
        eventId: "evt_1",
        storyTime: "ch001.ev001",
        instruction: "测试",
        payload: [],
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render_modify: 越界 chapterPath 拒绝", async () => {
  const { tools, dir } = await makeTools();
  try {
    const tool = tools.find((t) => t.name === "render_modify")!;
    await assertPathEscape(() =>
      tool.execute("1", {
        chapterPath: "../outside.md",
        eventId: "evt_1",
        modifyAnchorEventId: "evt_0",
        storyTime: "ch001.ev001",
        instruction: "测试",
        payload: [],
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render_preview: 可选 chapterPath 越界同样拒绝", async () => {
  const { tools, dir } = await makeTools();
  try {
    const tool = tools.find((t) => t.name === "render_preview")!;
    await assertPathEscape(() =>
      tool.execute("1", {
        chapterPath: "../../etc/passwd",
        eventId: "evt_1",
        storyTime: "ch001.ev001",
        instruction: "测试",
        payload: [],
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render_check: 越界 chapterPath 拒绝（checkNarrative 入口校验）", async () => {
  const { tools, dir } = await makeTools();
  try {
    const tool = tools.find((t) => t.name === "render_check")!;
    await assertPathEscape(() =>
      tool.execute("1", {
        target: "full",
        chapterPath: "../outside.md",
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render_append: 界内相对路径正常写入（不触发 PATH_ESCAPE）", async () => {
  const { tools, dir } = await makeTools();
  try {
    await mkdir(join(dir, "正文"), { recursive: true });
    const tool = tools.find((t) => t.name === "render_append")!;
    const result = await tool.execute("1", {
      chapterPath: join("正文", "第1章.md"),
      eventId: "evt_1",
      storyTime: "ch001.ev001",
      instruction: "测试",
      payload: [],
    });
    assert.equal(result.details.ok, true, "renderToFile 应成功");
    const content = await readFile(join(dir, "正文", "第1章.md"), "utf8");
    assert.match(content, /林墨推开门/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
