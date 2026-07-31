// tests/llm-config.test.ts
/**
 * llm-config.ts 测试 — env 探测 + LlmConfigStore 独立配置中心
 *
 * 覆盖：
 * - loadLlmConfigFromEnv：显式 env 优先、provider 标准 env 探测、缺省模型、全缺抛错
 * - LlmConfigStore：每 slot 独立配置（provider/model/apiKey）、default 回退、
 *   slot 优先于 default、env 兜底、setRuntime 直注入、clear 恢复回退
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  LlmConfigStore,
  loadLlmConfigFromEnv,
  createRuntimeFromConfig,
} from "../src/orchestrator/llm-config.ts";
import type { AgentRuntime, LlmConfig } from "../src/orchestrator/llm-config.ts";

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
function cfg(provider: "deepseek" | "openai" | "anthropic", name: string, apiKey: string): LlmConfig {
  return { model: { provider, name }, apiKey };
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

test("env: provider=openai 时从 OPENAI_API_KEY 探测", () => {
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

test("env: provider=anthropic 时从 ANTHROPIC_API_KEY 探测（getEnvApiKey 覆盖）", () => {
  cleanEnv();
  process.env.NE_LLM_PROVIDER = "anthropic";
  process.env.NE_LLM_MODEL = "claude-sonnet-4-5";
  process.env.ANTHROPIC_API_KEY = "sk-anthropic";
  assert.equal(loadLlmConfigFromEnv().apiKey, "sk-anthropic");
});

// ---------------------------------------------------------------------------
// LlmConfigStore
// ---------------------------------------------------------------------------

test("store: 每 slot 独立配置（provider/model/apiKey 各自独立）", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env-fallback"; // 兜底不应被用到
  const store = new LlmConfigStore();
  store.setConfig("planner", cfg("deepseek", "deepseek-v4-flash", "sk-plan"));
  store.setConfig("role", cfg("openai", "gpt-5.1", "sk-role"));
  const plannerRt = await store.getRuntime("planner");
  const roleRt = await store.getRuntime("role");
  assert.equal(plannerRt.model.provider, "deepseek");
  assert.equal(plannerRt.model.id, "deepseek-v4-flash");
  assert.equal(await plannerRt.getApiKey("deepseek"), "sk-plan");
  assert.equal(roleRt.model.provider, "openai");
  assert.equal(roleRt.model.id, "gpt-5.1");
  assert.equal(await roleRt.getApiKey("openai"), "sk-role");
});

test("store: slot 优先于 default", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash", "sk-default"));
  store.setConfig("role", cfg("anthropic", "claude-sonnet-4-5", "sk-role"));
  assert.equal((await store.getRuntime("planner")).model.id, "deepseek-v4-flash"); // 走 default
  assert.equal((await store.getRuntime("role")).model.id, "claude-sonnet-4-5"); // 走 slot
});

test("store: 只配 default 时所有 slot 回退 default", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash", "sk-default"));
  for (const slot of ["planner", "role", "reasoning", "renderer"] as const) {
    assert.equal((await store.getRuntime(slot)).model.id, "deepseek-v4-flash");
  }
});

test("store: 无任何注入时走 env 兜底（解析一次并缓存）", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  const rt1 = await store.getRuntime("planner");
  const rt2 = await store.getRuntime("role");
  assert.equal(rt1.model.id, "deepseek-v4-flash");
  assert.equal(rt2, rt1); // 同一 runtime 缓存
});

test("store: env 兜底也无 key 时抛错", async () => {
  cleanEnv();
  const store = new LlmConfigStore();
  await assert.rejects(() => store.getRuntime("planner"), /缺少 API Key/);
});

test("store: setRuntime 直注入（pi 适配器路径）", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const dummy: AgentRuntime = {
    model: { id: "dummy-model", provider: "deepseek", api: "openai-completions" } as never,
    streamFn: (async function* () {})() as never,
    getApiKey: async () => "sk-injected",
  };
  const store = new LlmConfigStore();
  store.setRuntime("role", dummy);
  assert.equal((await store.getRuntime("role")).model.id, "dummy-model");
  assert.equal(await (await store.getRuntime("role")).getApiKey("deepseek"), "sk-injected");
});

test("store: clear 恢复回退链", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  store.setConfig("role", cfg("openai", "gpt-5.1", "sk-role"));
  assert.equal((await store.getRuntime("role")).model.id, "gpt-5.1");
  store.clear("role");
  assert.equal((await store.getRuntime("role")).model.id, "deepseek-v4-flash"); // 回退 env
});

test("store: configuredSlots 只含已注入 slot", () => {
  cleanEnv();
  const store = new LlmConfigStore();
  assert.deepEqual(store.configuredSlots(), []);
  store.setConfig("planner", cfg("deepseek", "deepseek-v4-flash", "sk-p"));
  store.setConfig("default", cfg("deepseek", "deepseek-v4-flash", "sk-d"));
  assert.deepEqual(store.configuredSlots(), ["planner", "default"]);
});

test("store: createRuntimeFromConfig 与 setConfig 等价", async () => {
  cleanEnv();
  process.env.DEEPSEEK_API_KEY = "sk-env";
  const store = new LlmConfigStore();
  const config = cfg("deepseek", "deepseek-v4-flash", "sk-x");
  store.setRuntime("planner", createRuntimeFromConfig(config));
  const rt = await store.getRuntime("planner");
  assert.equal(rt.model.id, "deepseek-v4-flash");
  assert.equal(await rt.getApiKey("deepseek"), "sk-x");
});

test("store: 配置不存在的模型名立即抛错（getModel 未命中返回 undefined）", () => {
  cleanEnv();
  const store = new LlmConfigStore();
  assert.throws(
    () => store.setConfig("planner", cfg("openai", "not-a-real-model", "sk-x")),
    /模型不存在/,
  );
});
