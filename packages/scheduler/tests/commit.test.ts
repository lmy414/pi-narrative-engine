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
import type { WorldGraph } from "underworld-graph";
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
 * - updateFactEmbedding：记录调用次数和参数（P0-5 修复，2026-07-27 加）
 * - getAllDeclarationsAt：记录调用次数和参数（P0-3+6 修复，2026-07-27 加）
 *
 * TypeScript 结构类型：只要有 WorldGraph 的方法签名即可（多余属性不报错）
 */
function makeMockWg(): {
  wg: WorldGraph;
  processEventCalls: any[];
  addRelationCalls: any[];
  setVisibilityCalls: any[];
  updateFactEmbeddingCalls: any[];
  getAllDeclarationsAtCalls: any[];
  getAllDeclarationsAtReturn: Array<{ declarationId: string; entityId: string; property: string; value: unknown; modality: string; validFrom: string; validTo: string }>;
} {
  const processEventCalls: any[] = [];
  const addRelationCalls: any[] = [];
  const setVisibilityCalls: any[] = [];
  const updateFactEmbeddingCalls: any[] = [];
  const getAllDeclarationsAtCalls: any[] = [];
  // 默认返回空数组，测试用例可通过 getAllDeclarationsAtReturn 字段注入候选列表
  const getAllDeclarationsAtReturn: Array<{ declarationId: string; entityId: string; property: string; value: unknown; modality: string; validFrom: string; validTo: string }> = [];
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
    updateFactEmbedding: async (declarationId: string, embedding: number[]) => {
      updateFactEmbeddingCalls.push({ declarationId, embedding });
    },
    getAllDeclarationsAt: async (storyTime: string) => {
      getAllDeclarationsAtCalls.push(storyTime);
      return [...getAllDeclarationsAtReturn];
    },
  } as unknown as WorldGraph;
  return { wg, processEventCalls, addRelationCalls, setVisibilityCalls, updateFactEmbeddingCalls, getAllDeclarationsAtCalls, getAllDeclarationsAtReturn };
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
    embedder: {
      embed: async () => [0, 0, 0],
      embedEntity: async () => [0, 0, 0],
      embedFact: async () => [0, 0, 0],
    },
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

test("commit: 同 property 多条未闭合 Fact 全部 invalidated（不假设唯一）", async () => {
  const { wg, processEventCalls, setVisibilityCalls: _v } = makeMockWg();
  // mock getEntityAt 返回同 property 两条未闭合 Fact
  (wg as any).getEntityAt = async () => ({
    entityId: "e_lin",
    type: "character",
    summary: "",
    validFrom: "ch-1",
    validTo: "Infinity",
    properties: [
      { declarationId: "decl-1", entityId: "e_lin", property: "mood", value: "开心", modality: "fact", validFrom: "ch-1", validTo: "Infinity" },
      { declarationId: "decl-2", entityId: "e_lin", property: "mood", value: "放松", modality: "fact", validFrom: "ch-1", validTo: "Infinity" },
    ],
  });
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "绝望", modality: "fact" },
  ];
  setPlan("plan_inv", plan);

  const result = await commit("plan_inv", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls[0].invalidated.length, 2, "两条旧 Fact 都应闭合");
  assert.deepEqual(
    processEventCalls[0].invalidated.map((i: any) => i.declarationId).sort(),
    ["decl-1", "decl-2"],
  );
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

// ============================================================================
// P0-4 事务化测试（2026-07-27 修复）
// 单个 entityId 失败不阻断其他 entityId；失败项记入 failedEntityIds
// ============================================================================

test("commit: 单个 entityId processEvent 抛错时不阻断其他 entityId", async () => {
  const { wg, processEventCalls } = makeMockWg();
  // mock processEvent 对 entityId="e_fail" 抛错，对 "e_ok" 正常
  (wg as any).processEvent = async (input: any) => {
    if (input.entityId === "e_fail") {
      throw new Error("mock processEvent 失败");
    }
    processEventCalls.push(input);
  };
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs = [
    {
      characterId: "e_lin",
      actor: "林冲",
      action: "测试",
      state_changes: [
        { entityId: "e_fail", property: "mood", value: "绝望", modality: "fact" },
        { entityId: "e_ok", property: "location", value: "酒馆", modality: "fact" },
      ],
    },
  ];
  setPlan("plan_p0_4_partial", plan);

  const result = await commit("plan_p0_4_partial", ctx);

  assert.equal(result.ok, false, "部分失败时 ok 应为 false（保守语义）");
  assert.equal(processEventCalls.length, 1, "应只成功 1 次 processEvent");
  assert.equal(processEventCalls[0].entityId, "e_ok", "成功的应是 e_ok");
  assert.deepEqual(result.failedEntityIds, ["e_fail"], "failedEntityIds 应含 e_fail");
  assert.equal(result.appliedEventIds.length, 1, "appliedEventIds 应有 1 项");
});

test("commit: 部分失败时 plan 缓存仍被清理（避免重复 commit）", async () => {
  const { wg } = makeMockWg();
  (wg as any).processEvent = async () => {
    throw new Error("mock 失败");
  };
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "绝望", modality: "fact" },
  ];
  setPlan("plan_p0_4_cleanup", plan);

  const r1 = await commit("plan_p0_4_cleanup", ctx);
  assert.equal(r1.ok, false, "应失败");
  assert.deepEqual(r1.failedEntityIds, ["e_lin"]);

  // 再次 commit 同 planId 应返回 not found（plan 已清理）
  const r2 = await commit("plan_p0_4_cleanup", ctx);
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? "", /not found/);
});

test("commit: relation_update 失败时不阻断主链路", async () => {
  const { wg, addRelationCalls, processEventCalls } = makeMockWg();
  (wg as any).addRelation = async () => {
    throw new Error("mock addRelation 失败");
  };
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
  ];
  plan.roleResult.outputs[0].relation_update = [
    { target: "e_lu", label: "仇敌" },
  ];
  setPlan("plan_p0_4_rel_fail", plan);

  const result = await commit("plan_p0_4_rel_fail", ctx);

  // relation 失败 → ok=false，但 processEvent 应已成功
  assert.equal(result.ok, false, "relation 失败时 ok 应为 false");
  assert.equal(processEventCalls.length, 1, "state_changes 应已写入");
  assert.equal(addRelationCalls.length, 0, "addRelation 应未成功记录（已抛错）");
  assert.deepEqual(
    result.failedRelations,
    [{ source: "e_lin", target: "e_lu", label: "仇敌" }],
    "failedRelations 应含失败项",
  );
  assert.equal(result.appliedEventIds.length, 1, "主链路应已成功");
});

test("commit: 全部失败时返回 ok=false + 完整 failedEntityIds", async () => {
  const { wg } = makeMockWg();
  (wg as any).processEvent = async () => {
    throw new Error("全失败");
  };
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_a", property: "mood", value: "怒", modality: "fact" },
    { entityId: "e_b", property: "mood", value: "怒", modality: "fact" },
  ];
  setPlan("plan_p0_4_all_fail", plan);

  const result = await commit("plan_p0_4_all_fail", ctx);

  assert.equal(result.ok, false);
  assert.equal(result.appliedEventIds.length, 0, "无成功项");
  assert.deepEqual(
    result.failedEntityIds?.sort(),
    ["e_a", "e_b"],
    "failedEntityIds 应含全部 entityId",
  );
});

// ============================================================================
// P0-5 embedding 写入测试（2026-07-27 修复）
// commit.ts 4.2.5 步为新增 Fact 生成 embedding 并调 wg.updateFactEmbedding
// ============================================================================

test("commit: 4.2.5 步为新增 Fact 生成 embedding 并调 updateFactEmbedding", async () => {
  const { wg, updateFactEmbeddingCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "绝望", modality: "fact" },
    { entityId: "e_lin", property: "location", value: "山神庙", modality: "fact" },
  ];
  setPlan("plan_p0_5_embed", plan);

  const result = await commit("plan_p0_5_embed", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(
    updateFactEmbeddingCalls.length,
    2,
    "应为每个 state_change 调一次 updateFactEmbedding",
  );
  // 验证 declarationId 生成规则
  assert.equal(updateFactEmbeddingCalls[0].declarationId, "decl-e_lin-mood-ch-2");
  assert.equal(updateFactEmbeddingCalls[1].declarationId, "decl-e_lin-location-ch-2");
  // embedding 应为数组（mock 返回 [0,0,0]）
  assert.ok(Array.isArray(updateFactEmbeddingCalls[0].embedding));
});

test("commit: embedFact 抛错时不阻断 commit", async () => {
  const { wg, processEventCalls } = makeMockWg();
  // mock embedder.embedFact 抛错
  const ctx = makeMockCtx(wg);
  (ctx as any).embedder = {
    embed: async () => [0, 0, 0],
    embedEntity: async () => [0, 0, 0],
    embedFact: async () => {
      throw new Error("mock embedFact 失败");
    },
  };
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
  ];
  setPlan("plan_p0_5_embed_fail", plan);

  const result = await commit("plan_p0_5_embed_fail", ctx);

  // embedding 失败不阻断 commit，主链路应成功
  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls.length, 1, "processEvent 应已成功");
  assert.equal(result.appliedEventIds.length, 1);
});

// H1 修复（2026-07-30）：try/catch 移入循环内，单条 embedFact 失败不影响其余 property
test("commit: H1 - 多 state_change 第 1 条 embedFact 抛错时其余仍写入 embedding", async () => {
  const { wg, updateFactEmbeddingCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  // mock embedder.embedFact：仅 mood 抛错，其余正常
  (ctx as any).embedder = {
    embed: async () => [0, 0, 0],
    embedEntity: async () => [0, 0, 0],
    embedFact: async (decl: { property: string }) => {
      if (decl.property === "mood") {
        throw new Error("mock mood embedding 失败");
      }
      return [0, 1, 0];
    },
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
    { entityId: "e_lin", property: "location", value: "山神庙", modality: "fact" },
  ];
  setPlan("plan_h1_partial_embed_fail", plan);

  const result = await commit("plan_h1_partial_embed_fail", ctx);

  // commit 主链路应成功（embedding 失败不阻断）
  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  // 关键断言：location 的 embedding 仍被写入（H1 修复前会被跳过）
  assert.equal(
    updateFactEmbeddingCalls.length,
    1,
    "第 1 条 mood 失败后，第 2 条 location 的 embedding 应仍被写入",
  );
  assert.equal(
    updateFactEmbeddingCalls[0].declarationId,
    "decl-e_lin-location-ch-2",
    "应只写入 location 的 embedding",
  );
});

test("commit: updateFactEmbedding 抛错时不阻断 commit", async () => {
  const { wg, processEventCalls } = makeMockWg();
  // mock wg.updateFactEmbedding 抛错
  (wg as any).updateFactEmbedding = async () => {
    throw new Error("mock updateFactEmbedding 失败");
  };
  const ctx = makeMockCtx(wg);
  const plan = makePlan({ intent: "add" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
  ];
  setPlan("plan_p0_5_update_fail", plan);

  const result = await commit("plan_p0_5_update_fail", ctx);

  // embedding 写入失败不阻断 commit（与 setVisibility 同策略）
  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls.length, 1, "processEvent 应已成功");
});

test("commit: 无 state_changes 时不调 updateFactEmbedding", async () => {
  const { wg, updateFactEmbeddingCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  setPlan("plan_p0_5_no_sc", makePlan({ intent: "add" }));

  const result = await commit("plan_p0_5_no_sc", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(updateFactEmbeddingCalls.length, 0, "无 state_changes 不应调 updateFactEmbedding");
});

// ============================================================================
// P0-3+6 knowledge_gained 他盲修复测试（2026-07-27）
// commit.ts 4.4 步用 LLM（knowledgeMapper）把 knowledge_gained 映射到 declarationId
// 再调 wg.setVisibility 写"他盲"可见性（source=informed, confidence >= 0.5 才写）
// ============================================================================

test("commit: knowledge_gained 映射成功后写 Visibility（source=informed）", async () => {
  const { wg, setVisibilityCalls, getAllDeclarationsAtReturn } = makeMockWg();
  // 注入候选列表（mock world-graph 中已存在的声明）
  getAllDeclarationsAtReturn.push({
    declarationId: "decl-e_shi-mood-ch-1",
    entityId: "e_shi",
    property: "mood",
    value: "老迈",
    modality: "fact",
    validFrom: "ch-1",
    validTo: "Infinity",
  });
  const ctx = makeMockCtx(wg);
  // 注入 knowledgeMapper mock：把"师父老了"映射到 decl-e_shi-mood-ch-1
  (ctx as any).knowledgeMapper = async (
    _characterId: string,
    knowledgeItems: string[],
    _candidates: unknown[],
  ) => {
    return knowledgeItems.map((k) => ({
      knowledge: k,
      declarationId: "decl-e_shi-mood-ch-1",
      confidence: 0.9,
    }));
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_kg", plan);

  const result = await commit("plan_p0_3_kg", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  // 应有 1 次 setVisibility 调用（source=informed）
  // 注意：4.3 步也会调 setVisibility（如果有 state_changes），本用例无 state_changes
  // 所以这里只统计 source=informed 的调用
  const informedCalls = setVisibilityCalls.filter((c) => c.opts.source === "informed");
  assert.equal(informedCalls.length, 1, "应有 1 次 source=informed 的 setVisibility");
  assert.equal(informedCalls[0].characterId, "e_lin", "应是产出 knowledge_gained 的角色");
  assert.equal(informedCalls[0].declarationId, "decl-e_shi-mood-ch-1");
  assert.equal(informedCalls[0].opts.state, "known");
  assert.equal(informedCalls[0].opts.confidence, 0.9);
  assert.equal(informedCalls[0].opts.validFrom, "ch-2");
});

test("commit: confidence < 0.5 时不写 Visibility", async () => {
  const { wg, setVisibilityCalls, getAllDeclarationsAtReturn } = makeMockWg();
  getAllDeclarationsAtReturn.push({
    declarationId: "decl-e_shi-mood-ch-1",
    entityId: "e_shi",
    property: "mood",
    value: "老迈",
    modality: "fact",
    validFrom: "ch-1",
    validTo: "Infinity",
  });
  const ctx = makeMockCtx(wg);
  (ctx as any).knowledgeMapper = async (
    _characterId: string,
    knowledgeItems: string[],
    _candidates: unknown[],
  ) => {
    return knowledgeItems.map((k) => ({
      knowledge: k,
      declarationId: "decl-e_shi-mood-ch-1",
      confidence: 0.3, // 低于 0.5 阈值
    }));
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_low_conf", plan);

  const result = await commit("plan_p0_3_low_conf", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  const informedCalls = setVisibilityCalls.filter((c) => c.opts.source === "informed");
  assert.equal(informedCalls.length, 0, "confidence < 0.5 不应写 Visibility");
});

test("commit: knowledgeMapper 抛错时跳过 4.4 步不阻断 commit", async () => {
  const { wg, getAllDeclarationsAtReturn, processEventCalls, setVisibilityCalls } = makeMockWg();
  getAllDeclarationsAtReturn.push({
    declarationId: "decl-e_shi-mood-ch-1",
    entityId: "e_shi",
    property: "mood",
    value: "老迈",
    modality: "fact",
    validFrom: "ch-1",
    validTo: "Infinity",
  });
  const ctx = makeMockCtx(wg);
  (ctx as any).knowledgeMapper = async () => {
    throw new Error("mock knowledgeMapper 失败");
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
  ];
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_mapper_fail", plan);

  const result = await commit("plan_p0_3_mapper_fail", ctx);

  // mapper 失败不阻断 commit，主链路应成功
  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls.length, 1, "state_changes 应已写入");
  assert.equal(result.appliedEventIds.length, 1, "主链路应已成功");
  // 4.3 步的 setVisibility 应有（state_changes 的自盲修复，source=experienced），
  // 但 4.4 步不应有 source=informed 的调用（mapper 抛错跳过）
  const informedCalls = setVisibilityCalls.filter((c) => c.opts.source === "informed");
  assert.equal(informedCalls.length, 0, "mapper 抛错时不应有 source=informed 的 Visibility");
});

test("commit: 未注入 knowledgeMapper 时跳过 4.4 步（向后兼容）", async () => {
  const { wg, getAllDeclarationsAtCalls, setVisibilityCalls } = makeMockWg();
  const ctx = makeMockCtx(wg);
  // 显式移除 knowledgeMapper（模拟旧版 ctx）
  delete (ctx as any).knowledgeMapper;
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_no_mapper", plan);

  const result = await commit("plan_p0_3_no_mapper", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  // 未注入 knowledgeMapper 时不应调 getAllDeclarationsAt
  assert.equal(getAllDeclarationsAtCalls.length, 0, "未注入 mapper 不应查候选列表");
  // 不应有 source=informed 的 Visibility
  const informedCalls = setVisibilityCalls.filter((c) => c.opts.source === "informed");
  assert.equal(informedCalls.length, 0, "未注入 mapper 不应写 informed 可见性");
});

test("commit: 无 knowledge_gained 的角色不触发 mapper 调用", async () => {
  const { wg, getAllDeclarationsAtReturn } = makeMockWg();
  getAllDeclarationsAtReturn.push({
    declarationId: "decl-e_shi-mood-ch-1",
    entityId: "e_shi",
    property: "mood",
    value: "老迈",
    modality: "fact",
    validFrom: "ch-1",
    validTo: "Infinity",
  });
  const ctx = makeMockCtx(wg);
  let mapperCalled = false;
  (ctx as any).knowledgeMapper = async () => {
    mapperCalled = true;
    return [];
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  // 不注入 knowledge_gained（角色没学到新东西）
  plan.roleResult.outputs[0].knowledge_gained = undefined;
  setPlan("plan_p0_3_no_kg", plan);

  const result = await commit("plan_p0_3_no_kg", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(mapperCalled, false, "无 knowledge_gained 不应调 mapper");
});

test("commit: 候选列表查询失败时跳过 4.4 步不阻断 commit", async () => {
  const { wg, processEventCalls } = makeMockWg();
  // mock getAllDeclarationsAt 抛错
  (wg as any).getAllDeclarationsAt = async () => {
    throw new Error("mock getAllDeclarationsAt 失败");
  };
  const ctx = makeMockCtx(wg);
  (ctx as any).knowledgeMapper = async () => {
    throw new Error("mapper 不应被调用");
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].state_changes = [
    { entityId: "e_lin", property: "mood", value: "怒", modality: "fact" },
  ];
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_candidates_fail", plan);

  const result = await commit("plan_p0_3_candidates_fail", ctx);

  // 候选列表查询失败不阻断 commit
  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  assert.equal(processEventCalls.length, 1, "state_changes 应已写入");
});

test("commit: 候选列表为空时跳过 mapper 调用", async () => {
  const { wg, getAllDeclarationsAtReturn } = makeMockWg();
  // 不向 getAllDeclarationsAtReturn 注入任何候选（保持空数组）
  const ctx = makeMockCtx(wg);
  let mapperCalled = false;
  (ctx as any).knowledgeMapper = async () => {
    mapperCalled = true;
    return [];
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了"];
  setPlan("plan_p0_3_empty_candidates", plan);

  const result = await commit("plan_p0_3_empty_candidates", ctx);

  assert.equal(result.ok, true, `expected ok, error=${result.error}`);
  // 候选列表为空时不应调 mapper（避免无意义的 LLM 调用）
  assert.equal(mapperCalled, false, "候选列表为空时不应调 mapper");
});

test("commit: knowledgeMapper 接收正确的候选列表参数", async () => {
  const { wg, getAllDeclarationsAtReturn } = makeMockWg();
  getAllDeclarationsAtReturn.push(
    {
      declarationId: "decl-e_shi-mood-ch-1",
      entityId: "e_shi",
      property: "mood",
      value: "老迈",
      modality: "fact",
      validFrom: "ch-1",
      validTo: "Infinity",
    },
    {
      declarationId: "decl-e_lin-weapon-ch-1",
      entityId: "e_lin",
      property: "weapon",
      value: "长枪",
      modality: "fact",
      validFrom: "ch-1",
      validTo: "Infinity",
    },
  );
  const ctx = makeMockCtx(wg);
  let capturedCandidates: unknown = null;
  let capturedCharacterId: string = "";
  let capturedKnowledgeItems: string[] = [];
  (ctx as any).knowledgeMapper = async (
    characterId: string,
    knowledgeItems: string[],
    candidates: unknown,
  ) => {
    capturedCharacterId = characterId;
    capturedKnowledgeItems = knowledgeItems;
    capturedCandidates = candidates;
    return [];
  };
  const plan = makePlan({ intent: "add", storyTime: "ch-2" });
  plan.roleResult.outputs[0].knowledge_gained = ["师父老了", "林冲有长枪"];
  setPlan("plan_p0_3_args", plan);

  await commit("plan_p0_3_args", ctx);

  assert.equal(capturedCharacterId, "e_lin", "应传入角色 ID");
  assert.deepEqual(capturedKnowledgeItems, ["师父老了", "林冲有长枪"], "应传入 knowledge_gained 列表");
  assert.ok(Array.isArray(capturedCandidates), "候选列表应为数组");
  assert.equal((capturedCandidates as any[]).length, 2, "应有 2 个候选");
  // 验证候选列表只含 declarationId/entityId/property/value（不含 modality/validFrom 等）
  assert.deepEqual(
    (capturedCandidates as any[]).map((c) => Object.keys(c).sort()),
    [["declarationId", "entityId", "property", "value"], ["declarationId", "entityId", "property", "value"]],
    "候选列表应只含 4 字段",
  );
});
