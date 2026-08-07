/**
 * routes-chat.ts — 主会话聊天 API（/api/chat/*）
 *
 * 依据：docs/plans/2026-08-01-main-session-execution-plan.md §3.4
 *       PI RPC 模式 preflightResult 语义（rpc-mode.ts:389-411）
 *
 * 端点：
 * - POST /api/chat/message  body { text } → 接收即回 { ok: true }，内容经 SSE 事件流推送
 * - GET  /api/chat/events   SSE：session.subscribe 事件原样 JSON 推送（message_update 完整快照）
 * - GET  /api/chat/status   会话状态（只读，不触发会话启动）
 *
 * 契约要点：
 * - envelope 与既有路由一致 { ok, data, error }
 * - 无活跃项目 → 409 NO_ACTIVE_PROJECT；isStreaming → 409 CHAT_BUSY（单流约束）
 * - embedder 未加载 → 501 EMBEDDER_UNAVAILABLE
 *
 * 安全前提：只监听 localhost，端点不做鉴权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "./project-registry.ts";
import type { DebugBus } from "../debug/types.ts";
import { startSpan, newTraceId } from "../debug/bus.ts";
import { ChatContext } from "./chat-context.ts";
import { _ok as ok, _fail as fail } from "../visualizer/routes.ts";

export interface ChatApiContext {
  chatContext: ChatContext;
  registry: ProjectRegistry;
  /** 调试总线（chat.message span 用；null 时零开销 no-op） */
  debugBus?: DebugBus | null;
}

/** ChatContextError.code → HTTP 状态（缺省 500） */
const CHAT_ERROR_STATUS: Record<string, number> = {
  NO_ACTIVE_PROJECT: 409,
  CHAT_BUSY: 409,
  SESSION_NOT_FOUND: 404,
  SESSION_INVALID_PATH: 400,
  EMBEDDER_UNAVAILABLE: 501,
  MODEL_NOT_READY: 503,
};

const SSE_HEARTBEAT_MS = 30_000;

/** 取活跃项目目录，未激活抛 NO_ACTIVE_PROJECT */
function requireActiveDir(ctx: ChatApiContext): string {
  const active = ctx.registry.getActive();
  if (!active) {
    const err = new Error("尚未激活项目（先 POST /api/projects/activate）") as Error & { code?: string };
    err.code = "NO_ACTIVE_PROJECT";
    throw err;
  }
  return active.dir;
}

/** 校验请求体 { text }，缺失抛 INVALID_BODY / MISSING_FIELD */
function requireText(body: unknown): string {
  if (body === null || typeof body !== "object") {
    const err = new Error("请求体必须是 JSON 对象") as Error & { code?: string };
    err.code = "INVALID_BODY";
    throw err;
  }
  const text = (body as Record<string, unknown>).text;
  if (typeof text !== "string" || text.trim() === "") {
    const err = new Error("请求体缺少非空字段 text") as Error & { code?: string };
    err.code = "MISSING_FIELD";
    throw err;
  }
  return text;
}

/**
 * 处理 /api/chat/* 请求。命中返回 true（已写出响应），未命中返回 false。
 */
export async function handleChatApi(
  ctx: ChatApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/chat")) return false;
  const method = req.method ?? "GET";
  const segment = url.pathname.slice("/api/chat".length).replace(/\/+$/, "");

  try {
    // POST /api/chat/message
    if (segment === "/message" && method === "POST") {
      requireActiveDir(ctx);
      const text = requireText(body);
      // chat.message span：覆盖"接收 → preflight"阶段（流式生成经 /api/chat/events 推送，
      // 不在本 span 内；abort 语义由会话层管理，此处只记 preflight 成败）。
      // M-Sec-2 修复：不落盘用户输入原文（此前 text 前 200 字符经 debug bus
      // 持久化到 <cwd>/.pi/logs/debug.jsonl，用户未被明示输入会被持久化）；
      // 仅记录长度等元信息，调试面板展示时无敏感原文。
      const span = startSpan(ctx.debugBus, "chat.message", newTraceId(), {
        chars: text.length,
      });
      try {
        // sendChatMessage 内部：ensureHost → 检查 active isStreaming → prompt + 状态跟踪
        // 后台生成中的 session 不阻塞活跃会话发送
        const result = await ctx.chatContext.sendChatMessage(text);
        span.end({ received: true, sessionId: result.sessionId });
        ok(res, { received: true, sessionId: result.sessionId });
        return true;
      } catch (err) {
        span.error(err);
        throw err;
      }
    }

    // GET /api/chat/events（SSE 多路复用：所有 session 事件经统一通道推送）
    if (segment === "/events" && method === "GET") {
      const host = await ctx.chatContext.ensureHost();
      if (!host) throw errWithCode("NO_ACTIVE_PROJECT", "尚未激活项目");
      handleChatEvents(req, res, ctx.chatContext);
      return true;
    }

    // GET /api/chat/status（只读，不触发会话启动；返回多 session 状态）
    if (segment === "/status" && method === "GET") {
      const pool = ctx.chatContext.sessionPool;
      const activeHandle = pool.getActive();
      const active = ctx.registry.getActive();
      ok(res, {
        active: activeHandle !== null && active !== null,
        cwd: activeHandle?.host.cwd ?? null,
        isStreaming: activeHandle?.status === "streaming",
        sessionId: activeHandle?.id ?? null,
        systemPrompt: activeHandle ? activeHandle.host.session.systemPrompt : null,
        modelFallbackMessage: activeHandle?.host.modelFallbackMessage ?? null,
        // 后台生成中的 session 列表（非活跃且 status=streaming）
        backgroundStreaming: pool.getBackgroundStreaming().map((h) => ({
          sessionId: h.id,
          status: h.status,
        })),
        // 池中所有 session 的状态（前端用于按 sessionId 维护 busy 标记）
        sessions: pool.getAll().map((h) => ({
          sessionId: h.id,
          status: h.status,
          isActive: h.id === pool.activeSessionId,
        })),
      });
      return true;
    }

    // GET /api/chat/sessions（历史会话列表，只读，不触发会话启动）
    if (segment === "/sessions" && method === "GET") {
      requireActiveDir(ctx);
      const sessions = await ctx.chatContext.listSessions();
      const pool = ctx.chatContext.sessionPool;
      const activeId = pool.activeSessionId;
      ok(res, {
        sessions: sessions.map((s) => {
          const handle = pool.get(s.id);
          return {
            id: s.id,
            name: s.name ?? null,
            path: s.path,
            created: s.created.toISOString(),
            modified: s.modified.toISOString(),
            messageCount: s.messageCount,
            firstMessage: s.firstMessage,
            live: activeId !== null && s.id === activeId,
            // 池中 session 的状态（未在池中的历史会话为 idle）
            status: handle?.status ?? "idle",
          };
        }),
      });
      return true;
    }

    // POST /api/chat/abort — 中断会话生成（body 可带 sessionId 指定后台会话，缺省活跃会话）
    if (segment === "/abort" && method === "POST") {
      requireActiveDir(ctx);
      const sid =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>).sessionId
          : undefined;
      ok(res, await ctx.chatContext.abortChat(sid === undefined ? undefined : String(sid)));
      return true;
    }

    // POST /api/chat/sessions（新建空会话，live 转移到新会话）
    if (segment === "/sessions" && method === "POST") {
      requireActiveDir(ctx);
      const session = await ctx.chatContext.createSession();
      ok(res, {
        session: {
          id: session.id,
          name: session.name ?? null,
          path: session.path,
          created: session.created.toISOString(),
          modified: session.modified.toISOString(),
          messageCount: session.messageCount,
          firstMessage: session.firstMessage,
          live: true,
        },
      });
      return true;
    }

    // POST /api/chat/sessions/:id/activate（切换到指定会话，live 转移）
    // 必须在 /sessions/:id/messages 之前判断（endsWith("/activate") 区分后缀）
    if (segment.startsWith("/sessions/") && segment.endsWith("/activate") && method === "POST") {
      requireActiveDir(ctx);
      const id = decodeURIComponent(
        segment.slice("/sessions/".length, segment.length - "/activate".length),
      );
      const session = await ctx.chatContext.activateSession(id);
      ok(res, {
        session: {
          id: session.id,
          name: session.name ?? null,
          path: session.path,
          created: session.created.toISOString(),
          modified: session.modified.toISOString(),
          messageCount: session.messageCount,
          firstMessage: session.firstMessage,
          live: true,
        },
      });
      return true;
    }

    // GET /api/chat/sessions/:id/messages（历史消息 {role,text,ts}）
    if (segment.startsWith("/sessions/") && segment.endsWith("/messages") && method === "GET") {
      requireActiveDir(ctx);
      const id = decodeURIComponent(
        segment.slice("/sessions/".length, segment.length - "/messages".length),
      );
      ok(res, { id, messages: await ctx.chatContext.getSessionMessages(id) });
      return true;
    }

    // /api/chat 下的未知子路径
    fail(res, 404, "NOT_FOUND", `未知端点: /api/chat${segment}`);
    return true;
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
    const status = CHAT_ERROR_STATUS[code] ?? (code === "INTERNAL_ERROR" ? 500 : 400);
    fail(res, status, code, err instanceof Error ? err.message : String(err));
    return true;
  }
}

/** SSE 事件流：ChatContext.subscribe 多路复用，所有 session 事件带 sessionId 推送，30s 心跳，断开清理 */
function handleChatEvents(
  req: IncomingMessage,
  res: ServerResponse,
  chatContext: { subscribe: (cb: (event: unknown) => void) => () => void },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // 立即冲刷头部 + 首条注释：无事件期间客户端也能立刻确认连接已建立
  res.flushHeaders();
  res.write(`:connected\n\n`);

  // 🟠-2（2026-08-08）：半开连接判死（移植 debug/sse.ts 模式）——
  // 客户端消失但未收到 RST/FIN 时 res.write 持续"成功"但数据在内核缓冲堆积，
  // 此前死连接永不清理，可占满全局 SSE 配额（10）导致后续连接 503
  let dead = false;
  let cleanup: (() => void) | null = null;
  function markDead(): void {
    if (dead) return;
    dead = true;
    cleanup?.();
  }

  function send(event: unknown): void {
    // 严格布尔比较：mock/降级对象可能缺 writable/destroyed 字段（undefined ≠ 断连）
    if (dead || res.destroyed === true || res.writable === false) {
      markDead();
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      markDead();
    }
  }

  // 订阅 ChatContext 多路复用事件（所有 session 的 PI 事件 + background_complete 合成事件）
  const unsubscribe = chatContext.subscribe((event) => send(event));
  // 心跳 + 半开探测：writableLength 持续非零超过 60s（2 个心跳周期）判定死连接
  const HALF_OPEN_GRACE_MS = 60_000;
  let stuckSince = 0;
  const heartbeat = setInterval(() => {
    if (dead || res.destroyed === true || res.writable === false) {
      markDead();
      return;
    }
    if (res.writableLength > 0) {
      if (stuckSince === 0) stuckSince = Date.now();
      else if (Date.now() - stuckSince > HALF_OPEN_GRACE_MS) {
        markDead();
        return;
      }
    } else {
      stuckSince = 0;
    }
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      markDead();
    }
  }, SSE_HEARTBEAT_MS);

  cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // 已结束
    }
  };
  // 若判死发生在 cleanup 赋值之前（connected 注释已写入但 res 立即不可写），补执行一次清理
  if (dead) cleanup();

  // req/res 双监听：response close 事件比 req close 更可靠
  // （HTTP/1.1 响应关闭后不可写即断连）
  req.on("close", markDead);
  req.on("error", markDead);
  res.on("close", markDead);
  res.on("error", markDead);
}

function errWithCode(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

