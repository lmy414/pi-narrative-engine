// src/chat/scheduler-tools.ts
/**
 * scheduler-tools.ts — 主会话 SDK 编排器工具（customTools 注册）
 *
 * 依据：docs/plans/2026-08-01-main-session-execution-plan.md §3.2
 *
 * 与 MCP 版（src/orchestrator/mcp-server.ts）语义对齐的 4 个工具：
 * - scheduler_dispatch：派发事件（plan 模式返回 planId；yolo 模式自动落地）
 * - scheduler_commit：提交 plan（后半链路）
 * - scheduler_discard：丢弃 plan
 * - scheduler_queue_status：队列状态查询
 *
 * 解耦：execute 经 provider 动态取 OrchestratorService（mutable ref），
 * 项目切换后工具无需重新注册；不依赖 ExtensionContext。
 *
 * 注意：promptSnippet 必填——ToolDefinition 注释明确 custom tools 缺省
 * 不注入 systemPrompt 的 available tools 段，不写则 LLM 看不到工具。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { StructuredEvent } from "@pi/scheduler";
import type { OrchestratorService } from "../orchestrator/service.ts";

const STORY_TIME_PATTERN = /^ch\d{3}\.ev\d{3}$/;

export function validateStoryTime(storyTime: string): void {
  if (!STORY_TIME_PATTERN.test(storyTime)) {
    throw new Error(
      `storyTime 格式非法："${storyTime}"。必须为 ch<NNN>.ev<NNN> 3 位零填充格式（如 ch009.ev006），` +
      `保证字典序 == 故事时序。拒绝 ch-<N> 等格式（会导致 ch-10 < ch-2 的时序错乱）。`,
    );
  }
}

/** OrchestratorService 动态来源（项目切换后 provider 返回新实例，工具不变） */
export type OrchestratorProvider = () => OrchestratorService;

// ============================================================================
// 会话级默认执行模式（B7：plan/yolo 显式设置）
// ============================================================================

/**
 * 模块级默认模式：main.ts 启动时从 app-config 水合，PUT /api/scheduler/mode
 * 即时更新。工具版与 HTTP 版 dispatch 共用 buildDispatchEvent，故默认值
 * 在此一处生效（显式传 mode 优先）。
 */
let schedulerDefaultMode: "plan" | "yolo" = "plan";

export function setSchedulerDefaultMode(mode: "plan" | "yolo"): void {
  schedulerDefaultMode = mode;
}

export function getSchedulerDefaultMode(): "plan" | "yolo" {
  return schedulerDefaultMode;
}

/**
 * dispatch 参数 → StructuredEvent（工具版与 HTTP 版共用，DRY）
 *
 * 仅做格式校验（storyTime）与字段透传；必填字段的存在性校验由调用方负责
 * （工具靠 TypeBox schema，HTTP 靠 requireBody）。
 * mode 缺省时用会话级默认模式（B7）。
 */
export function buildDispatchEvent(params: {
  storyTime: string;
  instruction: string;
  characterIds: string[];
  executionHints?: string;
  mode?: "plan" | "yolo";
  chapterPath?: string;
}): StructuredEvent {
  validateStoryTime(params.storyTime);
  return {
    storyTime: params.storyTime,
    instruction: params.instruction,
    characterIds: params.characterIds,
    executionHints: params.executionHints,
    mode: params.mode ?? schedulerDefaultMode,
    chapterPath: params.chapterPath,
  };
}

export function createSchedulerTools(provider: OrchestratorProvider): ToolDefinition[] {
  return [
    // ------------------------------------------------------------------------
    // scheduler_dispatch
    // ------------------------------------------------------------------------
    defineTool({
      name: "scheduler_dispatch",
      label: "Scheduler Dispatch",
      description:
        "调度器派发事件：planner 推导检索计划 → 角色演绎 →（plan 模式返回 planId 待 commit；yolo 模式自动写扩散+渲染）。" +
        "剧情推进的唯一入口：主会话判断用户意图是推进剧情时调用。",
      promptSnippet: "派发剧情事件到编排器（plan/yolo 双模式）",
      parameters: Type.Object({
        storyTime: Type.String({
          description: "故事时间（格式 ch{NNN}.ev{NNN}，如 ch009.ev006；同章内 ev+1，进新章 ch+1 且 ev 从 001 开始）",
        }),
        instruction: Type.String({ description: "事件指令（自然语言，主会话已加工）" }),
        characterIds: Type.Array(Type.String(), { description: "参与角色 ID 列表（主会话已识别）" }),
        executionHints: Type.Optional(Type.String({
          description: "执行建议（用户特殊要求，如\"林冲要显得绝望\"）",
        })),
        mode: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("yolo")])),
        chapterPath: Type.Optional(Type.String({
          description: "章节文件路径（缺省时从 storyTime 推断）",
        })),
      }),
      async execute(_id, params, _signal, _onUpdate) {
        const event = buildDispatchEvent(params);
        const result = provider().dispatch(event);
        const text = `已派发事件到调度器：queueId=${result.queueId}，mode=${result.mode}` +
          (result.planId ? `，planId=${result.planId}（plan 模式，待 scheduler_commit 落地）` : "");
        return { content: [{ type: "text", text }], details: result };
      },
    }),

    // ------------------------------------------------------------------------
    // scheduler_commit
    // ------------------------------------------------------------------------
    defineTool({
      name: "scheduler_commit",
      label: "Scheduler Commit",
      description:
        "提交 plan 结果：写扩散到世界图 + 渲染章节文件 + 更新记忆（plan 模式后半链路）。" +
        "commit 后 planId 失效，不可重复提交。",
      promptSnippet: "提交调度器 plan（写扩散+渲染）",
      parameters: Type.Object({
        planId: Type.String({ description: "scheduler_dispatch 返回的 planId" }),
      }),
      async execute(_id, params, _signal, _onUpdate) {
        const result = await provider().commit(params.planId);
        const text = result.ok
          ? `已提交 plan ${params.planId}：${result.appliedEventIds.length} 个 change 事件，渲染到 ${result.chapterPath}`
          : `提交失败：${result.error ?? "plan 不存在"}`;
        return { content: [{ type: "text", text }], details: result };
      },
    }),

    // ------------------------------------------------------------------------
    // scheduler_discard
    // ------------------------------------------------------------------------
    defineTool({
      name: "scheduler_discard",
      label: "Scheduler Discard",
      description: "丢弃 plan：不写世界图、不渲染（从 plan 缓存移除）。主会话检查角色产出后觉得不对劲时调用。",
      promptSnippet: "丢弃调度器 plan（不写不渲染）",
      parameters: Type.Object({
        planId: Type.String({ description: "scheduler_dispatch 返回的 planId" }),
      }),
      async execute(_id, params, _signal, _onUpdate) {
        const result = provider().discard(params.planId);
        const text = result.ok
          ? `已丢弃 plan ${params.planId}`
          : `plan ${params.planId} 不存在（已过期或已被 commit/discard）`;
        return { content: [{ type: "text", text }], details: result };
      },
    }),

    // ------------------------------------------------------------------------
    // scheduler_queue_status
    // ------------------------------------------------------------------------
    defineTool({
      name: "scheduler_queue_status",
      label: "Scheduler Queue Status",
      description:
        "队列状态查询：队列长度 + 各事件状态（pending/running/done/error）+ 编排结果（yolo 模式含自动落地摘要）。",
      promptSnippet: "查询编排器队列状态",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate) {
        const result = provider().queueStatus();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
  ];
}
