// tests/event-queue.test.ts
/**
 * EventQueue 容量与 TTL 防护测试（🔴-4）
 *
 * 覆盖：
 * - maxLength 超限时淘汰最旧已完成项
 * - 全部未完成时入队抛错
 * - finishedTtlMs 过期惰性清理（getStatus/getAll/enqueue 触发）
 * - 容量防护不干扰正常串行消费
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventQueue } from "../src/event-queue.ts";

const doneWorker = async (event: unknown) => ({ echo: event });

test("EventQueue: 超限时淘汰最旧已完成项（🔴-4）", async () => {
  const q = new EventQueue<string, { echo: string }>(
    doneWorker,
    undefined,
    { maxLength: 3, finishedTtlMs: 0 },
  );
  const id1 = q.enqueue("a");
  // 等待 worker 完成 a（串行泵）
  await new Promise((r) => setTimeout(r, 20));
  q.enqueue("b");
  await new Promise((r) => setTimeout(r, 20));
  q.enqueue("c");
  await new Promise((r) => setTimeout(r, 20));
  q.enqueue("d");
  await new Promise((r) => setTimeout(r, 20));

  // a 是最旧已完成，应被淘汰
  assert.equal(q.getStatus(id1), undefined, "最旧已完成项应被淘汰");
  const ids = q.getAll().map((item) => item.queueId);
  assert.equal(ids.length, 3, "容量保持 3");
  assert.ok(!ids.includes(id1));
  const allDone = q.getAll().every((item) => item.status === "done");
  assert.ok(allDone, "其余项处理完成");
});

test("EventQueue: 全部未完成时入队抛错（🔴-4）", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((r) => { release = r; });
  const q = new EventQueue<string, { echo: string }>(
    async () => { await blocker; return { echo: "x" }; },
    undefined,
    { maxLength: 2, finishedTtlMs: 0 },
  );
  q.enqueue("a");
  q.enqueue("b");
  // 两个都 pending/running（worker 被 blocker 挂起）
  await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => q.enqueue("c"), /EventQueue 已满/);
  release();
  await new Promise((r) => setTimeout(r, 10));
});

test("EventQueue: 过期已完成项惰性清理（🔴-4）", async () => {
  const q = new EventQueue<string, { echo: string }>(
    doneWorker,
    undefined,
    { maxLength: 50, finishedTtlMs: 20 },
  );
  const id = q.enqueue("a");
  await new Promise((r) => setTimeout(r, 30));
  // 超过 TTL 20ms：getStatus/getAll 应清理
  assert.equal(q.getStatus(id), undefined, "过期项应从查询中消失");
  assert.equal(q.getAll().length, 0);
});

test("EventQueue: TTL 内已完成项保留（🔴-4）", async () => {
  const q = new EventQueue<string, { echo: string }>(
    doneWorker,
    undefined,
    { maxLength: 50, finishedTtlMs: 1000 },
  );
  const id = q.enqueue("a");
  await new Promise((r) => setTimeout(r, 20));
  const item = q.getStatus(id);
  assert.ok(item, "TTL 内已完成项保留");
  assert.equal(item!.status, "done");
});

test("EventQueue: 容量防护不影响正常串行消费", async () => {
  const q = new EventQueue<number, { echo: number }>(
    async (n) => { await new Promise((r) => setTimeout(r, 5)); return { echo: n }; },
    undefined,
    { maxLength: 10, finishedTtlMs: 0 },
  );
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(q.enqueue(i));
  // 轮询等待而非固定 sleep：CI 慢机/负载下 setTimeout(5) 可能显著拉长
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const items = q.getAll();
    if (items.length === 5 && items.every((i) => i.status === "done")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const items = q.getAll();
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((i) => i.status), ["done", "done", "done", "done", "done"]);
});

// ============================================================================
// stop 语义（🟠-5 2026-08-08）
// ============================================================================

test("EventQueue: stop 后入队抛错", async () => {
  const q = new EventQueue<string, { echo: string }>(doneWorker);
  q.stop();
  assert.throws(() => q.enqueue("x"), /已停止/);
});

test("EventQueue: stop 将 pending 任务标记 error，in-flight 允许完成", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((r) => { release = r; });
  const q = new EventQueue<string, { echo: string }>(
    async (event) => {
      if (event === "block") await blocker;
      return { echo: event };
    },
    undefined,
    { finishedTtlMs: 0 },
  );
  const runningId = q.enqueue("block");
  const pendingId = q.enqueue("after");
  // 等 worker 进入 in-flight
  await new Promise((r) => setTimeout(r, 20));
  q.stop();
  release(); // 放行 in-flight
  await new Promise((r) => setTimeout(r, 30));

  const running = q.getStatus(runningId)!;
  assert.equal(running.status, "done", "in-flight 任务应允许完成");
  const pending = q.getStatus(pendingId)!;
  assert.equal(pending.status, "error", "stop 时未开始任务应标记 error");
  assert.match(pending.error ?? "", /已停止/);
});

test("EventQueue: stop 幂等", async () => {
  const q = new EventQueue<string, { echo: string }>(doneWorker);
  q.stop();
  q.stop(); // 不抛错
  const items = q.getAll();
  assert.equal(items.length, 0);
});
