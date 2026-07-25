/**
 * plan.ts — 调度器 plan 函数
 *
 * 设计文档 §3.1 plan 函数的实现
 *
 * 10 步流程：
 * 1. 生成 eventId + planId
 * 2. 解析章节路径
 * 3. 调用 planner LLM 推导 RetrievalPlan
 * 4. 兜底：每个 characterId 至少 1 条 character_view
 * 5. 按 RetrievalPlan.items 逐项执行检索（pi 工具机制：import 子包函数）
 * 6. 按检索结果 + assignTo 构建每个角色的 dynamicFacts
 * 7. 加载每个角色的 staticCard，组装 CastMember[]
 * 8. 调用 @pi/role-pool.interact
 * 9. 缓存 plan 结果（planId → PlanResult）
 * 10. yolo 模式自动 commit；plan 模式等主会话确认
 */

import { interact } from "@pi/role-pool";
import type { CastMember, InteractCommand } from "@pi/role-pool";

import { executeRetrievalItem } from "./retrieve.ts";
import { buildPlannerSystemPrompt, buildPlannerUserMessage } from "./prompts.ts";
import { resolveChapterPath } from "./chapter-resolver.ts";
import { setPlan } from "./cache.ts";
import { randomId } from "./utils.ts";
import { commit } from "./commit.ts";
import type {
  DispatchPlanOutput,
  DispatchYoloOutput,
  FactSnapshot,
  PlanResult,
  SchedulerCtx,
  StructuredEvent,
} from "./types.ts";

/**
 * 调度器 plan 主函数
 *
 * @param event 主会话解析后的结构化事件
 * @param ctx 调度器上下文
 * @returns DispatchPlanOutput（plan 模式）或 DispatchYoloOutput（yolo 模式）
 */
export async function plan(
  event: StructuredEvent,
  ctx: SchedulerCtx,
): Promise<DispatchPlanOutput | DispatchYoloOutput> {
  // 1. 生成 eventId 和 planId
  const eventId = `evt_${Date.now()}_${randomId(6)}`;
  const planId = `plan_${Date.now()}_${randomId(6)}`;

  // 2. 解析章节路径
  const chapterPath = event.chapterPath ?? resolveChapterPath(ctx.cwd, event.storyTime);

  // 3. 调用 planner LLM 推导检索计划
  //    输入：事件指令 + 参与角色 + 执行建议
  //    输出：RetrievalPlan（一组 RetrievalItem，含 type/params/assignTo/label）
  //    详见 prompts.ts 和 §3.6 planner LLM 的 tool call 模式细节
  const retrievalPlan = await ctx.plannerLlm(
    buildPlannerSystemPrompt(ctx.plannerRuleSet, event),
    buildPlannerUserMessage(event),
  );

  // 4. 兜底：确保每个参与角色至少有 1 条 character_view 检索项
  //    避免 planner LLM 漏掉某角色导致该角色完全没有动态状态注入
  //    同时过滤 assignTo 中未参与的角色（防止 planner LLM 输出意外角色 ID）
  for (const characterId of event.characterIds) {
    // 过滤 assignTo 中未参与的角色
    for (const item of retrievalPlan.items) {
      item.assignTo = item.assignTo.filter((id) => event.characterIds.includes(id));
    }
    // 兜底补 character_view
    const hasOwnView = retrievalPlan.items.some(
      (it) =>
        it.type === "character_view" &&
        it.params.entityId === characterId &&
        it.assignTo.includes(characterId),
    );
    if (!hasOwnView) {
      retrievalPlan.items.push({
        type: "character_view",
        params: { entityId: characterId },
        assignTo: [characterId],
        label: `${characterId} 的可见状态`,
      });
    }
  }

  // 5. 按 retrievalPlan.items 逐项执行检索
  //    检索结果按 item.assignTo 分配到对应角色的 dynamicFacts 池
  //    检索通过 import 子包函数实现（pi 工具机制，见决策 #14）
  const dynamicFactsByCharacter = new Map<string, FactSnapshot[]>();
  for (const characterId of event.characterIds) {
    dynamicFactsByCharacter.set(characterId, []);
  }

  for (const item of retrievalPlan.items) {
    const result = await executeRetrievalItem(ctx, item, event.storyTime);
    if (!result || result.length === 0) continue;
    for (const characterId of item.assignTo) {
      const facts = dynamicFactsByCharacter.get(characterId);
      if (facts) {
        // 检索结果按 label 分组追加到该角色的 dynamicFacts
        // 注意：当前不去重（Pending Gap #11），同一 declarationId 可能被多次命中
        facts.push(...result);
      }
    }
  }

  // 5.5 解析动态层属主名称（2026-07-25 审计 P1）
  //     formatFact 以 `- [属主] property: value（modality）` 渲染归属。
  //     收集全部动态 Fact 的 entityId，批量解析：name Fact → summary（截断）→ entityId
  const ownerEntityIds = new Set<string>();
  for (const facts of dynamicFactsByCharacter.values()) {
    for (const f of facts) ownerEntityIds.add(f.entityId);
  }
  const ownerNames = new Map<string, string>();
  for (const eid of ownerEntityIds) {
    const snap = await ctx.wg.getEntityAt(eid, event.storyTime);
    const nameFact = snap?.properties.find((p) => p.property === "name");
    ownerNames.set(
      eid,
      nameFact ? String(nameFact.value) : snap?.summary ? String(snap.summary).slice(0, 20) : eid,
    );
  }
  for (const facts of dynamicFactsByCharacter.values()) {
    for (const f of facts) {
      f.ownerName = ownerNames.get(f.entityId) ?? f.entityId;
    }
  }

  // 6. 为每个角色构建 CastMember
  const cast: CastMember[] = [];
  for (const characterId of event.characterIds) {
    const staticCard = await ctx.staticCardLoader(characterId, event.storyTime);
    const dynamicFacts = dynamicFactsByCharacter.get(characterId) ?? [];
    cast.push({ characterId, staticCard, dynamicFacts });
  }

  // 7. 调用 @pi/role-pool.interact
  //    透传 executionHints 到 role-pool 的 system prompt（让角色也遵守用户特殊要求）
  //    [2026-07-25] role-pool 已扩展 InteractCommand.executionHints 字段（Pending Gap #14 完成）
  const interactCmd: InteractCommand = {
    eventInstruction: event.instruction,
    storyTime: event.storyTime,
    cast,
    executionHints: event.executionHints,
  };
  const roleResult = await interact(interactCmd, {
    llm: ctx.roleLlm,
    ruleSet: ctx.roleRuleSet,
  });

  // 8. 缓存 plan 结果（session 级 Map）
  const planResult: PlanResult = {
    planId,
    eventId,
    event,
    chapterPath,
    retrievalPlan,
    roleResult,
    cast,
    createdAt: Date.now(),
  };
  setPlan(planId, planResult);

  // 9. yolo 模式：自动 commit（一气呵成）
  if (event.mode === "yolo") {
    const commitResult = await commit(planId, ctx);
    return {
      mode: "yolo",
      planId,
      eventId,
      chapterPath,
      outputs: roleResult.outputs,
      errors: roleResult.errors,
      cast: cast.map((c) => ({
        characterId: c.characterId,
        name: String(c.staticCard.name ?? c.characterId),
        summary: String(c.staticCard.description ?? ""),
      })),
      retrievalPlan,
      commitResult,
    };
  }

  // 10. plan 模式：返回 DispatchPlanOutput（含 retrievalPlan 便于调试）
  //     等主会话审阅后调 scheduler_commit 提交
  return {
    mode: "plan",
    planId,
    eventId,
    chapterPath,
    outputs: roleResult.outputs,
    errors: roleResult.errors,
    cast: cast.map((c) => ({
      characterId: c.characterId,
      name: String(c.staticCard.name ?? c.characterId),
      summary: String(c.staticCard.description ?? ""),
    })),
    retrievalPlan,
  };
}
