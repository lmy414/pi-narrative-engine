import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoleRuleSet } from "../src/rule-loader.ts";

// v3（2026-08-09，D8）：角色规则集收回引擎自维护——loader 退位恒返回空串
// （角色扮演规则固化进 prompts.ts 的 BUILTIN_ROLE_RULES，不再读取外部文件）

test("loadRoleRuleSet: 恒返回空串（D8 收回引擎自维护）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-pool-test-"));
  try {
    const content = await loadRoleRuleSet(dir);
    assert.equal(content, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadRoleRuleSet: 残留的角色规则集.md 不再被读取", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "role-pool-test-"));
  try {
    await writeFile(
      path.join(dir, "角色规则集.md"),
      "# 角色规则集\n\n## 扮演原则\n- 第一人称思考",
      "utf8",
    );
    const content = await loadRoleRuleSet(dir);
    assert.equal(content, "", "文件残留也应返回空（收回语义）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
