// src/agents/world-tools.ts
/**
 * world-tools.ts — 子代理世界图 AgentTool（内部变体）
 *
 * 依据：docs/plans/2026-08-01-data-layer-ports-execution-plan.md §四 A4
 *
 * 与主会话工具（src/tools/world-tools.ts，依赖 ExtensionAPI）的区别：
 * - 闭包注入 OrchestratorPorts，不依赖 ExtensionAPI / SessionState
 * - 供 planner（只读）/ 可见推理（只读 + 写）子代理在 agent loop 中自主查/写
 * - world_event_apply 内部变体不带 userInput 字段（工具分配方案 §六 #4）
 *
 * 全部工具 executionMode: "sequential"（terminate 为 all 语义，避免同轮
 * 多工具导致产出提交工具无法终止，与 tools.ts 的产出工具同策略）。
 */

import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { OrchestratorPorts } from "../orchestrator/assembly.ts";

/** 可见性来源枚举（对齐 ports/types.ts 的 VisibilitySource 字面量联合） */
const VISIBILITY_SOURCE = Type.Union([
  Type.Literal("experienced"),
  Type.Literal("informed"),
  Type.Literal("witnessed"),
]);

const SEQUENTIAL = { executionMode: "sequential" as const };

// ============================================================================
// 只读工具（planner / 可见推理共用）
// ============================================================================

const entityGetParams = Type.Object({
  entityId: Type.String(),
  storyTime: Type.Optional(Type.String()),
});

/** 实体快照（含属性） */
export function createEntityGetTool(ports: OrchestratorPorts): AgentTool<typeof entityGetParams> {
  return {
    name: "world_entity_get",
    label: "World Entity Get",
    description: "获取实体快照（含属性列表）。storyTime 缺省时返回最近时间点。",
    parameters: entityGetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof entityGetParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const snap = await ports.worldGraph.getEntityAt(params.entityId, storyTime);
      return {
        content: [{ type: "text", text: snap ? JSON.stringify(snap) : `未找到实体 ${params.entityId}@${storyTime}` }],
        details: { snapshot: snap },
      };
    },
  };
}

const relationsParams = Type.Object({
  entityId: Type.String(),
  storyTime: Type.Optional(Type.String()),
});

/** 实体关系列表 */
export function createRelationsTool(ports: OrchestratorPorts): AgentTool<typeof relationsParams> {
  return {
    name: "world_relations",
    label: "World Relations",
    description: "获取实体在指定时间点的关系列表（source/target/label）。",
    parameters: relationsParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof relationsParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const rels = await ports.worldGraph.getRelations(params.entityId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels, count: rels.length },
      };
    },
  };
}

const characterViewParams = Type.Object({
  characterId: Type.String(),
  storyTime: Type.Optional(Type.String()),
});

/** 角色视角（五步过滤后的可见声明） */
export function createCharacterViewTool(ports: OrchestratorPorts): AgentTool<typeof characterViewParams> {
  return {
    name: "world_character_view",
    label: "World Character View",
    description: "获取角色视角：该角色在指定时间点可见的状态声明（含可见性过滤）。",
    parameters: characterViewParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof characterViewParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const view = await ports.worldGraph.getCharacterView(params.characterId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        details: { view, count: view.length },
      };
    },
  };
}

const eventChainParams = Type.Object({
  eventId: Type.String(),
});

/** 事件链（因果回溯） */
export function createEventChainTool(ports: OrchestratorPorts): AgentTool<typeof eventChainParams> {
  return {
    name: "world_event_chain",
    label: "World Event Chain",
    description: "获取事件因果链：给定事件 ID，返回其向上回溯的成因事件序列。必须提供 eventId。",
    parameters: eventChainParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof eventChainParams>) {
      const events = await ports.worldGraph.traceCauses(params.eventId);
      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { events, count: events.length },
      };
    },
  };
}

const queryParams = Type.Object({
  query: Type.String(),
  topK: Type.Optional(Type.Number()),
  storyTime: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([
    Type.Literal("fulltext"),
    Type.Literal("vector"),
    Type.Literal("hybrid"),
  ])),
});

/** 检索实体（fulltext/vector/hybrid，走 SearchPort） */
export function createQueryTool(ports: OrchestratorPorts): AgentTool<typeof queryParams> {
  return {
    name: "world_query",
    label: "World Query",
    description: "检索实体（默认 hybrid 混合检索）。返回与查询相关的实体快照列表。",
    parameters: queryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof queryParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const results = await ports.search.search(params.query, {
        topK: params.topK,
        storyTime,
        mode: params.mode,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { results, count: results.length },
      };
    },
  };
}

const storyTimesParams = Type.Object({});

/** 故事时间点列表 */
export function createStoryTimesTool(ports: OrchestratorPorts): AgentTool<typeof storyTimesParams> {
  return {
    name: "world_story_times",
    label: "World Story Times",
    description: "获取世界图全部故事时间点列表（字典序即故事时序）。",
    parameters: storyTimesParams,
    ...SEQUENTIAL,
    async execute(_id) {
      const times = await ports.worldGraph.listStoryTimes();
      return {
        content: [{ type: "text", text: JSON.stringify(times) }],
        details: { times, count: times.length },
      };
    },
  };
}

const statusParams = Type.Object({});

/** 世界图状态摘要（时间点数量 + 最新时间点） */
export function createStatusTool(ports: OrchestratorPorts): AgentTool<typeof statusParams> {
  return {
    name: "world_status",
    label: "World Status",
    description: "获取世界图状态摘要：故事时间点数量 + 最新时间点。",
    parameters: statusParams,
    ...SEQUENTIAL,
    async execute(_id) {
      const times = await ports.worldGraph.listStoryTimes();
      const latest = times.length > 0 ? [...times].sort().at(-1) : undefined;
      const details = { storyTimeCount: times.length, latestStoryTime: latest };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

/** planner 子代理完整工具集：7 只读 */
export function createPlannerTools(ports: OrchestratorPorts): AgentTool<any>[] {
  return [
    createEntityGetTool(ports),
    createRelationsTool(ports),
    createCharacterViewTool(ports),
    createQueryTool(ports),
    createStatusTool(ports),
    createStoryTimesTool(ports),
    createEventChainTool(ports),
  ];
}

// ============================================================================
// 角色受限变体（characterId 绑定 + 可见性过滤，工具分配方案 §5.2）
// ============================================================================

/** 角色可见声明 ID 集合（受限过滤的公共依据） */
async function visibleDeclarationIds(
  ports: OrchestratorPorts,
  characterId: string,
  storyTime: string,
): Promise<Set<string>> {
  const view = await ports.worldGraph.getCharacterView(characterId, storyTime);
  return new Set(view.map((d) => d.declarationId));
}

const limitedCharacterViewParams = Type.Object({
  storyTime: Type.Optional(Type.String()),
});

/** 受限角色视角：绑定 characterId，只返回该角色可见的声明 */
export function createLimitedCharacterViewTool(
  ports: OrchestratorPorts,
  characterId: string,
): AgentTool<typeof limitedCharacterViewParams> {
  return {
    name: "character_view_limited",
    label: "Character View (Limited)",
    description: `查询你（${characterId}）当前可见的世界状态（经可见性过滤）。`,
    parameters: limitedCharacterViewParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedCharacterViewParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const view = await ports.worldGraph.getCharacterView(characterId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        details: { view, count: view.length },
      };
    },
  };
}

const limitedEntityGetParams = Type.Object({
  entityId: Type.String(),
  storyTime: Type.Optional(Type.String()),
});

/** 受限实体查询：绑定 characterId，properties 只保留该角色可见的声明 */
export function createLimitedEntityGetTool(
  ports: OrchestratorPorts,
  characterId: string,
): AgentTool<typeof limitedEntityGetParams> {
  return {
    name: "entity_get_limited",
    label: "Entity Get (Limited)",
    description: `查询实体快照，但只返回你（${characterId}）可见的属性。`,
    parameters: limitedEntityGetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedEntityGetParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const snap = await ports.worldGraph.getEntityAt(params.entityId, storyTime);
      if (!snap) {
        return {
          content: [{ type: "text", text: `未找到实体 ${params.entityId}@${storyTime}` }],
          details: { snapshot: null },
        };
      }
      const visible = await visibleDeclarationIds(ports, characterId, storyTime);
      const filtered = {
        ...snap,
        properties: snap.properties.filter((p) => visible.has(p.declarationId)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
        details: { snapshot: filtered },
      };
    },
  };
}

const limitedRelationsParams = Type.Object({
  entityId: Type.String(),
  storyTime: Type.Optional(Type.String()),
});

/** 受限关系查询：绑定 characterId（关系无可见性概念，直接返回） */
export function createLimitedRelationsTool(
  ports: OrchestratorPorts,
  characterId: string,
): AgentTool<typeof limitedRelationsParams> {
  return {
    name: "relations_limited",
    label: "Relations (Limited)",
    description: `查询你（${characterId}）视角下的实体关系列表。`,
    parameters: limitedRelationsParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedRelationsParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const rels = await ports.worldGraph.getRelations(params.entityId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels, count: rels.length },
      };
    },
  };
}

const limitedQueryParams = Type.Object({
  query: Type.String(),
  topK: Type.Optional(Type.Number()),
  storyTime: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([
    Type.Literal("fulltext"),
    Type.Literal("vector"),
    Type.Literal("hybrid"),
  ])),
});

/**
 * 受限检索：绑定 characterId，检索后按可见声明交集过滤（调研 §7.2）
 *
 * 已知局限：Search 类无 characterId 过滤参数，先检索后过滤存在信息泄漏窗口
 * （搜索结果本身对 LLM 可见），本阶段接受，后续优化。
 * 跟踪：docs/audits/2026-08-03-code-audit.md L-BE-4
 */
export function createLimitedQueryTool(
  ports: OrchestratorPorts,
  characterId: string,
): AgentTool<typeof limitedQueryParams> {
  return {
    name: "query_limited",
    label: "Query (Limited)",
    description: `检索实体，但只返回与你（${characterId}）可见状态相交的结果。`,
    parameters: limitedQueryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedQueryParams>) {
      const storyTime = params.storyTime ?? (await latestStoryTime(ports));
      const results = await ports.search.search(params.query, {
        topK: params.topK,
        storyTime,
        mode: params.mode,
      });
      const visible = await visibleDeclarationIds(ports, characterId, storyTime);
      const filtered = results.filter((r) =>
        r.snapshot.properties.some((p) => visible.has(p.declarationId)),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
        details: { results: filtered, count: filtered.length },
      };
    },
  };
}

/** 角色代理受限工具集：4 只读（characterId 绑定） */
export function createRoleLimitedTools(ports: OrchestratorPorts, characterId: string): AgentTool<any>[] {
  return [
    createLimitedCharacterViewTool(ports, characterId),
    createLimitedEntityGetTool(ports, characterId),
    createLimitedRelationsTool(ports, characterId),
    createLimitedQueryTool(ports, characterId),
  ];
}

// ============================================================================
// 写工具（可见推理代理独占）
// ============================================================================

const eventApplyParams = Type.Object({
  // L-BE-5：eventId 由 LLM 生成且无格式校验，可能重复/孤立；按引擎约定（evt_ 前缀）收紧
  eventId: Type.String({ description: "事件 ID（evt_ 前缀）", pattern: "^evt_[A-Za-z0-9_.-]+$" }),
  type: Type.Union([
    Type.Literal("birth"),
    Type.Literal("death"),
    Type.Literal("change"),
  ], { description: "事件类型" }),
  storyTime: Type.String(),
  entityId: Type.String(),
  newFacts: Type.Optional(Type.Array(Type.Object({
    entityId: Type.String(),
    property: Type.String(),
    value: Type.Unknown(),
    modality: Type.Union([
      Type.Literal("fact"),
      Type.Literal("belief"),
      Type.Literal("hypothesis"),
    ]),
  }), { description: "新增事实（change 事件必填）" })),
  invalidated: Type.Optional(Type.Array(Type.Object({
    declarationId: Type.String({ description: "声明 ID（decl- 前缀）", pattern: "^decl-[A-Za-z0-9_.-]+$" }),
    property: Type.String(),
  }), { description: "闭合的旧事实（同 property 变更时填）" })),
});

/** 写 change 事件到世界图；sink 非空时把成功写入的 eventId 记录其中（失败溯源用） */
export function createEventApplyTool(ports: OrchestratorPorts, sink?: string[]): AgentTool<typeof eventApplyParams> {
  return {
    name: "world_event_apply",
    label: "World Event Apply",
    description: "应用 change/birth/death 事件到世界图。事件 ID 由你生成（evt_ 前缀）。",
    parameters: eventApplyParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof eventApplyParams>) {
      await ports.worldGraph.processEvent({
        eventId: params.eventId,
        type: params.type,
        storyTime: params.storyTime,
        entityId: params.entityId,
        source: "engine",
        ...(params.newFacts ? { newFacts: params.newFacts } : {}),
        ...(params.invalidated ? { invalidated: params.invalidated } : {}),
      });
      sink?.push(params.eventId);
      const details = { ok: true, eventId: params.eventId, entityId: params.entityId };
      return {
        content: [{ type: "text", text: `事件已应用：${params.eventId}（${params.type} @ ${params.storyTime}）` }],
        details,
      };
    },
  };
}

const visibilitySetParams = Type.Object({
  characterId: Type.String(),
  declarationId: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  source: VISIBILITY_SOURCE,
  validFrom: Type.String(),
});

/** 显式设置角色对声明的可见性 */
export function createVisibilitySetTool(ports: OrchestratorPorts): AgentTool<typeof visibilitySetParams> {
  return {
    name: "world_visibility_set",
    label: "World Visibility Set",
    description: "设置角色对某声明的可见性（state=known）。declarationId 生成规则：decl-{entityId}-{property}-{storyTime}。",
    parameters: visibilitySetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof visibilitySetParams>) {
      await ports.worldGraph.setVisibility(params.characterId, params.declarationId, {
        state: "known",
        confidence: params.confidence,
        source: params.source,
        validFrom: params.validFrom,
        isExplicit: true,
      });
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId };
      return {
        content: [{ type: "text", text: `可见性已设置：${params.characterId} -> ${params.declarationId}（confidence=${params.confidence}）` }],
        details,
      };
    },
  };
}

const visibilityCloseParams = Type.Object({
  characterId: Type.String(),
  declarationId: Type.String(),
  storyTime: Type.String(),
});

/** 闭合可见性声明 */
export function createVisibilityCloseTool(ports: OrchestratorPorts): AgentTool<typeof visibilityCloseParams> {
  return {
    name: "world_visibility_close",
    label: "World Visibility Close",
    description: "撤销角色对某声明的可见性（闭合可见性声明）。",
    parameters: visibilityCloseParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof visibilityCloseParams>) {
      await ports.worldGraph.closeVisibility(params.characterId, params.declarationId, params.storyTime);
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId };
      return {
        content: [{ type: "text", text: `可见性已撤销：${params.characterId} -x-> ${params.declarationId}` }],
        details,
      };
    },
  };
}

const visibilityInferParams = Type.Object({
  storyTime: Type.String(),
});

/** 从 located_in 关系推断所有角色的可见性 */
export function createVisibilityInferTool(ports: OrchestratorPorts): AgentTool<typeof visibilityInferParams> {
  return {
    name: "world_visibility_infer",
    label: "World Visibility Infer",
    description: "从 located_in 关系推断所有角色的可见性（场景级可见）。",
    parameters: visibilityInferParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof visibilityInferParams>) {
      await ports.worldGraph.inferVisibility(params.storyTime);
      return {
        content: [{ type: "text", text: `可见性推断完成 @ ${params.storyTime}` }],
        details: { ok: true, storyTime: params.storyTime },
      };
    },
  };
}

const relationAddParams = Type.Object({
  // 🟡（2026-08-08）：零校验修正——LLM 漏填/畸形 ID 会经内核非 strict addRelation
  // 静默写入 `rel--label-...` 垃圾关系（与 🟠-20 同源）；非空 + ID 格式校验
  sourceId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }),
  targetId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }),
  label: Type.String({ description: "关系标签（如 friend / located_in / 敌人）", minLength: 1 }),
  storyTime: Type.String(),
});

/** 新增关系 */
export function createRelationAddTool(ports: OrchestratorPorts): AgentTool<typeof relationAddParams> {
  return {
    name: "world_relation_add",
    label: "World Relation Add",
    description: "新增角色/实体之间的关系。source/target 用实体 ID（非名字）。",
    parameters: relationAddParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof relationAddParams>) {
      await ports.worldGraph.addRelation(params.sourceId, params.targetId, params.label, params.storyTime);
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系已新增：${params.sourceId} -[${params.label}]-> ${params.targetId}` }],
        details,
      };
    },
  };
}

const relationCloseParams = Type.Object({
  sourceId: Type.String(),
  targetId: Type.String(),
  label: Type.String(),
  storyTime: Type.String(),
});

/** 闭合关系 */
export function createRelationCloseTool(ports: OrchestratorPorts): AgentTool<typeof relationCloseParams> {
  return {
    name: "world_relation_close",
    label: "World Relation Close",
    description: "闭合（撤销）关系：source-target-label 在 storyTime 不再有效。",
    parameters: relationCloseParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof relationCloseParams>) {
      await ports.worldGraph.closeRelation(params.sourceId, params.targetId, params.label, params.storyTime);
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系已闭合：${params.sourceId} -[${params.label}]-> ${params.targetId}` }],
        details,
      };
    },
  };
}

/** 可见推理代理完整工具集：3 只读 + 6 写；sink 记录已写入事件 ID（提交失败溯源用） */
export function createReasoningTools(ports: OrchestratorPorts, sink?: string[]): AgentTool<any>[] {
  return [
    createEntityGetTool(ports),
    createRelationsTool(ports),
    createEventChainTool(ports),
    createEventApplyTool(ports, sink),
    createVisibilitySetTool(ports),
    createVisibilityCloseTool(ports),
    createVisibilityInferTool(ports),
    createRelationAddTool(ports),
    createRelationCloseTool(ports),
  ];
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 最近 storyTime（缺省参数兜底：取全部时间点最后一个） */
async function latestStoryTime(ports: OrchestratorPorts): Promise<string> {
  const times = await ports.worldGraph.listStoryTimes();
  // L-BE-1：空图时抛明确错误（此前返回 "" 被当查询值传给下游 → 静默返回 null，LLM 困惑）
  if (times.length === 0) {
    throw new Error("世界图为空：尚无任何 storyTime（先用 world_event_apply 写入事件）");
  }
  return [...times].sort().at(-1) ?? "";
}
