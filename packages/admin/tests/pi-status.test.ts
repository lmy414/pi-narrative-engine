// packages/admin/tests/pi-status.test.ts
/**
 * pi-status.ts 测试
 *
 * 覆盖：
 * - _isPiVersionCompatible: 版本号解析
 * - getPiStatus: model 已配/未配、hasKey 真假、pi 版本探测
 * - assertPiReady: model 未配/hasKey=false 抛错
 * - _detectPiVersion: mock spawn 行为
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { spawn as realSpawn } from "node:child_process";

import {
  getPiStatus,
  assertPiReady,
  _detectPiVersion,
  _isPiVersionCompatible,
  _piStatusInternals,
  AdminError,
} from "../src/index.ts";
import type { PiStatusContext } from "../src/index.ts";

// ---------------------------------------------------------------------------
// mock spawn helper
// ---------------------------------------------------------------------------

function makeMockChild(stdout: string, stderr: string, code: number, errorMsg?: string) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (errorMsg) {
      child.emit("error", new Error(errorMsg));
      return;
    }
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child as any;
}

function mockSpawn(stdout: string, stderr = "", code = 0, errorMsg?: string) {
  _piStatusInternals.spawn = (() => makeMockChild(stdout, stderr, code, errorMsg)) as any;
}

function restoreSpawn() {
  _piStatusInternals.spawn = realSpawn;
}

// ---------------------------------------------------------------------------

test("_isPiVersionCompatible: 0.82 通过", () => {
  assert.equal(_isPiVersionCompatible("0.82.0"), true);
});

test("_isPiVersionCompatible: 0.76 失败", () => {
  assert.equal(_isPiVersionCompatible("0.76.0"), false);
});

test("_isPiVersionCompatible: 1.0.0 通过", () => {
  assert.equal(_isPiVersionCompatible("1.0.0"), true);
});

test("_isPiVersionCompatible: null 返回 null", () => {
  assert.equal(_isPiVersionCompatible(null), null);
});

test("_isPiVersionCompatible: 格式异常返回 null", () => {
  assert.equal(_isPiVersionCompatible("not-a-version"), null);
});

test("getPiStatus: model 已配 + hasKey + pi 版本可用", async () => {
  mockSpawn("pi 0.82.0\n");
  try {
    const ctx: PiStatusContext = {
      model: { id: "deepseek-v4-flash", provider: "deepseek" },
      modelRegistry: { hasConfiguredAuth: () => true },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.model!.id, "deepseek-v4-flash");
    assert.equal(status.model!.provider, "deepseek");
    assert.equal(status.hasKey, true);
    assert.equal(status.piVersion, "0.82.0");
    assert.equal(status.warnings.length, 0);
  } finally {
    restoreSpawn();
  }
});

test("getPiStatus: model 未配", async () => {
  mockSpawn("pi 0.82.0\n");
  try {
    const ctx: PiStatusContext = {
      model: null,
      modelRegistry: { hasConfiguredAuth: () => false },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.model, null);
    assert.equal(status.hasKey, false);
    assert.ok(status.warnings.length > 0);
    assert.ok(status.warnings.some((w) => w.includes("ctx.model 为空")));
  } finally {
    restoreSpawn();
  }
});

test("getPiStatus: model 已配但 hasKey=false", async () => {
  mockSpawn("pi 0.82.0\n");
  try {
    const ctx: PiStatusContext = {
      model: { id: "deepseek-v4-flash", provider: "deepseek" },
      modelRegistry: { hasConfiguredAuth: () => false },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.hasKey, false);
  } finally {
    restoreSpawn();
  }
});

test("getPiStatus: hasConfiguredAuth 抛错记 warning", async () => {
  mockSpawn("pi 0.82.0\n");
  try {
    const ctx: PiStatusContext = {
      model: { id: "m", provider: "p" },
      modelRegistry: {
        hasConfiguredAuth: () => {
          throw new Error("boom");
        },
      },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.hasKey, false);
    assert.ok(status.warnings.some((w) => w.includes("hasConfiguredAuth 抛错")));
  } finally {
    restoreSpawn();
  }
});

test("getPiStatus: pi 不在 PATH 返回 null + warning", async () => {
  mockSpawn("", "", 1, "ENOENT");
  try {
    const ctx: PiStatusContext = {
      model: { id: "m", provider: "p" },
      modelRegistry: { hasConfiguredAuth: () => true },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.piVersion, null);
    assert.ok(status.warnings.some((w) => w.includes("pi")));
  } finally {
    restoreSpawn();
  }
});

test("getPiStatus: pi --version 非零退出码", async () => {
  mockSpawn("", "error: unknown command", 1);
  try {
    const ctx: PiStatusContext = {
      model: { id: "m", provider: "p" },
      modelRegistry: { hasConfiguredAuth: () => true },
    };
    const status = await getPiStatus(ctx);
    assert.equal(status.piVersion, null);
    assert.ok(status.warnings.some((w) => w.includes("退出码")));
  } finally {
    restoreSpawn();
  }
});

test("_detectPiVersion: 输出含多行取最后一段", async () => {
  mockSpawn("pi CLI\nversion: 0.82.0\n");
  try {
    const result = await _detectPiVersion();
    assert.equal(result.version, "0.82.0");
  } finally {
    restoreSpawn();
  }
});

test("assertPiReady: model 未配抛 PI_NO_MODEL", () => {
  assert.throws(
    () => assertPiReady({ model: null, hasKey: false, piVersion: null, warnings: [] }),
    (err: Error) => err instanceof AdminError && err.code === "PI_NO_MODEL",
  );
});

test("assertPiReady: hasKey=false 抛 PI_NO_API_KEY", () => {
  assert.throws(
    () =>
      assertPiReady({
        model: { id: "m", provider: "deepseek" },
        hasKey: false,
        piVersion: null,
        warnings: [],
      }),
    (err: Error) => err instanceof AdminError && err.code === "PI_NO_API_KEY",
  );
});

test("assertPiReady: 就绪不抛错", () => {
  assert.doesNotThrow(() =>
    assertPiReady({
      model: { id: "m", provider: "deepseek" },
      hasKey: true,
      piVersion: "0.82.0",
      warnings: [],
    }),
  );
});
