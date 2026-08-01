// src/agents/tools.ts
/**
 * tools.ts — 子代理内部产出提交 AgentTool
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.3.2
 *
 * 设计要点（2026-07-31 复核修正）：
 * - 4 个工具全部是"产出提交"性质：子代理在 agent loop 中推理完成后，通过
 *   tool call 提交结构化结果，编排器从 `tool_execution_end` 事件提取
 * - `terminate: true`：终止 agent loop。已查证（agent-loop.ts:544-546）该语义是
 *   **all 语义**——同轮 batch 内所有 finalized tool result 都 terminate 才停，
 *   因此工具设 `executionMode: "sequential"` 强制串行，避免同轮多工具无法终止
 * - schema 复用现有 TypeBox 定义（retrievalPlanSchema / characterActionSchema），
 *   diffusion_result / render_result 本阶段定义（阶段 2 接数据层时对齐）
 * - 本阶段不注入任何 world_* 检索/写入工具（用户澄清：不接触世界图业务）
 */

import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const retrievalPlanSchema = Type.Object({
  items: Type.Array(Type.Object({
    type: StringEnum([
      "character_view",
      "entity_snapshot",
      "relations",
      "search_text",
      "search_vector",
      "search_hybrid",
    ], { description: "检索类型" }),
    params: Type.Object({
      entityId: Type.Optional(Type.String({ description: "character_view / entity_snapshot / relations 用" })),
      query: Type.Optional(Type.String({ description: "search_* 用（自然语言查询）" })),
      nodeType: Type.Optional(StringEnum(["Entity", "Fact", "Relation", "Visibility"], {
        description: "search_* 必填：检索节点类型。注意：search_vector/search_hybrid 仅支持 Entity/Fact（只有这两种节点声明了 embedding 字段），Relation/Visibility 请用 search_text",
      })),
      limit: Type.Optional(Type.Integer({ description: "检索上限（search_* 用）" })),
      fieldPath: Type.Optional(Type.String({ description: "向量字段路径（search_vector/hybrid 用，缺省 embedding）" })),
      modalityFilter: Type.Optional(Type.Array(StringEnum(["fact", "belief", "hypothesis"]), {
        description: "模态过滤（character_view 用）",
      })),
      recordedAsOf: Type.Optional(Type.String({
        description: "事务时间坐标（可选，P0-2 修复）。modify/insert 锚定历史事件时，若要\"查改写前的世界状态\"，调用 wg.recordedNow() 取当前事务时间传入。日常推进（add）不需要使用。仅 character_view/entity_snapshot/relations 生效；search_* 暂不支持（会降级为 console.warn）。",
      })),
    }),
    assignTo: Type.Array(Type.String(), {
      description: "这条检索结果分配给哪些角色 ID（信息差分配）",
    }),
    label: Type.String({ description: "检索项语义标签（注入角色提示词时用作小标题）" }),
  })),
});

export const characterActionSchema = Type.Object({
  characterId: Type.String({ description: "你自己的 entityId（即 prompt 中的[你的 entityId]，如 e_lin_chong）" }),
  actor: Type.String({ description: "行动者名字（角色卡中的 name）" }),
  action: Type.String({ description: "可观察的行动描述" }),
  target: Type.Optional(Type.String({ description: "行动对象" })),
  emotion: Type.Optional(Type.String({ description: "角色情绪" })),
  relation_update: Type.Optional(Type.Array(Type.Object({
    target: Type.String({ description: "对方角色的 characterId（不是名字，如 e_lu_qian）" }),
    label: Type.String({ description: "关系标签" }),
  }))),
  thought: Type.Optional(Type.String({ description: "内心独白（其他角色不可见）" })),
  knowledge_gained: Type.Optional(Type.Array(Type.String(), {
    description: "获得的知识列表",
  })),
  state_changes: Type.Optional(Type.Array(Type.Object({
    entityId: Type.String({ description: "目标实体 ID" }),
    property: Type.String({ description: "属性路径（如 mood / location）" }),
    value: Type.Unknown({ description: "新值" }),
    modality: StringEnum(["fact", "belief", "hypothesis"], {
      description: "fact=客观 / belief=信念 / hypothesis=猜测",
    }),
  }))),
});

/**
 * diffusion_result 工具 schema — 可见推理代理的结构化产出
 *
 * 输出：已应用世界图的 change 事件摘要（appliedEventIds）+ visibilityChanges 摘要。
 * 阶段 A（数据层接线）：可见推理代理经 world_event_apply 等写工具自主写入世界图，
 * 提交的 diffusion_result 是"已应用摘要"（appliedEventIds 记录实际写入的事件）。
 * 渲染器代理消费此摘要作为扩散结果输入。
 */
export const diffusionResultSchema = Type.Object({
  appliedEventIds: Type.Optional(Type.Array(Type.String(), {
    description: "已应用的世界图事件 ID 列表（world_event_apply 返回）",
  })),
  changes: Type.Array(Type.Object({
    entityId: Type.String({ description: "状态变化的实体 ID" }),
    property: Type.String({ description: "属性路径（如 mood / location）" }),
    value: Type.Unknown({ description: "新值" }),
    modality: StringEnum(["fact", "belief", "hypothesis"], {
      description: "fact=客观 / belief=信念 / hypothesis=猜测",
    }),
  }), { description: "写扩散摘要：已应用的状态变化列表" }),
  visibilityChanges: Type.Optional(Type.Array(Type.Object({
    characterId: Type.String({ description: "获知方角色 ID" }),
    declarationId: Type.String({ description: "新增可见的声明 ID" }),
    source: StringEnum(["experienced", "informed", "witnessed"], {
      description: "获知方式：experienced=亲历 / informed=被告知 / witnessed=目睹",
    }),
    confidence: Type.Number({ minimum: 0, maximum: 1, description: "置信度 0-1" }),
  }), { description: "已应用的可见性变更摘要" })),
});

/**
 * render_result 工具 schema — 渲染器代理的结构化产出
 *
 * 输出：正文文本 + 目标章节路径 + 写入是否成功。
 * 阶段 A：渲染器代理经 chapter_write 写入章节文件后提交结果（ok 记录写入成败）。
 */
export const renderResultSchema = Type.Object({
  chapterPath: Type.String({ description: "目标章节文件路径（渲染锚点）" }),
  text: Type.String({ description: "渲染正文（完整追加段落）" }),
  ok: Type.Optional(Type.Boolean({ description: "章节写入是否成功（chapter_write 返回 ok）" })),
});

/** planner 子代理：提交检索计划（AgentTool 包装，无 ctx，闭包注入） */
export function createRetrievalPlanTool(): AgentTool {
  return {
    name: "retrieval_plan",
    label: "Retrieval Plan",
    description: "提交本次事件的检索计划。必须调用此工具一次提交结果。",
    parameters: retrievalPlanSchema,
    // terminate 为 all 语义：强制串行避免同轮多工具导致无法终止
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "检索计划已提交" }],
        details: { plan: params },
        terminate: true,
      };
    },
  };
}

/** 角色代理：提交角色行为（AgentTool 包装） */
export function createCharacterActionTool(): AgentTool {
  return {
    name: "character_action",
    label: "Character Action",
    description: "提交角色本次行动的结构化输出。必须调用此工具一次提交结果。",
    parameters: characterActionSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "角色行为已提交" }],
        details: { action: params },
        terminate: true,
      };
    },
  };
}

/** 可见推理代理：提交扩散结果（change 事件 + visibilityChanges） */
export function createDiffusionResultTool(): AgentTool {
  return {
    name: "diffusion_result",
    label: "Diffusion Result",
    description: "提交状态扩散结果（change 事件 + visibilityChanges）。必须调用此工具一次提交结果。",
    parameters: diffusionResultSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "扩散结果已提交" }],
        details: { diffusion: params },
        terminate: true,
      };
    },
  };
}

/** 渲染器代理：提交渲染结果（正文文本） */
export function createRenderResultTool(): AgentTool {
  return {
    name: "render_result",
    label: "Render Result",
    description: "提交渲染结果（正文文本 + 章节路径）。必须调用此工具一次提交结果。",
    parameters: renderResultSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "渲染结果已提交" }],
        details: { render: params },
        terminate: true,
      };
    },
  };
}
