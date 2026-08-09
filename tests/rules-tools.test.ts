// tests/rules-tools.test.ts
/**
 * rules-tools.ts 测试（v3 D11 渐进披露，2026-08-09）
 *
 * 覆盖：
 * - listRules: 文件存在性 + 首行标题作简介
 * - formatRulesManifest: <available_rules> 清单（元数据，不含全文）
 * - createRulesReadTool: 读取成功 / 文件不存在返回 exists:false
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listRules,
  formatRulesManifest,
  createRulesReadTool,
} from "../src/agents/rules-tools.ts";

async function makeRulesDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, "规则集"), { recursive: true });
  await writeFile(
    path.join(dir, "规则集", "文风规则.md"),
    "# 文风规则\n\n白描为主，对话简洁。\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "规则集", "检查规则.md"),
    "# 检查规则\n\n不得重复形容词。\n",
    "utf8",
  );
}

test("listRules: 存在文件用首行标题作简介，缺失文件标 exists=false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rules-tools-"));
  try {
    await makeRulesDir(dir);
    const rules = await listRules(dir);
    assert.equal(rules.length, 3);

    const style = rules.find((r) => r.name === "文风规则")!;
    assert.equal(style.exists, true);
    assert.equal(style.summary, "文风规则", "简介应为首行标题（去 #）");
    assert.equal(style.rel, path.join("规则集", "文风规则.md"));

    const custom = rules.find((r) => r.name === "自定义规则")!;
    assert.equal(custom.exists, false, "未创建的自定义规则应标 exists=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatRulesManifest: 渐进披露清单只含元数据，不含规则全文", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rules-tools-"));
  try {
    await makeRulesDir(dir);
    const manifest = await formatRulesManifest(dir);
    assert.ok(manifest.includes("<available_rules>"), "应含 <available_rules> 起始标签");
    assert.ok(manifest.includes("<rule><name>文风规则</name>"), "应含规则名称+位置");
    assert.ok(manifest.includes("rules_read"), "应含按需读取引导");
    // 关键：清单不得泄露规则正文
    assert.ok(!manifest.includes("白描为主，对话简洁"), "清单不应含规则全文（渐进披露）");
    assert.ok(!manifest.includes("不得重复形容词"), "清单不应含检查规则全文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createRulesReadTool: 读取规则全文（按需披露落地）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rules-tools-"));
  try {
    await makeRulesDir(dir);
    const tool = createRulesReadTool(dir);
    const result = await tool.execute("call-1", { rule: "文风规则" } as never);
    assert.equal(result.details.exists, true);
    assert.ok((result.content[0] as { type: string; text: string }).text.includes("白描为主"), "应返回规则全文");
    assert.equal(result.details.rel, path.join("规则集", "文风规则.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createRulesReadTool: 文件不存在返回 exists=false 与提示", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rules-tools-"));
  try {
    const tool = createRulesReadTool(dir);
    const result = await tool.execute("call-1", { rule: "自定义规则" } as never);
    assert.equal(result.details.exists, false);
    assert.ok((result.content[0] as { type: string; text: string }).text.includes("不存在"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
