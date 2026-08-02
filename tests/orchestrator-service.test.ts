// tests/orchestrator-service.test.ts
/**
 * OrchestratorService 单测（A2/A3 验收）
 *
 * 用 fake orchestrator（stub run / runPostRolePipeline）断言：
 * - plan 模式：queue done 后 plans 缓存，commit 触发后半链路并清理缓存
 * - commit 幂等（重复 commit 报错）、discard 清理
 * - pipeline 抛错时 commit 返回失败并清理缓存
 * - yolo 模式：不缓存 plan（result.commit 已含落地摘要）
 * - queueStatus 暴露 result（A3）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Orchestrator, OrchestratorResult, DiffusionOutput, RenderOutput, CommitSummary } from "../src/orchestrator.ts";
import { OrchestratorService } from "../src/orchestrator/service.ts";
import type { StructuredEvent } from "@pi/scheduler";

/** 构造一个 plan 模式的 fake 编排结果 */
function makeResult(mode: "plan" | "yolo" = "plan"): OrchestratorResult {
  const event: StructuredEvent = {
    storyTime: "ch001.ev001",
    instruction: "测试事件",
    characterIds: ["char_a"],
    mode,
  };
  return {
    mode,
    planId: mode === "plan" ? "plan_test_1" : "plan_yolo_1",
    eventId: "evt_test_1",
    chapterPath: "chapters/ch001.md",
    event,
    outputs: [],
    errors: [],
    cast: [],
    retrievalPlan: { items: [], description: "" },
    stages: [
      {
        stage: "planner",
        agent: "planner",
        status: "done",
        durationMs: 12,
        provider: "test-provider",
        model: "test-planner",
      },
      {
        stage: "role",
        agent: "role",
        status: "error",
        error: "char_a: role failed",
      },
    ],
    ...(mode === "yolo" ? {
      diffusion: { changes: [] } as DiffusionOutput,
      render: { chapterPath: "chapters/ch001.md", text: "正文" } as RenderOutput,
      commit: {
        ok: true,
        appliedEventIds: ["evt_x"],
        visibilityChanges: undefined,
        writtenText: "正文",
        chapterPath: "chapters/ch001.md",
        errors: [],
      } as CommitSummary,
    } : {}),
  };
}

/** fake orchestrator：记录 runPostRolePipeline 调用参数 */
function makeFakeOrchestrator(overrides?: {
  pipelineError?: Error;
  result?: OrchestratorResult;
}): { fake: Orchestrator; calls: { event: StructuredEvent; eventId: string; outputs: unknown[] }[] } {
  const calls: { event: StructuredEvent; eventId: string; outputs: unknown[] }[] = [];
  const fake = {
    run: async (event: StructuredEvent): Promise<OrchestratorResult> => {
      if (overrides?.result) return overrides.result;
      return makeResult(event.mode === "yolo" ? "yolo" : "plan");
    },
    runPostRolePipeline: async (
      event: StructuredEvent,
      eventId: string,
      outputs: unknown[],
    ): Promise<{ diffusion: DiffusionOutput; render: RenderOutput; commit: CommitSummary }> => {
      calls.push({ event, eventId, outputs });
      if (overrides?.pipelineError) throw overrides.pipelineError;
      return {
        diffusion: { appliedEventIds: ["evt_x"], changes: [] },
        render: { chapterPath: event.chapterPath ?? "", text: "渲染正文" },
        commit: {
          ok: true,
          appliedEventIds: ["evt_x"],
          visibilityChanges: undefined,
          writtenText: "渲染正文",
          chapterPath: event.chapterPath ?? "",
          errors: [],
        },
      };
    },
  } as unknown as Orchestrator;
  return { fake, calls };
}

/** 等待队列 worker 完成（异步 pump） */
function waitWorker(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

// 保留行为契约：plan commit 与 yolo 后半链路仍返回世界图应用结果（appliedEventIds）
// 和章节写入结果（chapterPath / writtenText），结果中不要求 memory update/error 字段
test("plan 模式：dispatch 后 plans 缓存，commit 触发后半链路并清理缓存", async () => {
  const { fake, calls } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);

  service.dispatch(makeResult("plan").event);
  await waitWorker();
  assert.equal(service.planCount(), 1, "plan 模式完成后缓存 plan");

  const commitResult = await service.commit("plan_test_1");
  assert.equal(commitResult.ok, true);
  assert.deepEqual(commitResult.appliedEventIds, ["evt_x"]);
  assert.equal(commitResult.writtenText, "渲染正文");
  assert.equal(service.planCount(), 0, "commit 后清理缓存");

  // 后半链路收到正确的 event / eventId / outputs
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event.storyTime, "ch001.ev001");
  assert.equal(calls[0].eventId, "evt_test_1");
});

test("commit 幂等：plan 不存在时报错", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const first = await service.commit("plan_test_1");
  assert.equal(first.ok, true);

  const second = await service.commit("plan_test_1");
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /not found/);
});

test("pipeline 抛错：commit 返回失败并清理缓存", async () => {
  const { fake } = makeFakeOrchestrator({ pipelineError: new Error("可见推理失败") });
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const result = await service.commit("plan_test_1");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /可见推理失败/);
  assert.equal(service.planCount(), 0);
});

test("discard：清理缓存，重复 discard 返回 false", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  assert.equal(service.discard("plan_test_1").ok, true);
  assert.equal(service.planCount(), 0);
  assert.equal(service.discard("plan_test_1").ok, false);
});

test("yolo 模式：不缓存 plan（result 已含自动落地摘要）", async () => {
  const { fake } = makeFakeOrchestrator({ result: makeResult("yolo") });
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("yolo").event);
  await waitWorker();

  assert.equal(service.planCount(), 0, "yolo 模式不缓存 plan");
  const status = service.queueStatus();
  const done = status.items.find((i) => i.status === "done");
  assert.ok(done, "队列有 done 项");
  assert.equal(done?.result?.mode, "yolo");
  assert.equal(done?.result?.commit?.ok, true);
  assert.equal(done?.result?.commit?.writtenText, "正文");
});

test("queueStatus 暴露完整编排结果（A3）", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const status = service.queueStatus();
  assert.equal(status.length, 1);
  const item = status.items[0];
  assert.equal(item.status, "done");
  assert.equal(item.result?.mode, "plan");
  assert.equal(item.result?.planId, "plan_test_1");
  assert.equal(item.result?.event.storyTime, "ch001.ev001");
});

test("listPlans：待确认 plan 摘要，commit/discard 后移除", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const plans = service.listPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].planId, "plan_test_1");
  assert.equal(plans[0].storyTime, "ch001.ev001");
  assert.equal(plans[0].mode, "plan");
  assert.deepEqual(plans[0].characterIds, ["char_a"]);
  assert.equal(plans[0].outputCount, 0);
  assert.equal(plans[0].errorCount, 0);
  assert.equal("stages" in plans[0], false, "status 摘要不暴露 stages");

  assert.equal(service.discard("plan_test_1").ok, true);
  assert.equal(service.listPlans().length, 0, "discard 后 listPlans 为空");
});

test("getPlan：返回公开详情 DTO，且 commit/discard 后不可查询", async () => {
  const result = makeResult("plan");
  result.outputs = [{ actor: "char_a", action: "前进" } as never];
  result.cast = [{ characterId: "char_a", name: "甲", summary: "角色摘要" }];
  result.errors = [{ characterId: "char_a", error: "role failed" }];
  const { fake } = makeFakeOrchestrator({ result });
  const service = new OrchestratorService(fake);
  service.dispatch(result.event);
  await waitWorker();

  const detail = service.getPlan("plan_test_1");
  assert.deepEqual(Object.keys(detail ?? {}).sort(), [
    "cast",
    "characterIds",
    "errors",
    "mode",
    "outputs",
    "planId",
    "retrievalPlan",
    "stages",
    "storyTime",
  ]);
  assert.deepEqual(detail?.stages.map(({ stage, status }) => ({ stage, status })), [
    { stage: "planner", status: "done" },
    { stage: "role", status: "error" },
  ]);
  assert.equal(detail?.stages[1].durationMs, undefined, "不存在的可选字段保持省略");
  assert.equal("event" in (detail ?? {}), false);
  assert.equal("commit" in (detail ?? {}), false);

  detail!.characterIds.push("mutated");
  detail!.stages[0].status = "error";
  detail!.outputs[0].state_changes = [{ property: "mutated" }] as never;
  assert.deepEqual(service.getPlan("plan_test_1")?.characterIds, ["char_a"], "返回只读副本");
  assert.equal(service.getPlan("plan_test_1")?.stages[0].status, "done");
  assert.equal(service.getPlan("plan_test_1")?.outputs[0].state_changes, undefined);

  await service.commit("plan_test_1");
  assert.equal(service.getPlan("plan_test_1"), undefined);

  service.dispatch(result.event);
  await waitWorker();
  assert.equal(service.discard("plan_test_1").ok, true);
  assert.equal(service.getPlan("plan_test_1"), undefined);
});
