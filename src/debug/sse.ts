/**
 * sse.ts — SSE 端点 + 历史拉取
 *
 * 端点：
 * - GET /api/debug/stream  —— SSE 长连接，先发送历史快照，再实时推送新事件
 * - GET /api/debug/events  —— 拉取环形缓冲内所有事件（一次性 JSON）
 * - POST /api/debug/clear  —— 清空环形缓冲
 *
 * SSE 协议要点：
 * - Content-Type: text/event-stream
 * - 每条消息 `data: <json>\n\n`
 * - 每 30 秒发送 `:heartbeat\n\n` 防止代理超时
 * - 客户端断开时取消订阅，避免内存泄漏
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DebugBus } from "./types.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 处理 /api/debug/stream 的 SSE 请求
 *
 * @param bus 调试总线
 * @param req HTTP 请求（用于检测客户端断开）
 * @param res HTTP 响应（保持不结束，持续推送）
 */
export function handleDebugStream(
  bus: DebugBus,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // 写 SSE 头部
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Nginx 等代理不缓冲
  });
  // 立即冲刷头部 + 首条注释：缓冲为空时客户端也能立刻确认连接已建立
  res.flushHeaders();
  res.write(`:connected\n\n`);

  // 发送一条 SSE 消息
  function send(event: unknown): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 写入失败（客户端已断开），忽略
    }
  }

  // 1. 发送历史快照（前端按 traceId 聚合恢复 DAG 状态）
  for (const event of bus.snapshot()) {
    send(event);
  }

  // 2. 订阅新事件
  const unsubscribe = bus.subscribe((event) => send(event));

  // 3. 启动心跳
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      // 忽略
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 4. 客户端断开时清理
  const cleanup = () => {
    clearInterval(heartbeatTimer);
    unsubscribe();
    try {
      res.end();
    } catch {
      // 已结束
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

/**
 * 处理 /api/debug/events 的 GET 请求（一次性拉取历史）
 */
export function handleDebugEvents(
  bus: DebugBus,
  res: ServerResponse,
): void {
  const events = bus.snapshot();
  const body = JSON.stringify({ ok: true, data: { events }, error: null });
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(body);
}

/**
 * 处理 /api/debug/clear 的 POST 请求（清空缓冲）
 */
export function handleDebugClear(
  bus: DebugBus,
  res: ServerResponse,
): void {
  bus.clear();
  const body = JSON.stringify({ ok: true, data: { cleared: true }, error: null });
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(body);
}
