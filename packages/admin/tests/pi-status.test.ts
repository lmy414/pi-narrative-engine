// packages/admin/tests/pi-status.test.ts
/**
 * pi-status.ts 测试（pure-SDK 版）
 *
 * 覆盖：
 * - getPiStatus: 模型已解析 + hasKey（配置链 / auth.json 回退）
 * - getPiStatus: 模型解析不出（resolveModel 返回 null / 抛错）
 * - getPiStatus: piVersion 恒为 null
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

import { getPiStatus } from "../src/index.ts";
import type { ResolvedModel } from "../src/index.ts";

/** 最小 AuthStorage mock（pi-status 只用 hasAuth） */
function mockAuthStorage(hasAuth: (provider: string) => boolean): AuthStorage {
  return { hasAuth } as unknown as AuthStorage;
}

test("getPiStatus: 配置链已解析模型且有 key", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage(() => false),
    resolveModel: () => ({ provider: "deepseek", modelId: "deepseek-v4-flash", hasKey: true }),
  });
  assert.deepEqual(status.model, { id: "deepseek-v4-flash", provider: "deepseek" });
  assert.equal(status.hasKey, true);
  assert.equal(status.piVersion, null);
  assert.equal(status.warnings.length, 0);
});

test("getPiStatus: 配置链无 key 时回退 auth.json", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage((p) => p === "deepseek"),
    resolveModel: () => ({ provider: "deepseek", modelId: "deepseek-v4-flash", hasKey: false }),
  });
  assert.equal(status.hasKey, true, "auth.json 有该 provider 凭据应视为 hasKey");
  assert.equal(status.warnings.length, 0);
});

test("getPiStatus: 配置链与 auth.json 均无 key", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage(() => false),
    resolveModel: () => ({ provider: "deepseek", modelId: "deepseek-v4-flash", hasKey: false }),
  });
  assert.ok(status.model !== null);
  assert.equal(status.hasKey, false);
  assert.ok(status.warnings.some((w) => w.includes("API Key")));
});

test("getPiStatus: resolveModel 返回 null（无配置无 env）", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage(() => false),
    resolveModel: () => null,
  });
  assert.equal(status.model, null);
  assert.equal(status.hasKey, false);
  assert.equal(status.piVersion, null);
  assert.ok(status.warnings.some((w) => w.includes("未配置模型")));
});

test("getPiStatus: resolveModel 抛错记 warning 不抛出", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage(() => false),
    resolveModel: (): ResolvedModel | null => {
      throw new Error("boom");
    },
  });
  assert.equal(status.model, null);
  assert.equal(status.hasKey, false);
  assert.ok(status.warnings.some((w) => w.includes("resolveModel 抛错")));
});

test("getPiStatus: authStorage.hasAuth 抛错记 warning 不抛出", () => {
  const status = getPiStatus({
    authStorage: mockAuthStorage(() => {
      throw new Error("io error");
    }),
    resolveModel: () => ({ provider: "deepseek", modelId: "m", hasKey: false }),
  });
  assert.equal(status.hasKey, false);
  assert.ok(status.warnings.some((w) => w.includes("hasAuth 抛错")));
});
