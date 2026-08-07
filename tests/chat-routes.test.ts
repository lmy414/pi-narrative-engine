// tests/chat-routes.test.ts
/**
 * 主会话聊天路由单测（C3 验收，stub ChatContext / registry / session，不调 LLM）
 *
 * 断言（docs/api/chat.md 契约）：
 * - 非 /api/chat 路径不命中
 * - POST message：无活跃项目 409 / 缺 text 400 / isStreaming 409 / 成功 200
 * - GET status：多 session 状态（只读，不触发 ensureHost）
 * - GET events：SSE 多路复用，订阅 ChatContext.subscribe，断开取消订阅
 * - 未知子路径 404
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handleChatApi } from "../src/app/routes-chat.ts";
import { ChatContext } from "../src/app/chat-context.ts";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import type { ProjectHandle } from "../src/app/project-registry.ts";
import type { MainSessionHost, MainSessionHostOptions } from "../src/chat/main-session.ts";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { LlmConfigStore } from "../src/orchestrator/llm-config.ts";
import type { OrchestratorService } from "../src/orchestrator/service.ts";
import type { Embedder } from "../src/embedder.ts";
import type { WorldGraph } from "underworld-graph";
import type { Search } from "../src/search.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionPool, type SessionHandle, type SessionStatus } from "../src/chat/session-pool.ts";

// ----------------------------------------------------------------------------
// stubs

interface StubSession {
  isStreaming: boolean;
  systemPrompt: string;
  sessionId: string;
  promptCalls: string[];
  prompt: (text: string, opts?: { preflightResult?: (ok: boolean) => void }) => Promise<void>;
  subscribe: (cb: (event: unknown) => void) => () => void;
}

interface StubHost {
  session: StubSession;
  cwd: string;
  modelFallbackMessage: string | undefined;
  switchSessionCalls: string[];
  newSessionCalls: number;
  switchSession: (path: string) => Promise<void>;
  newSession: () => Promise<void>;
}

function makeHost(session: StubSession, cwd = "/proj"): StubHost {
  return {
    session,
    cwd,
    modelFallbackMessage: undefined,
    switchSessionCalls: [],
    newSessionCalls: 0,
    // G2 stub：会话切换/新建（真实由 runtime 完成，测试只记录调用）
    switchSession: async (path: string) => { /* stub */ void path; },
    newSession: async () => { /* stub */ },
  };
}

function makeSession(overrides?: Partial<StubSession>): StubSession {
  const promptCalls: string[] = [];
  const session: StubSession = {
    isStreaming: false,
    systemPrompt: "system-prompt-stub",
    sessionId: "stub-session-id",
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
  host?: StubHost | null;
  activeHandle?: ProjectHandle | null;
  createSessionResult?: SessionInfo;
  activateSessionResult?: SessionInfo;
  createSessionError?: { code: string; message: string };
  activateSessionError?: { code: string; message: string };
  /** sendChatMessage 结果（默认按 host.session.isStreaming 判断 CHAT_BUSY） */
  sendChatMessageResult?: { preflightSucceeded: boolean; sessionId: string };
  /** sendChatMessage 抛错（CHAT_BUSY/MODEL_NOT_READY 等） */
  sendChatMessageError?: { code: string; message: string };
  /** abortChat 结果/抛错（中断生成） */
  abortChatResult?: { aborted: boolean; sessionId: string };
  abortChatError?: { code: string; message: string };
  /** 自定义 sessionPool（不传时按 host 自动构造） */
  pool?: SessionPool;
  /** SSE 订阅回调收集（外部传入用于断言事件推送） */
  subscribers?: Array<(event: unknown) => void>;
}): { chatContext: ChatContext; registry: { getActive: () => ProjectHandle | null } } {
  // 默认池：按 host 构造一个活跃 handle
  const pool = overrides.pool ?? new SessionPool();
  if (overrides.host && pool.size === 0) {
    const handle: SessionHandle = {
      id: overrides.host.session.sessionId,
      host: overrides.host as unknown as MainSessionHost,
      status: overrides.host.session.isStreaming ? "streaming" : "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    pool.set(handle);
    pool.setActive(handle.id);
  }

  const subscribers = overrides.subscribers ?? [];
  const chatContext = {
    ensureHost: async () => overrides.host ?? null,
    activeHost: overrides.host ?? null,
    sessionPool: pool,
    listSessions: async () => [] as SessionInfo[],
    createSession: async () => {
      if (overrides.createSessionError) {
        const err = new Error(overrides.createSessionError.message) as Error & { code: string };
        err.code = overrides.createSessionError.code;
        throw err;
      }
      return overrides.createSessionResult ?? makeSessionInfo("new-stub-id");
    },
    activateSession: async (_id: string) => {
      if (overrides.activateSessionError) {
        const err = new Error(overrides.activateSessionError.message) as Error & { code: string };
        err.code = overrides.activateSessionError.code;
        throw err;
      }
      return overrides.activateSessionResult ?? makeSessionInfo("activated-stub-id");
    },
    sendChatMessage: async (_text: string) => {
      if (overrides.sendChatMessageError) {
        const err = new Error(overrides.sendChatMessageError.message) as Error & { code: string };
        err.code = overrides.sendChatMessageError.code;
        throw err;
      }
      return overrides.sendChatMessageResult ?? { preflightSucceeded: true, sessionId: overrides.host?.session.sessionId ?? "stub-session-id" };
    },
    abortChat: async (sessionId?: string) => {
      if (overrides.abortChatError) {
        const err = new Error(overrides.abortChatError.message) as Error & { code: string };
        err.code = overrides.abortChatError.code;
        throw err;
      }
      return overrides.abortChatResult ?? { aborted: true, sessionId: sessionId ?? overrides.host?.session.sessionId ?? "stub-session-id" };
    },
    subscribe: (cb: (event: unknown) => void) => {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
    dispose: async () => {},
  } as unknown as ChatContext;
  const registry = {
    getActive: () => overrides.activeHandle === undefined ? HANDLE : overrides.activeHandle,
  };
  return { chatContext, registry };
}

/** 构造测试用 SessionInfo（含 path 字段，G2 端点需要） */
function makeSessionInfo(id: string, overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    path: `/proj/.pi/sessions/20260805_${id}.jsonl`,
    id,
    cwd: "/proj",
    created: new Date("2026-08-05T00:00:00Z"),
    modified: new Date("2026-08-05T00:00:00Z"),
    messageCount: 0,
    firstMessage: "(no messages)",
    allMessagesText: "",
    ...overrides,
  };
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
    flushHeaders() {
      headers["_flushed"] = 1;
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

test("ChatContext.ensureHost：A→B→A 重建 host 并隔离项目 provider/storyTime", async () => {
  const originalEnv = {
    provider: process.env.NE_LLM_PROVIDER,
    model: process.env.NE_LLM_MODEL,
    apiKey: process.env.NE_LLM_API_KEY,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
  };
  delete process.env.NE_LLM_PROVIDER;
  delete process.env.NE_LLM_MODEL;
  delete process.env.NE_LLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  const relationCalls: Array<{ project: string; storyTime: string }> = [];
  const handles = new Map(["/project-a", "/project-b"].map(dir => {
    const project = dir.at(-1)!;
    const wg = {
      processEvent: async () => {},
      addRelation: async (_source: string, _target: string, _label: string, storyTime: string) => {
        relationCalls.push({ project, storyTime });
      },
    } as WorldGraph;
    return [dir, { dir, meta: { name: project }, wg, search: { project } as unknown as Search, forceFulltext: false } as ProjectHandle];
  }));
  let active = handles.get("/project-a")!;
  const registry = { getActive: () => active };
  const hostOptions: MainSessionHostOptions[] = [];
  const disposed: string[] = [];
  const llmStore = new LlmConfigStore();
  llmStore.setConfig("default", {
    model: { provider: "deepseek", name: "deepseek-v4-flash" },
    apiKey: "configured-key",
  });

  const context = new ChatContext({
    registry: registry as never,
    llmStore,
    configDir: "/config",
    embedder: {} as Embedder,
    createOrchestratorService: async () => ({} as OrchestratorService),
    createHost(options) {
      hostOptions.push(options);
      return {
        cwd: options.cwd,
        session: makeSession(),
        modelFallbackMessage: undefined,
        start: async () => {},
        dispose: async () => { disposed.push(options.cwd); },
        switchSession: async () => {},
        newSession: async () => {},
      } as unknown as MainSessionHost;
    },
  });

  try {
    const hostA1 = await context.ensureHost();
    assert.equal(hostOptions[0]?.runtimeApiKey?.apiKey, "configured-key");
    const eventA = hostOptions[0]!.customTools.find(tool => tool.name === "world_event_apply")!;
    await eventA.execute("event-a", { event: { eventId: "a1", type: "change", storyTime: "ch001.ev001", entityId: "e1" } }, undefined, undefined, {} as never);

    active = handles.get("/project-b")!;
    const hostB = await context.ensureHost();
    assert.notEqual(hostB, hostA1);
    const relationB = hostOptions[1]!.customTools.find(tool => tool.name === "world_relation_add")!;
    await assert.rejects(() => relationB.execute("relation-b", { sourceId: "e1", targetId: "e2", label: "knows" }, undefined, undefined, {} as never), /storyTime required/);
    const eventB = hostOptions[1]!.customTools.find(tool => tool.name === "world_event_apply")!;
    await eventB.execute("event-b", { event: { eventId: "b1", type: "change", storyTime: "ch009.ev003", entityId: "e1" } }, undefined, undefined, {} as never);

    active = handles.get("/project-a")!;
    const hostA2 = await context.ensureHost();
    assert.notEqual(hostA2, hostA1);
    const relationA = hostOptions[2]!.customTools.find(tool => tool.name === "world_relation_add")!;
    await relationA.execute("relation-a", { sourceId: "e1", targetId: "e2", label: "knows" }, undefined, undefined, {} as never);

    assert.deepEqual(hostOptions.map(options => options.cwd), ["/project-a", "/project-b", "/project-a"]);
    assert.deepEqual(disposed, ["/project-a", "/project-b"]);
    assert.deepEqual(relationCalls, [{ project: "a", storyTime: "ch001.ev001" }]);
  } finally {
    await context.dispose();
    for (const [name, value] of Object.entries(originalEnv)) {
      const envName = name === "provider" ? "NE_LLM_PROVIDER" : name === "model" ? "NE_LLM_MODEL" : name === "apiKey" ? "NE_LLM_API_KEY" : "DEEPSEEK_API_KEY";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});

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
  const ctx = makeCtx({
    host: makeHost(session),
    sendChatMessageError: { code: "CHAT_BUSY", message: "当前活跃会话正在生成" },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "hi" });
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "CHAT_BUSY");
});

test("POST message：成功 → 200 received + preflight 语义", async () => {
  const session = makeSession();
  const ctx = makeCtx({
    host: makeHost(session),
    sendChatMessageResult: { preflightSucceeded: true, sessionId: session.sessionId },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "你好" });
  assert.equal(hit, true);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, data: { received: true, sessionId: session.sessionId }, error: null });
});

test("POST message：preflight 失败 → 503 MODEL_NOT_READY", async () => {
  const session = makeSession();
  const ctx = makeCtx({
    host: makeHost(session),
    sendChatMessageError: { code: "MODEL_NOT_READY", message: "主会话模型不可用" },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/message", { text: "hi" });
  assert.equal(hit, true);
  assert.equal(status, 503);
  assert.equal(json?.error?.code, "MODEL_NOT_READY");
});

test("GET status：只读不触发 ensureHost（未启动时 active=false）", async () => {
  // 未启动：pool 为空，activeHandle 为 null
  const ctx = makeCtx({ host: null, activeHandle: null });
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/status");
  assert.equal(hit, true);
  assert.equal(status, 200);
  assert.equal(json?.ok, true);
  const data = json?.data as { active: boolean; cwd: string | null; isStreaming: boolean; systemPrompt: string | null; sessions: unknown[] };
  assert.equal(data.active, false);
  assert.equal(data.cwd, null);
  assert.equal(data.systemPrompt, null);
  assert.ok(Array.isArray(data.sessions), "应返回 sessions 数组");
});

test("GET status：已启动时返回会话状态（含多 session 字段）", async () => {
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session) });
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/status");
  assert.equal(hit, true);
  assert.equal(status, 200);
  const data = json?.data as {
    active: boolean;
    cwd: string;
    isStreaming: boolean;
    systemPrompt: string;
    sessionId: string;
    sessions: Array<{ sessionId: string; status: SessionStatus; isActive: boolean }>;
    backgroundStreaming: unknown[];
  };
  assert.equal(data.active, true);
  assert.equal(data.cwd, "/proj");
  assert.equal(data.isStreaming, false);
  assert.equal(data.systemPrompt, "system-prompt-stub");
  assert.equal(data.sessionId, "stub-session-id");
  assert.ok(Array.isArray(data.sessions), "应返回 sessions 数组");
  assert.equal(data.sessions.length, 1, "池中应有 1 个 session");
  assert.equal(data.sessions[0].sessionId, "stub-session-id");
  assert.equal(data.sessions[0].status, "idle");
  assert.equal(data.sessions[0].isActive, true);
  assert.ok(Array.isArray(data.backgroundStreaming), "应返回 backgroundStreaming 数组");
});

test("GET /api/chat/unknown → 404 NOT_FOUND", async () => {
  const ctx = makeCtx({});
  const { hit, status, json } = await call(ctx, "GET", "/api/chat/whatever");
  assert.equal(hit, true);
  assert.equal(status, 404);
  assert.equal(json?.error?.code, "NOT_FOUND");
});

test("GET events（SSE）：订阅 ChatContext 多路复用事件并推送，断开取消订阅", async () => {
  const subscribers: Array<(event: unknown) => void> = [];
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session), subscribers });
  const { req, res, writes, headers, emitClose } = mockReqRes();
  const hit = await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.equal(hit, true);
  // 连接建立即冲刷头部 + 发送 :connected 注释（空事件期间客户端也能确认连接）
  assert.equal(headers["_flushed"], 1, "应调用 flushHeaders 立即冲刷响应头");
  assert.equal(writes[0], ":connected\n\n", "首条写入应为连接确认注释");
  // 推送事件 → data 行（多路复用封装：{ type: 'pi', sessionId, event })
  assert.equal(subscribers.length, 1, "应已订阅 ChatContext");
  subscribers[0]({ type: "pi", sessionId: "s1", event: { type: "message_update", message: { content: "x" } } });
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.ok(dataLines.length === 1 && dataLines[0].includes("message_update"), "事件应以 SSE data 行推送");

  emitClose();
  assert.equal(subscribers.length, 0, "客户端断开应取消订阅");
});

test("GET events（SSE）：background_complete 合成事件推送", async () => {
  const subscribers: Array<(event: unknown) => void> = [];
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session), subscribers });
  const { req, res, writes, emitClose } = mockReqRes();
  await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.equal(subscribers.length, 1, "应已订阅 ChatContext");
  subscribers[0]({ type: "background_complete", sessionId: "s1", timestamp: Date.now() });
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.equal(dataLines.length, 1, "应推送 1 条 background_complete 事件");
  const parsed = JSON.parse(dataLines[0].slice("data: ".length, -2));
  assert.equal(parsed.type, "background_complete");
  assert.equal(parsed.sessionId, "s1");

  emitClose();
});

test("GET events（SSE）：各类 PI 事件经多路复用通道推送（L-Test-4）", async () => {
  const subscribers: Array<(event: unknown) => void> = [];
  const session = makeSession();
  const ctx = makeCtx({ host: makeHost(session), subscribers });
  const { req, res, writes, emitClose } = mockReqRes();
  await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.equal(subscribers.length, 1, "应已订阅 ChatContext");
  // 多路复用封装：{ type: 'pi', sessionId, event } 原样推送（前端按 event.type 分支处理）
  const samples = [
    { type: "session_start", sessionId: "s1" },
    { type: "session_end", sessionId: "s1" },
    { type: "tool_execution", tool: { name: "world_query" }, state: "running" },
    { type: "message_update", message: { content: "流式" }, done: false },
  ];
  for (const sample of samples) {
    subscribers[0]({ type: "pi", sessionId: "s1", event: sample });
  }
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.equal(dataLines.length, samples.length, "每个事件一条 data 行");
  for (let i = 0; i < samples.length; i++) {
    const parsed = JSON.parse(dataLines[i].slice("data: ".length, -2));
    assert.equal(parsed.type, "pi", "外层 type 应为 pi");
    assert.equal(parsed.event.type, samples[i].type, `内层事件类型 ${samples[i].type} 原样透传`);
  }

  emitClose();
});

test("历史消息：聚合 toolCalls/provider/model/usage，并过滤 toolResult", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-chat-history-"));
  const projectDir = path.join(tmpDir, "project");
  const sessionDir = path.join(projectDir, ".pi", "sessions");
  fs.mkdirSync(projectDir, { recursive: true });
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(projectDir, sessionDir);
  manager.appendMessage({ role: "user", content: "开始", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "无工具回答" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 37,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
    },
    stopReason: "stop",
    timestamp: 2,
  } satisfies AssistantMessage);
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-ok", name: "read", arguments: {} },
      { type: "toolCall", id: "call-fail", name: "write", arguments: {} },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "toolUse",
    timestamp: 3,
  } satisfies AssistantMessage);
  manager.appendMessage(toolResult("call-ok", "read", false));
  manager.appendMessage(toolResult("orphan-result", "search", false));
  manager.appendMessage(toolResult("call-fail", "write", true));
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "残缺调用" },
      { type: "toolCall", id: "call-orphan", name: "search", arguments: {} },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-invalid-usage",
    usage: {
      input: -1,
      output: Number.NaN,
      cacheRead: Number.POSITIVE_INFINITY,
      cacheWrite: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -0.5 },
    },
    stopReason: "toolUse",
    timestamp: 7,
  } as unknown as AssistantMessage);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "非法总量" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-invalid-total",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.NaN,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 8,
  } satisfies AssistantMessage);

  const context = new ChatContext({
    registry: { getActive: () => ({ ...HANDLE, dir: projectDir }) } as unknown as ProjectRegistry,
    llmStore: new LlmConfigStore(),
    configDir: path.join(tmpDir, "config"),
  });

  try {
    const { status, json } = await call(
      { chatContext: context, registry: { getActive: () => ({ ...HANDLE, dir: projectDir }) } },
      "GET",
      `/api/chat/sessions/${manager.getSessionId()}/messages`,
    );
    assert.equal(status, 200);
    const data = json?.data as { id: string; messages: Array<Record<string, unknown>> };
    assert.equal(data.id, manager.getSessionId());
    assert.deepEqual(data.messages, [
      { role: "user", text: "开始", ts: data.messages[0].ts },
      {
        role: "assistant",
        text: "无工具回答",
        ts: data.messages[1].ts,
        provider: "openai",
        model: "gpt-test",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          totalTokens: 37,
          estimatedCostUsd: 0.37,
        },
      },
      {
        role: "assistant",
        text: "",
        ts: data.messages[2].ts,
        toolCalls: [
          { id: "call-ok", name: "read", status: "done", isError: false },
          { id: "call-fail", name: "write", status: "error", isError: true },
        ],
        provider: "anthropic",
        model: "claude-test",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 3,
          estimatedCostUsd: 0.01,
        },
      },
      {
        role: "assistant",
        text: "残缺调用",
        ts: data.messages[3].ts,
        toolCalls: [
          { id: "call-orphan", name: "search", status: "error", isError: true },
        ],
        provider: "openai",
        model: "gpt-invalid-usage",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 5,
          totalTokens: 5,
          estimatedCostUsd: 0,
        },
      },
      {
        role: "assistant",
        text: "非法总量",
        ts: data.messages[4].ts,
        provider: "openai",
        model: "gpt-invalid-total",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
      },
    ]);
    for (const message of data.messages) {
      assert.equal("name" in message, false);
      assert.equal("roleTag" in message, false);
      assert.equal("characterId" in message, false);
      assert.notEqual(message.role, "toolResult");
    }
  } finally {
    await context.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function toolResult(toolCallId: string, toolName: string, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
    isError,
    timestamp: Date.now(),
  };
}

test("项目隔离：真实 ProjectRegistry + ChatContext，storyTime 不跨项目泄漏", async () => {
  const tmpDir = path.join(os.tmpdir(), `narrative-isolation-${Date.now()}`);
  const projA = path.join(tmpDir, "proj-a");
  const projB = path.join(tmpDir, "proj-b");
  for (const dir of [projA, projB]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "novel.json"),
      JSON.stringify({ name: path.basename(dir), worldGraphDir: ".pi/world-graph" }),
    );
  }

  const originalEnv = {
    provider: process.env.NE_LLM_PROVIDER,
    model: process.env.NE_LLM_MODEL,
    apiKey: process.env.NE_LLM_API_KEY,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
  };
  delete process.env.NE_LLM_PROVIDER;
  delete process.env.NE_LLM_MODEL;
  delete process.env.NE_LLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  const registry = new ProjectRegistry();
  await registry.setActive(projA, { allowInit: true });

  const hostOptions: MainSessionHostOptions[] = [];
  const disposed: string[] = [];
  const storyTimeLog: string[] = [];
  const llmStore = new LlmConfigStore();
  llmStore.setConfig("default", {
    model: { provider: "deepseek", name: "deepseek-v4-flash" },
    apiKey: "configured-key",
  });

  const context = new ChatContext({
    registry,
    llmStore,
    configDir: "/config",
    embedder: {} as Embedder,
    createOrchestratorService: async () => ({} as OrchestratorService),
    createHost(options) {
      hostOptions.push(options);
      return {
        cwd: options.cwd,
        session: makeSession(),
        modelFallbackMessage: undefined,
        start: async () => {},
        dispose: async () => { disposed.push(options.cwd); },
        switchSession: async () => {},
        newSession: async () => {},
      } as unknown as MainSessionHost;
    },
  });

  try {
    // 激活项目 A，设置 storyTime
    const hostA1 = await context.ensureHost();
    assert.equal(hostOptions[0]?.runtimeApiKey?.apiKey, "configured-key");
    assert.equal(hostOptions[0]?.cwd, projA);
    const eventA = hostOptions[0]!.customTools.find(tool => tool.name === "world_event_apply")!;
    await eventA.execute("event-a", { event: { eventId: "a1", type: "change", storyTime: "ch001.ev001", entityId: "e1" } }, undefined, undefined, {} as never);
    storyTimeLog.push("A:ch001.ev001");

    // 切换到项目 B，设置不同 storyTime
    await registry.setActive(projB, { allowInit: true });
    const hostB = await context.ensureHost();
    assert.notEqual(hostB, hostA1);
    // B 没有 storyTime → relation_add 应拒绝
    const relationB = hostOptions[1]!.customTools.find(tool => tool.name === "world_relation_add")!;
    await assert.rejects(() => relationB.execute("rel-b", { sourceId: "e1", targetId: "e2", label: "knows" }, undefined, undefined, {} as never), /storyTime required/);
    const eventB = hostOptions[1]!.customTools.find(tool => tool.name === "world_event_apply")!;
    await eventB.execute("event-b", { event: { eventId: "b1", type: "change", storyTime: "ch009.ev003", entityId: "e1" } }, undefined, undefined, {} as never);
    storyTimeLog.push("B:ch009.ev003");

    // 切回项目 A，验证 storyTime 恢复为 ch001.ev001
    await registry.setActive(projA, { allowInit: true });
    const hostA2 = await context.ensureHost();
    assert.notEqual(hostA2, hostA1);
    // A 的 storyTime 应仍为 ch001.ev001（relation_add 不需要 storyTime 参数）
    const relationA = hostOptions[2]!.customTools.find(tool => tool.name === "world_relation_add")!;
    await relationA.execute("rel-a", { sourceId: "e1", targetId: "e2", label: "knows" }, undefined, undefined, {} as never);

    // 验证日志
    assert.deepEqual(hostOptions.map(o => o.cwd), [projA, projB, projA]);
    assert.deepEqual(disposed, [projA, projB]);
    assert.deepEqual(storyTimeLog, ["A:ch001.ev001", "B:ch009.ev003"]);
  } finally {
    await context.dispose();
    await registry.closeAll();
    // 清理临时目录
    for (const dir of [projA, projB]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const [name, value] of Object.entries(originalEnv)) {
      const envName = name === "provider" ? "NE_LLM_PROVIDER" : name === "model" ? "NE_LLM_MODEL" : name === "apiKey" ? "NE_LLM_API_KEY" : "DEEPSEEK_API_KEY";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});

// ============================================================================
// G2 会话管理端点（POST /sessions, POST /sessions/:id/activate, GET /sessions 扩展 path）
// ============================================================================

test("POST /api/chat/sessions：无活跃项目 → 409 NO_ACTIVE_PROJECT", async () => {
  const ctx = makeCtx({ activeHandle: null });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions", {});
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "NO_ACTIVE_PROJECT");
});

test("POST /api/chat/sessions：streaming 中不再阻塞（多 session 并存，旧会话后台继续）", async () => {
  // 多 session 并存设计：createSession 不再检查 isStreaming，新会话创建后旧会话保持存活
  const session = makeSession({ isStreaming: true });
  const newInfo = makeSessionInfo("new-session-bg", {
    messageCount: 0,
    firstMessage: "(no messages)",
  });
  const ctx = makeCtx({
    host: makeHost(session),
    createSessionResult: newInfo,
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions", {});
  assert.equal(hit, true);
  assert.equal(status, 200, "streaming 中创建新会话应成功（不中断旧会话生成）");
  const data = json?.data as { session: { id: string; live: boolean } };
  assert.equal(data.session.id, "new-session-bg");
  assert.equal(data.session.live, true);
});

test("POST /api/chat/sessions：成功 → 200 新会话 live=true", async () => {
  const newInfo = makeSessionInfo("new-session-123", {
    messageCount: 0,
    firstMessage: "(no messages)",
  });
  const ctx = makeCtx({ host: makeHost(makeSession()), createSessionResult: newInfo });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions", {});
  assert.equal(hit, true);
  assert.equal(status, 200);
  const data = json?.data as { session: { id: string; live: boolean; path: string; messageCount: number } };
  assert.equal(data.session.id, "new-session-123");
  assert.equal(data.session.live, true);
  assert.equal(data.session.path, newInfo.path);
  assert.equal(data.session.messageCount, 0);
});

test("POST /api/chat/sessions/:id/activate：会话不存在 → 404 SESSION_NOT_FOUND", async () => {
  const ctx = makeCtx({
    host: makeHost(makeSession()),
    activateSessionError: { code: "SESSION_NOT_FOUND", message: "会话不存在: bad-id" },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions/bad-id/activate", {});
  assert.equal(hit, true);
  assert.equal(status, 404);
  assert.equal(json?.error?.code, "SESSION_NOT_FOUND");
});

test("POST /api/chat/sessions/:id/activate：streaming 中不阻塞（多 session 并存，旧会话后台继续）", async () => {
  // 多 session 并存：activateSession 不再检查 streaming，切换不中断旧会话生成
  const session = makeSession({ isStreaming: true });
  const activated = makeSessionInfo("activated-while-streaming", {
    messageCount: 3,
    firstMessage: "切换中",
  });
  const ctx = makeCtx({
    host: makeHost(session),
    activateSessionResult: activated,
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions/activated-while-streaming/activate", {});
  assert.equal(hit, true);
  assert.equal(status, 200, "streaming 中切换会话应成功（不中断旧会话生成）");
  const data = json?.data as { session: { id: string; live: boolean } };
  assert.equal(data.session.id, "activated-while-streaming");
  assert.equal(data.session.live, true);
});

test("POST /api/chat/sessions/:id/activate：成功 → 200 live 转移", async () => {
  const activated = makeSessionInfo("activated-session-456", {
    messageCount: 5,
    firstMessage: "开始",
  });
  const ctx = makeCtx({
    host: makeHost(makeSession()),
    activateSessionResult: activated,
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions/activated-session-456/activate", {});
  assert.equal(hit, true);
  assert.equal(status, 200);
  const data = json?.data as { session: { id: string; live: boolean; messageCount: number; firstMessage: string } };
  assert.equal(data.session.id, "activated-session-456");
  assert.equal(data.session.live, true);
  assert.equal(data.session.messageCount, 5);
  assert.equal(data.session.firstMessage, "开始");
});

test("GET /api/chat/sessions：响应含 path 字段（G2 切换需要）", async () => {
  // 用真实 ChatContext + 临时目录，验证 SessionInfo.path 透出
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-sessions-list-"));
  const projectDir = path.join(tmpDir, "project");
  const sessionDir = path.join(projectDir, ".pi", "sessions");
  fs.mkdirSync(projectDir, { recursive: true });
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(projectDir, sessionDir);
  // SDK 行为：只有 assistant 消息到达才 flush 文件（_persist hasAssistant 检查）
  manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    stopReason: "stop",
    timestamp: 2,
  } satisfies AssistantMessage);

  const context = new ChatContext({
    registry: { getActive: () => ({ ...HANDLE, dir: projectDir }) } as unknown as ProjectRegistry,
    llmStore: new LlmConfigStore(),
    configDir: path.join(tmpDir, "config"),
  });

  try {
    const { hit, status, json } = await call(
      { chatContext: context, registry: { getActive: () => ({ ...HANDLE, dir: projectDir }) } },
      "GET",
      "/api/chat/sessions",
    );
    assert.equal(hit, true);
    assert.equal(status, 200);
    const data = json?.data as { sessions: Array<{ id: string; path: string; live: boolean }> };
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].id, manager.getSessionId());
    assert.ok(data.sessions[0].path.endsWith(".jsonl"), "path 应为 .jsonl 文件路径");
    assert.equal(data.sessions[0].live, false, "无 host 启动时 live=false");
  } finally {
    await context.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("启动恢复：continueRecent 在有最近会话时复用旧文件", async () => {
  // 验证 MainSessionHost.start() 用 continueRecent（有最近会话则 open 旧文件）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-restore-"));
  const projectDir = path.join(tmpDir, "project");
  const sessionDir = path.join(projectDir, ".pi", "sessions");
  const agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  // 先创建一个会话，写入 user + assistant 消息（SDK 行为：只有 assistant 消息才 flush 文件）
  const manager1 = SessionManager.create(projectDir, sessionDir);
  const existingId = manager1.getSessionId();
  manager1.appendMessage({ role: "user", content: "previous", timestamp: 1 });
  manager1.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    stopReason: "stop",
    timestamp: 2,
  } satisfies AssistantMessage);

  // 再用 MainSessionHost 启动（应恢复 existingId）
  const { MainSessionHost } = await import("../src/chat/main-session.ts");
  const host = new MainSessionHost({
    agentDir,
    cwd: projectDir,
    sessionDir,
    customTools: [],
  });
  await host.start();
  try {
    assert.equal(host.session.sessionId, existingId, "启动应恢复最近会话 id");
  } finally {
    await host.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("启动恢复：无会话时新建空会话", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-restore-empty-"));
  const projectDir = path.join(tmpDir, "project");
  const sessionDir = path.join(projectDir, ".pi", "sessions");
  const agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const { MainSessionHost } = await import("../src/chat/main-session.ts");
  const host = new MainSessionHost({
    agentDir,
    cwd: projectDir,
    sessionDir,
    customTools: [],
  });
  await host.start();
  try {
    assert.ok(host.session.sessionId, "无会话时应新建空会话");
    // SDK 行为：newSession 后只有 assistant 消息到达才 flush 文件；
    // 此处无消息发送，sessionDir 可能为空或只有未 flush 的内存会话。
    // 验证 sessionId 非空即足够（文件落盘在首条 assistant 消息后）。
  } finally {
    await host.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SessionPool 单测（多 session 并存核心）
// ============================================================================

function makePoolHandle(id: string, status: SessionStatus = "idle"): SessionHandle {
  return {
    id,
    host: { cwd: "/proj" } as unknown as MainSessionHost,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("SessionPool：多 session 并存，setActive 切换不 dispose 旧 handle", () => {
  const pool = new SessionPool();
  const h1 = makePoolHandle("s1", "streaming");
  const h2 = makePoolHandle("s2", "idle");
  pool.set(h1);
  pool.set(h2);
  pool.setActive("s1");
  assert.equal(pool.getActive()?.id, "s1");
  assert.equal(pool.size, 2, "池中应有 2 个 session");

  // 切换活跃到 s2，s1 应仍在池中（不被 dispose）
  pool.setActive("s2");
  assert.equal(pool.getActive()?.id, "s2");
  assert.equal(pool.get("s1")?.id, "s1", "切换后 s1 仍应在池中");
  assert.equal(pool.size, 2, "切换不应减少池大小");
});

test("SessionPool：getBackgroundStreaming 返回非活跃且 streaming 的会话", () => {
  const pool = new SessionPool();
  const active = makePoolHandle("active", "idle");
  const bg1 = makePoolHandle("bg1", "streaming");
  const bg2 = makePoolHandle("bg2", "streaming");
  const idle = makePoolHandle("idle", "idle");
  pool.set(active);
  pool.set(bg1);
  pool.set(bg2);
  pool.set(idle);
  pool.setActive("active");

  const bgList = pool.getBackgroundStreaming();
  assert.equal(bgList.length, 2, "应有 2 个后台生成中的会话");
  const bgIds = bgList.map((h) => h.id).sort();
  assert.deepEqual(bgIds, ["bg1", "bg2"]);
});

test("SessionPool：updateStatus 更新状态与 updatedAt", async () => {
  const pool = new SessionPool();
  const h = makePoolHandle("s1", "idle");
  pool.set(h);
  const before = h.updatedAt;
  // 确保时间戳推进
  await new Promise((r) => setTimeout(r, 5));
  pool.updateStatus("s1", "streaming");
  assert.equal(pool.get("s1")?.status, "streaming");
  assert.ok(pool.get("s1")!.updatedAt > before, "updatedAt 应更新");

  pool.updateStatus("s1", "error", "网络错误");
  assert.equal(pool.get("s1")?.status, "error");
  assert.equal(pool.get("s1")?.lastError, "网络错误");
});

test("SessionPool：remove 移除指定 handle，活跃被移除时 activeId 清空", () => {
  const pool = new SessionPool();
  const h1 = makePoolHandle("s1");
  pool.set(h1);
  pool.setActive("s1");
  assert.equal(pool.activeSessionId, "s1");

  const removed = pool.remove("s1");
  assert.equal(removed?.id, "s1");
  assert.equal(pool.size, 0);
  assert.equal(pool.activeSessionId, null, "活跃被移除后 activeId 应为 null");
  assert.equal(pool.getActive(), null);
});

test("SessionPool：setActive 不存在时抛错", () => {
  const pool = new SessionPool();
  assert.throws(() => pool.setActive("nonexistent"), /不存在/);
});

test("SessionPool：getAll 按 createdAt 升序", async () => {
  const pool = new SessionPool();
  const h1 = makePoolHandle("s1");
  pool.set(h1);
  await new Promise((r) => setTimeout(r, 5));
  const h2 = makePoolHandle("s2");
  pool.set(h2);
  await new Promise((r) => setTimeout(r, 5));
  const h3 = makePoolHandle("s3");
  pool.set(h3);

  const all = pool.getAll();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((h) => h.id), ["s1", "s2", "s3"], "应按 createdAt 升序");
});

test("SessionPool：clear 清空所有 handle与活跃指针", () => {
  const pool = new SessionPool();
  pool.set(makePoolHandle("s1"));
  pool.set(makePoolHandle("s2"));
  pool.setActive("s1");
  assert.equal(pool.size, 2);

  pool.clear();
  assert.equal(pool.size, 0);
  assert.equal(pool.activeSessionId, null);
  assert.equal(pool.getActive(), null);
});

// ============ 🟡 SessionPool LRU 上限（2026-08-08） ============

test("SessionPool：超上限时淘汰最旧非活跃 handle 并 dispose host", async () => {
  const pool = new SessionPool();
  const disposed: string[] = [];
  const make = (id: string, createdAt: number) => ({
    id,
    host: { dispose: async () => { disposed.push(id); } } as never,
    status: "idle" as const,
    createdAt,
    updatedAt: createdAt,
  });
  // 填满 MAX_SESSIONS 个 idle（mock MAX_SESSIONS 太大——直接验证淘汰逻辑：
  // 用 11 个 handle 模拟超限，断言最旧非活跃被淘汰）
  const MAX = 10;
  for (let i = 0; i < MAX; i++) pool.set(make(`s${i}`, i));
  // 第 11 个（最旧 s0 应被淘汰）
  pool.set(make("s10", 10));
  assert.equal(pool.size, MAX, "超过上限应淘汰到 MAX");
  assert.equal(pool.get("s0"), null, "最旧 idle 应被淘汰");
  assert.deepEqual(disposed, ["s0"], "被淘汰 handle 的 host 应 dispose");
});

test("SessionPool：淘汰不排除活跃/streaming，且不淘汰刚插入的 handle（审计修正）", async () => {
  const pool = new SessionPool();
  const disposed: string[] = [];
  const make = (id: string, status: "idle" | "streaming", createdAt: number) => ({
    id,
    host: { dispose: async () => { disposed.push(id); } } as never,
    status,
    createdAt,
    updatedAt: createdAt,
  });
  // 9 个 streaming（受保护）+ 1 个活跃 = 池满
  for (let i = 0; i < 9; i++) pool.set(make(`st${i}`, "streaming", i));
  pool.set(make("active", "idle", 9));
  pool.setActive("active");
  // 新建第 11 个——可淘汰候选只剩活跃（被排除）与新 handle（被排除）→ 无候选可淘汰
  pool.set(make("new", "idle", 10));
  assert.equal(pool.get("new") !== null, true, "新 handle 不被自身 set 淘汰（审计修正：候选排除 handle.id）");
  assert.equal(pool.get("active") !== null, true, "活跃 handle 不被淘汰");
  for (let i = 0; i < 9; i++) assert.equal(pool.get(`st${i}`) !== null, true, "streaming handle 不被淘汰");
  assert.deepEqual(disposed, [], "无候选可淘汰时不 dispose 任何 handle");
});

// ----------------------------------------------------------------------------

test("POST /chat/abort：成功中断返回 200 + aborted；sessionId 透传", async () => {
  const ctx = makeCtx({ host: makeHost(makeSession()) });
  const r1 = await call(ctx, "POST", "/api/chat/abort", {});
  assert.equal(r1.hit, true);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json?.data, { aborted: true, sessionId: "stub-session-id" });

  const r2 = await call(ctx, "POST", "/api/chat/abort", { sessionId: "bg-session-1" });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json?.data, { aborted: true, sessionId: "bg-session-1" });
});

test("POST /chat/abort：无活跃项目 409；会话不存在 404", async () => {
  const noProj = makeCtx({ host: null, activeHandle: null });
  const r1 = await call(noProj, "POST", "/api/chat/abort", {});
  assert.equal(r1.status, 409);

  const notFound = makeCtx({
    host: makeHost(makeSession()),
    abortChatError: { code: "SESSION_NOT_FOUND", message: "会话不存在: nope" },
  });
  const r2 = await call(notFound, "POST", "/api/chat/abort", { sessionId: "nope" });
  assert.equal(r2.status, 404);
  assert.equal(r2.json?.error?.code, "SESSION_NOT_FOUND");
});

test("ChatContext.abortChat：streaming 中断成功；非 streaming 幂等 false；未知会话抛错", async () => {
  let abortCalls = 0;
  const streamingSession = makeSession({ isStreaming: true }) as StubSession & { abort: () => Promise<void> };
  streamingSession.abort = async () => { abortCalls++; };
  const context = new ChatContext({
    registry: { getActive: () => HANDLE } as never,
    llmStore: new LlmConfigStore(),
    configDir: "/config",
    embedder: {} as Embedder,
    createOrchestratorService: async () => ({} as OrchestratorService),
    createHost(options) {
      return {
        cwd: options.cwd,
        session: streamingSession,
        modelFallbackMessage: undefined,
        start: async () => {},
        dispose: async () => {},
        switchSession: async () => {},
        newSession: async () => {},
      } as unknown as MainSessionHost;
    },
  });
  try {
    await context.ensureHost();
    const r1 = await context.abortChat();
    assert.deepEqual(r1, { aborted: true, sessionId: "stub-session-id" });
    assert.equal(abortCalls, 1);

    streamingSession.isStreaming = false;
    const r2 = await context.abortChat();
    assert.equal(r2.aborted, false);
    assert.equal(abortCalls, 1, "非 streaming 不再调 abort");

    await assert.rejects(() => context.abortChat("nope"), /会话不存在/);
  } finally {
    await context.dispose();
  }
});

// ============================================================================
// 生命周期竞态修复（🟠-3 / 🟠-4 2026-08-08）
// ============================================================================

test("ChatContext.ensureHost：冷启动窗口并发调用单飞，只创建一个 host（🟠-3）", async () => {
  const handles = new Map([
    ["/proj-a", { dir: "/proj-a", meta: { name: "a" }, wg: {}, search: {}, forceFulltext: false } as ProjectHandle],
  ]);
  let created = 0;
  let startResolve!: () => void;
  const gate = new Promise<void>((r) => { startResolve = r; });
  const context = new ChatContext({
    registry: { getActive: () => handles.get("/proj-a")! } as never,
    llmStore: new LlmConfigStore(),
    configDir: "/config",
    embedder: {} as Embedder,
    createOrchestratorService: async () => ({} as OrchestratorService),
    createHost(options) {
      created++;
      return {
        cwd: options.cwd,
        session: makeSession(),
        modelFallbackMessage: undefined,
        start: async () => { await gate; }, // 模拟慢启动（冷启动窗口）
        dispose: async () => {},
        switchSession: async () => {},
        newSession: async () => {},
      } as unknown as MainSessionHost;
    },
  });
  try {
    // 先并发发起（不 await），等全部进入单飞窗口后再放行 gate
    const p1 = context.ensureHost();
    const p2 = context.ensureHost();
    const p3 = context.ensureHost();
    await new Promise((r) => setTimeout(r, 50));
    startResolve();
    const [h1, h2, h3] = await Promise.all([p1, p2, p3]);
    assert.equal(created, 1, "并发 ensureHost 只应创建一个 host（单飞）");
    assert.equal(h1, h2, "并发调用应共享同一 host");
    assert.equal(h2, h3);
  } finally {
    startResolve();
    await context.dispose();
  }
});

test("ChatContext.activateSession：前缀命中池中会话仅切指针，不重复创建 host（🟠-4）", async () => {
  const projDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chat-ctx-"));
  try {
    await fs.promises.mkdir(path.join(projDir, ".pi", "sessions"), { recursive: true });
    const handle = {
      dir: projDir,
      meta: { name: "proj" },
      wg: {},
      search: {},
      forceFulltext: false,
    } as unknown as ProjectHandle;
    let created = 0;
    const context = new ChatContext({
      registry: { getActive: () => handle } as never,
      llmStore: new LlmConfigStore(),
      configDir: "/config",
      embedder: {} as Embedder,
      createOrchestratorService: async () => ({} as OrchestratorService),
      createHost(options) {
        created++;
        return {
          cwd: options.cwd,
          session: makeSession({
            sessionManager: {
              getSessionFile: () => path.join(projDir, ".pi", "sessions", "x.jsonl"),
            },
          } as never),
          modelFallbackMessage: undefined,
          start: async () => {},
          dispose: async () => {},
          switchSession: async () => {},
          newSession: async () => {},
        } as unknown as MainSessionHost;
      },
    });
    try {
      const info = await context.createSession();
      assert.equal(created, 1, "createSession 创建 1 个 host");
      const prefix = info.id.slice(0, 8);
      const activated = await context.activateSession(prefix);
      assert.equal(activated.id, info.id, "前缀应命中池中同一会话");
      assert.equal(created, 1, "前缀命中不应再创建 host（旧实现会重开同一会话文件并泄漏旧 host）");
    } finally {
      await context.dispose();
    }
  } finally {
    await fs.promises.rm(projDir, { recursive: true, force: true });
  }
});
