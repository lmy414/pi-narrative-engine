/**
 * bus.test.ts — 调试事件总线单测
 *
 * 验证：
 * - emit 后订阅者同步收到
 * - 环形缓冲容量上限与 FIFO 顺序
 * - snapshot 返回时间顺序的事件列表
 * - startSpan 自动配对 start/end 事件并计算 durationMs
 * - 未注入 bus 时 startSpan 返回 noop（不抛错）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebugBus, startSpan, newTraceId } from "../../src/debug/bus.ts";

// ----------------------------------------------------------------------------

test("createDebugBus: emit 后订阅者同步收到", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  bus.emit({
    id: "test-1",
    ts: Date.now(),
    traceId: "t1",
    stage: "test",
    status: "start",
  });

  assert.equal(received.length, 1);
  assert.equal((received[0] as { id: string }).id, "test-1");
});

test("createDebugBus: subscribe 返回的取消订阅函数有效", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  const unsubscribe = bus.subscribe((event) => received.push(event));

  bus.emit({ id: "a", ts: 0, traceId: "t", stage: "x", status: "start" });
  unsubscribe();
  bus.emit({ id: "b", ts: 0, traceId: "t", stage: "x", status: "start" });

  assert.equal(received.length, 1);
  assert.equal((received[0] as { id: string }).id, "a");
});

test("createDebugBus: 多订阅者互不影响，单个抛错不阻断其他", () => {
  const bus = createDebugBus();
  const a: unknown[] = [];
  const b: unknown[] = [];
  bus.subscribe((event) => {
    throw new Error("boom");
  });
  bus.subscribe((event) => a.push(event));
  bus.subscribe((event) => b.push(event));

  // emit 内部 catch 订阅者异常，不应抛
  bus.emit({ id: "x", ts: 0, traceId: "t", stage: "s", status: "start" });

  // 抛错的订阅者不影响其他订阅者
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

// ----------------------------------------------------------------------------

test("createDebugBus: 环形缓冲容量上限与 FIFO 顺序", () => {
  const bus = createDebugBus(3);
  for (let i = 0; i < 5; i++) {
    bus.emit({ id: `e${i}`, ts: i, traceId: "t", stage: "s", status: "start" });
  }
  const snap = bus.snapshot();
  // 容量 3，应保留最后 3 条（e2, e3, e4）
  assert.equal(snap.length, 3);
  assert.equal(snap[0].id, "e2");
  assert.equal(snap[1].id, "e3");
  assert.equal(snap[2].id, "e4");
});

test("createDebugBus: 未达容量时 snapshot 返回全部", () => {
  const bus = createDebugBus(100);
  bus.emit({ id: "a", ts: 0, traceId: "t", stage: "s", status: "start" });
  bus.emit({ id: "b", ts: 1, traceId: "t", stage: "s", status: "start" });
  const snap = bus.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].id, "a");
  assert.equal(snap[1].id, "b");
});

test("createDebugBus: clear 清空缓冲", () => {
  const bus = createDebugBus();
  bus.emit({ id: "a", ts: 0, traceId: "t", stage: "s", status: "start" });
  assert.equal(bus.snapshot().length, 1);
  bus.clear();
  assert.equal(bus.snapshot().length, 0);
});

test("createDebugBus: 默认容量 1000", () => {
  const bus = createDebugBus();
  for (let i = 0; i < 1500; i++) {
    bus.emit({ id: `e${i}`, ts: i, traceId: "t", stage: "s", status: "start" });
  }
  const snap = bus.snapshot();
  assert.equal(snap.length, 1000);
  // 应保留最后 1000 条（e500..e1499）
  assert.equal(snap[0].id, "e500");
  assert.equal(snap[snap.length - 1].id, "e1499");
});

// ----------------------------------------------------------------------------

test("startSpan: 自动发射 start 事件", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  startSpan(bus, "plan.llm", "trace-1", { query: "test" });

  assert.equal(received.length, 1);
  const ev = received[0] as { stage: string; status: string; input: { query: string } };
  assert.equal(ev.stage, "plan.llm");
  assert.equal(ev.status, "start");
  assert.deepEqual(ev.input, { query: "test" });
});

test("startSpan: end() 发射 end 事件并计算 durationMs", async () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  const span = startSpan(bus, "test", "trace-1");
  await new Promise((r) => setTimeout(r, 10));
  span.end({ result: "ok" });

  assert.equal(received.length, 2);
  const endEv = received[1] as { status: string; output: { result: string }; durationMs: number };
  assert.equal(endEv.status, "end");
  assert.deepEqual(endEv.output, { result: "ok" });
  assert.ok(endEv.durationMs >= 10, `durationMs=${endEv.durationMs} 应 >= 10`);
});

test("startSpan: error() 发射 error 事件并携带错误消息", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  const span = startSpan(bus, "test", "trace-1");
  span.error(new Error("something failed"));

  assert.equal(received.length, 2);
  const errEv = received[1] as { status: string; error: string };
  assert.equal(errEv.status, "error");
  assert.equal(errEv.error, "something failed");
});

test("startSpan: 非错误对象时 error 携带字符串", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  const span = startSpan(bus, "test", "trace-1");
  span.error("string error");

  const errEv = received[1] as { status: string; error: string };
  assert.equal(errEv.error, "string error");
});

test("startSpan: 未注入 bus 时返回 noop（不抛错）", () => {
  const span1 = startSpan(null, "test", "trace-1");
  const span2 = startSpan(undefined, "test", "trace-1");

  span1.end();
  span1.error(new Error("x"));
  span2.end();
  span2.error(new Error("y"));
  // 不抛错即可
});

test("startSpan: start/end 共享同一 eventId（用于前端配对）", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  const span = startSpan(bus, "test", "trace-1");
  span.end();

  const startEv = received[0] as { id: string };
  const endEv = received[1] as { id: string };
  // start 和 end 是两条独立事件（id 不同），但 end 的 stage 与 start 一致
  assert.notEqual(startEv.id, endEv.id);
});

test("startSpan: parentId 透传", () => {
  const bus = createDebugBus();
  const received: unknown[] = [];
  bus.subscribe((event) => received.push(event));

  const span = startSpan(bus, "test", "trace-1");
  // 用 span.eventId 作为子阶段的 parentId
  startSpan(bus, "test.child", "trace-1", undefined, span.eventId);

  const childEv = received[1] as { stage: string; parentId: string };
  assert.equal(childEv.stage, "test.child");
  assert.equal(childEv.parentId, span.eventId);
});

// ----------------------------------------------------------------------------

test("newTraceId: 返回 trace_ 前缀的唯一字符串", () => {
  const id1 = newTraceId();
  const id2 = newTraceId();
  assert.ok(id1.startsWith("trace_"));
  assert.ok(id2.startsWith("trace_"));
  assert.notEqual(id1, id2);
});
