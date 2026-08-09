// packages/admin/tests/doctor.test.ts
/**
 * doctor.ts 测试
 *
 * 覆盖：
 * - _checkNodeVersion: 当前版本通过
 * - _checkNativeBindings: 真实环境（本仓库已装原生绑定）
 * - _checkTemplates: 模板目录存在
 * - _checkEmbedderEnv: 缓存存在/镜像配置/无缓存
 * - _checkNovelStructure: 工程结构检查
 * - runDoctor: 综合报告统计正确
 * - formatDoctorReport: 文本格式
 *
 * （pi CLI 版本探测、dist/ 产物、.pi/extensions/ 布局检查已随 pure-SDK 迁移移除）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  runDoctor,
  formatDoctorReport,
  _checkNodeVersion,
  _checkNativeBindings,
  _checkTemplates,
  _checkEmbedderEnv,
  _checkNovelStructure,
} from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", ".."); // narrative-engine/

// ---------------------------------------------------------------------------

test("_checkNodeVersion: 当前 Node 通过", () => {
  const r = _checkNodeVersion();
  assert.equal(r.status, "pass");
  assert.ok(r.message.includes(process.version));
});

test("_checkNativeBindings: 在仓库根目录运行（应通过或 fail，不抛错）", () => {
  // 真实环境：仓库已装 better-sqlite3 等
  const checks = _checkNativeBindings(repoRoot);
  assert.equal(checks.length, 3);
  for (const c of checks) {
    assert.ok(["pass", "fail"].includes(c.status));
  }
});

test("_checkTemplates: 仓库 templates 存在", () => {
  const r = _checkTemplates(repoRoot);
  assert.equal(r.status, "pass");
  assert.ok(r.message.includes("模板文件"));
});

test("_checkEmbedderEnv: 临时目录无缓存 warn 或镜像 pass", async () => {
  // 临时目录无缓存，行为取决于 HF_ENDPOINT 是否设置
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    const r = _checkEmbedderEnv(dir);
    assert.ok(["pass", "warn"].includes(r.status));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkEmbedderEnv: 本地缓存命中 pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    const cacheDir = join(dir, "node_modules", "@xenova", "transformers", ".cache", "Xenova");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "model.onnx"), "fake", "utf8");
    const r = _checkEmbedderEnv(dir);
    assert.equal(r.status, "pass");
    assert.ok(r.message.includes("模型已缓存"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkNovelStructure: 完整工程结构", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    // 创建完整工程结构（v3：小说.json + 规则集/ 三件）
    await writeFile(join(dir, "小说.json"), "{}", "utf8");
    await mkdir(join(dir, "规则集"), { recursive: true });
    await writeFile(join(dir, "规则集", "文风规则.md"), "style", "utf8");
    await writeFile(join(dir, "规则集", "检查规则.md"), "check", "utf8");
    await writeFile(join(dir, "规则集", "自定义规则.md"), "custom", "utf8");
    await mkdir(join(dir, "正文"), { recursive: true });
    await mkdir(join(dir, ".pi", "world-graph-v3"), { recursive: true });
    await writeFile(join(dir, ".pi", "world-graph-v3", "world.db"), "fake", "utf8");

    const checks = await _checkNovelStructure(dir);
    assert.equal(checks.length, 6);
    const passed = checks.filter((c) => c.status === "pass");
    assert.equal(passed.length, 6, "完整工程应 6 项全 pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkNovelStructure: 空目录所有项 warn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    const checks = await _checkNovelStructure(dir);
    assert.equal(checks.length, 6);
    const passed = checks.filter((c) => c.status === "pass");
    assert.equal(passed.length, 0, "空目录无任何 pass");
    const warned = checks.filter((c) => c.status === "warn");
    assert.equal(warned.length, 6, "缺失项均为 warn（不阻断）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDoctor: 仓库自身（不传 novelDir）", async () => {
  const report = await runDoctor({ repoRoot });
  // node 1 + native 3 + templates 1 + embedder-env 1 = 6
  assert.equal(report.checks.length, 6);
  assert.equal(report.checks.length, report.passed + report.failures + report.warnings);
  const tplCheck = report.checks.find((c) => c.id === "templates");
  assert.equal(tplCheck!.status, "pass");
});

test("runDoctor: novelDir 提供时含工程结构检查", async () => {
  const novelDir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    await writeFile(join(novelDir, "小说.json"), "{}", "utf8");
    const report = await runDoctor({ repoRoot, novelDir });
    const novelChecks = report.checks.filter((c) => c.id.startsWith("novel-"));
    assert.equal(novelChecks.length, 6);
    const novelJsonCheck = report.checks.find((c) => c.id === "novel-小说.json");
    assert.equal(novelJsonCheck!.status, "pass");
  } finally {
    await rm(novelDir, { recursive: true, force: true });
  }
});

test("formatDoctorReport: 含状态图标与统计行", async () => {
  const report = await runDoctor({ repoRoot });
  const text = formatDoctorReport(report);
  assert.ok(text.includes("✅") || text.includes("❌") || text.includes("⚠️"));
  assert.ok(text.includes("═"));
});

test("formatDoctorReport: 全部通过时显示 🎉", () => {
  const report = {
    checks: [{ id: "x", name: "X", status: "pass" as const, message: "ok" }],
    failures: 0,
    warnings: 0,
    passed: 1,
    ok: true,
  };
  const text = formatDoctorReport(report);
  assert.ok(text.includes("🎉"));
});
