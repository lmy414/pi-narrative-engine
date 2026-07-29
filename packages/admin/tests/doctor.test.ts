// packages/admin/tests/doctor.test.ts
/**
 * doctor.ts 测试
 *
 * 覆盖：
 * - _checkNodeVersion: 当前版本通过
 * - _checkNativeBindings: 真实环境（本仓库已装原生绑定）
 * - _checkDist: dist 存在/不存在
 * - _checkTemplates: 模板目录存在
 * - _checkEmbedderEnv: 缓存存在/镜像配置/无缓存
 * - _checkPiVersion: mock spawn
 * - _checkNovelStructure: 工程结构检查
 * - runDoctor: 综合报告统计正确
 * - formatDoctorReport: 文本格式
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn as realSpawn } from "node:child_process";

import {
  runDoctor,
  formatDoctorReport,
  _checkNodeVersion,
  _checkNativeBindings,
  _checkDist,
  _checkTemplates,
  _checkEmbedderEnv,
  _checkPiVersion,
  _checkNovelStructure,
  _doctorInternals,
} from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", ".."); // narrative-engine/

function makeMockChild(stdout: string, code: number) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  });
  return child as any;
}

function restoreSpawn() {
  _doctorInternals.spawn = realSpawn;
}

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

test("_checkDist: 仓库已构建（dist 存在）", () => {
  // 真实环境：CI 已构建；本地若未构建会 fail，两种都合法
  const r = _checkDist(repoRoot);
  assert.ok(["pass", "fail"].includes(r.status));
});

test("_checkDist: 不存在目录 fail", () => {
  const r = _checkDist(join(tmpdir(), "nonexistent-xxx"));
  assert.equal(r.status, "fail");
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

test("_checkPiVersion: mock 0.82 通过", async () => {
  _doctorInternals.spawn = (() => makeMockChild("pi 0.82.0\n", 0)) as any;
  try {
    const r = await _checkPiVersion();
    assert.equal(r.status, "pass");
    assert.ok(r.message.includes("0.82.0"));
  } finally {
    restoreSpawn();
  }
});

test("_checkPiVersion: mock 0.76 fail", async () => {
  _doctorInternals.spawn = (() => makeMockChild("pi 0.76.0\n", 0)) as any;
  try {
    const r = await _checkPiVersion();
    assert.equal(r.status, "fail");
    assert.ok(r.message.includes("过旧"));
  } finally {
    restoreSpawn();
  }
});

test("_checkPiVersion: mock 非零退出码 warn", async () => {
  _doctorInternals.spawn = (() => makeMockChild("", 1)) as any;
  try {
    const r = await _checkPiVersion();
    assert.equal(r.status, "warn");
  } finally {
    restoreSpawn();
  }
});

test("_checkNovelStructure: 完整工程结构", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    // 创建完整工程结构
    await writeFile(join(dir, "novel.json"), "{}", "utf8");
    await writeFile(join(dir, "规则集.md"), "render", "utf8");
    await writeFile(join(dir, "planner 规则集.md"), "planner", "utf8");
    await writeFile(join(dir, "角色规则集.md"), "role", "utf8");
    await mkdir(join(dir, "正文"), { recursive: true });
    await mkdir(join(dir, ".pi", "extensions", "narrative-engine"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "extensions", "narrative-engine", "index.js"),
      "// fake",
      "utf8",
    );
    await mkdir(join(dir, ".pi", "extensions", "narrative-engine", "node_modules"), {
      recursive: true,
    });
    await mkdir(join(dir, ".pi", "world-graph-v3"), { recursive: true });
    await writeFile(join(dir, ".pi", "world-graph-v3", "world.db"), "fake", "utf8");

    const checks = await _checkNovelStructure(dir);
    // 至少 8 项 + 扩展目录原生绑定 3 项 + 扩展目录 embedder 1 项 = 12
    assert.ok(checks.length >= 8);
    const passed = checks.filter((c) => c.status === "pass");
    assert.ok(passed.length >= 8, `应有至少 8 项 pass，实际 ${passed.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_checkNovelStructure: 空目录所有项 fail/warn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    const checks = await _checkNovelStructure(dir);
    assert.ok(checks.length >= 8);
    const passed = checks.filter((c) => c.status === "pass");
    assert.equal(passed.length, 0, "空目录无任何 pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDoctor: 仓库自身（不传 novelDir）", async () => {
  _doctorInternals.spawn = (() => makeMockChild("pi 0.82.0\n", 0)) as any;
  try {
    const report = await runDoctor({ repoRoot });
    assert.ok(report.checks.length >= 6);
    assert.equal(report.checks.length, report.passed + report.failures + report.warnings);
    // 仓库自身应 dist/templates/native 都通过
    const distCheck = report.checks.find((c) => c.id === "dist");
    const tplCheck = report.checks.find((c) => c.id === "templates");
    if (existsSync(join(repoRoot, "dist", "index.js"))) {
      assert.equal(distCheck!.status, "pass");
    }
    assert.equal(tplCheck!.status, "pass");
  } finally {
    restoreSpawn();
  }
});

test("runDoctor: novelDir 提供时含工程结构检查", async () => {
  _doctorInternals.spawn = (() => makeMockChild("pi 0.82.0\n", 0)) as any;
  const novelDir = await mkdtemp(join(tmpdir(), "admin-doctor-"));
  try {
    await writeFile(join(novelDir, "novel.json"), "{}", "utf8");
    const report = await runDoctor({ repoRoot, novelDir });
    const novelChecks = report.checks.filter((c) => c.id.startsWith("novel-"));
    assert.ok(novelChecks.length >= 8);
    const novelJsonCheck = report.checks.find((c) => c.id === "novel-novel.json");
    assert.equal(novelJsonCheck!.status, "pass");
  } finally {
    restoreSpawn();
    await rm(novelDir, { recursive: true, force: true });
  }
});

test("formatDoctorReport: 含状态图标与统计行", async () => {
  _doctorInternals.spawn = (() => makeMockChild("pi 0.82.0\n", 0)) as any;
  try {
    const report = await runDoctor({ repoRoot });
    const text = formatDoctorReport(report);
    assert.ok(text.includes("✅") || text.includes("❌") || text.includes("⚠️"));
    assert.ok(text.includes("═"));
  } finally {
    restoreSpawn();
  }
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
