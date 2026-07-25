// tests/commit.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { commit } from "../src/commit.ts";
import { setPlan, resetPlanCache, loadAllPlans, removePlansDir } from "../src/cache.ts";
import type { PlanResult, SchedulerCtx, StructuredEvent } from "../src/types.ts";
import type { WorldGraph } from "@pi/world-graph";
import type { RoleAgentOutput } from "@pi/role-pool";

// ----------------------------------------------------------------------------
// 测试夹具
// ----------------------------------------------------------------------------

let tmpCwd: string;
let chapterPath: string;

beforeEach(async () => {
  resetPlanCache();
  tmpCwd = await mkdtemp(path.join(tmpdir(), "commit-test-"));
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

/**
 * mock WorldGraph：只实现 commit 用到的方法
 * - getEntityAt：返回 null（避免触发 invalidated 逻辑）
 * - processEvent：记录调用次数和参数
 * - addRelation：记录调用次数和参数（2026-07-25 加，对应 Pending Gap #2）
 *
 * TypeScript 结构类型：只要有 WorldGraph 的方法签名即可（多余属性不报错）
 */
function makeMockWg(): {
  wg: WorldGraph;
  processEventCalls: any[];
  addRelationCalls: any[];
  setVisibilityCalls: any[];
} {
  const processEventCalls: any[] = [];
  const addRelationCalls: any[] = [];
  const setVisibilityCalls: any[] = [];
  const wg = {
    getEntityAt: async () => null,
    processEvent: async (input: any) => {
      processEventCalls.push(input);
    },
    addRelation: async (sourceId: string, targetId: string, label: string, storyTime: string) => {
      addRelationCalls.push({ sourceId, targetId, label, storyTime });
    },
    setVisibility: async (characterId: string, declarationId: string, opts: any) => {
      setVisibilityCalls.push({ characterId, declarationId, opts });
    },
  } as unknown as WorldGraph;
  return { wg, processEventCalls, addRelationCalls, setVisibilityCalls };
}

/**
 * 完整 SchedulerCtx mock：
 * - renderLlm 返回固定文本（便于断言）
 * - roleLlm / plannerLlm 不在 commit 路径上，给空函数
 * - 规则集空字符串
 */
function makeMockCtx(wg: WorldGraph): SchedulerCtx {
  return {
    wg,
    plannerLlm: async () => ({ items: [] }),
    roleLlm: async () => ({}) as RoleAgentOutput,
    renderLlm: async () => "这是渲染器生成的正文。",
    embedder: { embed: async () => [0, 0, 0] },
    roleRuleSet: "",
    renderRuleSet: "",
    plannerRuleSet: "",
    cwd: tmpCwd,
    staticCardLoader: async () => ({
      name: "测试角色",
      description: "用于测试",
    }),
  };
}

/**
 * 构造一个最小可用的 plan
 */
function makePlan(eventOver: Partial<StructuredEvent> = {}): PlanResult {
  const event: StructuredEvent = {
    storyTime: "ch-1",
    instruction: "测试指令",
    characterIds: [],
    ...eventOver,
  };
  return {
    planId: "plan_test",
    eventId: "evt_test_001",
    event,
    chapterPath,
    retrievalPlan: { items: [] },
    roleResult: {
      outputs: [
        {
          characterId: "e_lin",
          actor: "林冲",
          action: "推开酒馆门",
        },
      ],
      errors: [],
    },
    cast: [],
    createdAt: Date.now(),
  };
}

/**
 * 预置章节文件：含一个锚点供 modify/insert 定位
 */
async function makeChapterWithAnchor(anchorEventId: string): Promise<void> {
  await mkdir(path.dirname(chapterPath), { recursive: true });
  const content =
    `<!-- engine v0.01 -->\n\n` +
    `<!-- event: ${anchorEventId} -->\n\n` +
    `原有正文内容。\n`;
  await writeFile(chapterPath, content, "utf8");
}

// ----------------------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------------------

test("commit: plan 不存在返回错误", async () => {
  const { wg } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const result = await commit("plan_not_exist", ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not found/);
});

test("commit: intent=add 走 append 模式", async () => {
  const { wg, processEventCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  setPlan("plan_add", makePlan({ intent: "add" }));

  const result = await commit("plan_add", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(result.planId, "plan_add");
  assert.equal(result.eventId, "evt_test_001");
  // 章节文件应被写入新锚点 + 渲染正文
  assert.ok(existsSync(chapterPath), "章节文件应存在");
  const content = await readFile(chapterPath, "utf8");
  assert.ok(content.includes("<!-- event: evt_test_001 -->"), "应有新锚点");
  assert.ok(content.includes("这是渲染器生成的正文。"), "应有渲染正文");
  // getPlan 应返回 null（commit 后已 delete）
  assert.equal(processEventCalls.length, 0, "无 state_changes 应不调 processEvent");
});

test("commit: intent=modify 走 modify 模式，重写指定锚点区间", async () => {
  const { wg } = makeMockWg();
  const ctx = makeMockCtx(wg);
  // 预置章节含 evt_target 锚点
  await makeChapterWithAnchor("evt_target");
  setPlan(
    "plan_modify",
    makePlan({ intent: "modify", targetEventId: "evt_target" }),
  );

  const result = await commit("plan_modify", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  const content = await readFile(chapterPath, "utf8");
  // modify 应保留原锚点
  assert.ok(content.includes("<!-- event: evt_target -->"), "原锚点应保留");
  // 但正文已被替换为渲染器输出
  assert.ok(content.includes("这是渲染器生成的正文。"), "应有新渲染正文");
  // 原有正文应被替换掉
  assert.ok(!content.includes("原有正文内容。"), "原正文应被覆盖");
});

test("commit: intent=insert 在目标锚点之后插入新事件区块", async () => {
  const { wg } = makeMockWg();
  const ctx = makeMockCtx(wg);
  await makeChapterWithAnchor("evt_target");
  setPlan(
    "plan_insert",
    makePlan({ intent: "insert", targetEventId: "evt_target" }),
  );

  const result = await commit("plan_insert", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  const content = await readFile(chapterPath, "utf8");
  // 原锚点应保留
  const idxTarget = content.indexOf("<!-- event: evt_target -->");
  const idxNew = content.indexOf("<!-- event: evt_test_001 -->");
  assert.ok(idxTarget > -1, "原锚点应存在");
  assert.ok(idxNew > idxTarget, "新锚点应在原锚点之后");
  // 原正文应保留（insert 不替换）
  assert.ok(content.includes("原有正文内容。"), "原正文应保留");
  // 新渲染正文应存在
  assert.ok(content.includes("这是渲染器生成的正文。"), "应有新渲染正文");
});

test("commit: intent=insert 缺 targetEventId 返回 ok=false", async () => {
  const { wg } = makeMockWg();
  const ctx = makeMockCtx(wg);
  await makeChapterWithAnchor("evt_target");
  setPlan("plan_insert_no_target", makePlan({ intent: "insert" }));

  const result = await commit("plan_insert_no_target", ctx);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /targetEventId/);
});

test("commit: state_changes 触发 wg.processEvent 调用", async () => {
  const { wg, processEventCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  // 注入 state_changes
  plan.roleResult.outputs[0].state_changes = [
    {
      entityId: "e_lin",
      property: "location",
      value: "酒馆",
      modality: "fact",
    },
  ];
  setPlan("plan_sc", plan);

  const result = await commit("plan_sc", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls.length, 1, "应有 1 次 processEvent 调用");
  assert.equal(processEventCalls[0].type, "change");
  assert.equal(processEventCalls[0].entityId, "e_lin");
  assert.equal(result.appliedEventIds.length, 1);
});

// ----------------------------------------------------------------------------
// 自产自知可见性测试（2026-07-25 修复角色自盲，审计核对项 4）
// state_changes 写入的新 Fact 必须对产生变更的角色可见，
// 否则下一场 character_view 五步过滤会把它滤掉（角色"自盲"）
// ----------------------------------------------------------------------------

test("commit: state_changes 的新 Fact 为作者角色写入可见性（自盲回归）", async () => {
  const { wg, setVisibilityCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].state_changes = [
    {
      entityId: "e_lin",
      property: "mood",
      value: "绝望",
      modality: "fact",
    },
  ];
  setPlan("plan_vis", plan);

  const result = await commit("plan_vis", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(setVisibilityCalls.length, 1, "应有 1 次 setVisibility 调用");
  assert.equal(setVisibilityCalls[0].characterId, "e_lin", "作者角色应获得可见性");
  assert.equal(
    setVisibilityCalls[0].declarationId,
    "decl-e_lin-mood-ch-2",
    "declarationId 应与 world-graph 生成规则一致",
  );
  assert.equal(setVisibilityCalls[0].opts.state, "known");
  assert.equal(setVisibilityCalls[0].opts.validFrom, "ch-2");
});

test("commit: 无 state_changes 时不调 setVisibility", async () => {
  const { wg, setVisibilityCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  setPlan("plan_no_vis", plan);

  const result = await commit("plan_no_vis", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(setVisibilityCalls.length, 0, "无变更不应写可见性");
});

// ============================================================================
// relation_update 写入测试（2026-07-25 解决 Pending Gap #2）
// 验证 LLM 输出的 characterId 被直接透传给 wg.addRelation
// ============================================================================

test("commit: relation_update 触发 wg.addRelation 调用", async () => {
  const { wg, addRelationCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  // 注入 relation_update（target 是对方 characterId，不是名字）
  plan.roleResult.outputs[0].relation_update = [
    { target: "e_lu", label: "仇敌" },
  ];
  setPlan("plan_rel", plan);

  const result = await commit("plan_rel", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(addRelationCalls.length, 1, "应有 1 次 addRelation 调用");
  assert.equal(addRelationCalls[0].sourceId, "e_lin", "source 应为角色 characterId");
  assert.equal(addRelationCalls[0].targetId, "e_lu", "target 应为对方 characterId");
  assert.equal(addRelationCalls[0].label, "仇敌");
  assert.equal(addRelationCalls[0].storyTime, "ch-1");
});

test("commit: 多角色多 relation_update 全部写入", async () => {
  const { wg, addRelationCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs = [
    {
      characterId: "e_lin",
      actor: "林冲",
      action: "举刀",
      relation_update: [
        { target: "e_lu", label: "仇敌" },
        { target: "e_zhang", label: "旧识" },
      ],
    },
    {
      characterId: "e_wu",
      actor: "武松",
      action: "劝架",
      relation_update: [{ target: "e_lin", label: "结义" }],
    },
  ];
  setPlan("plan_multi_rel", plan);

  const result = await commit("plan_multi_rel", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(addRelationCalls.length, 3, "应有 3 次 addRelation 调用");
  assert.equal(addRelationCalls[0].sourceId, "e_lin");
  assert.equal(addRelationCalls[0].targetId, "e_lu");
  assert.equal(addRelationCalls[1].sourceId, "e_lin");
  assert.equal(addRelationCalls[1].targetId, "e_zhang");
  assert.equal(addRelationCalls[2].sourceId, "e_wu");
  assert.equal(addRelationCalls[2].targetId, "e_lin");
});

test("commit: 无 relation_update 时不调 addRelation", async () => {
  const { wg, addRelationCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  setPlan("plan_no_rel", makePlan({ intent: "add" }));

  const result = await commit("plan_no_rel", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(addRelationCalls.length, 0, "无 relation_update 应不调 addRelation");
});

test("commit: commit 后 plan 缓存被清空（幂等性）", async () => {
  const { wg } = makeMockWg();
  const ctx = makeMockCtx(wg);
  setPlan("plan_idem", makePlan({ intent: "add" }));

  const r1 = await commit("plan_idem", ctx);
  assert.equal(r1.ok, true);

  // 再次 commit 应失败（plan 已删除）
  const r2 = await commit("plan_idem", ctx);
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? "", /not found/);
});
