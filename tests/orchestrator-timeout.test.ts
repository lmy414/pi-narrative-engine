// tests/orchestrator-timeout.test.ts
/**
 * 子代理整体超时兜底单测（🔴-B 2026-08-08，复用 BUG-028 的
 * promptAndCollectWithTimeout，本次接入 planner/role 前半链路）
 *
 * 断言：
 * - LLM 无响应（prompt 永不 resolve）时：整体超时 reject + agent.abort() 被调用
 *   （collect.ts 的 180s 只 reject 产出 promise、不取消 prompt——本函数
 *   Promise.race + abort 才是真正的兜底）
 * - 正常提交路径：返回工具提交的产出，定时器清理
 * - 工具执行失败：reject 且 abort 不被调用（非超时错误原样透传）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptAndCollectWithTimeout } from "../src/orchestrator.ts";

interface StubAgent {
  subscribe: (fn: (event: unknown) => void) => () => void;
  prompt: () => Promise<unknown>;
  abort: () => void;
}

function makeStubAgent(): { agent: StubAgent; trigger: (event: unknown) => void; aborted: () => boolean } {
  let listener: ((event: unknown) => void) | undefined;
  let aborted = false;
  const agent: StubAgent = {
    subscribe(fn) {
      listener = fn;
      return () => { listener = undefined; };
    },
    prompt: () => new Promise(() => { /* 永不 resolve：模拟 LLM 无响应 */ }),
    abort() {
      aborted = true;
    },
  };
  return {
    agent,
    trigger: (event) => listener?.(event),
    aborted: () => aborted,
  };
}

test("promptAndCollectWithTimeout: LLM 无响应时整体超时 + abort 子代理", async () => {
  const { agent, aborted } = makeStubAgent();
  const t0 = Date.now();
  await assert.rejects(
    promptAndCollectWithTimeout<{ plan: string }>(agent as never, "retrieval_plan", 60, "planner 子代理"),
    /planner 子代理 整体超时（60ms，已中断子代理）/,
  );
  assert.ok(Date.now() - t0 >= 50, "应在约 60ms 后 reject");
  assert.ok(aborted(), "超时后必须调用 agent.abort() 中断子代理");
});

test("promptAndCollectWithTimeout: 正常提交路径返回产出", async () => {
  const { agent, trigger } = makeStubAgent();
  // prompt 模拟立即返回（正常 LLM 响应），工具提交事件在 prompt 期间触发
  agent.prompt = async () => {
    setImmediate(() =>
      trigger({
        type: "tool_execution_end",
        toolName: "retrieval_plan",
        isError: false,
        result: { details: { plan: "P1" } },
      }),
    );
  };
  const out = await promptAndCollectWithTimeout<{ plan: string }>(agent as never, "retrieval_plan", 200, "planner 子代理");
  assert.deepEqual(out, { plan: "P1" });
});

test("promptAndCollectWithTimeout: 工具执行失败时原样 reject（非超时不 abort）", async () => {
  const { agent, trigger, aborted } = makeStubAgent();
  agent.prompt = async () => {
    setImmediate(() =>
      trigger({
        type: "tool_execution_end",
        toolName: "retrieval_plan",
        isError: true,
      }),
    );
  };
  await assert.rejects(
    promptAndCollectWithTimeout<{ plan: string }>(agent as never, "retrieval_plan", 200, "planner 子代理"),
    /retrieval_plan 工具执行失败/,
  );
  assert.ok(!aborted(), "工具失败不是超时，不应调用 abort");
});
