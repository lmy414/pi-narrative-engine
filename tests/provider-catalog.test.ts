// tests/provider-catalog.test.ts
/**
 * provider-catalog.ts 测试
 *
 * 覆盖：
 * - listBuiltinProviders: 内置厂商派生非空、模型列表正确、builtin=true
 * - toCustomProviderView / getProviderViews: 内置 + 自定义合并
 * - findProviderView: 按 id 查找两类厂商
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listBuiltinProviders,
  toCustomProviderView,
  getProviderViews,
  findProviderView,
} from "../src/app/provider-catalog.ts";
import type { CustomProvider } from "@earendil-works/pi-coding-agent";

const sampleCustom: CustomProvider = {
  id: "my-groq",
  name: "My Groq",
  baseURL: "https://api.groq.com/openai/v1",
  apiKind: "openai-completions",
  modelIds: ["llama-3.3-70b", "llama-3.1-8b"],
  fetchModels: true,
};

test("listBuiltinProviders: 派生内置厂商为非空且 builtin=true", () => {
  const views = listBuiltinProviders();
  assert.ok(views.length > 0, "内置厂商列表不应为空");
  for (const v of views) {
    assert.equal(v.builtin, true);
    assert.equal(v.kind, "builtin");
    assert.ok(Array.isArray(v.modelIds));
  }
  // 已知厂商存在
  const ids = views.map((v) => v.id);
  assert.ok(ids.includes("deepseek"), "应含 deepseek");
  assert.ok(ids.includes("openai"), "应含 openai");
});

test("listBuiltinProviders: 模型/apiKind 派生正确", () => {
  const views = listBuiltinProviders();
  const deepseek = views.find((v) => v.id === "deepseek");
  assert.ok(deepseek, "deepseek 应在内置厂商中");
  assert.ok(deepseek.modelIds.length > 0, "deepseek 应有模型");
  assert.ok(deepseek.apiKind.length > 0, "apiKind 应派生出来");
});

test("toCustomProviderView: 自定义厂商转视图", () => {
  const v = toCustomProviderView(sampleCustom);
  assert.equal(v.id, "my-groq");
  assert.equal(v.name, "My Groq");
  assert.equal(v.kind, "custom");
  assert.equal(v.builtin, false);
  assert.deepEqual(v.modelIds, ["llama-3.3-70b", "llama-3.1-8b"]);
  assert.equal(v.apiKind, "openai-completions");
});

test("getProviderViews: 内置 + 自定义合并且无 id 冲突", () => {
  const views = getProviderViews([sampleCustom]);
  const ids = views.map((v) => v.id);
  assert.ok(ids.includes("my-groq"));
  assert.ok(ids.includes("deepseek"));
  assert.equal(views.filter((v) => v.id === "my-groq").length, 1);
});

test("findProviderView: 按 id 查内置 / 自定义", () => {
  const customViews = [sampleCustom];
  const builtinFound = findProviderView(customViews, "deepseek");
  assert.ok(builtinFound);
  assert.equal(builtinFound!.builtin, true);

  const customFound = findProviderView(customViews, "my-groq");
  assert.ok(customFound);
  assert.equal(customFound!.builtin, false);

  const missing = findProviderView(customViews, "nope");
  assert.equal(missing, undefined);
});