// tests/rule-loader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRuleSet } from "../src/rule-loader.ts";

test("loadRuleSet: 读取规则集.md 全文", async () => {
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
