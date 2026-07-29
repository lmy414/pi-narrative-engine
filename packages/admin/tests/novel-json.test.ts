// packages/admin/tests/novel-json.test.ts
/**
 * novel-json.ts 测试
 *
 * 覆盖：
 * - _normalizeNovelJson: 缺失字段填默认值、name 回退 basename、未知字段保留
 * - readNovelJson: 文件不存在/正常读取/JSON 解析失败
 * - writeNovelJson: 文件不存在创建/合并写/原子写
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

import {
  readNovelJson,
  writeNovelJson,
  _normalizeNovelJson,
  AdminError,
} from "../src/index.ts";

test("_normalizeNovelJson: 缺失字段填默认值", () => {
  const result = _normalizeNovelJson({ name: "我的小说" }, "/tmp/project");
  assert.equal(result.name, "我的小说");
  assert.equal(result.engine, "narrative-engine");
  assert.equal(result.engineVersion, "0.1.0");
  assert.equal(result.worldGraphDir, ".pi/world-graph-v3");
  assert.equal(result.chaptersDir, "正文");
  assert.equal(result.storyTimeFormat, "ch{NNN}.ev{NNN}");
  assert.equal(result.createdAt, "");
});

test("_normalizeNovelJson: name 缺失回退目录 basename", () => {
  const result = _normalizeNovelJson({}, "/tmp/my-project");
  assert.equal(result.name, "my-project");
  assert.equal(basename("/tmp/my-project"), "my-project");
});

test("_normalizeNovelJson: 类型不匹配回退默认值", () => {
  const result = _normalizeNovelJson(
    { name: 123, engine: null, engineVersion: [] },
    "/tmp/p",
  );
  assert.equal(result.name, "p", "name 非字符串回退 basename");
  assert.equal(result.engine, "narrative-engine");
  assert.equal(result.engineVersion, "0.1.0");
});

test("_normalizeNovelJson: 保留未知字段", () => {
  const result = _normalizeNovelJson(
    { name: "P", customField: "extra", chapters: 10 },
    "/tmp/p",
  );
  assert.equal(result.customField, "extra");
  assert.equal(result.chapters, 10);
});

test("readNovelJson: 文件不存在返回 exists=false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    const result = await readNovelJson(dir);
    assert.equal(result.exists, false);
    assert.equal(result.data, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNovelJson: 正常读取并填默认值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    await writeFile(
      join(dir, "novel.json"),
      JSON.stringify({ name: "测试小说", createdAt: "2026-07-29" }),
      "utf8",
    );
    const result = await readNovelJson(dir);
    assert.equal(result.exists, true);
    assert.equal(result.data!.name, "测试小说");
    assert.equal(result.data!.createdAt, "2026-07-29");
    assert.equal(result.data!.engine, "narrative-engine");
    assert.equal(result.data!.chaptersDir, "正文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNovelJson: 非法 JSON 抛 INVALID_NOVEL_JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    await writeFile(join(dir, "novel.json"), "{ not json", "utf8");
    await assert.rejects(
      () => readNovelJson(dir),
      (err: Error) => err instanceof AdminError && err.code === "INVALID_NOVEL_JSON",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNovelJson: 顶层非对象抛 INVALID_NOVEL_JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    await writeFile(join(dir, "novel.json"), "[1,2,3]", "utf8");
    await assert.rejects(
      () => readNovelJson(dir),
      (err: Error) => err instanceof AdminError && err.code === "INVALID_NOVEL_JSON",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeNovelJson: 文件不存在时创建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    const result = await writeNovelJson(dir, { name: "新小说" });
    assert.equal(result.name, "新小说");
    assert.equal(result.engine, "narrative-engine");
    const content = await readFile(join(dir, "novel.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.name, "新小说");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeNovelJson: 已存在文件合并写", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    await writeFile(
      join(dir, "novel.json"),
      JSON.stringify({ name: "旧名", engine: "narrative-engine", engineVersion: "0.1.0" }),
      "utf8",
    );
    const result = await writeNovelJson(dir, { name: "新名", chaptersDir: "新正文" });
    assert.equal(result.name, "新名");
    assert.equal(result.chaptersDir, "新正文");
    assert.equal(result.engine, "narrative-engine", "未更新字段保留");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeNovelJson: name 缺失时用目录 basename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  try {
    const result = await writeNovelJson(dir, {});
    assert.equal(result.name, basename(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
