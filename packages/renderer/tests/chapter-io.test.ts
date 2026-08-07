// tests/chapter-io.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHAPTER_VERSION_MARKER,
  EVENT_ANCHOR_PREFIX,
  readChapter,
  appendToChapter,
  modifyChapterSection,
  readChapterSection,
  ensureChapterFile,
} from "../src/chapter-io.ts";

test("ensureChapterFile: 文件不存在时创建并写入版本标记", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    const content = await readFile(filePath, "utf8");
    assert.equal(content, CHAPTER_VERSION_MARKER + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureChapterFile: 文件已存在时不覆盖", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    const existing = CHAPTER_VERSION_MARKER + "\n\n<!-- event: evt_001 -->\n\n已有内容\n";
    await writeFile(filePath, existing, "utf8");
    await ensureChapterFile(filePath);
    const content = await readFile(filePath, "utf8");
    assert.equal(content, existing);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readChapter: 读取整个章节文件", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    const content = CHAPTER_VERSION_MARKER + "\n\n<!-- event: evt_001 -->\n\n第一段\n";
    await writeFile(filePath, content, "utf8");
    const result = await readChapter(filePath);
    assert.equal(result, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendToChapter: 在文件末尾追加事件锚点+文本", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "第一段正文\n");
    await appendToChapter(filePath, "evt_002", "第二段正文\n");
    const content = await readFile(filePath, "utf8");
    const expected = [
      CHAPTER_VERSION_MARKER,
      "",
      "<!-- event: evt_001 -->",
      "",
      "第一段正文",
      "",
      "<!-- event: evt_002 -->",
      "",
      "第二段正文",
      "",
    ].join("\n");
    assert.equal(content, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendToChapter: 文本末尾无换行时自动补", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "无尾换行的文本");
    const content = await readFile(filePath, "utf8");
    assert.ok(content.endsWith("无尾换行的文本\n"), "应自动补尾换行");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("modifyChapterSection: 重写指定锚点区间", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "旧的第一段");
    await appendToChapter(filePath, "evt_002", "第二段保持不变");
    await appendToChapter(filePath, "evt_003", "第三段保持不变");

    // 重写 evt_001
    await modifyChapterSection(filePath, "evt_001", "新的第一段");

    const content = await readFile(filePath, "utf8");
    assert.ok(content.includes("新的第一段"), "应包含新文本");
    assert.ok(!content.includes("旧的第一段"), "不应包含旧文本");
    assert.ok(content.includes("第二段保持不变"), "后续段落应保留");
    assert.ok(content.includes("第三段保持不变"), "后续段落应保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("modifyChapterSection: 锚点不存在时抛错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "第一段");

    await assert.rejects(
      () => modifyChapterSection(filePath, "evt_999", "新文本"),
      /锚点.*未找到/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readChapterSection: 读取指定锚点区间文本", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "第一段");
    await appendToChapter(filePath, "evt_002", "第二段");
    await appendToChapter(filePath, "evt_003", "第三段");

    // 读取单个锚点
    const section1 = await readChapterSection(filePath, "evt_001");
    assert.ok(section1.includes("第一段"));
    assert.ok(!section1.includes("第二段"));

    // 读取区间
    const section12 = await readChapterSection(filePath, "evt_001", "evt_003");
    assert.ok(section12.includes("第一段"));
    assert.ok(section12.includes("第二段"));
    assert.ok(!section12.includes("第三段"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readChapterSection: 读取最新事件（无 endEventId）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "第一段");
    await appendToChapter(filePath, "evt_002", "第二段");

    // 读取从 evt_002 到末尾
    const section = await readChapterSection(filePath, "evt_002");
    assert.ok(section.includes("第二段"));
    assert.ok(!section.includes("第一段"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============ 🟠-13 append 防重（2026-08-08） ============

test("appendToChapter: 同 eventId 重复追加拒绝（🟠-13）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    await appendToChapter(filePath, "evt_001", "第一段\n");
    await assert.rejects(
      () => appendToChapter(filePath, "evt_001", "重复追加"),
      /拒绝重复追加/,
      "同 eventId 二次追加应拒绝（防双锚点孤儿区块）",
    );
    // 文件内容不变（未追加第二个锚点）
    const content = await readFile(filePath, "utf8");
    assert.equal(content.split("<!-- event: evt_001 -->").length - 1, 1, "应只有一个锚点");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendToChapter: 畸形 eventId 拒绝（🟠-13 审计修正）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "第1章-测试.md");
    await ensureChapterFile(filePath);
    // 含 " -->" 的畸形 ID 可伪造锚点子串绕过防重守卫——格式校验必须拦截
    await assert.rejects(
      () => appendToChapter(filePath, 'evt_001 -->"', "x"),
      /非法事件 ID/,
    );
    await assert.rejects(
      () => appendToChapter(filePath, "没有前缀", "x"),
      /非法事件 ID/,
      "非 evt_ 前缀应拒绝",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
