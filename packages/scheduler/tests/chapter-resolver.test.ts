// tests/chapter-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveChapterPath } from "../src/chapter-resolver.ts";

test("resolveChapterPath: 标准 ch-N 格式", () => {
  const p = resolveChapterPath("D:/novel", "ch-2");
  assert.equal(p, path.join("D:/novel", "正文", "第2章-未命名.md"));
});

test("resolveChapterPath: ch-1 第一卷", () => {
  const p = resolveChapterPath("D:/novel", "ch-1");
  assert.equal(p, path.join("D:/novel", "正文", "第1章-未命名.md"));
});

test("resolveChapterPath: 大数字 ch-100", () => {
  const p = resolveChapterPath("D:/novel", "ch-100");
  assert.equal(p, path.join("D:/novel", "正文", "第100章-未命名.md"));
});

test("resolveChapterPath: 非 ch-N 格式兜底为第1章", () => {
  const p = resolveChapterPath("D:/novel", "invalid");
  assert.equal(p, path.join("D:/novel", "正文", "第1章-未命名.md"));
});

test("resolveChapterPath: 空字符串兜底为第1章", () => {
  const p = resolveChapterPath("D:/novel", "");
  assert.equal(p, path.join("D:/novel", "正文", "第1章-未命名.md"));
});

test("resolveChapterPath: 相对 cwd 路径", () => {
  const p = resolveChapterPath(".", "ch-3");
  assert.equal(p, path.join(".", "正文", "第3章-未命名.md"));
});

test("resolveChapterPath: 跨平台路径分隔符（win 反斜杠 cwd）", () => {
  const p = resolveChapterPath("D:\\novel", "ch-5");
  // path.join 会按当前平台规范化（win 上是反斜杠，posix 是正斜杠）
  assert.ok(p.includes("第5章-未命名.md"));
});
