/**
 * scheduler-tools.ts — 调度器工具域注册
 *
 * 工具清单：
 *   scheduler_dispatch  派发事件（plan 模式返回；yolo 模式自动 commit）
 *   scheduler_commit    提交 plan 结果（写扩散 + 渲染）
 *   scheduler_discard   丢弃 plan（不写不渲染）
 *
 * 设计依据：docs/plans/2026-07-25-scheduler-design.md §5
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  plan as schedulerPlan,
  commit as schedulerCommit,
  discard as schedulerDiscard,
  type StructuredEvent,
} from "@pi/scheduler";
import { makeSchedulerCtx } from "../scheduler-llm.ts";
import { updateMemory } from "../memory.ts";
import {
  type SessionState,
  requireWg,
  requireEmbedder,
} from "../session-state.ts";

/**
 * storyTime 格式校验（H3 修复，2026-07-30）
 *
 * 强制 `ch<NNN>.ev<NNN>` 3 位零填充格式，保证字典序 == 故事时序。
 * 拦截 `ch-<N>` 等格式，避免 `ch-10 < ch-2`（'1' < '2'）导致
 * retrieve P0-1 时态过滤与 getEntityAt 双时态查询系统性失效。
 *
 * chapter-resolver 的兜底逻辑保留（供导入器等独立调用路径），
 * 但调度器入口严格校验，确保主会话派发的事件时间格式正确。
 *
 * 2026-08-01 导出：主会话 SDK 工具（src/chat/scheduler-tools.ts）复用同一边界校验。
 */
const STORY_TIME_PATTERN = /^ch\d{3}\.ev\d{3}$/;

export function validateStoryTime(storyTime: string): void {
  if (!STORY_TIME_PATTERN.test(storyTime)) {
    throw new Error(
      `storyTime 格式非法："${storyTime}"。必须为 ch<NNN>.ev<NNN> 3 位零填充格式（如 ch009.ev006），` +
      `保证字典序 == 故事时序。拒绝 ch-<N> 等格式（会导致 ch-10 < ch-2 的时序错乱）。`,
    );
  }
}

export function registerSchedulerTools(pi: ExtensionAPI, state: SessionState): void {
  // --------------------------------------------------------------------------
  // scheduler_dispatch
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "scheduler_dispatch",
    label: "Scheduler Dispatch",
    description:
      "调度器派发事件：planner LLM 推导检索计划→检索世界图→role-pool 演绎→（plan 模式返回；yolo 模式自动 commit 写扩散+渲染）。plan 模式下返回 planId 供 scheduler_commit/scheduler_discard 使用。",
    promptSnippet: "派发事件到调度器（plan/yolo 双模式）",
    parameters: Type.Object({
      storyTime: Type.String({ description: "故事时间（格式 ch{NNN}.ev{NNN}，如 ch009.ev006；同章内 ev+1，进新章 ch+1 且 ev 从 001 开始）" }),
      instruction: Type.String({ description: "事件指令（自然语言，主会话已加工）" }),
      characterIds: Type.Array(Type.String(), {
        description: "参与角色 ID 列表（主会话已识别）",
      }),
      executionHints: Type.Optional(Type.String({
        description: "执行建议（用户特殊要求，如\"林冲要显得绝望\"）",
      })),
      mode: Type.Optional(Type.Union([
        Type.Literal("plan"),
        Type.Literal("yolo"),
      ])),
      chapterPath: Type.Optional(Type.String({
        description: "章节文件路径（缺省时调度器从 storyTime 推断）",
      })),
      // M4a 修复：删除 locationId 参数（死字段，调度器未消费）
      intent: Type.Optional(Type.Union([
        Type.Literal("add"),
        Type.Literal("modify"),
        Type.Literal("insert"),
      ])),
      targetEventId: Type.Optional(Type.String({
        description: "modify/insert 模式必填：目标事件 ID（modify 重写该锚点区间，insert 在该锚点后插入）",
      })),
      userInput: Type.Optional(Type.String({
        description: "用户口述原文（主会话透传用户原话，写入事件日志供项目记忆展示）",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      // H3 修复（2026-07-30）：系统边界校验 storyTime 格式
      validateStoryTime(params.storyTime);

      const g = requireWg(state);
      const emb = requireEmbedder(state);
      const cwd = state.sessionCwd ?? process.cwd();
      const schedCtx = await makeSchedulerCtx(g, emb, cwd, piCtx, state.debugBus ?? undefined);

      const event: StructuredEvent = {
        storyTime: params.storyTime,
        instruction: params.instruction,
        characterIds: params.characterIds,
        executionHints: params.executionHints,
        mode: params.mode,
        chapterPath: params.chapterPath,
        // M4a 修复：不传 locationId（已从 StructuredEvent 删除）
        intent: params.intent,
        targetEventId: params.targetEventId,
        userInput: params.userInput,
      };

      const result = await schedulerPlan(event, schedCtx);

      // 推进 storyTime 锚点（2026-07-25 修复：dispatch/commit 此前不更新
      // currentStoryTime，导致后续工具调用失去时间锚点）
      // modify/insert 可能锚定历史时刻，故只前进不后退
      if (!state.currentStoryTime || params.storyTime > state.currentStoryTime) {
        state.currentStoryTime = params.storyTime;
      }

      // yolo 模式已在调度器内部 commit，这里同步更新项目记忆
      if (result.mode === "yolo") {
        try {
          await updateMemory(g, cwd);
        } catch (err) {
          console.warn(`[narrative-engine] 更新项目记忆失败: ${err}`);
        }
      }

      const text = result.mode === "yolo"
        ? `调度器 yolo 模式完成：planId=${result.planId}，已 commit（${result.commitResult.appliedEventIds.length} 个 change 事件，已渲染到 ${result.commitResult.chapterPath}）`
        : `调度器 plan 模式完成：planId=${result.planId}（${result.outputs.length} 个角色输出，等 commit/discard）`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // scheduler_commit
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "scheduler_commit",
    label: "Scheduler Commit",
    description:
      "提交 plan 结果：写扩散到世界图（按 entityId 分组生成 change 事件）+ 渲染章节文件（append 模式）。commit 后 planId 失效，不可重复提交。",
    promptSnippet: "提交调度器 plan（写扩散+渲染）",
    parameters: Type.Object({
      planId: Type.String({ description: "scheduler_dispatch 返回的 planId" }),
    }),
    async execute(_id, params, _signal, _onUpdate, piCtx: ExtensionContext) {
      const g = requireWg(state);
      const emb = requireEmbedder(state);
      const cwd = state.sessionCwd ?? process.cwd();
      const schedCtx = await makeSchedulerCtx(g, emb, cwd, piCtx, state.debugBus ?? undefined);

      const result = await schedulerCommit(params.planId, schedCtx);

      // 写扩散完成后更新项目记忆（失败不阻断 commit 结果）
      // H2 修复（2026-07-30）：原条件 `result.ok` 会在部分成功时跳过 memory 更新，
      // 导致下一轮检索的"最近事件"展示滞后。改为只要有 appliedEventIds 就更新。
      if (result.appliedEventIds.length > 0) {
        try {
          await updateMemory(g, cwd);
        } catch (err) {
          console.warn(`[narrative-engine] 更新项目记忆失败: ${err}`);
        }
      }

      const text = result.ok
        ? `已提交 plan ${params.planId}：${result.appliedEventIds.length} 个 change 事件，渲染到 ${result.chapterPath}`
        : `提交失败：${result.error}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // scheduler_discard
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "scheduler_discard",
    label: "Scheduler Discard",
    description:
      "丢弃 plan：不写世界图、不渲染。主会话检查 RoleAgentOutput[] 后觉得不对劲时调用。",
    promptSnippet: "丢弃调度器 plan（不写不渲染）",
    parameters: Type.Object({
      planId: Type.String({ description: "scheduler_dispatch 返回的 planId" }),
    }),
    async execute(_id, params) {
      const ok = schedulerDiscard(params.planId);
      const text = ok
        ? `已丢弃 plan ${params.planId}`
        : `plan ${params.planId} 不存在（已过期或已被 commit/discard）`;
      return {
        content: [{ type: "text", text }],
        details: { ok, planId: params.planId },
      };
    },
  });
}
