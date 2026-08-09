// packages/admin/tests/rulesets.test.ts
/**
 * rulesets.ts 测试（v3 D9/D11：规则集迁入 规则集/ 文件夹，style/check/custom 三件）
 *
 * 覆盖：
 * - readAllRulesets: 全部读取/文件不存在返回空内容
 * - readRuleset: 单个读取
 * - writeRuleset: 写入（自动建 规则集/ 目录）/原子写/返回 mtime
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
  style: "文风规则内容",
  check: "检查规则内容",
  custom: "自定义规则内容",
};

const RULESET_FILES = {
  style: join("规则集", "文风规则.md"),
  check: join("规则集", "检查规则.md"),
  custom: join("规则集", "自定义规则.md"),
};

/** 在临时项目里创建 规则集/ 目录并写入文件 */
async function writeRulesetFile(dir: string, name: keyof typeof RULESET_FILES, content: string): Promise<void> {
  await mkdir(join(dir, "规则集"), { recursive: true });
  await writeFile(join(dir, RULESET_FILES[name]), content, "utf8");
}

test("RULESET_NAMES: 顺序固定为 [style, check, custom]", () => {
  assert.deepEqual([...RULESET_NAMES], ["style", "check", "custom"]);
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

test("readAllRulesets: 读取存在的文件（规则集/ 子目录）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeRulesetFile(dir, "style", RULESET_CONTENT.style);
    await writeRulesetFile(dir, "check", RULESET_CONTENT.check);
    await writeRulesetFile(dir, "custom", RULESET_CONTENT.custom);
    const result = await readAllRulesets(dir);
    assert.equal(result.length, 3);
    const style = result.find((r) => r.name === "style")!;
    assert.equal(style.exists, true);
    assert.equal(style.content, RULESET_CONTENT.style);
    assert.equal(style.charCount, RULESET_CONTENT.style.length);
    assert.ok(style.mtime);
    assert.equal(style.filename, join("规则集", "文风规则.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRuleset: 单个读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeRulesetFile(dir, "custom", RULESET_CONTENT.custom);
    const r = await readRuleset(dir, "custom");
    assert.equal(r.content, RULESET_CONTENT.custom);
    assert.equal(r.name, "custom");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRuleset: 自动创建规则集/ 目录并写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    const result = await writeRuleset(dir, "style", "新内容");
    assert.equal(result.exists, true);
    assert.equal(result.content, "新内容");
    assert.ok(result.mtime);
    // 再次写入同一文件，mtime 应更新（或至少不报错）
    const result2 = await writeRuleset(dir, "style", "更新内容");
    assert.equal(result2.content, "更新内容");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRuleset: 覆盖已存在文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-rulesets-"));
  try {
    await writeRulesetFile(dir, "style", "旧内容");
    const result = await writeRuleset(dir, "style", "新内容");
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
    // 准备模板（templates/novel/规则集/文风规则.md）
    await mkdir(join(templatesDir, "规则集"), { recursive: true });
    await writeFile(
      join(templatesDir, "规则集", "文风规则.md"),
      "模板内容：文风规则",
      "utf8",
    );
    // 重置
    const result = await resetRuleset({ novelDir, templatesDir }, "style");
    assert.equal(result.exists, true);
    assert.equal(result.content, "模板内容：文风规则");
    // 原文件已被覆盖
    const r2 = await readRuleset(novelDir, "style");
    assert.equal(r2.content, "模板内容：文风规则");
  } finally {
    await rm(novelDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  }
});

test("resetRuleset: 模板不存在抛 TEMPLATE_NOT_FOUND", async () => {
  const novelDir = await mkdtemp(join(tmpdir(), "admin-novel-"));
  const templatesDir = await mkdtemp(join(tmpdir(), "admin-templates-"));
  try {
    // 模板目录为空，没有 规则集/文风规则.md
    await assert.rejects(
      () => resetRuleset({ novelDir, templatesDir }, "style"),
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
    await writeRulesetFile(novelDir, "style", "用户修改后的内容");
    await mkdir(join(templatesDir, "规则集"), { recursive: true });
    await writeFile(join(templatesDir, "规则集", "文风规则.md"), "模板原版", "utf8");
    const result = await resetRuleset({ novelDir, templatesDir }, "style");
    assert.equal(result.content, "模板原版");
  } finally {
    await rm(novelDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  }
});
