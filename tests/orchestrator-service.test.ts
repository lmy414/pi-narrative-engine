// tests/orchestrator-service.test.ts
/**
 * OrchestratorService 单测（A2/A3 验收）
 *
 * 用 fake orchestrator（stub run / runPostRolePipeline）断言：
 * - plan 模式：queue done 后 plans 缓存，commit 触发后半链路并清理缓存
 * - commit 幂等（重复 commit 报错）、discard 清理
 * - pipeline 抛错时 commit 返回失败并清理缓存
 * - yolo 模式：不缓存 plan（result.commit 已含落地摘要）
 * - queueStatus 暴露 resultSummary 摘要 + active 活跃数（A3 + G1-1/G1-2 瘦身）
 * - 完整 result 按需走 getQueuedEvent（不再每 2s 全量序列化）
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

  // BUG-014 异步化：commit 入队即返回，不等 pipeline 执行
  const commitResult = await service.commit("plan_test_1");
  assert.equal(commitResult.ok, true);
  assert.equal(commitResult.status, "committing");
  assert.equal(typeof commitResult.queueId, "string");
  // 等后台 commit pipeline 完成
  await waitWorker();
  // plan 保留（TTL 清理），status 流转
  assert.notEqual(service.planCount(), 0, "commit 后 plan 保留（异步化，TTL 清理）");

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
  // BUG-014：重复 commit 同一 plan 返回 COMMIT_IN_PROGRESS
  assert.equal(second.error, "COMMIT_IN_PROGRESS");
});

test("pipeline 抛错：commit 入队成功，后台失败后 plan 标记 error", async () => {
  // BUG-014 异步化：commit 入队即返回 ok=true，pipeline 错误在后台处理
  const { fake } = makeFakeOrchestrator({ pipelineError: new Error("可见推理失败") });
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const result = await service.commit("plan_test_1");
  assert.equal(result.ok, true);
  assert.equal(result.status, "committing");
  // 等后台 commit pipeline 完成
  await waitWorker();
  const plan = service.getPlan("plan_test_1");
  // plan 保留，status 流转为 error
  assert.notEqual(plan, undefined);
  assert.equal(plan?.status, "error");
});

test("pipeline 部分写入失败：commit 入队成功，后台失败后 plan 标记 error 保留供排查（L-Test-1）", async () => {
  // BUG-014 异步化 + 🔴-2 契约：部分写入失败时 plan 保留供排查
  const partialError = Object.assign(new Error("第 2 个事件写入失败"), { appliedEventIds: ["evt_a"] });
  const { fake } = makeFakeOrchestrator({ pipelineError: partialError });
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const result = await service.commit("plan_test_1");
  assert.equal(result.ok, true);
  assert.equal(result.status, "committing");
  // 等后台 commit pipeline 完成
  await waitWorker();
  assert.equal(service.planCount(), 1, "部分写入时保留 plan 供排查");
  const plan = service.getPlan("plan_test_1");
  assert.equal(plan?.status, "error");
  assert.equal(service.discard("plan_test_1").ok, true);
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
  // G1-1 瘦身：queueStatus 仅暴露 resultSummary，完整 result 走 getQueuedEvent
  assert.equal(done?.resultSummary?.mode, "yolo");
  assert.equal(done?.resultSummary?.chapterPath, "chapters/ch001.md");
  assert.deepEqual(done?.resultSummary?.appliedEventIds, ["evt_x"]);
  assert.equal(done?.resultSummary?.writtenTextLength, 2); // "正文".length === 2
  assert.equal(done?.result, undefined, "queueStatus 不再暴露完整 result");
  // 按需拉取完整 result
  const full = service.getQueuedEvent(done!.queueId);
  assert.equal(full?.result?.mode, "yolo");
  assert.equal(full?.result?.commit?.ok, true);
  assert.equal(full?.result?.commit?.writtenText, "正文");
});

test("queueStatus 暴露摘要而非完整 result（A3 + G1-1 瘦身）", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  const status = service.queueStatus();
  assert.equal(status.length, 1);
  // G1-2：active 字段区分活跃 vs 累计
  assert.equal(status.active, 0, "完成后 active=0（区分 length 累计）");
  const item = status.items[0];
  assert.equal(item.status, "done");
  assert.equal(item.result, undefined, "不再暴露完整 result（瘦身）");
  assert.equal(item.resultSummary?.mode, "plan");
  assert.equal(item.resultSummary?.planId, "plan_test_1");
  assert.equal(item.resultSummary?.outputCount, 0);
  assert.equal(item.resultSummary?.errorCount, 0);
  assert.equal(item.resultSummary?.chapterPath, "chapters/ch001.md");
  // 完整 result（含 event.storyTime 等）按需走 getQueuedEvent
  const full = service.getQueuedEvent(item.queueId);
  assert.equal(full?.result?.event.storyTime, "ch001.ev001");
});

test("queueStatus.active 反映 pending/running 数（G1-2）", async () => {
  let release!: () => void;
  const blocker = new Promise<void>((r) => { release = r; });
  const { fake } = makeFakeOrchestrator();
  // 临时替换 run 让 worker 挂起
  (fake as unknown as { run: unknown }).run = async () => { await blocker; return makeResult("plan"); };
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await new Promise((r) => setTimeout(r, 20));
  const status = service.queueStatus();
  assert.equal(status.active, 1, "running 中 active=1");
  assert.equal(status.length, 1, "length 也为 1（同一项）");
  release();
  await waitWorker();
  const doneStatus = service.queueStatus();
  assert.equal(doneStatus.active, 0, "完成后 active=0");
  assert.equal(doneStatus.length, 1, "length 仍为 1（已完成未清理）");
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
  // BUG-014: PlanDetail 新增 status（必有）+ commitQueueId?/commitError?（optional，未提交时不存在）
  assert.deepEqual(Object.keys(detail ?? {}).sort(), [
    "cast",
    "characterIds",
    "errors",
    "mode",
    "outputs",
    "planId",
    "retrievalPlan",
    "stages",
    "status",
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

  // BUG-014 异步化：commit 入队后 plan 不删除，status 流转为 "committing"
  await service.commit("plan_test_1");
  const committed = service.getPlan("plan_test_1");
  assert.notEqual(committed, undefined);
  assert.equal(committed?.status, "committing");

  service.dispatch(result.event);
  await waitWorker();
  assert.equal(service.discard("plan_test_1").ok, true);
  assert.equal(service.getPlan("plan_test_1"), undefined);
});

test("committed PlanDetail 同时含三项结果（diffusion + render + commit）", async () => {
  const { fake } = makeFakeOrchestrator();
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();
  await service.commit("plan_test_1");
  await waitWorker();

  const detail = service.getPlan("plan_test_1");
  assert.notEqual(detail, undefined);
  assert.equal(detail?.status, "committed");
  assert.ok(detail?.diffusion, "committed 后应有 diffusion");
  assert.ok(detail?.render, "committed 后应有 render");
  assert.ok(detail?.commit, "committed 后应有 commit");
  assert.deepEqual(detail?.diffusion, { appliedEventIds: ["evt_x"], changes: [] });
  assert.equal(detail?.render?.chapterPath, "", "render chapterPath 来自 runPostRolePipeline 返回值");
  assert.equal(detail?.render?.text, "渲染正文", "render 保留 text");
  assert.equal(detail?.commit?.ok, true);
  assert.equal(detail?.commit?.writtenText, "渲染正文");
  assert.equal(detail?.commit?.chapterPath, "");
  assert.deepEqual(detail?.commit?.appliedEventIds, ["evt_x"]);
});

test("commit 失败保留前半链路并设置 commitError", async () => {
  const { fake } = makeFakeOrchestrator({ pipelineError: new Error("可见推理失败") });
  const service = new OrchestratorService(fake);
  service.dispatch(makeResult("plan").event);
  await waitWorker();

  // 确认前半链路完整
  const before = service.getPlan("plan_test_1");
  assert.notEqual(before, undefined);
  assert.equal(before?.status, "confirmed");
  assert.ok(Array.isArray(before?.outputs));
  assert.ok(Array.isArray(before?.cast));
  assert.ok(Array.isArray(before?.stages));
  assert.ok(before?.retrievalPlan);
  assert.equal("diffusion" in (before ?? {}), false, "confirmed 时无 diffusion");
  assert.equal("commitError" in (before ?? {}), false, "confirmed 时无 commitError");

  await service.commit("plan_test_1");
  await waitWorker();

  const after = service.getPlan("plan_test_1");
  assert.notEqual(after, undefined);
  assert.equal(after?.status, "error");
  assert.equal(after?.commitError, "可见推理失败", "commitError 反映错误信息");
  // 前半链路保留
  assert.equal(after?.outputs.length, before?.outputs.length, "outputs 保留");
  assert.equal(after?.cast.length, before?.cast.length, "cast 保留");
  assert.equal(after?.stages.length, before?.stages.length, "stages 保留");
  assert.ok(after?.retrievalPlan, "retrievalPlan 保留");
  assert.equal("diffusion" in (after ?? {}), false, "失败时无 diffusion");
});

test("DTO 深拷贝覆盖 outputs.thought、diffusion、render.text 和 commit", async () => {
  const result = makeResult("plan");
  result.outputs = [{ actor: "char_a", action: "思考", thought: "深度思考内容" } as never];
  const { fake } = makeFakeOrchestrator({ result });
  const service = new OrchestratorService(fake);
  service.dispatch(result.event);
  await waitWorker();
  await service.commit("plan_test_1");
  await waitWorker();

  const detail = service.getPlan("plan_test_1");
  assert.notEqual(detail, undefined);

  // outputs.thought 深拷贝
  const thoughtBefore = detail!.outputs[0].thought;
  detail!.outputs[0].thought = "篡改内容";
  assert.equal(service.getPlan("plan_test_1")!.outputs[0].thought, thoughtBefore, "outputs.thought 深拷贝");

  // diffusion 深拷贝
  detail!.diffusion!.changes = [{ property: "mutated" }] as never;
  detail!.diffusion!.appliedEventIds = ["mutated"];
  assert.deepEqual(service.getPlan("plan_test_1")!.diffusion?.changes, []);
  assert.deepEqual(service.getPlan("plan_test_1")!.diffusion?.appliedEventIds, ["evt_x"]);

  // render.text 深拷贝
  detail!.render!.text = "篡改正文";
  assert.equal(service.getPlan("plan_test_1")!.render?.text, "渲染正文");

  // commit 深拷贝
  detail!.commit!.writtenText = "篡改";
  assert.equal(service.getPlan("plan_test_1")!.commit?.writtenText, "渲染正文");
});
