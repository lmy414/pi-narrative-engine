import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSubmission } from "../src/agents/collect.ts";

test("collectSubmission: prompt 期间工具失败不会触发 unhandledRejection", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const agent = {
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const collected = collectSubmission(agent as never, "retrieval_plan");
    listener?.({
      type: "tool_execution_end",
      toolName: "retrieval_plan",
      isError: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(collected.promise, /retrieval_plan 工具执行失败/);
    collected.dispose();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("collectSubmission: 超时后 reject 且不再 resolve（🔴-3）", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const agent = {
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const collected = collectSubmission(agent as never, "retrieval_plan", 30);
  const t0 = Date.now();
  await assert.rejects(collected.promise, /产出收集超时（30ms）/);
  assert.ok(Date.now() - t0 >= 25, "应在约 30ms 后 reject");
  collected.dispose();
});

test("collectSubmission: 正常提交在超时前 resolve，dispose 清除定时器", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const agent = {
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const collected = collectSubmission<{ plan: string }>(agent as never, "retrieval_plan", 50);
  listener?.({
    type: "tool_execution_end",
    toolName: "retrieval_plan",
    isError: false,
    result: { details: { plan: "P1" } },
  });
  const out = await collected.promise;
  assert.deepEqual(out, { plan: "P1" });
  collected.dispose();
});

test("collectSubmission: agent_end 无产出时附带底层 LLM 错误（如 402）", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const agent = {
    state: {
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "error", errorMessage: "402 Insufficient Balance" },
      ],
    },
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const collected = collectSubmission(agent as never, "retrieval_plan");
  listener?.({ type: "agent_end" });
  await assert.rejects(
    collected.promise,
    /retrieval_plan 未提交产出（agent 已终止）：402 Insufficient Balance/,
  );
  collected.dispose();
});

test("collectSubmission: agent_end 无 LLM 错误时保持原文案", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const agent = {
    state: { messages: [{ role: "assistant", stopReason: "stop" }] },
    subscribe(fn: (event: unknown) => void) {
      listener = fn;
      return () => { listener = undefined; };
    },
  };
  const collected = collectSubmission(agent as never, "retrieval_plan");
  listener?.({ type: "agent_end" });
  await assert.rejects(collected.promise, /retrieval_plan 未提交产出（agent 已终止）$/);
  collected.dispose();
});
