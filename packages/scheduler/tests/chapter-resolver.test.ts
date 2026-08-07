// tests/chapter-resolver.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveChapterPath } from "../src/chapter-resolver.ts";

// 🟠-22（2026-08-08）：storyTime 只接受引擎统一格式 ch<NNN>.ev<MMM>
// （ch-N 口述格式已废弃；解析失败抛错而非兜底第 1 章）

test("resolveChapterPath: 导入器格式 ch009.ev003 取章节号（审计 Q3）", () => {
  const p = resolveChapterPath("D:/novel", "ch009.ev003");
  assert.equal(p, path.join("D:/novel", "正文", "第9章-未命名.md"));
});

test("resolveChapterPath: 导入器格式 ch001.ev021", () => {
  const p = resolveChapterPath("D:/novel", "ch001.ev021");
  assert.equal(p, path.join("D:/novel", "正文", "第1章-未命名.md"));
});

test("resolveChapterPath: 大数字章节 ch100.ev001", () => {
  const p = resolveChapterPath("D:/novel", "ch100.ev001");
  assert.equal(p, path.join("D:/novel", "正文", "第100章-未命名.md"));
});

test("resolveChapterPath: 相对 cwd 路径", () => {
  const p = resolveChapterPath(".", "ch003.ev001");
  assert.equal(p, path.join(".", "正文", "第3章-未命名.md"));
});

test("resolveChapterPath: 跨平台路径分隔符（win 反斜杠 cwd）", () => {
  const p = resolveChapterPath("D:\\novel", "ch005.ev001");
  // path.join 会按当前平台规范化（win 上是反斜杠，posix 是正斜杠）
  assert.ok(p.includes("第5章-未命名.md"));
});

// 🟠-22：废弃格式与非法输入一律抛错（不静默兜底污染 第1章-未命名.md）

test("resolveChapterPath: ch-N 口述格式拒绝（🟠-22）", () => {
  assert.throws(() => resolveChapterPath("D:/novel", "ch-2"), /非法 storyTime/);
  assert.throws(() => resolveChapterPath("D:/novel", "ch-1"), /非法 storyTime/);
});

test("resolveChapterPath: 非法/空 storyTime 抛错而非兜底（🟠-22）", () => {
  assert.throws(() => resolveChapterPath("D:/novel", "invalid"), /非法 storyTime/);
  assert.throws(() => resolveChapterPath("D:/novel", ""), /非法 storyTime/);
  assert.throws(() => resolveChapterPath("D:/novel", "ch009"), /非法 storyTime/);
  // 旧正则曾接受的无连字符形式（ch2）与 ch-N 一样拒绝
  assert.throws(() => resolveChapterPath("D:/novel", "ch2"), /非法 storyTime/);
});

test("resolveChapterPath: 章号越界拒绝（🟠-22 审计修正）", () => {
  assert.throws(() => resolveChapterPath("D:/novel", "ch000.ev001"), /章号越界/, "ch000 应拒绝（防第0章错文件）");
  assert.throws(() => resolveChapterPath("D:/novel", "ch1000.ev001"), /非法 storyTime/, "4 位章号格式非法");
});

test("resolveChapterPath: 上限边界 ch999 通过", () => {
  const p = resolveChapterPath("D:/novel", "ch999.ev999");
  assert.equal(p, path.join("D:/novel", "正文", "第999章-未命名.md"));
});
