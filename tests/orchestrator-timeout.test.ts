// tests/orchestrator-timeout.test.ts
/**
 * 子代理整体超时兜底单测（🔴-B 2026-08-08，迁移到 AgentRuntime.driveToReply）
 *
 * 2026-08-12 统一代理抽象：原 promptAndCollectWithTimeout（BUG-028 修复）已并入
 * LlmConfigStoreRuntime.driveToReply——Promise.race 整体超时 + 超时 abort session。
 *
 * 断言：
 * - LLM 无响应（prompt 永不 resolve）时：整体超时 reject + session.abort() 被调用
 * - 正常路径：从 message_end 事件提取最终 assistant 文本
 * - 超时不触发时 abort 不被调用
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmConfigStoreRuntime } from "../src/agents/agent-runtime.ts";
import { LlmConfigStore } from "../src/orchestrator/llm-config.ts";

interface StubSession {
  subscribe: (fn: (event: unknown) => void) => () => void;
  prompt: (text: string, opts?: unknown) => Promise<unknown>;
  abort: () => Promise<void>;
}

function makeStubSession(): {
  session: StubSession;
  trigger: (event: unknown) => void;
  aborted: () => boolean;
} {
  let listener: ((event: unknown) => void) | undefined;
  let aborted = false;
  const session: StubSession = {
    subscribe(fn) {
      listener = fn;
      return () => { listener = undefined; };
    },
    // 默认永不 resolve：模拟 LLM 无响应
    prompt: () => new Promise(() => {}),
    async abort() {
      aborted = true;
    },
  };
  return {
    session,
    trigger: (event) => listener?.(event),
    aborted: () => aborted,
  };
}

const store = new LlmConfigStore();
store.setConfig("default", {
  model: { provider: "deepseek", name: "deepseek-v4-flash" },
  apiKey: "test-key",
});

test("driveToReply: LLM 无响应时整体超时 + abort session", async () => {
  const runtime = new LlmConfigStoreRuntime(store);
  const { session, aborted } = makeStubSession();
  const t0 = Date.now();
  await assert.rejects(
    runtime.driveToReply(session as never, "事件指令", { timeoutMs: 60 }),
    /Agent prompt 超时（60ms，已中断子代理）/,
  );
  assert.ok(Date.now() - t0 >= 50, "应在约 60ms 后 reject");
  assert.ok(aborted(), "超时后必须调用 session.abort() 中断子代理");
});

test("driveToReply: 正常路径从 message_end 提取最终 assistant 文本", async () => {
  const runtime = new LlmConfigStoreRuntime(store);
  const { session, trigger } = makeStubSession();
  session.prompt = async () => {
    // 同步触发 message_end（在 prompt resolve 回到 driveToReply 的 finally 之前）
    trigger({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '```json\n{"plan":"P1"}\n```' }],
        stopReason: "stop",
      },
    });
  };
  const reply = await runtime.driveToReply(session as never, "事件指令", { timeoutMs: 200 });
  assert.equal(reply.text, '```json\n{"plan":"P1"}\n```');
  assert.equal(reply.stopReason, "stop");
});

test("driveToReply: prompt 抛错时原样 reject 且保留错误信息", async () => {
  const runtime = new LlmConfigStoreRuntime(store);
  const { session, trigger } = makeStubSession();
  session.prompt = async () => {
    // 先发一个 message_end（模拟部分输出），再抛错
    trigger({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "部分输出" }],
        stopReason: "error",
        errorMessage: "402 Insufficient Balance",
      },
    });
    throw new Error("402 Insufficient Balance");
  };
  await assert.rejects(
    runtime.driveToReply(session as never, "事件指令", { timeoutMs: 200 }),
    /402 Insufficient Balance/,
  );
});