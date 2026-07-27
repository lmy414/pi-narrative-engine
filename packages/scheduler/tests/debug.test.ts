/**
 * debug.test.ts — 调度链调试埋点单测
 *
 * 验证：
 * - 注入 debugBus 后，plan() 发射 dispatch/plan.llm/retrieve.item/role.interact 事件
 * - 注入 debugBus 后，commit() 发射 commit/commit.step.4/commit.step.5/commit.step.7 事件
 * - 未注入 debugBus 时无副作用（与现有 117 测试兼容）
 * - 事件 parentId 正确链接（子阶段 parentId = 父阶段 eventId）
 * - 异常路径发射 error 事件
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { plan } from "../src/plan.ts";
import { commit } from "../src/commit.ts";
import { setPlan, resetPlanCache, loadAllPlans, removePlansDir } from "../src/cache.ts";
import { createDebugBus } from "../../../src/debug/bus.ts";
import type { DebugBus, DebugEvent } from "../src/debug.ts";
import type { PlanResult, SchedulerCtx, StructuredEvent } from "../src/types.ts";
import type { WorldGraph } from "@pi/world-graph";
import type { RoleAgentOutput } from "@pi/role-pool";

// ----------------------------------------------------------------------------

let tmpCwd: string;
let chapterPath: string;

beforeEach(async () => {
  resetPlanCache();
  tmpCwd = await mkdtemp(path.join(tmpdir(), "debug-test-"));
  await removePlansDir(tmpCwd);
  await loadAllPlans(tmpCwd);
  chapterPath = path.join(tmpCwd, "正文", "第1章-测试.md");
});

afterEach(async () => {
  try {
    await rm(tmpCwd, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

// ----------------------------------------------------------------------------

/** 收集 bus 上所有事件，按 traceId 分组 */
function makeRecordingBus(): { bus: DebugBus; events: DebugEvent[]; byTrace: Map<string, DebugEvent[]> } {
  const events: DebugEvent[] = [];
  const byTrace = new Map<string, DebugEvent[]>();
  const bus = createDebugBus();
  bus.subscribe((e) => {
    events.push(e);
    const list = byTrace.get(e.traceId) ?? [];
    list.push(e);
    byTrace.set(e.traceId, list);
  });
  return { bus, events, byTrace };
}

/** 极简 mock wg，仅支持 plan/commit 用到的方法 */
function makeMockWg(): WorldGraph {
  return {
    getEntityAt: async () => null,
    processEvent: async () => {},
    addRelation: async () => {},
    setVisibility: async () => {},
    updateFactEmbedding: async () => {},
    getAllDeclarationsAt: async () => [],
  } as unknown as WorldGraph;
}

function makeMockCtx(bus: DebugBus | null): SchedulerCtx {
  return {
    wg: makeMockWg(),
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({}) as RoleAgentOutput,
    renderLlm: async () => "渲染正文",
    embedder: {
      embed: async () => [0, 0, 0],
      embedEntity: async () => [0, 0, 0],
      embedFact: async () => [0, 0, 0],
    },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: tmpCwd,
    staticCardLoader: async () => ({ name: "测试角色", description: "测试" }),
    ...(bus ? { debugBus: bus } : {}),
  };
}

function makeEvent(over: Partial<StructuredEvent> = {}): StructuredEvent {
  return {
    storyTime: "ch-1",
    instruction: "测试指令",
    characterIds: ["e_lin"],
    ...over,
  };
}

// ----------------------------------------------------------------------------

test("plan: 未注入 debugBus 时无副作用（noop 兼容）", async () => {
  const ctx = makeMockCtx(null);
  const result = await plan(makeEvent(), ctx);
  assert.equal(result.mode, "plan");
  // 不抛错即通过
});

test("plan: 注入 debugBus 后发射 dispatch.start/end 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  await plan(makeEvent(), ctx);

  const startEvents = events.filter((e) => e.stage === "dispatch" && e.status === "start");
  const endEvents = events.filter((e) => e.stage === "dispatch" && e.status === "end");
  assert.equal(startEvents.length, 1, "应有 1 个 dispatch.start");
  assert.equal(endEvents.length, 1, "应有 1 个 dispatch.end");
});

test("plan: dispatch 事件的 input 含 storyTime/instruction/characterIds", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  await plan(makeEvent({ storyTime: "ch-5", instruction: "林冲夜奔" }), ctx);

  const startEv = events.find((e) => e.stage === "dispatch" && e.status === "start");
  assert.ok(startEv);
  const input = startEv!.input as { storyTime: string; instruction: string; characterIds: string[] };
  assert.equal(input.storyTime, "ch-5");
  assert.equal(input.instruction, "林冲夜奔");
  assert.deepEqual(input.characterIds, ["e_lin"]);
});

test("plan: 发射 plan.llm.start/end 事件，parentId 指向 dispatch", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  await plan(makeEvent(), ctx);

  const dispatchStart = events.find((e) => e.stage === "dispatch" && e.status === "start");
  const planLlmStart = events.find((e) => e.stage === "plan.llm" && e.status === "start");
  const planLlmEnd = events.find((e) => e.stage === "plan.llm" && e.status === "end");
  assert.ok(dispatchStart);
  assert.ok(planLlmStart);
  assert.ok(planLlmEnd);
  assert.equal(planLlmStart!.parentId, dispatchStart!.id, "plan.llm 的 parentId 应是 dispatch.start 的 id");
  assert.equal(planLlmEnd!.parentId, dispatchStart!.id);
});

test("plan: planner LLM 抛错时发射 plan.llm.error 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  ctx.plannerLlm = async () => { throw new Error("planner down"); };

  await assert.rejects(() => plan(makeEvent(), ctx), /planner down/);

  const errEvent = events.find((e) => e.stage === "plan.llm" && e.status === "error");
  assert.ok(errEvent, "应有 plan.llm.error 事件");
  assert.equal(errEvent!.error, "planner down");

  // dispatch 也应被标记为 error
  const dispatchErr = events.find((e) => e.stage === "dispatch" && e.status === "error");
  assert.ok(dispatchErr, "应有 dispatch.error 事件");
});

test("plan: 发射 role.interact.start/end 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  await plan(makeEvent(), ctx);

  const start = events.find((e) => e.stage === "role.interact" && e.status === "start");
  const end = events.find((e) => e.stage === "role.interact" && e.status === "end");
  assert.ok(start);
  assert.ok(end);
});

test("plan: yolo 模式下 dispatch 与 commit 共享同一 traceId", async () => {
  const { bus, byTrace } = makeRecordingBus();
  const ctx = makeMockCtx(bus);
  await plan(makeEvent({ mode: "yolo" }), ctx);

  // 应只有一个 traceId（dispatch + commit 在同一次 plan 调用里）
  assert.equal(byTrace.size, 1, "yolo 模式应只有一个 traceId");
  const traceId = [...byTrace.keys()][0];
  const events = byTrace.get(traceId)!;

  // 应同时含 dispatch 和 commit 事件
  assert.ok(events.some((e) => e.stage === "dispatch"), "应有 dispatch 事件");
  assert.ok(events.some((e) => e.stage === "commit"), "应有 commit 事件");
});

// ----------------------------------------------------------------------------

test("commit: 注入 debugBus 后发射 commit.start/end 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  // 预置 plan
  const planResult: PlanResult = {
    planId: "plan_dbg_1",
    eventId: "evt_dbg_1",
    event: makeEvent(),
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: { outputs: [], errors: [] },
    cast: [],
    createdAt: Date.now(),
  };
  setPlan("plan_dbg_1", planResult);

  await commit("plan_dbg_1", ctx);

  const start = events.filter((e) => e.stage === "commit" && e.status === "start");
  const end = events.filter((e) => e.stage === "commit" && e.status === "end");
  assert.equal(start.length, 1);
  assert.equal(end.length, 1);
});

test("commit: 独立调用时自动生成 traceId（不传 traceId 参数）", async () => {
  const { bus, byTrace } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  const planResult: PlanResult = {
    planId: "plan_dbg_2",
    eventId: "evt_dbg_2",
    event: makeEvent(),
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: { outputs: [], errors: [] },
    cast: [],
    createdAt: Date.now(),
  };
  setPlan("plan_dbg_2", planResult);

  await commit("plan_dbg_2", ctx); // 不传 traceId

  // 应自动生成一个 traceId
  assert.equal(byTrace.size, 1);
  const traceId = [...byTrace.keys()][0];
  assert.ok(traceId.startsWith("trace_"), `traceId 应以 trace_ 开头，实际: ${traceId}`);
});

test("commit: state_changes 触发 commit.step.4 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  const planResult: PlanResult = {
    planId: "plan_dbg_3",
    eventId: "evt_dbg_3",
    event: makeEvent({ storyTime: "ch-2" }),
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: {
      outputs: [
        {
          characterId: "e_lin",
          actor: "林冲",
          action: "杀人",
          state_changes: [
            { entityId: "e_lin", property: "mood", value: "绝望", modality: "fact" },
          ],
        },
      ],
      errors: [],
    },
    cast: [],
    createdAt: Date.now(),
  };
  setPlan("plan_dbg_3", planResult);

  await commit("plan_dbg_3", ctx);

  const step4Start = events.find((e) => e.stage === "commit.step.4" && e.status === "start");
  const step4End = events.find((e) => e.stage === "commit.step.4" && e.status === "end");
  assert.ok(step4Start, "应有 commit.step.4.start");
  assert.ok(step4End, "应有 commit.step.4.end");

  // step.4 的 parentId 应指向 commit.start
  const commitStart = events.find((e) => e.stage === "commit" && e.status === "start");
  assert.equal(step4Start!.parentId, commitStart!.id, "step.4 的 parentId 应是 commit.start 的 id");
});

test("commit: relation_update 触发 commit.step.5 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  const planResult: PlanResult = {
    planId: "plan_dbg_4",
    eventId: "evt_dbg_4",
    event: makeEvent(),
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: {
      outputs: [
        {
          characterId: "e_lin",
          actor: "林冲",
          action: "举刀",
          relation_update: [{ target: "e_lu", label: "仇敌" }],
        },
      ],
      errors: [],
    },
    cast: [],
    createdAt: Date.now(),
  };
  setPlan("plan_dbg_4", planResult);

  await commit("plan_dbg_4", ctx);

  const step5Start = events.find((e) => e.stage === "commit.step.5" && e.status === "start");
  const step5End = events.find((e) => e.stage === "commit.step.5" && e.status === "end");
  assert.ok(step5Start, "应有 commit.step.5.start");
  assert.ok(step5End, "应有 commit.step.5.end");
});

test("commit: 渲染触发 commit.step.7 事件", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  await mkdir(path.dirname(chapterPath), { recursive: true });
  await writeFile(chapterPath, "<!-- engine v0.01 -->\n\n", "utf8");

  const planResult: PlanResult = {
    planId: "plan_dbg_5",
    eventId: "evt_dbg_5",
    event: makeEvent(),
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: { outputs: [], errors: [] },
    cast: [],
    createdAt: Date.now(),
  };
  setPlan("plan_dbg_5", planResult);

  await commit("plan_dbg_5", ctx);

  const step7Start = events.find((e) => e.stage === "commit.step.7" && e.status === "start");
  const step7End = events.find((e) => e.stage === "commit.step.7" && e.status === "end");
  assert.ok(step7Start, "应有 commit.step.7.start");
  assert.ok(step7End, "应有 commit.step.7.end");
});

test("commit: plan 不存在时不发射任何事件（早返回）", async () => {
  const { bus, events } = makeRecordingBus();
  const ctx = makeMockCtx(bus);

  await commit("plan_not_exist", ctx);

  assert.equal(events.length, 0, "plan 不存在时应早返回，不发射事件");
});
