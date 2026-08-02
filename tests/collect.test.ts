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
