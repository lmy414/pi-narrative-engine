// tests/chat-routes.test.ts
/**
 * 主会话聊天路由单测（C3 验收，stub ChatContext / registry / session，不调 LLM）
 *
 * 断言（docs/api/chat.md 契约）：
 * - 非 /api/chat 路径不命中
 * - POST message：无活跃项目 409 / 缺 text 400 / isStreaming 409 / 成功 200
 * - GET status：会话状态（只读，不触发 ensureHost）
 * - GET events：SSE 推送 session 事件，断开取消订阅
 * - 未知子路径 404
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { handleChatApi } from "../src/app/routes-chat.ts";
import type { ChatContext } from "../src/app/chat-context.ts";
import type { ProjectHandle } from "../src/app/project-registry.ts";

// ----------------------------------------------------------------------------
// stubs

interface StubSession {
  isStreaming: boolean;
  systemPrompt: string;
  promptCalls: string[];
  prompt: (text: string, opts?: { preflightResult?: (ok: boolean) => void }) => Promise<void>;
  subscribe: (cb: (event: unknown) => void) => () => void;
}

function makeHost(session: StubSession, cwd = "/proj") {
  return { session, cwd, modelFallbackMessage: undefined };
}

function makeSession(overrides?: Partial<StubSession>): StubSession {
  const promptCalls: string[] = [];
  const session: StubSession = {
    isStreaming: false,
    systemPrompt: "system-prompt-stub",
    promptCalls,
    prompt: async (text, opts) => {
      promptCalls.push(text);
      opts?.preflightResult?.(true);
    },
    subscribe: () => () => {},
    ...overrides,
  };
  return session;
}

const HANDLE = {
  dir: "/proj",
  meta: { name: "proj" },
  wg: {},
  search: {},
  forceFulltext: false,
} as unknown as ProjectHandle;

function makeCtx(overrides: {
  host?: ReturnType<typeof makeHost> | null;
  activeHandle?: ProjectHandle | null;
}): { chatContext: ChatContext; registry: { getActive: () => ProjectHandle | null } } {
  const chatContext = {
    ensureHost: async () => overrides.host ?? null,
    activeHost: overrides.host ?? null,
    dispose: async () => {},
  } as unknown as ChatContext;
  const registry = {
    getActive: () => overrides.activeHandle === undefined ? HANDLE : overrides.activeHandle,
  };
  return { chatContext, registry };
}

/** mock req/res（参考 tests/debug/sse.test.ts） */
function mockReqRes() {
  const writes: string[] = [];
  const headers: Record<string, string | number | string[]> = {};
  let ended = false;
  const reqEmitter = new EventEmitter();
  const req = Object.assign(reqEmitter, { method: "GET", url: "/api/chat/x" }) as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, h?: Record<string, string | number | string[]>) {
      headers["_status"] = status;
      if (h) Object.assign(headers, h);
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) writes.push(chunk);
      ended = true;
    },
  } as unknown as ServerResponse;
  return { req, res, writes, headers, ended: () => ended, emitClose: () => reqEmitter.emit("close") };
}

async function call(
  ctx: { chatContext: ChatContext; registry: { getActive: () => ProjectHandle | null } },
  method: string,
  path: string,
  body?: unknown,
) {
  const { req, res, writes, headers } = mockReqRes();
  (req as { method: string }).method = method;
  const hit = await handleChatApi(ctx, req, res, new URL(`http://localhost${path}`), body ?? null);
  let json: { ok: boolean; data: unknown; error: { code: string; message: string } | null } | null = null;
  const bodyStr = writes.join("");
  if (bodyStr) {
    try { json = JSON.parse(bodyStr) as typeof json; } catch { json = null; }
  }
  return { hit, status: headers["_status"] as number, json, writes, ended: bodyStr !== "" };
}

// ----------------------------------------------------------------------------

test("非 /api/chat 路径不命中", async () => {
  const ctx = makeCtx({});
  const { hit, ended } = await call(ctx, "GET", "/api/world/entities");
  assert.equal(hit, false);
  assert.equal(ended, false, "未命中不应写出响应");
});

test("POST message：无活跃项目 → 409 NO_ACTIVE_PROJECT", async () => {
  const ctx = makeCtx({ activeHandle: null });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "hi" });
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "NO_ACTIVE_PROJECT");
});

test("POST message：缺 text → 400 MISSING_FIELD", async () => {
  const ctx = makeCtx({});
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", {});
  assert.equal(hit, true);
  assert.equal(status, 400);
  assert.equal(json?.error?.code, "MISSING_FIELD");
});

test("POST message：isStreaming → 409 CHAT_BUSY", async () => {
  const session = makeSession({ isStreaming: true });
  const ctx = makeCtx({ host: makeHost(session) });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "hi" });
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "CHAT_BUSY");
  assert.equal(session.promptCalls.length, 0, "忙碌时不应调用 prompt");
});

test("POST message：成功 → 200 received + preflight 语义", async () => {
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session) });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "你好" });
  assert.equal(hit, true);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, data: { received: true }, error: null });
  assert.deepEqual(session.promptCalls, ["你好"]);
});

test("POST message：preflight 失败 → 400 MODEL_NOT_READY", async () => {
  const session = makeSession({
    prompt: async (_text, opts) => { opts?.preflightResult?.(false); },
  });
  const ctx = makeCtx({ host: makeHost(session) });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "hi" });
  assert.equal(hit, true);
  assert.equal(status, 400);
  assert.equal(json?.error?.code, "MODEL_NOT_READY");
});

test("GET status：只读不触发 ensureHost（未启动时 active=false）", async () => {
  const ctx = makeCtx({ host: null });
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/status");
  assert.equal(hit, true);
  assert.equal(status, 200);
  assert.equal(json?.ok, true);
  const data = json?.data as { active: boolean; cwd: string | null; isStreaming: boolean; systemPrompt: string | null };
  assert.equal(data.active, false);
  assert.equal(data.cwd, null);
  assert.equal(data.systemPrompt, null);
});

test("GET status：已启动时返回会话状态", async () => {
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session) });
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/status");
  assert.equal(hit, true);
  assert.equal(status, 200);
  const data = json?.data as { active: boolean; cwd: string; isStreaming: boolean; systemPrompt: string };
  assert.equal(data.active, true);
  assert.equal(data.cwd, "/proj");
  assert.equal(data.isStreaming, false);
  assert.equal(data.systemPrompt, "system-prompt-stub");
});

test("GET /api/chat/unknown → 404 NOT_FOUND", async () => {
  const ctx = makeCtx({});
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/whatever");
  assert.equal(hit, true);
  assert.equal(status, 404);
  assert.equal(json?.error?.code, "NOT_FOUND");
});

test("GET events（SSE）：订阅 session 事件并推送，断开取消订阅", async () => {
  let listener: ((event: unknown) => void) | null = null;
  let unsubscribed = false;
  const session = makeSession({
    subscribe: (cb) => {
      listener = cb;
      return () => { unsubscribed = true; };
    },
  });
  const ctx = makeCtx({ host: makeHost(session) });
  const { req, res, writes, emitClose } = mockReqRes();
  const hit = await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.equal(hit, true);
  // 推送事件 → data 行
  assert.ok(listener, "应已订阅 session");
  listener!({ type: "message_update", message: { content: "x" } });
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.ok(dataLines.length === 1 && dataLines[0].includes("message_update"), "事件应以 SSE data 行推送");

  emitClose();
  assert.equal(unsubscribed, true, "客户端断开应取消订阅");
});
