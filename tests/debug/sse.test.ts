/**
 * sse.test.ts — SSE handler 单测
 *
 * 验证：
 * - GET /api/debug/stream 发送历史快照 + 实时推送
 * - GET /api/debug/events 拉取历史 JSON
 * - POST /api/debug/clear 清空缓冲
 * - 客户端断开时取消订阅（无内存泄漏）
 * - 心跳定时器在连接关闭时被清理
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { createDebugBus } from "../../src/debug/bus.ts";
import {
  handleDebugStream,
  handleDebugEvents,
  handleDebugClear,
} from "../../src/debug/sse.ts";

// ----------------------------------------------------------------------------

/**
 * 构造 mock req/res 用于 SSE 测试
 * - req 是 EventEmitter，能 emit "close" / "error"
 * - res 收集 write 调用，提供 getBody() 拼接结果
 */
function mockReqRes(): {
  req: IncomingMessage;
  res: ServerResponse;
  writes: string[];
  headers: Record<string, string | number | string[]>;
  isEnded: () => boolean;
  emitClose: () => void;
  emitError: (err: Error) => void;
} {
  const writes: string[] = [];
  const headers: Record<string, string | number | string[]> = {};
  let ended = false;
  const reqEmitter = new EventEmitter();

  const req = Object.assign(reqEmitter, {
    method: "GET",
    url: "/api/debug/stream",
  }) as unknown as IncomingMessage;

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

  return {
    req,
    res,
    writes,
    headers,
    isEnded: () => ended,
    emitClose: () => reqEmitter.emit("close"),
    emitError: (err: Error) => reqEmitter.emit("error", err),
  };
}

// ----------------------------------------------------------------------------

test("handleDebugStream: 设置 SSE 响应头", () => {
  const bus = createDebugBus();
  const { req, res, headers, emitClose } = mockReqRes();

  handleDebugStream(bus, req, res);

  assert.equal(headers["_status"], 200);
  assert.equal(headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(headers["Cache-Control"], "no-cache, no-transform");
  emitClose(); // 清理心跳定时器
});

test("handleDebugStream: 立即冲刷头部并发送连接确认注释", () => {
  const bus = createDebugBus();
  const { req, res, writes, headers, emitClose } = mockReqRes();

  handleDebugStream(bus, req, res);

  assert.equal(headers["_flushed"], 1, "应调用 flushHeaders 立即冲刷响应头");
  assert.equal(writes[0], ":connected\n\n", "首条写入应为连接确认注释");
  emitClose();
});

test("handleDebugStream: 连接时发送历史快照", () => {
  const bus = createDebugBus();
  bus.emit({ id: "h1", ts: 100, traceId: "t1", stage: "test", status: "start" });
  bus.emit({ id: "h2", ts: 200, traceId: "t1", stage: "test", status: "end" });

  const { req, res, writes, emitClose } = mockReqRes();
  handleDebugStream(bus, req, res);

  // 应有 2 条 data: 行
  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.equal(dataLines.length, 2);
  assert.ok(dataLines[0].includes("h1"));
  assert.ok(dataLines[1].includes("h2"));
  emitClose();
});

test("handleDebugStream: 新事件实时推送", () => {
  const bus = createDebugBus();
  const { req, res, writes, emitClose } = mockReqRes();
  handleDebugStream(bus, req, res);

  const initialCount = writes.length;
  bus.emit({ id: "live-1", ts: 300, traceId: "t2", stage: "test", status: "start" });

  const dataLines = writes.filter((w) => w.startsWith("data: "));
  assert.ok(dataLines.some((l) => l.includes("live-1")));
  assert.ok(writes.length > initialCount);
  emitClose();
});

test("handleDebugStream: SSE 消息格式为 `data: <json>\\n\\n`", () => {
  const bus = createDebugBus();
  const { req, res, writes, emitClose } = mockReqRes();
  handleDebugStream(bus, req, res);

  bus.emit({ id: "fmt-1", ts: 0, traceId: "t", stage: "x", status: "start" });

  const dataLine = writes.find((w) => w.startsWith("data: ") && w.includes("fmt-1"));
  assert.ok(dataLine, "应找到包含 fmt-1 的 data 行");
  assert.ok(dataLine.endsWith("\n\n"), "应以 \\n\\n 结尾");

  // 解析 JSON 验证结构
  const json = JSON.parse(dataLine.slice("data: ".length, -2));
  assert.equal(json.id, "fmt-1");
  assert.equal(json.traceId, "t");
  emitClose();
});

test("handleDebugStream: 客户端断开时取消订阅", () => {
  const bus = createDebugBus();
  const { req, res, writes, emitClose } = mockReqRes();
  handleDebugStream(bus, req, res);

  emitClose();

  // 断开后新事件不再推送
  const countAfterClose = writes.length;
  bus.emit({ id: "after-close", ts: 0, traceId: "t", stage: "x", status: "start" });
  assert.equal(writes.length, countAfterClose, "断开后不应再推送");
});

test("handleDebugStream: error 事件也触发清理", () => {
  const bus = createDebugBus();
  const { req, res, writes, emitError } = mockReqRes();
  handleDebugStream(bus, req, res);

  emitError(new Error("connection reset"));

  const countAfterError = writes.length;
  bus.emit({ id: "after-err", ts: 0, traceId: "t", stage: "x", status: "start" });
  assert.equal(writes.length, countAfterError, "error 后不应再推送");
});

// ----------------------------------------------------------------------------

test("handleDebugEvents: 返回 JSON envelope 含历史事件", () => {
  const bus = createDebugBus();
  bus.emit({ id: "e1", ts: 0, traceId: "t", stage: "x", status: "start" });
  bus.emit({ id: "e2", ts: 1, traceId: "t", stage: "x", status: "end" });

  const { req, res, writes, headers, isEnded } = mockReqRes();
  // handleDebugEvents 不需要 req，只写 res
  void req;
  handleDebugEvents(bus, res);

  assert.equal(headers["_status"], 200);
  assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(isEnded(), true, "应调用 res.end()");

  const body = writes.join("");
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.events.length, 2);
  assert.equal(parsed.data.events[0].id, "e1");
  assert.equal(parsed.data.events[1].id, "e2");
});

test("handleDebugEvents: 空缓冲返回空数组", () => {
  const bus = createDebugBus();
  const { res, writes } = mockReqRes();
  handleDebugEvents(bus, res);

  const parsed = JSON.parse(writes.join(""));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.events.length, 0);
});

// ----------------------------------------------------------------------------

test("handleDebugClear: 清空环形缓冲", () => {
  const bus = createDebugBus();
  bus.emit({ id: "e1", ts: 0, traceId: "t", stage: "x", status: "start" });
  assert.equal(bus.snapshot().length, 1);

  const { res, writes, isEnded } = mockReqRes();
  handleDebugClear(bus, res);

  assert.equal(isEnded(), true);
  const parsed = JSON.parse(writes.join(""));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.cleared, true);
  assert.equal(bus.snapshot().length, 0, "缓冲应已清空");
});
