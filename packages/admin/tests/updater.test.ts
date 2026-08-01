// packages/admin/tests/updater.test.ts
/**
 * updater.ts 测试
 *
 * 覆盖：
 * - compareVersions: 本地版本读取/远程版本探测失败/v 前缀 tag/语义化选 latest
 * - _compareSemver: 数值比较/v 前缀/段内非数字后缀
 *
 * （runUpdate 一键更新执行链已随 pure-SDK 迁移删除，不再测试）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as realSpawn } from "node:child_process";

import {
  compareVersions,
  _compareSemver,
  _updaterInternals,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// mock spawn helper
// ---------------------------------------------------------------------------

function makeMockChild(stdout: string, stderr: string, code: number) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child as any;
}

function restoreSpawn() {
  _updaterInternals.spawn = realSpawn;
}

// ---------------------------------------------------------------------------

test("compareVersions: 本地版本读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", version: "0.1.2" }),
      "utf8",
    );
    // mock git ls-remote 失败（无远程）
    _updaterInternals.spawn = (() => makeMockChild("", "", 1)) as any;
    try {
      const result = await compareVersions(dir);
      assert.equal(result.local, "0.1.2");
      assert.equal(result.remote, null);
      assert.equal(result.updateAvailable, false);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: 远程版本更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "abc123\trefs/tags/0.1.0\ndef456\trefs/tags/0.1.2\n",
        "",
        0,
      )) as any;
    try {
      const result = compareVersions(dir);
      const r = await result;
      assert.equal(r.local, "0.1.0");
      assert.equal(r.remote, "0.1.2");
      assert.equal(r.updateAvailable, true);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: package.json 缺失用 0.0.0 兜底", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    _updaterInternals.spawn = (() => makeMockChild("", "", 1)) as any;
    try {
      const result = await compareVersions(dir);
      assert.equal(result.local, "0.0.0");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============ M15+M16 回归测试 ============

test("_compareSemver: 数值比较而非字典序", () => {
  // M16 核心：0.1.10 应大于 0.1.2（字典序会判反）
  assert.ok(_compareSemver("0.1.10", "0.1.2") > 0);
  assert.ok(_compareSemver("0.1.2", "0.1.10") < 0);
  assert.equal(_compareSemver("0.1.2", "0.1.2"), 0);
  // 主版本/次版本差异
  assert.ok(_compareSemver("1.0.0", "0.9.9") > 0);
  assert.ok(_compareSemver("0.2.0", "0.1.9") > 0);
  // 长度不一致时短的前补 0
  assert.ok(_compareSemver("1.2", "1.2.0") === 0);
  assert.ok(_compareSemver("1.2.1", "1.2") > 0);
});

test("_compareSemver: 兼容 v 前缀", () => {
  assert.equal(_compareSemver("v0.1.2", "0.1.2"), 0);
  assert.ok(_compareSemver("v0.1.10", "v0.1.2") > 0);
});

test("_compareSemver: 忽略段内非数字后缀", () => {
  // parseInt("2-alpha") = 2，预发布标签不参与比较
  assert.equal(_compareSemver("0.1.2-alpha", "0.1.2"), 0);
  assert.ok(_compareSemver("0.1.3", "0.1.2-beta") > 0);
});

test("compareVersions: 支持 v 前缀 tag（M15 回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    // 远程 tag 用 v 前缀（git tag 常见约定）
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "abc123\trefs/tags/v0.1.0\ndef456\trefs/tags/v0.1.2\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.local, "0.1.0");
      assert.equal(r.remote, "0.1.2");
      assert.equal(r.updateAvailable, true);
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: 多版本号语义化选 latest（M16 回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    // 0.1.10 > 0.1.2（数值序），字典序会错误选 0.1.2
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "a\trefs/tags/0.1.2\nb\trefs/tags/0.1.10\nc\trefs/tags/0.1.3\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.remote, "0.1.10");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareVersions: v 前缀与无前缀混合排序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-upd-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
      "utf8",
    );
    _updaterInternals.spawn = (() =>
      makeMockChild(
        "a\trefs/tags/v0.1.2\nb\trefs/tags/0.1.10\n",
        "",
        0,
      )) as any;
    try {
      const r = await compareVersions(dir);
      assert.equal(r.remote, "0.1.10");
    } finally {
      restoreSpawn();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
