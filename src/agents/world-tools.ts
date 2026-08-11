// src/agents/world-tools.ts
/**
 * world-tools.ts — 统一世界图 AgentTool（主会话 + 子代理共用一套实现）
 *
 * 依据：docs/plans/2026-08-10-worldgraph-dataaccess-and-visibility.md §五（D3）。
 *
 * 职责：
 * - 闭包注入 WorldToolDeps（dataAccess + search + 会话态注入点），不依赖
 *   ExtensionAPI / SessionState，数据走 WorldGraphDataAccess 唯一入口。
 * - 子集分发：createPlannerTools（7 只读）/ createRoleLimitedTools（4 只读受限）/
 *   createReasoningTools（3 只读 + 6 写）/ createMainSessionTools（全集 18）。
 * - 主会话经 agent-tool-adapter.ts 的 wrapper 消费（ToolDefinition），子代理直接消费 AgentTool。
 *
 * 2026-08-11 统一调和（对齐设计文档 §五表格）：
 * - world_event_apply：schema 取并集（source/entityType/summary/causedBy/userInput 可选），
 *   source 缺省 "engine"；写事件后调 onStoryTime。
 * - world_visibility_set：统一参数 storyTime（缺省 resolve）作 validFrom；isExplicit 可选缺省 true。
 * - world_status：取丰富版（currentStoryTime/entityCount/eventCount/recordedNow/latestStoryTime）。
 * - 其余共有工具以子代理版为基座，按并集补齐主会话可选能力（recordedAsOf / typeFilter /
 *   eventId 可选兜底 getAllEvents），校验规则取两版较严者（ID pattern、枚举、minLength 全保留）。
 *
 * 全部工具 executionMode: "sequential"（terminate 为 all 语义，避免同轮多工具
 * 导致产出提交工具无法终止，与 tools.ts 的产出工具同策略）。
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorldGraphDataAccess } from "../data/world-graph-data-access.ts";
import type { SearchPort } from "../ports/types.ts";

/** 统一依赖注入（设计文档 §五）：会话状态外置，DataAccess 无会话状态 */
export interface WorldToolDeps {
  dataAccess: WorldGraphDataAccess;
  search: SearchPort;
  /** storyTime 缺省解析：主会话注入"读会话态，空则取最新"；子代理注入"取最新" */
  resolveStoryTime?: () => Promise<string>;
  /** 写操作成功后的 storyTime 副作用：主会话注入"写会话态"；子代理不传 */
  onStoryTime?: (storyTime: string) => void;
}

// ============================================================================
// 共享类型/schema 常量（参数 schema 全部导出，供 visualizer/routes.ts HTTP 层复用）
// ============================================================================

/** 可见性来源枚举（对齐 ports/types.ts 的 VisibilitySource 字面量联合） */
export const VISIBILITY_SOURCE = Type.Union([
  Type.Literal("experienced"),
  Type.Literal("informed"),
  Type.Literal("witnessed"),
]);

/** 实体类型枚举（对齐仓库 EntityType） */
export const ENTITY_TYPE = Type.Union([
  Type.Literal("character"),
  Type.Literal("location"),
  Type.Literal("item"),
  Type.Literal("concept"),
]);

/** 声明模态枚举 */
export const MODALITY = Type.Union([
  Type.Literal("fact"),
  Type.Literal("belief"),
  Type.Literal("hypothesis"),
]);

const SEQUENTIAL = { executionMode: "sequential" as const };

/** 可选 storyTime（缺省 resolveStoryTime 兜底） */
const storyTimeOpt = Type.Optional(Type.String());
/** retcon 事务时间坐标（可选） */
const recordedAsOfOpt = Type.Optional(Type.String({
  description: "事务时间坐标（world_status 返回的 recordedNow 历史值）。传入后只含该时点之前写入的内容（retcon 隔离）",
}));

/** 属性名中文词表（对象/属性名 schema 描述复用） */
const PROPERTY_VOCAB =
  "属性名（中文词表：角色=名字/性格/背景/说话风格/目标/能力/外貌/位置/心情/健康/当前行动/职业；跨实体=信念.关于_{对象}.{方面}）";

// ============================================================================
// 只读工具（planner / 可见推理共用）
// ============================================================================

export const worldEntityGetParams = Type.Object({
  entityId: Type.String(),
  storyTime: storyTimeOpt,
  recordedAsOf: recordedAsOfOpt,
});

/** 实体快照（含属性） */
export function createEntityGetTool(deps: WorldToolDeps): AgentTool<typeof worldEntityGetParams> {
  return {
    name: "world_entity_get",
    label: "World Entity Get",
    description: "获取实体快照（含属性列表）。storyTime 缺省时返回最近时间点。",
    parameters: worldEntityGetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEntityGetParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const snap = await deps.dataAccess.getEntityAt(params.entityId, storyTime, {
        recordedAsOf: params.recordedAsOf,
      });
      return {
        content: [{ type: "text", text: snap ? JSON.stringify(snap) : `未找到实体 ${params.entityId}@${storyTime}` }],
        details: { snapshot: snap },
      };
    },
  };
}

export const worldRelationsParams = Type.Object({
  entityId: Type.String(),
  storyTime: storyTimeOpt,
});

/** 实体关系列表 */
export function createRelationsTool(deps: WorldToolDeps): AgentTool<typeof worldRelationsParams> {
  return {
    name: "world_relations",
    label: "World Relations",
    description: "获取实体在指定时间点的关系列表（source/target/label）。",
    parameters: worldRelationsParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldRelationsParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const rels = await deps.dataAccess.getRelations(params.entityId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels, count: rels.length },
      };
    },
  };
}

export const worldCharacterViewParams = Type.Object({
  characterId: Type.String(),
  storyTime: storyTimeOpt,
  recordedAsOf: recordedAsOfOpt,
});

/** 角色视角（五步过滤后的可见声明） */
export function createCharacterViewTool(deps: WorldToolDeps): AgentTool<typeof worldCharacterViewParams> {
  return {
    name: "world_character_view",
    label: "World Character View",
    description: "获取角色视角：该角色在指定时间点可见的状态声明（含可见性过滤）。",
    parameters: worldCharacterViewParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldCharacterViewParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const view = await deps.dataAccess.getCharacterView(params.characterId, storyTime, {
        recordedAsOf: params.recordedAsOf,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        details: { view, count: view.length },
      };
    },
  };
}

export const worldEventChainParams = Type.Object({
  eventId: Type.Optional(Type.String()),
});

/** 事件链（因果回溯；不传 eventId 时返回全部事件） */
export function createEventChainTool(deps: WorldToolDeps): AgentTool<typeof worldEventChainParams> {
  return {
    name: "world_event_chain",
    label: "World Event Chain",
    description: "获取事件链：给定 eventId 向上回溯成因事件；不传 eventId 时返回全部事件。",
    parameters: worldEventChainParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEventChainParams>) {
      const events = params.eventId
        ? await deps.dataAccess.traceCauses(params.eventId)
        : await deps.dataAccess.getAllEvents();
      if (events === null) {
        return {
          content: [{ type: "text", text: `未找到事件（不存在或因果链为空）: ${params.eventId}` }],
          details: { ok: false, eventId: params.eventId },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { events, count: events.length },
      };
    },
  };
}

export const worldQueryParams = Type.Object({
  query: Type.String(),
  topK: Type.Optional(Type.Number()),
  typeFilter: Type.Optional(ENTITY_TYPE),
  storyTime: storyTimeOpt,
  mode: Type.Optional(Type.Union([
    Type.Literal("fulltext"),
    Type.Literal("vector"),
    Type.Literal("hybrid"),
  ])),
});

/** 检索实体（fulltext/vector/hybrid，走 SearchPort） */
export function createQueryTool(deps: WorldToolDeps): AgentTool<typeof worldQueryParams> {
  return {
    name: "world_query",
    label: "World Query",
    description: "检索实体（默认 hybrid 混合检索）。返回与查询相关的实体快照列表。",
    parameters: worldQueryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldQueryParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const results = await deps.search.search(params.query, {
        topK: params.topK,
        typeFilter: params.typeFilter,
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

export const worldStoryTimesParams = Type.Object({});

/** 故事时间点列表 */
export function createStoryTimesTool(deps: WorldToolDeps): AgentTool<typeof worldStoryTimesParams> {
  return {
    name: "world_story_times",
    label: "World Story Times",
    description: "获取世界图全部故事时间点列表（字典序即故事时序）。",
    parameters: worldStoryTimesParams,
    ...SEQUENTIAL,
    async execute(_id) {
      const times = await deps.dataAccess.listStoryTimes();
      return {
        content: [{ type: "text", text: JSON.stringify(times) }],
        details: { times, count: times.length },
      };
    },
  };
}

export const worldStatusParams = Type.Object({});

/** 世界图状态摘要（丰富版：currentStoryTime + 实体/事件数 + recordedNow + 最新时间点） */
export function createStatusTool(deps: WorldToolDeps): AgentTool<typeof worldStatusParams> {
  return {
    name: "world_status",
    label: "World Status",
    description: "获取世界图状态摘要：当前/最新故事时间点、实体数、事件数、recordedNow。",
    parameters: worldStatusParams,
    ...SEQUENTIAL,
    async execute(_id) {
      const times = await deps.dataAccess.listStoryTimes();
      const latest = times.length > 0 ? [...times].sort().at(-1) : undefined;
      let current: string | undefined;
      if (deps.resolveStoryTime) {
        try {
          current = await deps.resolveStoryTime();
        } catch {
          current = latest;
        }
      }
      const st = current ?? latest ?? "Infinity";
      const [entities, events, recordedNow] = await Promise.all([
        deps.dataAccess.getAllEntities(st),
        deps.dataAccess.getAllEvents(),
        deps.dataAccess.recordedNow(),
      ]);
      const details = {
        currentStoryTime: current ?? null,
        latestStoryTime: latest ?? null,
        storyTimeCount: times.length,
        entityCount: entities.length,
        eventCount: events.length,
        recordedNow: recordedNow ?? null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

/** planner 子代理完整工具集：7 只读 */
export function createPlannerTools(deps: WorldToolDeps): AgentTool<any>[] {
  return [
    createEntityGetTool(deps),
    createRelationsTool(deps),
    createCharacterViewTool(deps),
    createQueryTool(deps),
    createStatusTool(deps),
    createStoryTimesTool(deps),
    createEventChainTool(deps),
  ];
}

// ============================================================================
// 角色受限变体（characterId 绑定 + 可见性过滤，工具分配方案 §5.2）
// ============================================================================

/** 角色可见声明 ID 集合（受限过滤的公共依据） */
async function visibleDeclarationIds(
  deps: WorldToolDeps,
  characterId: string,
  storyTime: string,
): Promise<Set<string>> {
  const view = await deps.dataAccess.getCharacterView(characterId, storyTime);
  return new Set(view.map((d) => d.declarationId));
}

export const limitedCharacterViewParams = Type.Object({
  storyTime: storyTimeOpt,
});

/** 受限角色视角：绑定 characterId，只返回该角色可见的声明 */
export function createLimitedCharacterViewTool(
  deps: WorldToolDeps,
  characterId: string,
): AgentTool<typeof limitedCharacterViewParams> {
  return {
    name: "character_view_limited",
    label: "Character View (Limited)",
    description: `查询你（${characterId}）当前可见的世界状态（经可见性过滤）。`,
    parameters: limitedCharacterViewParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedCharacterViewParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const view = await deps.dataAccess.getCharacterView(characterId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        details: { view, count: view.length },
      };
    },
  };
}

export const limitedEntityGetParams = Type.Object({
  entityId: Type.String(),
  storyTime: storyTimeOpt,
});

/** 受限实体查询：绑定 characterId，properties 只保留该角色可见的声明 */
export function createLimitedEntityGetTool(
  deps: WorldToolDeps,
  characterId: string,
): AgentTool<typeof limitedEntityGetParams> {
  return {
    name: "entity_get_limited",
    label: "Entity Get (Limited)",
    description: `查询实体快照，但只返回你（${characterId}）可见的属性。`,
    parameters: limitedEntityGetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedEntityGetParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const snap = await deps.dataAccess.getEntityAt(params.entityId, storyTime);
      if (!snap) {
        return {
          content: [{ type: "text", text: `未找到实体 ${params.entityId}@${storyTime}` }],
          details: { snapshot: null },
        };
      }
      const visible = await visibleDeclarationIds(deps, characterId, storyTime);
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

export const limitedRelationsParams = Type.Object({
  entityId: Type.String(),
  storyTime: storyTimeOpt,
});

/** 受限关系查询：绑定 characterId（关系无可见性概念，直接返回） */
export function createLimitedRelationsTool(
  deps: WorldToolDeps,
  characterId: string,
): AgentTool<typeof limitedRelationsParams> {
  return {
    name: "relations_limited",
    label: "Relations (Limited)",
    description: `查询你（${characterId}）视角下的实体关系列表。`,
    parameters: limitedRelationsParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedRelationsParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const rels = await deps.dataAccess.getRelations(params.entityId, storyTime);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels, count: rels.length },
      };
    },
  };
}

export const limitedQueryParams = Type.Object({
  query: Type.String(),
  topK: Type.Optional(Type.Number()),
  storyTime: storyTimeOpt,
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
  deps: WorldToolDeps,
  characterId: string,
): AgentTool<typeof limitedQueryParams> {
  return {
    name: "query_limited",
    label: "Query (Limited)",
    description: `检索实体，但只返回与你（${characterId}）可见状态相交的结果。`,
    parameters: limitedQueryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof limitedQueryParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      const results = await deps.search.search(params.query, {
        topK: params.topK,
        storyTime,
        mode: params.mode,
      });
      const visible = await visibleDeclarationIds(deps, characterId, storyTime);
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
export function createRoleLimitedTools(deps: WorldToolDeps, characterId: string): AgentTool<any>[] {
  return [
    createLimitedCharacterViewTool(deps, characterId),
    createLimitedEntityGetTool(deps, characterId),
    createLimitedRelationsTool(deps, characterId),
    createLimitedQueryTool(deps, characterId),
  ];
}

// ============================================================================
// 写工具（可见推理代理独占 + 主会话）
// ============================================================================

export const worldEventApplyParams = Type.Object({
  // L-BE-5：eventId 由 LLM 生成且无格式校验，可能重复/孤立；按引擎约定（evt_ 前缀）收紧
  eventId: Type.String({ description: "事件 ID（evt_ 前缀）", pattern: "^evt_[A-Za-z0-9_.-]+$" }),
  type: Type.Union([
    Type.Literal("birth"),
    Type.Literal("death"),
    Type.Literal("change"),
  ], { description: "事件类型" }),
  storyTime: Type.String(),
  entityId: Type.String(),
  source: Type.Optional(Type.Union([
    Type.Literal("engine"),
    Type.Literal("user"),
  ])),
  entityType: Type.Optional(ENTITY_TYPE),
  summary: Type.Optional(Type.String({ description: "实体无状态客观描述（birth 事件用）" })),
  newFacts: Type.Optional(Type.Array(Type.Object({
    entityId: Type.String(),
    property: Type.String({ description: PROPERTY_VOCAB }),
    // 0.3.0：value → description（string 契约，searchable 进全文索引）
    description: Type.String({ description: "状态描述文本（可读长句）" }),
    modality: MODALITY,
  }), { description: "新增事实（change 事件必填）" })),
  invalidated: Type.Optional(Type.Array(Type.Object({
    declarationId: Type.String({ description: "声明 ID（decl- 前缀）", pattern: "^decl-[A-Za-z0-9_.-]+$" }),
    property: Type.String(),
  }), { description: "闭合的旧事实（同 property 变更时填）" })),
  causedBy: Type.Optional(Type.String()),
  userInput: Type.Optional(Type.String({ description: "用户口述原文（写入事件日志，供项目记忆展示）" })),
});

/** 写 change/birth/death 事件到世界图；sink 非空时把成功写入的 eventId 记录其中（失败溯源用） */
export function createEventApplyTool(deps: WorldToolDeps, sink?: string[]): AgentTool<typeof worldEventApplyParams> {
  return {
    name: "world_event_apply",
    label: "World Event Apply",
    description: "应用 change/birth/death 事件到世界图。事件 ID 由你生成（evt_ 前缀）。",
    parameters: worldEventApplyParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEventApplyParams>) {
      await deps.dataAccess.processEvent({
        eventId: params.eventId,
        type: params.type,
        storyTime: params.storyTime,
        entityId: params.entityId,
        source: params.source ?? "engine",
        ...(params.entityType !== undefined ? { entityType: params.entityType } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
        ...(params.newFacts ? { newFacts: params.newFacts } : {}),
        ...(params.invalidated ? { invalidated: params.invalidated } : {}),
        ...(params.causedBy !== undefined ? { causedBy: params.causedBy } : {}),
        ...(params.userInput !== undefined ? { userInput: params.userInput } : {}),
      });
      sink?.push(params.eventId);
      deps.onStoryTime?.(params.storyTime);
      const details = { ok: true, eventId: params.eventId, entityId: params.entityId };
      return {
        content: [{ type: "text", text: `事件已应用：${params.eventId}（${params.type} @ ${params.storyTime}）` }],
        details,
      };
    },
  };
}

export const worldVisibilitySetParams = Type.Object({
  characterId: Type.String(),
  declarationId: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  source: VISIBILITY_SOURCE,
  storyTime: storyTimeOpt,
  isExplicit: Type.Optional(Type.Boolean()),
});

/** 显式设置角色对声明的可见性（state=known）。declarationId 生成规则：decl-{entityId}-{property}-{storyTime} */
export function createVisibilitySetTool(deps: WorldToolDeps): AgentTool<typeof worldVisibilitySetParams> {
  return {
    name: "world_visibility_set",
    label: "World Visibility Set",
    description: "设置角色对某声明的可见性（state=known）。declarationId 生成规则：decl-{entityId}-{property}-{storyTime}。",
    parameters: worldVisibilitySetParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldVisibilitySetParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.setVisibility(params.characterId, params.declarationId, {
        state: "known",
        confidence: params.confidence,
        source: params.source,
        validFrom: storyTime,
        isExplicit: params.isExplicit ?? true,
      });
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId };
      return {
        content: [{ type: "text", text: `可见性已设置：${params.characterId} -> ${params.declarationId}（confidence=${params.confidence}）` }],
        details,
      };
    },
  };
}

export const worldVisibilityCloseParams = Type.Object({
  characterId: Type.String(),
  declarationId: Type.String(),
  storyTime: storyTimeOpt,
});

/** 闭合可见性声明 */
export function createVisibilityCloseTool(deps: WorldToolDeps): AgentTool<typeof worldVisibilityCloseParams> {
  return {
    name: "world_visibility_close",
    label: "World Visibility Close",
    description: "撤销角色对某声明的可见性（闭合可见性声明）。",
    parameters: worldVisibilityCloseParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldVisibilityCloseParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.closeVisibility(params.characterId, params.declarationId, storyTime);
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId };
      return {
        content: [{ type: "text", text: `可见性已撤销：${params.characterId} -x-> ${params.declarationId}` }],
        details,
      };
    },
  };
}

export const worldVisibilityInferParams = Type.Object({
  storyTime: storyTimeOpt,
});

/** 从 located_in 关系推断所有角色的可见性 */
export function createVisibilityInferTool(deps: WorldToolDeps): AgentTool<typeof worldVisibilityInferParams> {
  return {
    name: "world_visibility_infer",
    label: "World Visibility Infer",
    description: "从 located_in 关系推断所有角色的可见性（场景级可见）。",
    parameters: worldVisibilityInferParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldVisibilityInferParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.inferVisibilityAt(storyTime);
      return {
        content: [{ type: "text", text: `可见性推断完成 @ ${storyTime}` }],
        details: { ok: true, storyTime },
      };
    },
  };
}

export const worldRelationAddParams = Type.Object({
  // 🟡（2026-08-08）：零校验修正——LLM 漏填/畸形 ID 会经内核非 strict addRelation
  // 静默写入 `rel--label-...` 垃圾关系（与 🟠-20 同源）；非空 + ID 格式校验
  sourceId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }),
  targetId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }),
  label: Type.String({ description: "关系标签（角色规则集中文枚举：仇敌/朋友/师徒/结义/恋人/上下级/亲属/同盟/敌对/认识/邻居/同事；located_in 为系统保留词勿翻译）", minLength: 1 }),
  description: Type.Optional(Type.String({ description: "关系叙事描述（可选长句）" })),
  storyTime: storyTimeOpt,
});

/** 新增关系 */
export function createRelationAddTool(deps: WorldToolDeps): AgentTool<typeof worldRelationAddParams> {
  return {
    name: "world_relation_add",
    label: "World Relation Add",
    description: "新增角色/实体之间的关系。source/target 用实体 ID（非名字）。",
    parameters: worldRelationAddParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldRelationAddParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.addRelation(
        params.sourceId,
        params.targetId,
        params.label,
        storyTime,
        params.description ? { description: params.description } : undefined,
      );
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系已新增：${params.sourceId} -[${params.label}]-> ${params.targetId}` }],
        details,
      };
    },
  };
}

export const worldRelationCloseParams = Type.Object({
  sourceId: Type.String(),
  targetId: Type.String(),
  label: Type.String(),
  storyTime: storyTimeOpt,
});

/** 闭合关系 */
export function createRelationCloseTool(deps: WorldToolDeps): AgentTool<typeof worldRelationCloseParams> {
  return {
    name: "world_relation_close",
    label: "World Relation Close",
    description: "闭合（撤销）关系：source-target-label 在 storyTime 不再有效。",
    parameters: worldRelationCloseParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldRelationCloseParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.closeRelation(params.sourceId, params.targetId, params.label, storyTime);
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系已闭合：${params.sourceId} -[${params.label}]-> ${params.targetId}` }],
        details,
      };
    },
  };
}

/** 可见推理代理完整工具集：3 只读 + 6 写；sink 记录已写入事件 ID（提交失败溯源用） */
export function createReasoningTools(deps: WorldToolDeps, sink?: string[]): AgentTool<any>[] {
  return [
    createEntityGetTool(deps),
    createRelationsTool(deps),
    createEventChainTool(deps),
    createEventApplyTool(deps, sink),
    createVisibilitySetTool(deps),
    createVisibilityCloseTool(deps),
    createVisibilityInferTool(deps),
    createRelationAddTool(deps),
    createRelationCloseTool(deps),
  ];
}

// ============================================================================
// 主会话独有写/查询工具（并入自 chat/world-tools.ts）
// ============================================================================

export const worldEntityCreateParams = Type.Object({
  entityId: Type.String(),
  type: ENTITY_TYPE,
  initialProps: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "初始属性（property 用中文词表：角色=名字/性格/背景/说话风格/目标/能力/外貌/位置/心情/健康/当前行动/职业；地点=名字/描述/类型/天气/时段/氛围；物品=名字/材质/主人/历史/能力/状态/位置/磨损；概念=名字/规则/范围/元素；值必须为字符串）",
  })),
  storyTime: Type.String(),
});

/** 创建实体（诞生） */
export function createEntityCreateTool(deps: WorldToolDeps): AgentTool<typeof worldEntityCreateParams> {
  return {
    name: "world_entity_create",
    label: "World Entity Create",
    description: "创建实体（诞生）",
    parameters: worldEntityCreateParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEntityCreateParams>) {
      await deps.dataAccess.birthEntity(params.entityId, params.type, params.initialProps ?? {}, params.storyTime);
      deps.onStoryTime?.(params.storyTime);
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 已创建（${params.type}）@ ${params.storyTime}` }],
        details: { ok: true, entityId: params.entityId },
      };
    },
  };
}

export const worldEntityKillParams = Type.Object({
  entityId: Type.String(),
  storyTime: Type.String(),
});

/** 消亡实体 */
export function createEntityKillTool(deps: WorldToolDeps): AgentTool<typeof worldEntityKillParams> {
  return {
    name: "world_entity_kill",
    label: "World Entity Kill",
    description: "消亡实体",
    parameters: worldEntityKillParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEntityKillParams>) {
      await deps.dataAccess.killEntity(params.entityId, params.storyTime);
      deps.onStoryTime?.(params.storyTime);
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 已消亡 @ ${params.storyTime}` }],
        details: { ok: true, entityId: params.entityId },
      };
    },
  };
}

export const worldEntityUpdateSummaryParams = Type.Object({
  entityId: Type.String(),
  summary: Type.String(),
  storyTime: storyTimeOpt,
});

/** 更新实体摘要（作者可见的元信息，纯展示字段） */
export function createEntityUpdateSummaryTool(deps: WorldToolDeps): AgentTool<typeof worldEntityUpdateSummaryParams> {
  return {
    name: "world_entity_update_summary",
    label: "World Entity Update Summary",
    description: "更新实体摘要（作者可见的元信息，纯展示字段，不参与时态/检索/可见性）。每次更新写一条 change 事件（可回溯）",
    parameters: worldEntityUpdateSummaryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEntityUpdateSummaryParams>) {
      const storyTime = await resolveStoryTime(deps, params.storyTime);
      await deps.dataAccess.updateEntitySummary(params.entityId, params.summary, storyTime);
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 摘要已更新 @ ${storyTime}` }],
        details: { ok: true, entityId: params.entityId, summary: params.summary },
      };
    },
  };
}

export const worldEntityHistoryParams = Type.Object({
  entityId: Type.String(),
});

/** 实体全部版本 + 全部 Fact（含历史） */
export function createEntityHistoryTool(deps: WorldToolDeps): AgentTool<typeof worldEntityHistoryParams> {
  return {
    name: "world_entity_history",
    label: "World Entity History",
    description: "查询单个实体的全部版本（含已闭合记录），按 validFrom 升序。返回 Entity 记录数组 + 全部 Fact（含历史）",
    parameters: worldEntityHistoryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldEntityHistoryParams>) {
      const history = await deps.dataAccess.getEntityHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(history) }],
        details: history,
      };
    },
  };
}

export const worldRelationHistoryParams = Type.Object({
  entityId: Type.Optional(Type.String()),
});

/** 关系历史（含已闭合）。不传 entityId 返回全部关系 */
export function createRelationHistoryTool(deps: WorldToolDeps): AgentTool<typeof worldRelationHistoryParams> {
  return {
    name: "world_relation_history",
    label: "World Relation History",
    description: "查询关系历史（含已闭合）。不传 entityId 返回全部关系",
    parameters: worldRelationHistoryParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof worldRelationHistoryParams>) {
      const relations = await deps.dataAccess.getRelationHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(relations) }],
        details: { relations, count: relations.length },
      };
    },
  };
}

/** 主会话完整工具集：全集 18 */
export function createMainSessionTools(deps: WorldToolDeps): AgentTool<any>[] {
  return [
    createStatusTool(deps),
    createEntityCreateTool(deps),
    createEntityKillTool(deps),
    createEntityGetTool(deps),
    createEntityUpdateSummaryTool(deps),
    createEntityHistoryTool(deps),
    createRelationAddTool(deps),
    createRelationCloseTool(deps),
    createRelationsTool(deps),
    createRelationHistoryTool(deps),
    createEventApplyTool(deps),
    createEventChainTool(deps),
    createCharacterViewTool(deps),
    createVisibilitySetTool(deps),
    createVisibilityCloseTool(deps),
    createVisibilityInferTool(deps),
    createQueryTool(deps),
    createStoryTimesTool(deps),
  ];
}

/** 主会话 ToolDefinition 的 promptSnippet 映射表（wrapper 按工具名挂接） */
export const WORLD_TOOL_PROMPT_SNIPPETS: Record<string, string> = {
  world_status: "查看世界图当前状态",
  world_entity_create: "创建世界图实体",
  world_entity_kill: "使世界图实体消亡",
  world_entity_get: "获取实体世界图快照",
  world_entity_update_summary: "更新实体摘要",
  world_entity_history: "查询实体历史",
  world_relation_add: "创建世界图关系",
  world_relation_close: "闭合世界图关系",
  world_relations: "查看实体关系",
  world_relation_history: "查询关系历史",
  world_event_apply: "应用世界图事件",
  world_event_chain: "查看世界图事件链",
  world_character_view: "查看角色可见世界",
  world_visibility_set: "设置角色声明可见性",
  world_visibility_close: "撤销角色声明可见性",
  world_visibility_infer: "推断角色可见性",
  world_query: "检索世界图实体",
  world_story_times: "列出世界图故事时间点",
};

// ============================================================================
// 内部辅助
// ============================================================================

/** storyTime 解析：显式参数 > resolveStoryTime() > 最新时间点 */
async function resolveStoryTime(deps: WorldToolDeps, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (deps.resolveStoryTime) return deps.resolveStoryTime();
  return latestStoryTime(deps.dataAccess);
}

/** 最近 storyTime（缺省参数兜底：取全部时间点最后一个） */
async function latestStoryTime(dataAccess: WorldGraphDataAccess): Promise<string> {
  const times = await dataAccess.listStoryTimes();
  // L-BE-1：空图时抛明确错误（此前返回 "" 被当查询值传给下游 → 静默返回 null，LLM 困惑）
  if (times.length === 0) {
    throw new Error("世界图为空：尚无任何 storyTime（先用 world_event_apply 写入事件）");
  }
  return [...times].sort().at(-1) ?? "";
}