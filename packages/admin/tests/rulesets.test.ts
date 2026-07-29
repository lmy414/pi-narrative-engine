// packages/admin/tests/rulesets.test.ts
/**
 * rulesets.ts 测试
 *
 * 覆盖：
 * - readAllRulesets: 全部读取/文件不存在返回空内容
 * - readRuleset: 单个读取
 * - writeRuleset: 写入/原子写/返回 mtime
 * - resetRuleset: 从模板重置/模板不存在抛错
 * - RULESET_NAMES: 顺序固定
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readAllRulesets,
  readRuleset,
  writeRuleset,
  resetRuleset,
  RULESET_NAMES,
  AdminError,
} from "../src/index.ts";

const RULESET_CONTENT = {
  render: "渲染规则集内容",
  planner: "planner 规则集内容",
  role: "角色规则集内容",
};

const RULESET_FILES = {
  render: "规则集.md",
  planner: "planner 规则集.md",
  role: "角色规则集.md",
};

test("RULESET_NAMES: 顺序固定为 [render, planner, role]", () => {
  assert.deepEqual([...RULESET_NAMES], ["render", "planner", "role"]);
});

test("readAllRulesets: 全部文件不存在返回空内容", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    const result = await readAllRulesets(dir);
    assert.equal(result.length, 3);
    for (const r of result) {
      assert.equal(r.exists, false);
      assert.equal(r.content, "");
      assert.equal(r.mtime, null);
      assert.equal(r.charCount, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAllRulesets: 读取存在的文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeFile(join(dir, "规则集.md"), RULESET_CONTENT.render, "utf8");
    await writeFile(join(dir, "planner 规则集.md"), RULESET_CONTENT.planner, "utf8");
    await writeFile(join(dir, "角色规则集.md"), RULESET_CONTENT.role, "utf8");
    const result = await readAllRulesets(dir);
    assert.equal(result.length, 3);
    const render = result.find((r) => r.name === "render")!;
    assert.equal(render.exists, true);
    assert.equal(render.content, RULESET_CONTENT.render);
    assert.equal(render.charCount, RULESET_CONTENT.render.length);
    assert.ok(render.mtime);
    assert.equal(render.filename, "规则集.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRuleset: 单个读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeFile(join(dir, "角色规则集.md"), RULESET_CONTENT.role, "utf8");
    const r = await readRuleset(dir, "role");
    assert.equal(r.content, RULESET_CONTENT.role);
    assert.equal(r.name, "role");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRuleset: 写入并返回 mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    const result = await writeRuleset(dir, "render", "新内容");
    assert.equal(result.exists, true);
    assert.equal(result.content, "新内容");
    assert.ok(result.mtime);
    // 再次写入同一文件，mtime 应更新（或至少不报错）
    const result2 = await writeRuleset(dir, "render", "更新内容");
    assert.equal(result2.content, "更新内容");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRuleset: 覆盖已存在文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeFile(join(dir, "规则集.md"), "旧内容", "utf8");
    const result = await writeRuleset(dir, "render", "新内容");
    assert.equal(result.content, "新内容");
    assert.notEqual(result.content, "旧内容");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resetRuleset: 从模板重置", async () => {
  const novelDir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  const templatesDir = await mkdtemp(join(tmpdir(), "admin-templates-"));
  try {
    // 准备模板
    await writeFile(
      join(templatesDir, "规则集.md"),
      "模板内容：渲染规则集",
      "utf8",
    );
    // 重置
    const result = await resetRuleset({ novelDir, templatesDir }, "render");
    assert.equal(result.exists, true);
    assert.equal(result.content, "模板内容：渲染规则集");
    // 原文件已被覆盖
    const r2 = await readRuleset(novelDir, "render");
    assert.equal(r2.content, "模板内容：渲染规则集");
  } finally {
    await rm(novelDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  }
});

test("resetRuleset: 模板不存在抛 TEMPLATE_NOT_FOUND", async () => {
  const novelDir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  const templatesDir = await mkdtemp(join(tmpdir(), "admin-templates-"));
  try {
    // 模板目录为空，没有规则集.md
    await assert.rejects(
      () => resetRuleset({ novelDir, templatesDir }, "render"),
      (err: Error) => err instanceof AdminError && err.code === "TEMPLATE_NOT_FOUND",
    );
  } finally {
    await rm(novelDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  }
});

test("resetRuleset: 覆盖已存在的规则集文件", async () => {
  const novelDir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  const templatesDir = await mkdtemp(join(tmpdir(), "admin-templates-"));
  try {
    await writeFile(join(novelDir, "规则集.md"), "用户修改后的内容", "utf8");
    await writeFile(join(templatesDir, "规则集.md"), "模板原版", "utf8");
    const result = await resetRuleset({ novelDir, templatesDir }, "render");
    assert.equal(result.content, "模板原版");
  } finally {
    await rm(novelDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  }
});
