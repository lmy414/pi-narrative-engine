// tests/path-guard.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { assertPathInside } from "../src/path-guard.ts";

const base = join(tmpdir(), "pg-base-" + Date.now());

test("assertPathInside: 相对路径在基准内放行", () => {
  const abs = assertPathInside(base, "chapters/ch001.md", "章节文件路径");
  assert.equal(abs, join(base, "chapters", "ch001.md"));
});

test("assertPathInside: 绝对路径在基准内放行", () => {
  const target = join(base, "chapters", "ch001.md");
  assert.equal(assertPathInside(base, target, "章节文件路径"), target);
});

test("assertPathInside: ../ 越界拒绝", () => {
  assert.throws(
    () => assertPathInside(base, `../outside.md`, "章节文件路径"),
    (err: Error & { code?: string }) => err.code === "PATH_ESCAPE",
  );
});

test("assertPathInside: 绝对路径越界拒绝", () => {
  const target = join(base, "..", "outside", "x.md");
  assert.throws(
    () => assertPathInside(base, target, "章节文件路径"),
    (err: Error & { code?: string }) => err.code === "PATH_ESCAPE",
  );
});

test("assertPathInside: 含 .. 但仍在基准内的路径放行", () => {
  const target = join(base, "a", "b", "..", "c.md");
  const abs = assertPathInside(base, target, "章节文件路径");
  assert.equal(abs, join(base, "a", "c.md"));
});

test("assertPathInside: 基准本身命中放行", () => {
  assert.equal(assertPathInside(base, base, "章节文件路径"), base);
});

test("assertPathInside: 同级兄弟目录路径拒绝", () => {
  const sibling = join(base + "-sibling", "x.md");
  assert.throws(
    () => assertPathInside(base, sibling, "章节文件路径"),
    (err: Error & { code?: string }) => err.code === "PATH_ESCAPE",
  );
});

test("assertPathInside: Windows 反斜杠 ../ 越界拒绝（win32 语义，POSIX 按字面文件名放行）", () => {
  if (process.platform === "win32") {
    assert.throws(
      () => assertPathInside(base, `..\\outside.md`, "章节文件路径"),
      (err: Error & { code?: string }) => err.code === "PATH_ESCAPE",
    );
  } else {
    // POSIX：反斜杠是合法文件名字符，`..\outside.md` 为基准内字面文件名，放行属正确行为
    const abs = assertPathInside(base, `..\\outside.md`, "章节文件路径");
    assert.equal(abs, join(base, `..\\outside.md`));
  }
});

test("assertPathInside: sep 前缀混淆（base+sep 开头）不误伤兄弟目录", () => {
  const decoy = join(base, "..", "pg-base-" + Date.now() + "suffix", "x.md");
  assert.throws(
    () => assertPathInside(base, decoy, "章节文件路径"),
    (err: Error & { code?: string }) => err.code === "PATH_ESCAPE",
  );
});
