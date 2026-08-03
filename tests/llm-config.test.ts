// tests/llm-config.test.ts
/**
 * llm-config.ts 测试 — env 探测 + LlmConfigStore 独立配置中心（直接面向 pi-ai）
 *
 * 覆盖：
 * - loadLlmConfigFromEnv：显式 env 优先、provider 标准 env 探测（getEnvApiKey）、缺省模型、全缺抛错
 * - LlmConfigStore：每 slot 独立配置、getModel 产出 pi-ai Model、getApiKey 配置 key 优先、
 *   provider 标准 env 兜底、default 回退、env 兜底、模型未命中抛错、clear 恢复回退
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  LlmConfigStore,
  loadLlmConfigFromEnv,
} from "../src/orchestrator/llm-config.ts";
import type { LlmConfig } from "../src/orchestrator/llm-config.ts";

const LLM_ENV_KEYS = [
  "NE_LLM_PROVIDER",
  "NE_LLM_MODEL",
  "NE_LLM_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

afterEach(() => {
  for (const key of LLM_ENV_KEYS) delete process.env[key];
});

/** 清理全部相关 env，避免本机真实凭据干扰测试 */
function cleanEnv(): void {
  for (const key of LLM_ENV_KEYS) delete process.env[key];
}

/** 构造一份测试用 LlmConfig */
function cfg(provider: "deepseek" | "openai" | "anthropic", name: string, apiKey?: string): LlmConfig {
  return apiKey ? { model: { provider, name }, apiKey } : { model: { provider, name } };
}

// ---------------------------------------------------------------------------
// loadLlmConfigFromEnv
// ---------------------------------------------------------------------------

test("env: NE_LLM_* 三件套全部生效", () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "deepseek";
  process.env.NE_LLM_MODEL = "deepseek-v4-flash";
  process.env.NE_LLM_API_KEY = "sk-explicit";
  const config = loadLlmConfigFromEnv();
  assert.equal(config.model.provider, "deepseek");
  assert.equal(config.model.name, "deepseek-v4-flash");
  assert.equal(config.apiKey, "sk-explicit");
});

test("env: NE_LLM_API_KEY 优先于 provider 标准 env", () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "openai";
  process.env.NE_LLM_MODEL = "gpt-5.1";
  process.env.NE_LLM_API_KEY = "sk-ne";
  process.env.OPENAI_API_KEY = "sk-env";
  assert.equal(loadLlmConfigFromEnv().apiKey, "sk-ne");
});

test("env: provider=openai 时从 OPENAI_API_KEY 探测（getEnvApiKey）", () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "openai";
  process.env.NE_LLM_MODEL = "gpt-5.1";
  process.env.OPENAI_API_KEY = "sk-openai-env";
  assert.equal(loadLlmConfigFromEnv().apiKey, "sk-openai-env");
});

test("env: 缺省模型时从 DEEPSEEK_API_KEY 探测（无显式 provider）", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-deepseek";
  const config = loadLlmConfigFromEnv();
  assert.equal(config.model.provider, "deepseek");
  assert.equal(config.model.name, "deepseek-v4-flash");
  assert.equal(config.apiKey, "sk-deepseek");
});

test("env: 全部缺失抛错并提示来源", () => {
  cleanEnv();
  assert.throws(() => loadLlmConfigFromEnv(), /缺少 API Key/);
  assert.throws(() => loadLlmConfigFromEnv(), /NE_LLM_API_KEY/);
  assert.throws(() => loadLlmConfigFromEnv(), /标准 env/);
});

// ---------------------------------------------------------------------------
// LlmConfigStore
// ---------------------------------------------------------------------------

test("store: 每 slot 独立模型（getModel 产出 pi-ai Model）", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env-fallback";
  const store = new LlmConfigStore();
  store.setConfig("planner", cfg("deepseek", "deepseek-v4-flash"));
  store.setConfig("role", cfg("openai", "gpt-5.1"));
  const plannerModel = store.getModel("planner");
  const roleModel = store.getModel("role");
  assert.equal(plannerModel.id, "deepseek-v4-flash");
  assert.equal(plannerModel.provider, "deepseek");
  assert.equal(roleModel.id, "gpt-5.1");
  assert.equal(roleModel.provider, "openai");
});

test("store: getModel 结果缓存（同 slot 同一 Model 实例）", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("planner", cfg("deepseek", "deepseek-v4-flash"));
  assert.equal(store.getModel("planner"), store.getModel("planner"));
});

test("store: getApiKey 配置 key 优先，provider 标准 env 兜底", async () => {
  cleanEnv();
  process.env.OPENAI_API_KEY = "sk-openai-env";
  const store = new LlmConfigStore();
  store.setConfig("role", cfg("openai", "gpt-5.1", "sk-role")); // 显式 key
  assert.equal(store.getApiKey("role"), "sk-role");
  store.clear("role");
  store.setConfig("role", cfg("openai", "gpt-5.1")); // 省略 key → 标准 env
  assert.equal(store.getApiKey("role"), "sk-openai-env");
});

test("store: slot 只覆盖模型无 key 时回退 slot provider 标准 env（不借 default 的 key）", () => {
  cleanEnv();
  process.env.OPENAI_API_KEY = "sk-openai-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash", "sk-default"));
  store.setConfig("role", cfg("openai", "gpt-5.1"));
  assert.equal(store.getApiKey("role"), "sk-openai-env");
});

test("store: slot 覆盖模型无 key、default 有 key、无 env 时抛错（M-Logic-1 跨 provider 借 key 修复）", () => {
  cleanEnv();
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash", "sk-default"));
  store.setConfig("role", cfg("openai", "gpt-5.1"));
  assert.throws(() => store.getApiKey("role"), /API Key/);
});

test("store: slot 和 default 都无 key 时回退 NE_LLM_API_KEY", () => {
  cleanEnv();
  process.env.NE_LLM_API_KEY = "sk-ne-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash"));
  store.setConfig("renderer", cfg("openai", "gpt-5.1"));
  assert.equal(store.getApiKey("renderer"), "sk-ne-env");
});

test("store: slot 优先于 default", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash"));
  store.setConfig("role", cfg("anthropic", "claude-sonnet-4-5"));
  assert.equal(store.getModel("planner").id, "deepseek-v4-flash"); // 走 default
  assert.equal(store.getModel("role").id, "claude-sonnet-4-5"); // 走 slot
});

test("store: 只配 default 时所有 slot 回退 default", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash"));
  for (const slot of ["planner", "role", "reasoning", "renderer"] as const) {
    assert.equal(store.getModel(slot).id, "deepseek-v4-flash");
  }
});

test("store: 无任何注入时走 env 兜底", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  assert.equal(store.getModel("planner").id, "deepseek-v4-flash");
  assert.equal(store.getApiKey("planner"), "sk-env");
});

test("store: env 兜底也无 key 时抛错", async () => {
  cleanEnv();
  const store = new LlmConfigStore();
  assert.throws(() => store.getApiKey("planner"), /API Key/);
});

test("store: 配置不存在的模型名在 getModel 时抛错（getModel 未命中返回 undefined）", () => {
  cleanEnv();
  const store = new LlmConfigStore();
  store.setConfig("planner", cfg("openai", "not-a-real-model"));
  assert.throws(() => store.getModel("planner"), /模型不存在/);
});

test("store: clear 恢复回退链", () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("role", cfg("openai", "gpt-5.1"));
  assert.equal(store.getModel("role").id, "gpt-5.1");
  store.clear("role");
  assert.equal(store.getModel("role").id, "deepseek-v4-flash"); // 回退 env
});

test("store: configuredSlots 只含已注入 slot", () => {
  cleanEnv();
  const store = new LlmConfigStore();
  assert.deepEqual(store.configuredSlots(), []);
  store.setConfig("planner", cfg("deepseek", "deepseek-v4-flash"));
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash"));
  assert.deepEqual(store.configuredSlots(), ["planner", "default"]);
});
