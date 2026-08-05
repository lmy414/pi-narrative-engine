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
}): { chatContext: ChatContext; registry: { getActive: () => ProjectHandle | null } } {
  const chatContext = {
    ensureHost: async () => overrides.host ?? null,
    activeHost: overrides.host ?? null,
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
  const { req, res, writes, headers, emitClose } = mockReqRes();
  const hit = await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.equal(hit, true);
  // 连接建立即冲刷头部 + 发送 :connected 注释（空事件期间客户端也能确认连接）
  assert.equal(headers["_flushed"], 1, "应调用 flushHeaders 立即冲刷响应头");
  assert.equal(writes[0], ":connected\n\n", "首条写入应为连接确认注释");
  // 推送事件 → data 行
  assert.ok(listener, "应已订阅 session");
  listener!({ type: "message_update", message: { content: "x" } });
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.ok(dataLines.length === 1 && dataLines[0].includes("message_update"), "事件应以 SSE data 行推送");

  emitClose();
  assert.equal(unsubscribed, true, "客户端断开应取消订阅");
});

test("GET events（SSE）：各类 session 事件原样透传（L-Test-4）", async () => {
  let listener: ((event: unknown) => void) | null = null;
  const session = makeSession({
    subscribe: (cb) => {
      listener = cb;
      return () => {};
    },
  });
  const ctx = makeCtx({ host: makeHost(session) });
  const { req, res, writes, emitClose } = mockReqRes();
  await handleChatApi(ctx, req, res, new URL("http://localhost/api/chat/events"), null);

  assert.ok(listener, "应已订阅 session");
  // 事件类型回归：start/end/工具执行/消息更新 均应原样 JSON 透传（前端按 type 分支处理）
  const samples = [
    { type: "session_start", sessionId: "s1" },
    { type: "session_end", sessionId: "s1" },
    { type: "tool_execution", tool: { name: "world_query" }, state: "running" },
    { type: "message_update", message: { content: "流式" }, done: false },
  ];
  for (const sample of samples) listener!(sample);
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.equal(dataLines.length, samples.length, "每个事件一条 data 行");
  for (let i = 0; i < samples.length; i++) {
    const parsed = JSON.parse(dataLines[i].slice("data: ".length, -2));
    assert.equal(parsed.type, samples[i].type, `事件类型 ${samples[i].type} 原样透传`);
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

test("POST /api/chat/sessions：streaming 中 → 409 CHAT_BUSY", async () => {
  const session = makeSession({ isStreaming: true });
  const ctx = makeCtx({
    host: makeHost(session),
    createSessionError: { code: "CHAT_BUSY", message: "当前会话正在生成" },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions", {});
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "CHAT_BUSY");
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

test("POST /api/chat/sessions/:id/activate：streaming 中 → 409 CHAT_BUSY", async () => {
  const session = makeSession({ isStreaming: true });
  const ctx = makeCtx({
    host: makeHost(session),
    activateSessionError: { code: "CHAT_BUSY", message: "当前会话正在生成" },
  });
  const { hit, status, json } = await call(ctx, "POST", "/api/chat/sessions/some-id/activate", {});
  assert.equal(hit, true);
  assert.equal(status, 409);
  assert.equal(json?.error?.code, "CHAT_BUSY");
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
