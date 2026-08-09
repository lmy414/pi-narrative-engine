// tests/rule-loader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRuleSet, loadStyleRuleSet, loadCheckRuleSet } from "../src/rule-loader.ts";

test("loadRuleSet: 读取规则集.md 全文（旧名兼容）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const content = "# 规则集\n\n文风偏古典武侠，白描为主。\n禁止现代词汇。\n";
    await writeFile(path.join(dir, "规则集.md"), content, "utf8");

    const result = await loadRuleSet(dir);
    assert.equal(result, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRuleSet: 文件不存在时返回空字符串", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const result = await loadRuleSet(dir);
    assert.equal(result, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRuleSet: 不缓存，每次重读", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const filePath = path.join(dir, "规则集.md");
    await writeFile(filePath, "版本1", "utf8");
    const r1 = await loadRuleSet(dir);
    await writeFile(filePath, "版本2", "utf8");
    const r2 = await loadRuleSet(dir);
    assert.equal(r1, "版本1");
    assert.equal(r2, "版本2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// v3（2026-08-09，D9）：规则集拆分——文风规则.md / 检查规则.md（规则集/ 目录）

test("loadStyleRuleSet: 读取规则集/文风规则.md", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    await mkdir(path.join(dir, "规则集"), { recursive: true });
    const content = "# 文风规则\n\n白描为主，对话简洁。";
    await writeFile(path.join(dir, "规则集", "文风规则.md"), content, "utf8");
    assert.equal(await loadStyleRuleSet(dir), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStyleRuleSet: 新位置缺失时兼容回退旧 规则集.md", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    const content = "# 旧版规则集\n- 白描";
    await writeFile(path.join(dir, "规则集.md"), content, "utf8");
    assert.equal(await loadStyleRuleSet(dir), content, "旧项目（仅 规则集.md）应回退读取");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStyleRuleSet: 新位置优先于旧位置", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    await mkdir(path.join(dir, "规则集"), { recursive: true });
    await writeFile(path.join(dir, "规则集", "文风规则.md"), "新文风", "utf8");
    await writeFile(path.join(dir, "规则集.md"), "旧文风", "utf8");
    assert.equal(await loadStyleRuleSet(dir), "新文风");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCheckRuleSet: 读取规则集/检查规则.md", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    await mkdir(path.join(dir, "规则集"), { recursive: true });
    const content = "# 检查规则\n\n不得重复形容词。";
    await writeFile(path.join(dir, "规则集", "检查规则.md"), content, "utf8");
    assert.equal(await loadCheckRuleSet(dir), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCheckRuleSet: 文件不存在时返回空字符串", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renderer-test-"));
  try {
    assert.equal(await loadCheckRuleSet(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
