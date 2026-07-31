// tests/llm-config.test.ts
/**
 * llm-config.ts 测试 — loadLlmConfig 探测链
 *
 * 覆盖：
 * - 显式 env（NE_LLM_PROVIDER/MODEL/API_KEY）优先
 * - provider 标准 env 探测（OPENAI_API_KEY 等）
 * - Codex auth.json 读取（CODEX_HOME 可注入，避免触碰真实 ~/.codex）
 * - MCP 客户端名映射（codex → openai / claude-desktop → anthropic）
 * - deepseek 缺省不回读 auth.json（避免 key 错配）
 * - 全部缺失抛错
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLlmConfig, readCodexAuthKey } from "../src/orchestrator/llm-config.ts";

const LLM_ENV_KEYS = [
  "NE_LLM_PROVIDER",
  "NE_LLM_MODEL",
  "NE_LLM_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "CODEX_HOME",
] as const;

afterEach(() => {
  for (const key of LLM_ENV_KEYS) delete process.env[key];
});

/** 清理全部相关 env，避免本机真实凭据干扰测试 */
function cleanEnv(): void {
  for (const key of LLM_ENV_KEYS) delete process.env[key];
}

test("显式 NE_LLM_* 三件套全部生效", async () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "deepseek";
  process.env.NE_LLM_MODEL = "deepseek-v4-flash";
  process.env.NE_LLM_API_KEY = "sk-explicit";
  const config = await loadLlmConfig();
  assert.equal(config.model.provider, "deepseek");
  assert.equal(config.model.name, "deepseek-v4-flash");
  assert.equal(config.apiKey, "sk-explicit");
});

test("NE_LLM_API_KEY 优先于 provider 标准 env", async () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "openai";
  process.env.NE_LLM_MODEL = "openai/gpt-5.1";
  process.env.NE_LLM_API_KEY = "sk-ne";
  process.env.OPENAI_API_KEY = "sk-env";
  const config = await loadLlmConfig();
  assert.equal(config.apiKey, "sk-ne");
});

test("provider=openai 时从 OPENAI_API_KEY 探测", async () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "openai";
  process.env.NE_LLM_MODEL = "openai/gpt-5.1";
  process.env.OPENAI_API_KEY = "sk-openai-env";
  const config = await loadLlmConfig();
  assert.equal(config.apiKey, "sk-openai-env");
});

test("缺省模型时从 DEEPSEEK_API_KEY 探测（无显式 provider）", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-deepseek";
  const config = await loadLlmConfig();
  assert.equal(config.model.provider, "deepseek");
  assert.equal(config.model.name, "deepseek-v4-flash");
  assert.equal(config.apiKey, "sk-deepseek");
});

test("clientName=codex 映射 openai + 读 Codex auth.json", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-codex-file" }));
    process.env.CODEX_HOME = dir;
    const config = await loadLlmConfig({ clientName: "codex" });
    assert.equal(config.model.provider, "openai");
    assert.equal(config.model.name, "openai/gpt-5.1-codex-mini");
    assert.equal(config.apiKey, "sk-codex-file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clientName=claude-desktop 映射 anthropic + ANTHROPIC_API_KEY", async () => {
  cleanEnv();
  process.env.ANTHROPIC_API_KEY = "sk-anthropic";
  const config = await loadLlmConfig({ clientName: "claude-desktop" });
  assert.equal(config.model.provider, "anthropic");
  assert.equal(config.model.name, "claude-sonnet-4-5");
  assert.equal(config.apiKey, "sk-anthropic");
});

test("clientName 大小写不敏感", async () => {
  cleanEnv();
  process.env.OPENAI_API_KEY = "sk-case";
  const config = await loadLlmConfig({ clientName: "Codex" });
  assert.equal(config.model.provider, "openai");
});

test("provider=deepseek 时不读 Codex auth.json（避免 key 错配）", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-codex-file" }));
    process.env.CODEX_HOME = dir;
    process.env.NE_LLM_PROVIDER = "deepseek";
    process.env.NE_LLM_MODEL = "deepseek-v4-flash";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    const config = await loadLlmConfig();
    assert.equal(config.apiKey, "sk-deepseek");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("全部缺失时抛错并列出尝试过的来源", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    process.env.CODEX_HOME = dir; // auth.json 不存在
    await assert.rejects(() => loadLlmConfig(), /缺少 API Key/);
    await assert.rejects(() => loadLlmConfig(), /NE_LLM_API_KEY/);
    await assert.rejects(() => loadLlmConfig(), /DEEPSEEK_API_KEY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuthKey: 文件缺失返回 undefined", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    process.env.CODEX_HOME = dir;
    assert.equal(await readCodexAuthKey(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuthKey: JSON 损坏返回 undefined", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    await writeFile(join(dir, "auth.json"), "{ not json");
    process.env.CODEX_HOME = dir;
    assert.equal(await readCodexAuthKey(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCodexAuthKey: 空字符串 key 视为缺失", async () => {
  cleanEnv();
  const dir = await mkdtemp(join(tmpdir(), "llm-config-test-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "" }));
    process.env.CODEX_HOME = dir;
    assert.equal(await readCodexAuthKey(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
