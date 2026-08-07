// tests/chapter-edit.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { insertChapterSection } from "../src/chapter-edit.ts";
import {
  ensureChapterFile,
  _appendToChapter,
  CHAPTER_VERSION_MARKER,
} from "@pi/renderer";

let tmpDir: string;
let chapterPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chapter-edit-test-"));
  chapterPath = path.join(tmpDir, "第1章-测试.md");
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

/**
 * 构造一个含 3 个事件锚点的章节文件：
 *   <!-- engine v0.01 -->
 *   <!-- event: evt_001 --> ... <!-- event: evt_002 --> ... <!-- event: evt_003 --> ...
 */
async function makeChapterWith3Events(): Promise<void> {
  await ensureChapterFile(chapterPath);
  await _appendToChapter(chapterPath, "evt_001", "第一段正文。");
  await _appendToChapter(chapterPath, "evt_002", "第二段正文。");
  await _appendToChapter(chapterPath, "evt_003", "第三段正文。");
}

test("insertChapterSection: 文件不存在时自动创建", async () => {
  // afterEventId 在新建文件中肯定找不到，但应先尝试建文件再报"锚点未找到"
  await assert.rejects(
    () => insertChapterSection(chapterPath, "evt_001", "evt_new", "新内容"),
    /锚点/,
  );
  // 文件应已被 ensureChapterFile 创建
  const content = await readFile(chapterPath, "utf8");
  assert.equal(content.trim(), CHAPTER_VERSION_MARKER);
});

test("insertChapterSection: 在末尾锚点之后插入（无下一锚点）", async () => {
  await makeChapterWith3Events();
  await insertChapterSection(
    chapterPath,
    "evt_003",
    "evt_new",
    "这是新插入的段落。",
  );

  const content = await readFile(chapterPath, "utf8");
  // 新锚点应在 evt_003 之后
  const idx003 = content.indexOf("<!-- event: evt_003 -->");
  const idxNew = content.indexOf("<!-- event: evt_new -->");
  assert.ok(idx003 > -1, "evt_003 锚点应存在");
  assert.ok(idxNew > idx003, "新锚点应在 evt_003 之后");
  assert.ok(content.includes("这是新插入的段落。"));
});

test("insertChapterSection: 在中间锚点之后插入（有下一锚点）", async () => {
  await makeChapterWith3Events();
  await insertChapterSection(
    chapterPath,
    "evt_001",
    "evt_new",
    "插在第一段和第二段之间。",
  );

  const content = await readFile(chapterPath, "utf8");
  const idx001 = content.indexOf("<!-- event: evt_001 -->");
  const idxNew = content.indexOf("<!-- event: evt_new -->");
  const idx002 = content.indexOf("<!-- event: evt_002 -->");

  assert.ok(idx001 > -1);
  assert.ok(idxNew > idx001, "新锚点应在 evt_001 之后");
  assert.ok(idx002 > idxNew, "evt_002 应在新锚点之后");
  assert.ok(content.includes("插在第一段和第二段之间。"));
  assert.ok(content.includes("第二段正文。"), "原有 evt_002 正文应保留");
});

test("insertChapterSection: 锚点不存在时抛错", async () => {
  await makeChapterWith3Events();
  await assert.rejects(
    () => insertChapterSection(chapterPath, "evt_not_exist", "evt_new", "新内容"),
    /evt_not_exist/,
  );
});

test("insertChapterSection: 文本末尾无换行时自动补换行", async () => {
  await makeChapterWith3Events();
  await insertChapterSection(
    chapterPath,
    "evt_003",
    "evt_new",
    "无换行结尾的文本", // 故意不带 \n
  );
  const content = await readFile(chapterPath, "utf8");
  // 新锚点 + 正文 + 换行 应正确写入
  assert.ok(content.includes("<!-- event: evt_new -->\n\n无换行结尾的文本\n"));
});

test("insertChapterSection: 多次连续插入保持锚点顺序", async () => {
  await makeChapterWith3Events();
  // 第一次在 evt_001 后插
  await insertChapterSection(chapterPath, "evt_001", "evt_a", "A段");
  // 第二次在 evt_a 后插
  await insertChapterSection(chapterPath, "evt_a", "evt_b", "B段");

  const content = await readFile(chapterPath, "utf8");
  const idx001 = content.indexOf("<!-- event: evt_001 -->");
  const idxA = content.indexOf("<!-- event: evt_a -->");
  const idxB = content.indexOf("<!-- event: evt_b -->");
  const idx002 = content.indexOf("<!-- event: evt_002 -->");

  assert.ok(idx001 < idxA, "evt_a 应在 evt_001 之后");
  assert.ok(idxA < idxB, "evt_b 应在 evt_a 之后");
  assert.ok(idxB < idx002, "evt_002 应在 evt_b 之后");
});

test("insertChapterSection: 不影响其他锚点区间的内容", async () => {
  await makeChapterWith3Events();
  await insertChapterSection(chapterPath, "evt_001", "evt_new", "新插入内容");

  const content = await readFile(chapterPath, "utf8");
  assert.ok(content.includes("第一段正文。"), "evt_001 正文应保留");
  assert.ok(content.includes("第二段正文。"), "evt_002 正文应保留");
  assert.ok(content.includes("第三段正文。"), "evt_003 正文应保留");
});

// ============ 🟠-21 并发写锁（2026-08-08） ============

test("insertChapterSection: 同文件并发插入双区块共存（🟠-21）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  try {
    const filePath = path.join(dir, "第1章.md");
    await writeFile(
      filePath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", ""].join("\n"),
      "utf8",
    );
    // 两个并发 insert（基于同一初始内容）——per-file 锁保证串行读-改-写
    await Promise.all([
      insertChapterSection(filePath, "evt_001", "evt_002", "第二段。"),
      insertChapterSection(filePath, "evt_001", "evt_003", "第三段。"),
    ]);
    const content = await readFile(filePath, "utf8");
    assert.ok(content.includes("<!-- event: evt_002 -->"), "evt_002 锚点应保留");
    assert.ok(content.includes("<!-- event: evt_003 -->"), "evt_003 锚点应保留");
    assert.ok(content.includes("第二段。") && content.includes("第三段。"), "两区块正文都应保留（无覆盖丢失）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insertChapterSection: 失败 insert 不断链（🟠-21）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  try {
    const filePath = path.join(dir, "第1章.md");
    await writeFile(
      filePath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", ""].join("\n"),
      "utf8",
    );
    // 失败的 insert（锚点不存在）与成功的 insert 并发——失败不阻塞后续
    await Promise.all([
      insertChapterSection(filePath, "evt_nonexistent", "evt_bad", "坏").catch(() => "failed"),
      insertChapterSection(filePath, "evt_001", "evt_002", "第二段。"),
    ]);
    const content = await readFile(filePath, "utf8");
    assert.ok(content.includes("<!-- event: evt_002 -->"), "失败后成功 insert 仍应落地");
    assert.ok(!content.includes("<!-- event: evt_bad -->"), "失败 insert 不应写入");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insertChapterSection: 与 renderer append 并发（跨模块共享锁）双写入共存（🟠-21）", async () => {  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  try {
    const filePath = path.join(dir, "第1章.md");
    await writeFile(
      filePath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", ""].join("\n"),
      "utf8",
    );
    // insert（scheduler 锁）与 append（renderer 锁）并发——共享同一 per-path 锁，
    // 修复前：后写者基于旧内容整体覆盖，先写者区块静默丢失
    await Promise.all([
      insertChapterSection(filePath, "evt_001", "evt_002", "第二段。"),
      _appendToChapter(filePath, "evt_003", "第三段。"),
    ]);
    const content = await readFile(filePath, "utf8");
    assert.ok(content.includes("<!-- event: evt_002 -->"), "insert 区块应保留");
    assert.ok(content.includes("<!-- event: evt_003 -->"), "append 区块应保留");
    assert.ok(content.includes("第二段。") && content.includes("第三段。"), "双区块正文共存（无覆盖丢失）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insertChapterSection: 混合路径拼写（正/反斜杠）共享同一锁链（🟠-21 审计修正）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  try {
    const filePath = path.join(dir, "第1章.md");
    await writeFile(
      filePath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", ""].join("\n"),
      "utf8",
    );
    // 正斜杠与反斜杠拼写指向同一文件——锁键归一化后落入同一锁链（串行）
    const posixPath = filePath.replaceAll(path.sep, "/");
    await Promise.all([
      insertChapterSection(posixPath, "evt_001", "evt_002", "第二段。"),
      insertChapterSection(filePath, "evt_001", "evt_003", "第三段。"),
    ]);
    const content = await readFile(filePath, "utf8");
    assert.ok(content.includes("<!-- event: evt_002 -->"), "正斜杠拼写 insert 应保留");
    assert.ok(content.includes("<!-- event: evt_003 -->"), "反斜杠拼写 insert 应保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("insertChapterSection: 重复锚点/新 ID 防重（🟡 4c 审计修正）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  try {
    const dupPath = path.join(dir, "第1章.md");
    await writeFile(
      dupPath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", "", "<!-- event: evt_001 -->", "", "重复锚点。", ""].join("\n"),
      "utf8",
    );
    // afterEventId 锚点重复 → 拒绝（indexOf 首处错位防护）
    await assert.rejects(
      () => insertChapterSection(dupPath, "evt_001", "evt_002", "第二段。"),
      /重复出现/,
    );

    // 新 ID 已存在 → 拒绝（双锚点孤儿防护）：文件中 evt_001 唯一 + evt_002 已存在
    const dupIdPath = path.join(dir, "第2章.md");
    await writeFile(
      dupIdPath,
      ["<!-- engine v0.01 -->", "", "<!-- event: evt_001 -->", "", "第一段。", "", "<!-- event: evt_002 -->", "", "既有段。", ""].join("\n"),
      "utf8",
    );
    await assert.rejects(
      () => insertChapterSection(dupIdPath, "evt_001", "evt_002", "重复 ID"),
      /已在章节中存在锚点/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
