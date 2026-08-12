// tests/debug/orchestrator-spans.test.ts
/**
 * orchestrator 四阶段 span 埋点测试（B2）
 *
 * 用"planner slot 配置了不存在的模型"构造确定性失败路径（getModel 在
 * planner span 内抛错，不触网络），断言：
 * - 注入 bus 时：orchestrator root span 与 planner 子 span 配对
 *   （start + error、共享 traceId、parentId 指向 root、含耗时与错误消息）
 * - 未注入 bus 时：同样抛错，埋点零开销 no-op 不炸
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StructuredEvent } from "@pi/scheduler";
import { Orchestrator } from "../../src/orchestrator.ts";
import { LlmConfigStore } from "../../src/orchestrator/llm-config.ts";
import { LlmConfigStoreRuntime } from "../../src/agents/agent-runtime.ts";
import { createDebugBus } from "../../src/debug/bus.ts";
import type { DebugBus } from "../../src/debug/types.ts";

const EVENT: StructuredEvent = {
  storyTime: "ch001.ev001",
  instruction: "埋点测试事件",
  characterIds: ["char_a"],
  mode: "plan",
};

function makeOrchestrator(debugBus: DebugBus | null): Orchestrator {
  const llmStore = new LlmConfigStore();
  // planner slot 指向不存在的模型 → resolveModel("planner") 在 span 内确定性抛错
  llmStore.setConfig("planner", {
    model: { provider: "deepseek", name: "no-such-model-xyz" },
    apiKey: "sk-fake",
  });
  return new Orchestrator({
    agentRuntime: new LlmConfigStoreRuntime(llmStore),
    agentDir: process.cwd(),
    cwd: process.cwd(),
    plannerRuleSet: "",
    roleRuleSet: "",
    renderRuleSet: "",
    staticCardLoader: async (id: string) => ({ name: id, description: "" }),
    ports: {} as never,
    dataAccess: {} as never,
    debugBus,
  });
}

test("注入 bus：root/planner span 配对（start+error、traceId、parentId、耗时）", async () => {
  const bus = createDebugBus();
  const orchestrator = makeOrchestrator(bus);

  await assert.rejects(() => orchestrator.run(EVENT), /模型不存在/);

  const events = bus.snapshot();
  const rootStart = events.find((e) => e.stage === "orchestrator" && e.status === "start");
  const plannerStart = events.find((e) => e.stage === "planner" && e.status === "start");
  const plannerError = events.find((e) => e.stage === "planner" && e.status === "error");
  const rootError = events.find((e) => e.stage === "orchestrator" && e.status === "error");

  assert.ok(rootStart, "应有 orchestrator start");
  assert.ok(plannerStart, "应有 planner start");
  assert.ok(plannerError, "应有 planner error");
  assert.ok(rootError, "应有 orchestrator error");
  assert.equal(events.length, 4, "失败路径恰好 4 条事件");

  // traceId 全链路一致；planner 挂在 root 下（DAG 边）
  const traceId = rootStart!.traceId;
  assert.ok(events.every((e) => e.traceId === traceId), "全部事件共享同一 traceId");
  assert.equal(plannerStart!.parentId, rootStart!.id);
  assert.equal(plannerError!.parentId, rootStart!.id);

  // error 事件含错误消息与耗时
  assert.match(plannerError!.error ?? "", /模型不存在/);
  assert.equal(typeof plannerError!.durationMs, "number");
  assert.equal(typeof rootError!.durationMs, "number");

  // root span 输入含事件摘要
  const input = rootStart!.input as { storyTime?: string; characterIds?: string[] };
  assert.equal(input.storyTime, "ch001.ev001");
  assert.deepEqual(input.characterIds, ["char_a"]);
});

test("未注入 bus：run 抛同样的错，埋点 no-op 不炸", async () => {
  const orchestrator = makeOrchestrator(null);
  await assert.rejects(() => orchestrator.run(EVENT), /模型不存在/);
});
