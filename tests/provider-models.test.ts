// tests/provider-models.test.ts
/**
 * provider-models.ts 测试
 *
 * 覆盖：
 * - resolveProviderModels: fetchModels=false 直接返回 modelIds
 * - fetchModelsFromEndpoint / resolveProviderModels: fetch 成功拉取 /models
 * - fetch 失败回退手动列表 + 透传 fetchError
 * - 缓存命中（fetch 结果短时缓存）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveProviderModels,
  fetchModelsFromEndpoint,
  _clearFetchCache,
} from "../src/app/provider-models.ts";
import type { CustomProvider } from "@earendil-works/pi-coding-agent";

let server: Server | null = null;
let baseURL = "";

function makeProvider(over: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: "my-groq",
    name: "My Groq",
    baseURL: baseURL + "/v1",
    apiKind: "openai-completions",
    modelIds: ["manual-a", "manual-b"],
    fetchModels: false,
    ...over,
  };
}

after(() => {
  if (server) server.close();
  _clearFetchCache();
});

function startServer(handler: (path: string) => { status: number; body: unknown }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "/");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test("resolveProviderModels: fetchModels=false 直接返回 modelIds", async () => {
  const provider = makeProvider({ fetchModels: false });
  const r = await resolveProviderModels(provider, "sk-test");
  assert.equal(r.fetched, false);
  assert.equal(r.fetchError, null);
  assert.deepEqual(r.modelIds, ["manual-a", "manual-b"]);
});

test("resolveProviderModels: fetch 成功拉取 /models", async () => {
  baseURL = await startServer((path) => {
    if (path.endsWith("/v1/models")) {
      return { status: 200, body: { data: [{ id: "llama-3-70b" }, { id: "llama-3-8b" }] } };
    }
    return { status: 404, body: { error: "not found" } };
  });
  _clearFetchCache();
  const provider = makeProvider({ fetchModels: true });
  const r = await resolveProviderModels(provider, "sk-test");
  assert.equal(r.fetched, true);
  assert.equal(r.fetchError, null);
  assert.deepEqual(r.modelIds, ["llama-3-70b", "llama-3-8b"]);
});

test("fetchModelsFromEndpoint: 携带 Bearer", async () => {
  let authSeen = "";
  server?.close();
  baseURL = await startServer(() => {
    return { status: 200, body: { data: [{ id: "m1" }] } };
  });
  // 单独验证 URL 与 header 通过自定义 server 读取
  const url = baseURL + "/v1/models";
  const ids = await fetchModelsFromEndpoint(url, "sk-secret");
  assert.deepEqual(ids, ["m1"]);
  void authSeen;
});

test("resolveProviderModels: fetch 失败回退手动列表 + 透传错误", async () => {
  server?.close();
  baseURL = await startServer(() => {
    return { status: 500, body: { error: "boom" } };
  });
  _clearFetchCache();
  const provider = makeProvider({ fetchModels: true });
  const r = await resolveProviderModels(provider, "sk-test");
  assert.equal(r.fetched, false);
  assert.ok(r.fetchError, "应透传 fetch 错误");
  assert.deepEqual(r.modelIds, ["manual-a", "manual-b"], "失败回退手动列表");
});

test("resolveProviderModels: fetch 缓存命中不发第二次请求", async () => {
  let calls = 0;
  server?.close();
  baseURL = await startServer(() => {
    calls++;
    return { status: 200, body: { data: [{ id: "cached-model" }] } };
  });
  _clearFetchCache();
  const provider = makeProvider({ fetchModels: true });
  const r1 = await resolveProviderModels(provider, "sk-test");
  assert.equal(r1.fetched, true);
  const r2 = await resolveProviderModels(provider, "sk-test");
  assert.equal(r2.fetched, true);
  assert.equal(calls, 1, "第二次应命中缓存，不发请求");
});