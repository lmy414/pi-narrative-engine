import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const code = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "frontend-demo", "api-client.js"),
  "utf8",
);
const mockCode = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "frontend-demo", "api-mock.js"),
  "utf8",
);
const mockDataCode = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "frontend-demo", "mock-data.js"),
  "utf8",
);

type FetchCall = { url: string; options: Record<string, any> };

function loadClient(responses: Array<{ status?: number; envelope: any }> = []) {
  const calls: FetchCall[] = [];
  const storage = new Map<string, string>();
  const context: Record<string, any> = {
    URLSearchParams,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    fetch: async (url: string, options: Record<string, any>) => {
      calls.push({ url, options });
      const response = responses.shift() ?? { envelope: { ok: true, data: {}, error: null } };
      const status = response.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => structuredClone(response.envelope),
      };
    },
  };
  context.globalThis = context;
  context.module = { exports: {} };
  new Function("globalThis", "module", "URLSearchParams", code)(context, context.module, URLSearchParams);
  return { client: context.module.exports, calls, storage };
}

test("exposes exactly the same public methods as ApiMock", () => {
  const { client } = loadClient();
  const mockObject = mockCode.slice(mockCode.indexOf("const ApiMock = {"), mockCode.indexOf("\n};", mockCode.indexOf("const ApiMock = {")));
  const mockMethods = [...mockObject.matchAll(/^\s+async\s+(\w+)\s*\(/gm)].map((match) => match[1]).sort();
  const clientMethods = Object.keys(client).filter((name) => !name.startsWith("subscribe")).sort();
  assert.deepEqual(clientMethods, mockMethods);
  assert.equal(typeof client.subscribeChat, "function");
  assert.equal(typeof client.subscribeDebug, "function");
});

test("SSE subscriptions use same-origin endpoints and close EventSource", () => {
  const urls: string[] = [];
  const sources: any[] = [];
  const context: Record<string, any> = {
    URLSearchParams,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {}, error: null }) }),
    EventSource: class {
      closed = false;
      constructor(url: string) { urls.push(url); sources.push(this); }
      close() { this.closed = true; }
    },
  };
  context.globalThis = context;
  context.module = { exports: {} };
  new Function("globalThis", "module", "URLSearchParams", code)(context, context.module, URLSearchParams);
  const client = context.module.exports;
  const closeChat = client.subscribeChat(() => {}, () => {});
  const closeDebug = client.subscribeDebug(() => {}, () => {});
  assert.deepEqual(urls, ["/api/chat/events", "/api/debug/stream"]);
  closeChat();
  closeDebug();
  assert.ok(sources.every((source) => source.closed));
});

test("maps GET query and write methods to same-origin endpoints", async () => {
  const { client, calls } = loadClient();
  await client.getGraph("ch001.ev002", "1");
  await client.writeFile("正文/第一章.md", "你好", "mtime-1");
  await client.clearLlmSlot("planner");

  assert.equal(calls[0].url, "/api/graph?storyTime=ch001.ev002&includeClosed=1");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "/api/files/write");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    path: "正文/第一章.md", content: "你好", baseMtime: "mtime-1",
  });
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(calls[2].url, "/api/admin/llm/slot/planner");
});

test("returns a non-2xx error envelope and records its HTTP status", async () => {
  const error = { ok: false, data: null, error: { code: "ENTITY_NOT_FOUND", message: "missing" } };
  const { client } = loadClient([{ status: 404, envelope: error }]);
  const result = await client.getEntity("missing", "ch001.ev001");
  assert.deepEqual(result, { ...error, _status: 404 });
});

test("normalizes graph and entity declaration arrays at the client boundary", async () => {
  const snapshot = {
    entityId: "char-1",
    type: "character",
    summary: "主角",
    validFrom: "ch001.ev001",
    validTo: "Infinity",
    properties: [
      { declarationId: "d1", entityId: "char-1", property: "name", value: "阿明", validFrom: "ch001.ev001", validTo: "Infinity" },
      { declarationId: "d2", entityId: "char-1", property: "mood", value: "平静", validFrom: "ch001.ev001", validTo: "Infinity" },
    ],
  };
  const { client } = loadClient([
    { envelope: { ok: true, data: { entities: [snapshot], relations: [{ label: "friend" }] }, error: null } },
    { envelope: { ok: true, data: snapshot, error: null } },
  ]);

  const graph = await client.getGraph("ch001.ev001", false);
  assert.equal(graph.data.entities[0].entityType, "character");
  assert.deepEqual(graph.data.entities[0].properties, { name: "阿明", mood: "平静" });
  assert.equal(graph.data.entities[0].declarations.length, 2);
  assert.deepEqual(graph.data.relations, [{ label: "friend" }]);

  const entity = await client.getEntity("char-1", "ch001.ev001");
  assert.deepEqual(entity.data.properties, { name: "阿明", mood: "平静" });
  assert.equal(entity.data.declarations[0].declarationId, "d1");
});

test("normalizes real relation validity fields without changing legacy relations", async () => {
  const { client } = loadClient([{ envelope: { ok: true, data: {
    entities: [],
    relations: [
      { relationId: "open", validFrom: "ch001.ev001", validTo: "Infinity" },
      { relationId: "closed", validFrom: "ch001.ev001", validTo: "ch002.ev001" },
      { relationId: "legacy", storyTime: "ch003.ev001", closed: false },
    ],
  }, error: null } }]);
  const result = await client.getGraph("ch003.ev001", true);
  assert.deepEqual(result.data.relations.map((relation: any) => ({
    id: relation.relationId,
    storyTime: relation.storyTime,
    closed: relation.closed,
    closedAt: relation.closedAt,
  })), [
    { id: "open", storyTime: "ch001.ev001", closed: false, closedAt: undefined },
    { id: "closed", storyTime: "ch001.ev001", closed: true, closedAt: "ch002.ev001" },
    { id: "legacy", storyTime: "ch003.ev001", closed: false, closedAt: undefined },
  ]);
});

test("maps real search result fields to the frontend entity result shape", async () => {
  const { client } = loadClient([{ envelope: { ok: true, data: { results: [{
    entityId: "char-1",
    type: "character",
    score: 0.9,
    matchType: "fulltext",
    snapshot: { summary: "主角", properties: [{ property: "name", value: "阿明" }] },
  }] }, error: null } }]);
  const result = await client.search("阿明", "ch001.ev001");
  assert.deepEqual(result.data.results, [{
    id: "char-1", type: "entity", entityType: "character", name: "阿明", summary: "主角",
  }]);
});

test("preserves history fields and adds frontend entity/properties/declarations", async () => {
  const history = {
    entities: [{ entityId: "char-1", type: "character", summary: "主角", validFrom: "t1", validTo: "Infinity" }],
    facts: [
      { declarationId: "old", property: "mood", value: "平静", validFrom: "t1", validTo: "t2", createdAt: "r1" },
      { declarationId: "new", property: "mood", value: "愤怒", validFrom: "t2", validTo: "Infinity", updatedAt: "r2" },
    ],
    relations: [{ relationId: "rel-1", validFrom: "t1", validTo: "Infinity" }],
  };
  const { client } = loadClient([{ envelope: { ok: true, data: history, error: null } }]);
  const result = await client.getEntityHistory("char-1");
  assert.deepEqual(result.data.entities, history.entities);
  assert.deepEqual(result.data.facts, history.facts);
  assert.deepEqual(result.data.relations, [{
    ...history.relations[0], storyTime: "t1", closed: false,
  }]);
  assert.equal(result.data.entity.entityType, "character");
  assert.deepEqual(result.data.entity.properties, { mood: "愤怒" });
  assert.deepEqual(result.data.declarations, history.facts);
});

test("keeps UI preferences local and sends only server config fields", async () => {
  const { client, calls, storage } = loadClient([
    { envelope: { ok: true, data: { launcher: { lastProjectDir: "D:/novel" } }, error: null } },
    { envelope: { ok: true, data: { saved: true }, error: null } },
  ]);
  const localOnly = await client.setAppConfig({ theme: "dark", fontSize: 16, autoSave: true });
  assert.equal(localOnly.ok, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(storage.get("ne-frontend-ui-prefs")!), { theme: "dark", fontSize: 16, autoSave: true });

  const config = await client.getAppConfig();
  assert.deepEqual(config.data, {
    launcher: { lastProjectDir: "D:/novel" }, theme: "dark", fontSize: 16, autoSave: true,
  });
  await client.setAppConfig({ theme: "light", embedder: { model: "bge-small" } });
  assert.equal(calls[1].url, "/api/admin/app-config");
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].options.body), { embedder: { model: "bge-small" } });
});

test("rejects folder operations without fetch and maps .md node operations", async () => {
  const { client, calls } = loadClient();
  for (const result of [
    await client.createFolder("正文/新目录"),
    await client.renameNode("正文/旧目录", "正文/新目录"),
    await client.deleteNode("正文/旧目录"),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UNSUPPORTED_OPERATION");
  }
  assert.equal(calls.length, 0);

  await client.renameNode("正文/旧.md", "正文/新.md");
  await client.deleteNode("正文/新.md");
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ["/api/files/rename", "POST"],
    ["/api/files/delete", "POST"],
  ]);
});

function loadMockApi() {
  return new Function(
    "setTimeout",
    `${mockDataCode}\n${mockCode}\n;return { getChain, MOCK_EVENTS };`,
  )(setTimeout) as {
    getChain: (eventId: string) => { events: Array<{ eventId: string }> };
    MOCK_EVENTS: Array<{ eventId: string; causes: string[] }>;
  };
}

test("getChain 对 causes 环不死循环且不重复收集（L-Test-3 / L-FE-5）", () => {
  const { getChain, MOCK_EVENTS } = loadMockApi();
  MOCK_EVENTS.length = 0;
  MOCK_EVENTS.push(
    { eventId: "evt-a", causes: ["evt-b"] },
    { eventId: "evt-b", causes: ["evt-a"] },
    { eventId: "evt-c", causes: [] },
  );

  const chain = getChain("evt-a");
  const ids = chain.events.map((event) => event.eventId);
  assert.deepEqual(ids, ["evt-a", "evt-b"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("getSchedulerStatus sends GET /scheduler/status", async () => {
  const { client, calls } = loadClient();
  await client.getSchedulerStatus();
  assert.equal(calls[0].url, "/api/scheduler/status");
  assert.equal(calls[0].options.method, "GET");
});

test("getSchedulerPlan sends GET /scheduler/plans/:id", async () => {
  const { client, calls } = loadClient();
  await client.getSchedulerPlan("plan-001");
  assert.equal(calls[0].url, "/api/scheduler/plans/plan-001");
  assert.equal(calls[0].options.method, "GET");
});

test("commitPlan sends POST /scheduler/commit with planId", async () => {
  const { client, calls } = loadClient();
  await client.commitPlan("plan-001");
  assert.equal(calls[0].url, "/api/scheduler/commit");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(calls[0].options.body), { planId: "plan-001" });
});

test("discardPlan sends POST /scheduler/discard with planId", async () => {
  const { client, calls } = loadClient();
  await client.discardPlan("plan-001");
  assert.equal(calls[0].url, "/api/scheduler/discard");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(calls[0].options.body), { planId: "plan-001" });
});
