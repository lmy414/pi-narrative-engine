/**
 * commit.ts — 调度器 commit 函数
 *
 * 设计文档 §3.2 commit 函数的实现
 *
 * 8 步流程：
 * 1. 取出 plan 结果（按 planId）
 * 2. 提取 state_changes（扁平化为 StateChange[]）
 * 3. 按 entityId 分组
 * 4. 为每个 entityId 写扩散（查询 invalidated + processEvent）
 * 5. relation_update 写入世界图（2026-07-25 解决 Pending Gap #2）
 *    - 直接调 wg.addRelation(sourceId, targetId, label, storyTime)
 *    - source/target 均为 characterId（role-pool prompt 已让 LLM 直接输出 ID）
 *    - 无需"实体消解"
 * 5.5 自产自知可见性（2026-07-25 修复角色自盲断链，审计核对项 4）
 *    - state_changes 写入的新 Fact 只对已有 Visibility 记录的角色可见
 *    - 此前 commit 不写 Visibility → 下一场 character_view 五步过滤把新 Fact 滤掉
 *      → 角色看不见自己上一场的状态变化（"自盲"）
 *    - 修复：为产生该 state_change 的角色（作者）写入 Visibility（state=known,
 *      source=experienced, confidence=1）；declarationId 按 world-graph 生成规则
 *      `decl-{entityId}-{property}-{storyTime}` 重建
 * 6. 投影为 RoleOutput[]（去掉 state_changes 和 characterId，保留渲染器需要的 6 字段）
 * 7. 按 event.intent 分支写章节文件（Pending Gap #4 已完成）：
 *    - add（缺省）：renderer.renderToFile(mode="append")
 *    - modify：renderer.renderToFile(mode="modify", modifyAnchorEventId=targetEventId)
 *    - insert：renderer.renderText 生成文本 + chapter-edit.insertChapterSection
 *      （renderer 无 insert 模式，调度器内嵌插入逻辑）
 * 8. 清理 plan 缓存（commit 后不可再次提交）
 *
 * 幂等性：commit 后 planId 从缓存删除，重复 commit 同一 planId 会返回错误。
 *
 * 回退机制（Pending Gap #4 已完成）：
 * - modify/insert 都不改 world-graph：世界图扩散按"新事件"处理，
 *   不撤销原 targetEventId 的状态声明（Git revert 思路：补偿事件，非 reset）。
 *   理由：撤销原事件会破坏已索引的 Fact 时序，影响其他角色的检索视图。
 * - 章节文件层面才做替换/插入：modify 重写锚点区间正文，insert 在锚点后追加。
 * - 用户若要"撤销某事件的状态影响"，应通过新事件（type=change 把 property 改回）
 *   显式表达，而不是让调度器自动 reset。
 */

import { extractStateChanges, extractRelations, toRoleOutputs } from "@pi/role-pool";
import type { RenderResult, RoleOutput } from "@pi/renderer";
import { renderToFile, renderText, readChapter } from "@pi/renderer";

import { deletePlan, getPlan } from "./cache.ts";
import { insertChapterSection } from "./chapter-edit.ts";
import { groupBy, randomId } from "./utils.ts";
import type { CommitResult, SchedulerCtx, StructuredEvent } from "./types.ts";

/**
 * 提交 plan：写扩散到世界图 + 渲染章节文件
 *
 * @param planId plan ID（来自 scheduler_dispatch 返回）
 * @param ctx 调度器上下文
 * @returns CommitResult（含 ok + appliedEventIds + chapterPath + writtenText）
 */
export async function commit(
  planId: string,
  ctx: SchedulerCtx,
): Promise<CommitResult> {
  // 1. 取出 plan 结果
  const planResult = getPlan(planId);
  if (!planResult) {
    return {
      ok: false,
      planId,
      eventId: "",
      chapterPath: "",
      appliedEventIds: [],
      writtenText: "",
      error: `plan ${planId} not found (expired or never created)`,
    };
  }

  const { event, eventId, chapterPath, roleResult } = planResult;

  // 2. 提取 state_changes（扁平化为 StateChange[]）
  //    StateChange 结构兼容 world_event_apply 的 newFacts
  const stateChanges = extractStateChanges(roleResult.outputs);

  // 2.5 建立 state_change 作者映射（entityId → 产生变更的 characterId 集合）
  //     供步骤 4.3 写入"自产自知"可见性（extractStateChanges 不保留作者，直接遍历 outputs）
  const changeAuthors = new Map<string, Set<string>>();
  for (const out of roleResult.outputs) {
    for (const change of out.state_changes ?? []) {
      let set = changeAuthors.get(change.entityId);
      if (!set) {
        set = new Set();
        changeAuthors.set(change.entityId, set);
      }
      set.add(out.characterId);
    }
  }

  // 3. 按 entityId 分组（每个 entityId 生成一个 change 事件，决策 #7）
  const changesByEntity = groupBy(stateChanges, (c) => c.entityId);

  // 4. 为每个 entityId 写扩散
  const appliedEventIds: string[] = [];
  for (const [entityId, changes] of changesByEntity) {
    // 4.1 查询 invalidated：该 entityId 当前未闭合的 Fact，按 property 匹配
    //     role-pool 输出的 state_changes 表示"实体某 property 变为新值"，
    //     需要把同 property 的旧 Fact 闭合（invalidated）。
    const snapshot = await ctx.wg.getEntityAt(entityId, event.storyTime);
    const invalidated: { declarationId: string; property: string }[] = [];
    if (snapshot) {
      for (const change of changes) {
        // 找到同 property 的未闭合 Fact（取第一个，假设唯一）
        const existingFact = snapshot.properties.find(
          (p) => p.property === change.property,
        );
        if (existingFact) {
          invalidated.push({
            declarationId: existingFact.declarationId,
            property: change.property,
          });
        }
      }
    }

    // 4.2 调用 wg.processEvent 写 change 事件
    //     type="change" 时用 invalidated + newFacts（参考 world-graph.ts#L347-L373）
    const subEventId = `evt_${Date.now()}_${randomId(6)}`;
    await ctx.wg.processEvent({
      eventId: subEventId,
      type: "change",
      storyTime: event.storyTime,
      entityId,
      source: "engine",
      invalidated: invalidated.length > 0 ? invalidated : undefined,
      newFacts: changes.map((c) => ({
        entityId: c.entityId,
        property: c.property,
        value: c.value,
        modality: c.modality,
      })),
    });
    appliedEventIds.push(subEventId);

    // 4.3 自产自知：为产生这些变更的角色写入新 Fact 的可见性
    //     不修则下一场 character_view 五步过滤会把新 Fact 滤掉（角色自盲）
    const knowers = changeAuthors.get(entityId);
    if (knowers) {
      for (const change of changes) {
        // declarationId 生成规则与 world-graph.processEvent 一致
        const declarationId = `decl-${entityId}-${change.property}-${event.storyTime}`;
        for (const knowerId of knowers) {
          try {
            await ctx.wg.setVisibility(knowerId, declarationId, {
              state: "known",
              confidence: 1,
              source: "experienced",
              validFrom: event.storyTime,
              isExplicit: true,
            });
          } catch {
            // 重复可见性等异常不阻断 commit（与导入器 write.ts 的容错策略一致）
          }
        }
      }
    }
  }

  // 5. relation_update 写入世界图（2026-07-25 解决 Pending Gap #2）
  //    role-pool prompt 已让 LLM 在 relation_update.target 直接填对方 characterId
  //    所以这里直接调 wg.addRelation(sourceId=characterId, targetId=characterId, label, storyTime)
  //    不再做"实体消解"
  const relationUpdates = extractRelations(roleResult.outputs);
  for (const rel of relationUpdates) {
    await ctx.wg.addRelation(rel.source, rel.target, rel.label, event.storyTime);
  }

  // 6. 投影为 RoleOutput[]（去掉 state_changes 和 characterId，保留渲染器需要的 6 字段）
  //    toRoleOutputs 返回 Omit<RoleAgentOutput, "state_changes" | "characterId">[]
  //    结构上兼容 @pi/renderer 的 RoleOutput
  const roleOutputs = toRoleOutputs(roleResult.outputs) as RoleOutput[];

  // 7. 按 event.intent 分支写章节文件（Pending Gap #4 已完成）
  //    用 plan 阶段生成的 eventId 作为渲染锚点
  const renderResult = await renderChapter(
    event,
    chapterPath,
    eventId,
    roleOutputs,
    ctx,
  );

  // 8. 清理 plan 缓存（commit 后不可再次提交，幂等性保障）
  deletePlan(planId);

  return {
    ok: renderResult.ok,
    planId,
    eventId,
    appliedEventIds,
    chapterPath,
    writtenText: renderResult.writtenText,
    error: renderResult.error,
  };
}

/**
 * 按 event.intent 分支写章节文件（Pending Gap #4）
 *
 * - add（缺省）：调 renderer.renderToFile(mode="append")
 * - modify：调 renderer.renderToFile(mode="modify", modifyAnchorEventId=targetEventId)
 *   world-graph 不撤销原事件的状态声明（Git revert 思路，详见文件头注释）
 * - insert：renderer 无 insert 模式，调度器先 renderText 生成文本，
 *   再调 insertChapterSection 把文本插入到 targetEventId 锚点之后
 *
 * @param event 原始结构化事件
 * @param chapterPath 章节文件路径
 * @param eventId 本次 commit 的渲染锚点 ID（plan 阶段生成）
 * @param roleOutputs 角色池投影后的 7 字段输出
 * @param ctx 调度器上下文
 */
async function renderChapter(
  event: StructuredEvent,
  chapterPath: string,
  eventId: string,
  roleOutputs: RoleOutput[],
  ctx: SchedulerCtx,
): Promise<RenderResult> {
  const intent = event.intent ?? "add";

  // add / modify：renderer.renderToFile 直接支持
  if (intent === "add" || intent === "modify") {
    return await renderToFile(
      {
        mode: intent === "modify" ? "modify" : "append",
        chapterPath,
        eventId,
        storyTime: event.storyTime,
        instruction: event.instruction,
        payload: roleOutputs,
        modifyAnchorEventId: intent === "modify" ? event.targetEventId : undefined,
      },
      { llm: ctx.renderLlm, ruleSet: ctx.renderRuleSet },
    );
  }

  // insert：renderer 无 insert 模式，调度器自行处理
  // 1. 读取章节全文作为上下文
  // 2. 调 renderText 生成新正文（mode="append" 复用其续写提示词）
  // 3. 调 insertChapterSection 把生成文本插到 targetEventId 锚点之后
  if (!event.targetEventId) {
    return {
      ok: false,
      chapterPath,
      mode: "append", // RenderResult.mode 字面量类型限制，用 append 占位
      eventId,
      writtenText: "",
      error: "insert 模式缺 targetEventId，无法定位插入锚点",
    };
  }

  try {
    const existingContent = await readChapter(chapterPath);
    const renderedText = await renderText(
      {
        mode: "append",
        eventId,
        storyTime: event.storyTime,
        instruction: event.instruction,
        payload: roleOutputs,
        context: existingContent,
      },
      { llm: ctx.renderLlm, ruleSet: ctx.renderRuleSet },
    );
    await insertChapterSection(
      chapterPath,
      event.targetEventId,
      eventId,
      renderedText,
    );
    return {
      ok: true,
      chapterPath,
      mode: "append", // RenderResult.mode 字面量类型限制，用 append 占位
      eventId,
      writtenText: renderedText,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      chapterPath,
      mode: "append",
      eventId,
      writtenText: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
