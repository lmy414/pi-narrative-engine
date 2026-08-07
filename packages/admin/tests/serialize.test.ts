// packages/admin/tests/serialize.test.ts
/**
 * serialize.ts 测试（🟠-8 2026-08-08）
 *
 * 覆盖：
 * - createWriteQueue：fn 串行执行（并发调用不交错）
 * - 单次失败不中断后续（tail 吞 rejection）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteQueue } from "../src/serialize.ts";

test("createWriteQueue: 并发 fn 严格串行执行", async () => {
  const enqueue = createWriteQueue();
  const order: number[] = [];
  const mk = (id: number, delayMs: number) => async () => {
    order.push(id);
    await new Promise((r) => setTimeout(r, delayMs));
    return id;
  };
  // 三个并发提交，第一个最慢——串行化后仍按提交序完成
  const results = await Promise.all([
    enqueue(mk(1, 30)),
    enqueue(mk(2, 5)),
    enqueue(mk(3, 5)),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3], "fn 必须按提交顺序执行，不得交错");
});

test("createWriteQueue: 单次失败不中断后续", async () => {
  const enqueue = createWriteQueue();
  const calls: string[] = [];
  const p1 = enqueue(async () => {
    calls.push("a");
    throw new Error("write 失败");
  });
  const p2 = enqueue(async () => {
    calls.push("b");
    return "ok";
  });
  await assert.rejects(p1, /write 失败/);
  assert.equal(await p2, "ok", "前一个失败后，后续任务仍应执行");
  assert.deepEqual(calls, ["a", "b"]);
});
