// packages/admin/tests/env-store.test.ts
/**
 * env-store.ts 测试
 *
 * 覆盖：
 * - _parseEnvContent：注释/空行/kv/unknown 识别
 * - readEnvFile：文件不存在/正常读取/只提取扩展专属变量
 * - writeEnvFile：原地更新/追加新 key/删除 key/保留注释与未知字段/原子写
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readEnvFile,
  writeEnvFile,
  _parseEnvContent,
  EXTENSION_ENV_KEYS,
} from "../src/index.ts";

test("_parseEnvContent: 识别空行/注释/kv/unknown", () => {
  const content = [
    "# 这是注释",
    "",
    "HF_ENDPOINT=https://hf-mirror.com",
    "PI_DEBUG=off",
    "PI_EMBEDDER_MODEL=Xenova/bge-small-zh-v1.5",
    "OTHER_KEY=should_be_unknown",
    "bad line without equals",
    'QUOTED="value with spaces"',
  ].join("\n");
  const lines = _parseEnvContent(content);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].type, "comment");
  assert.equal(lines[1].type, "blank");
  assert.equal(lines[2].type, "kv");
  assert.equal(lines[2].key, "HF_ENDPOINT");
  assert.equal(lines[2].value, "https://hf-mirror.com");
  assert.equal(lines[5].type, "kv");
  assert.equal(lines[5].key, "OTHER_KEY");
  assert.equal(lines[6].type, "unknown");
  assert.equal(lines[7].value, "value with spaces");
});

test("_parseEnvContent: 单引号去引号", () => {
  const lines = _parseEnvContent("HF_ENDPOINT='https://hf-mirror.com'");
  assert.equal(lines[0].value, "https://hf-mirror.com");
});

test("_parseEnvContent: 空值", () => {
  const lines = _parseEnvContent("HF_ENDPOINT=");
  assert.equal(lines[0].value, "");
});

test("readEnvFile: 文件不存在返回 exists=false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const result = await readEnvFile(join(dir, ".env"));
    assert.equal(result.exists, false);
    assert.equal(result.lineCount, 0);
    assert.deepEqual(result.values, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readEnvFile: 只提取扩展专属变量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      [
        "# 注释",
        "DEEPSEEK_API_KEY=sk-xxx",
        "HF_ENDPOINT=https://hf-mirror.com",
        "PI_DEBUG=off",
        "PI_EMBEDDER_MODEL=Xenova/bge-small-zh-v1.5",
        "OTHER_VAR=should_not_appear",
      ].join("\n"),
      "utf8",
    );
    const result = await readEnvFile(envPath);
    assert.equal(result.exists, true);
    assert.equal(result.values.HF_ENDPOINT, "https://hf-mirror.com");
    assert.equal(result.values.PI_DEBUG, "off");
    assert.equal(result.values.PI_EMBEDDER_MODEL, "Xenova/bge-small-zh-v1.5");
    assert.equal(result.values.DEEPSEEK_API_KEY, undefined);
    assert.equal(result.values.OTHER_VAR, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEnvFile: 文件不存在时创建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    const result = await writeEnvFile(envPath, { HF_ENDPOINT: "https://hf-mirror.com" });
    assert.equal(result.exists, true);
    assert.equal(result.values.HF_ENDPOINT, "https://hf-mirror.com");
    // 文件实际写入
    const content = await readFile(envPath, "utf8");
    assert.ok(content.includes("HF_ENDPOINT=https://hf-mirror.com"));
    assert.ok(content.includes("# narrative-engine 扩展配置"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEnvFile: 原地更新已存在的 key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeFile(
      envPath,
      ["# header", "HF_ENDPOINT=old", "OTHER=keep"].join("\n"),
      "utf8",
    );
    const result = await writeEnvFile(envPath, { HF_ENDPOINT: "new" });
    assert.equal(result.values.HF_ENDPOINT, "new");
    const content = await readFile(envPath, "utf8");
    assert.ok(content.includes("HF_ENDPOINT=new"));
    assert.ok(content.includes("OTHER=keep"), "未知字段应保留");
    assert.ok(content.includes("# header"), "注释应保留");
    assert.ok(!content.includes("HF_ENDPOINT=old"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEnvFile: 删除 key（传 undefined）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeFile(envPath, "HF_ENDPOINT=to-delete\nPI_DEBUG=off", "utf8");
    const result = await writeEnvFile(envPath, { HF_ENDPOINT: undefined });
    assert.equal(result.values.HF_ENDPOINT, undefined);
    assert.equal(result.values.PI_DEBUG, "off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEnvFile: 值含空格自动加引号", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    await writeEnvFile(envPath, { HF_ENDPOINT: "https://hf mirror.com" });
    const content = await readFile(envPath, "utf8");
    assert.ok(content.includes('HF_ENDPOINT="https://hf mirror.com"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("EXTENSION_ENV_KEYS: 包含三个扩展专属变量", () => {
  assert.equal(EXTENSION_ENV_KEYS.length, 3);
  assert.ok(EXTENSION_ENV_KEYS.includes("HF_ENDPOINT"));
  assert.ok(EXTENSION_ENV_KEYS.includes("PI_DEBUG"));
  assert.ok(EXTENSION_ENV_KEYS.includes("PI_EMBEDDER_MODEL"));
});

// ============ 并发写串行化（🟠-8 2026-08-08） ============

test("writeEnvFile: 并发写不同 key 不丢更新（🟠-8）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-env-"));
  try {
    const envPath = join(dir, ".env");
    await Promise.all([
      writeEnvFile(envPath, { HF_ENDPOINT: "https://hf-mirror.com" }),
      writeEnvFile(envPath, { PI_DEBUG: "off" }),
      writeEnvFile(envPath, { PI_EMBEDDER_MODEL: "Xenova/bge-small-zh-v1.5" }),
    ]);
    const result = await readEnvFile(envPath);
    assert.equal(result.values.HF_ENDPOINT, "https://hf-mirror.com", "并发写 HF_ENDPOINT 不应丢失");
    assert.equal(result.values.PI_DEBUG, "off", "并发写 PI_DEBUG 不应丢失");
    assert.equal(result.values.PI_EMBEDDER_MODEL, "Xenova/bge-small-zh-v1.5", "并发写 PI_EMBEDDER_MODEL 不应丢失");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
