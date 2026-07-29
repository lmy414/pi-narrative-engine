// packages/admin/tests/embedder-status.test.ts
/**
 * embedder-status.ts 测试
 *
 * 覆盖：
 * - _validateModelName: 合法/非法模型名
 * - _findCacheDir: 本地缓存/HF 缓存/无缓存
 * - _dirSize: 目录大小计算
 * - getEmbedderStatus: 默认模型/自定义模型/缓存命中
 * - clearEmbedderCache: 清理本地缓存
 * - warmupEmbedder: 成功/失败
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getEmbedderStatus,
  clearEmbedderCache,
  warmupEmbedder,
  assertModelValid,
  _validateModelName,
  _findCacheDir,
  _dirSize,
  DEFAULT_EMBEDDER_MODEL,
  AdminError,
} from "../src/index.ts";
import type { EmbedderLike } from "../src/index.ts";

// 保存与恢复 process.env.PI_EMBEDDER_MODEL
function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  return (async () => {
    const old = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      await fn();
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  })();
}

test("_validateModelName: 合法模型名", () => {
  assert.deepEqual(_validateModelName("Xenova/bge-small-zh-v1.5"), { ok: true });
  assert.deepEqual(_validateModelName("BAAI/bge-large-en"), { ok: true });
});

test("_validateModelName: 空字符串", () => {
  const r = _validateModelName("");
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("_validateModelName: 缺少 org/name 分隔符", () => {
  const r = _validateModelName("bge-small-zh");
  assert.equal(r.ok, false);
});

test("_validateModelName: 含非法字符", () => {
  const r = _validateModelName("org/name with space");
  assert.equal(r.ok, false);
});

test("assertModelValid: 合法不抛错", () => {
  assert.doesNotThrow(() => assertModelValid("Xenova/bge-small-zh-v1.5"));
});

test("assertModelValid: 非法抛 AdminError", () => {
  assert.throws(
    () => assertModelValid("invalid"),
    (err: Error) => err instanceof AdminError && err.code === "INVALID_EMBEDDER_MODEL",
  );
});

test("_dirSize: 空目录返回 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const size = await _dirSize(dir);
    assert.equal(size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_dirSize: 计算文件总大小", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    await writeFile(join(dir, "a.bin"), "aaaa", "utf8");
    await writeFile(join(dir, "b.bin"), "bb", "utf8");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "c.bin"), "c", "utf8");
    const size = await _dirSize(dir);
    assert.equal(size, 4 + 2 + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_dirSize: 不存在目录返回 0", async () => {
  const size = await _dirSize(join(tmpdir(), "nonexistent-xxx"));
  assert.equal(size, 0);
});

test("_findCacheDir: 无缓存返回 null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const result = _findCacheDir(dir);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_findCacheDir: 本地 node_modules 缓存命中", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const cacheDir = join(dir, "node_modules", "@xenova", "transformers", ".cache", "Xenova");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "model.onnx"), "fake", "utf8");
    const result = _findCacheDir(dir);
    assert.equal(result, cacheDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getEmbedderStatus: 默认模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    await withEnv("PI_EMBEDDER_MODEL", undefined, async () => {
      const status = await getEmbedderStatus(dir);
      assert.equal(status.model, DEFAULT_EMBEDDER_MODEL);
      assert.equal(status.isDefault, true);
      assert.equal(status.dim, null, "无 embedder 时 dim 为 null");
      assert.equal(status.cachePresent, false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getEmbedderStatus: 自定义模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    await withEnv("PI_EMBEDDER_MODEL", "BAAI/bge-large-en", async () => {
      const status = await getEmbedderStatus(dir);
      assert.equal(status.model, "BAAI/bge-large-en");
      assert.equal(status.isDefault, false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getEmbedderStatus: embedder 实例提供 dim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const emb: EmbedderLike = { init: async () => {}, getDimension: () => 512 };
    const status = await getEmbedderStatus(dir, emb);
    assert.equal(status.dim, 512);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getEmbedderStatus: 缓存命中时返回大小", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const cacheDir = join(dir, "node_modules", "@xenova", "transformers", ".cache", "Xenova");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "model.onnx"), "fake-model-data", "utf8");
    const status = await getEmbedderStatus(dir);
    assert.equal(status.cachePresent, true);
    assert.ok(status.cacheSizeBytes! > 0);
    assert.equal(status.cachePath, cacheDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearEmbedderCache: 清理本地缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const cacheDir = join(dir, "node_modules", "@xenova", "transformers", ".cache");
    await mkdir(join(cacheDir, "Xenova"), { recursive: true });
    await writeFile(join(cacheDir, "Xenova", "model.onnx"), "data", "utf8");
    const result = await clearEmbedderCache(dir);
    assert.equal(result.ok, true);
    assert.ok(result.clearedBytes > 0);
    assert.equal(result.clearedPaths.length, 1);
    // 清理后再查，cachePresent 应为 false
    const status = await getEmbedderStatus(dir);
    assert.equal(status.cachePresent, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearEmbedderCache: 无缓存时返回 0 字节", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-emb-"));
  try {
    const result = await clearEmbedderCache(dir);
    assert.equal(result.ok, true);
    assert.equal(result.clearedBytes, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("warmupEmbedder: 成功返回延迟", async () => {
  const emb: EmbedderLike = {
    init: async () => {
      // 模拟加载耗时
    },
    getDimension: () => 512,
  };
  const result = await warmupEmbedder(emb);
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.error, undefined);
});

test("warmupEmbedder: init 抛错返回失败", async () => {
  const emb: EmbedderLike = {
    init: async () => {
      throw new Error("model not found");
    },
    getDimension: () => 512,
  };
  const result = await warmupEmbedder(emb);
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes("model not found"));
});
