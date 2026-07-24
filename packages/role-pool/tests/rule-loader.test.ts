import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoleRuleSet } from "../src/rule-loader.ts";

test("loadRoleRuleSet: 读取角色规则集.md 全文", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-pool-test-"));
  try {
    await writeFile(path.join(dir, "角色规则集.md"), "# 角色规则集\n\n## 扮演原则\n- 第一人称思考", "utf8");
    const content = await loadRoleRuleSet(dir);
    assert.ok(content.includes("# 角色规则集"));
    assert.ok(content.includes("第一人称思考"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRoleRuleSet: 文件不存在时返回空字符串", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-pool-test-"));
  try {
    const content = await loadRoleRuleSet(dir);
    assert.equal(content, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRoleRuleSet: 空文件返回空字符串", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-pool-test-"));
  try {
    await writeFile(path.join(dir, "角色规则集.md"), "", "utf8");
    const content = await loadRoleRuleSet(dir);
    assert.equal(content, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
