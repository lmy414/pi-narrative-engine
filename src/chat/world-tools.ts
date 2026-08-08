import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorldGraph } from "underworld-graph";
import type { Search } from "../search.ts";

export interface WorldToolsProvider {
  wg: WorldGraph;
  search: Search;
  cwd: string;
  currentStoryTime: string | null;
  setCurrentStoryTime(storyTime: string): void;
}

// L-BE-3：可选 storyTime 参数类型复用的共享 schema（此前变量名 storyTime 与
// 工具参数 field 名冲突，可读性差；统一后缀 Opt 表"可选"）
const storyTimeOpt = Type.Optional(Type.String());
const recordedAsOf = Type.Optional(Type.String({ description: "事务时间坐标（world_status 返回的 recordedNow 历史值）。传入后只含该时点之前写入的内容（retcon 隔离）" }));
const characterViewRecordedAsOf = Type.Optional(Type.String({ description: "事务时间坐标。传入后角色视角只含该时点之前写入的内容（retcon 隔离）" }));
const entityType = Type.Union([Type.Literal("character"), Type.Literal("location"), Type.Literal("item"), Type.Literal("concept")]);
const modality = Type.Union([Type.Literal("fact"), Type.Literal("belief"), Type.Literal("hypothesis")]);
// M-Logic-6 修复：主会话版 visibility source 补齐枚举校验（对齐 agents/world-tools.ts
// VISIBILITY_SOURCE 与 ports/types.ts VisibilitySource 字面量联合），
// LLM 传入非法字符串不再于 zod 层抛晦涩错误
const visibilitySource = Type.Union([
  Type.Literal("experienced"),
  Type.Literal("informed"),
  Type.Literal("witnessed"),
]);

function resolveStoryTime(provider: WorldToolsProvider, explicit?: string): string {
  if (explicit) return explicit;
  if (provider.currentStoryTime) return provider.currentStoryTime;
  throw new Error("storyTime required (call world_event_apply first or pass storyTime explicitly)");
}

export function createWorldTools(provider: WorldToolsProvider): ToolDefinition[] {
  function tool<T extends Record<string, unknown>>(
    configOrProvider: WorldToolsProvider | {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      promptSnippet: string;
      execute: (provider: WorldToolsProvider, params: T) => Promise<any>;
    },
    maybeConfig?: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      promptSnippet: string;
      execute: (provider: WorldToolsProvider, params: T) => Promise<any>;
    },
  ): ToolDefinition {
    const config = (maybeConfig ?? configOrProvider) as {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      promptSnippet: string;
      execute: (provider: WorldToolsProvider, params: T) => Promise<any>;
    };
    return defineTool({
      ...config,
      async execute(_id: string, params: T) {
        return config.execute(provider, params);
      },
    } as any);
  }

  return [
    tool({ name: "world_status", label: "World Status", description: "获取世界图状态摘要（currentStoryTime / 实体数 / 事件数 / 关系数）。无需参数。", parameters: Type.Object({}), promptSnippet: "查看世界图当前状态", execute: async p => {
      let st = p.currentStoryTime;
      if (!st) { const times = await p.wg.listStoryTimes(); st = times.length ? times[times.length - 1]! : "Infinity"; }
      const entities = await p.wg.getAllEntities(st); const events = await p.wg.getAllEvents(); const recordedNow = await p.wg.recordedNow();
      const status = { currentStoryTime: p.currentStoryTime, entityCount: entities.length, eventCount: events.length, recordedNow };
      return { content: [{ type: "text", text: [`currentStoryTime: ${p.currentStoryTime ?? "(未设置)"}`, `统计时刻: ${st}`, `实体数: ${entities.length}`, `事件数: ${events.length}`, `recordedNow: ${recordedNow ?? "(空图)"}`].join("\n") }], details: { status } };
    }}),
    tool({ name: "world_entity_create", label: "World Entity Create", description: "创建实体（诞生）", parameters: Type.Object({ entityId: Type.String(), type: entityType, initialProps: Type.Optional(Type.Record(Type.String(), Type.Unknown())), storyTime: Type.String() }), promptSnippet: "创建世界图实体", execute: async (p, x: any) => { await p.wg.birthEntity(x.entityId, x.type, x.initialProps ?? {}, x.storyTime); p.setCurrentStoryTime(x.storyTime); return { content: [{ type: "text", text: `实体 ${x.entityId} 已创建（${x.type}）@ ${x.storyTime}` }], details: { ok: true, entityId: x.entityId } }; }}),
    tool({ name: "world_entity_kill", label: "World Entity Kill", description: "消亡实体", parameters: Type.Object({ entityId: Type.String(), storyTime: Type.String() }), promptSnippet: "使世界图实体消亡", execute: async (p, x: any) => { await p.wg.killEntity(x.entityId, x.storyTime); p.setCurrentStoryTime(x.storyTime); return { content: [{ type: "text", text: `实体 ${x.entityId} 已消亡 @ ${x.storyTime}` }], details: { ok: true, entityId: x.entityId } }; }}),
    tool({ name: "world_entity_get", label: "World Entity Get", description: "获取实体快照（bi-temporal：storyTime=故事时间轴，recordedAsOf=事务时间轴）", parameters: Type.Object({ entityId: Type.String(), storyTime: storyTimeOpt, recordedAsOf }), promptSnippet: "获取实体世界图快照", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); const snapshot = await p.wg.getEntityAt(x.entityId, st, { recordedAsOf: x.recordedAsOf }); return { content: [{ type: "text", text: snapshot ? JSON.stringify(snapshot) : `未找到实体 ${x.entityId} @ ${st}` }], details: snapshot ? { entityId: x.entityId, storyTime: st, snapshot } : { entityId: x.entityId, storyTime: st, error: "Entity not found at given storyTime" } }; }}),
    tool({ name: "world_entity_update_summary", label: "World Entity Update Summary", description: "更新实体摘要（作者可见的元信息，纯展示字段，不参与时态/检索/可见性）。每次更新写一条 change 事件（可回溯）", parameters: Type.Object({ entityId: Type.String(), summary: Type.String(), storyTime: storyTimeOpt }), promptSnippet: "更新实体摘要", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.updateEntitySummary(x.entityId, x.summary, st); return { content: [{ type: "text", text: `实体 ${x.entityId} 摘要已更新 @ ${st}` }], details: { ok: true, entityId: x.entityId, summary: x.summary } }; }}),
    tool({ name: "world_entity_history", label: "World Entity History", description: "查询单个实体的全部版本（含已闭合记录），按 validFrom 升序。返回 Entity 记录数组 + 全部 Fact（含历史）", parameters: Type.Object({ entityId: Type.String() }), promptSnippet: "查询实体历史", execute: async (p, x: any) => { const history = await p.wg.getEntityHistory(x.entityId); return { content: [{ type: "text", text: JSON.stringify(history) }], details: history }; }}),
    tool({ name: "world_relation_add", label: "World Relation Add", description: "创建关系", parameters: Type.Object({ /* 🟡 审计修正：主会话版同 agents 版——ID 格式校验 + label 非空（防 rel--label- 垃圾关系） */ sourceId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }), targetId: Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }), label: Type.String({ description: "关系标签（如 friend / located_in / 敌人）", minLength: 1 }), storyTime: storyTimeOpt }), promptSnippet: "创建世界图关系", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.addRelation(x.sourceId, x.targetId, x.label, st); return { content: [{ type: "text", text: `关系 ${x.sourceId} -[${x.label}]-> ${x.targetId} 已创建 @ ${st}` }], details: { ok: true, sourceId: x.sourceId, targetId: x.targetId, label: x.label } }; }}),
    tool({ name: "world_relation_close", label: "World Relation Close", description: "闭合关系", parameters: Type.Object({ sourceId: Type.String(), targetId: Type.String(), label: Type.String(), storyTime: storyTimeOpt }), promptSnippet: "闭合世界图关系", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.closeRelation(x.sourceId, x.targetId, x.label, st); return { content: [{ type: "text", text: `关系 ${x.sourceId} -[${x.label}]-> ${x.targetId} 已闭合 @ ${st}` }], details: { ok: true, sourceId: x.sourceId, targetId: x.targetId, label: x.label } }; }}),
    tool({ name: "world_relations", label: "World Relations", description: "列出实体的关系", parameters: Type.Object({ entityId: Type.String(), storyTime: storyTimeOpt }), promptSnippet: "查看实体关系", execute: async (p, x: any) => { const rels = await p.wg.getRelations(x.entityId, resolveStoryTime(p, x.storyTime)); return { content: [{ type: "text", text: JSON.stringify(rels) }], details: { relations: rels } }; }}),
    tool({ name: "world_relation_history", label: "World Relation History", description: "查询关系历史（含已闭合）。不传 entityId 返回全部关系", parameters: Type.Object({ entityId: Type.Optional(Type.String()) }), promptSnippet: "查询关系历史", execute: async (p, x: any) => { const relations = await p.wg.getRelationHistory(x.entityId); return { content: [{ type: "text", text: JSON.stringify(relations) }], details: { relations, count: relations.length } }; }}),
    tool({ name: "world_event_apply", label: "World Event Apply", description: "应用事件到世界图", parameters: Type.Object({ event: Type.Object({ eventId: Type.String({ description: "事件 ID（evt_ 前缀）", pattern: "^evt_[A-Za-z0-9_.-]+$" }), type: Type.Union([Type.Literal("birth"), Type.Literal("death"), Type.Literal("change")]), storyTime: Type.String(), entityId: Type.String(), source: Type.Optional(Type.Union([Type.Literal("engine"), Type.Literal("user")])), entityType: Type.Optional(entityType), summary: Type.Optional(Type.String()), newFacts: Type.Optional(Type.Array(Type.Object({ entityId: Type.String(), property: Type.String(), description: Type.String({ description: "状态描述文本（可读长句）" }), modality }))), invalidated: Type.Optional(Type.Array(Type.Object({ declarationId: Type.String({ description: "声明 ID（decl- 前缀）", pattern: "^decl-[A-Za-z0-9_.-]+$" }), property: Type.String() }))), causedBy: Type.Optional(Type.String()), userInput: Type.Optional(Type.String({ description: "用户口述原文（写入事件日志，供项目记忆展示）" })) }) }), promptSnippet: "应用世界图事件", execute: async (p, x: any) => { await p.wg.processEvent(x.event); p.setCurrentStoryTime(x.event.storyTime); return { content: [{ type: "text", text: `事件 ${x.event.eventId}（${x.event.type}）已应用 @ ${x.event.storyTime}` }], details: { ok: true, eventId: x.event.eventId, type: x.event.type } }; }}),
    tool({ name: "world_event_chain", label: "World Event Chain", description: "获取事件链（按 storyTime 升序）。可传 eventId 进行因果回溯", parameters: Type.Object({ eventId: Type.Optional(Type.String()) }), promptSnippet: "查看世界图事件链", execute: async (p, x: any) => { const events = x.eventId ? await p.wg.traceCauses(x.eventId) : await p.wg.getAllEvents(); if (events === null) return { content: [{ type: "text", text: "未找到事件（不存在或因果链为空）: " + x.eventId }], details: { ok: false, eventId: x.eventId } }; return { content: [{ type: "text", text: JSON.stringify(events) }], details: { events, count: events.length } }; }}),
    tool({ name: "world_character_view", label: "World Character View", description: "获取角色视角（五步过滤后的可见声明；recordedAsOf 可做事务时间隔离）", parameters: Type.Object({ characterId: Type.String(), storyTime: storyTimeOpt, recordedAsOf: characterViewRecordedAsOf }), promptSnippet: "查看角色可见世界", execute: async (p, x: any) => { const view = await p.wg.getCharacterView(x.characterId, resolveStoryTime(p, x.storyTime), { recordedAsOf: x.recordedAsOf }); return { content: [{ type: "text", text: JSON.stringify(view) }], details: { view, count: view.length } }; }}),
    tool({ name: "world_visibility_set", label: "World Visibility Set", description: "显式设置角色对某声明的可见性", parameters: Type.Object({ characterId: Type.String(), declarationId: Type.String(), confidence: Type.Number(), source: visibilitySource, isExplicit: Type.Boolean(), storyTime: storyTimeOpt }), promptSnippet: "设置角色声明可见性", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.setVisibility(x.characterId, x.declarationId, { state: "known", confidence: x.confidence, source: x.source, validFrom: st, isExplicit: x.isExplicit }); return { content: [{ type: "text", text: `可见性已设置：${x.characterId} -> ${x.declarationId}（confidence=${x.confidence}）@ ${st}` }], details: { ok: true, characterId: x.characterId, declarationId: x.declarationId } }; }}),
    tool({ name: "world_visibility_close", label: "World Visibility Close", description: "闭合可见性声明：撤销某角色对某声明的可见性", parameters: Type.Object({ characterId: Type.String(), declarationId: Type.String(), storyTime: storyTimeOpt }), promptSnippet: "撤销角色声明可见性", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.closeVisibility(x.characterId, x.declarationId, st); return { content: [{ type: "text", text: `可见性已撤销：${x.characterId} -✗-> ${x.declarationId} @ ${st}` }], details: { ok: true, characterId: x.characterId, declarationId: x.declarationId, storyTime: st } }; }}),
    tool({ name: "world_visibility_infer", label: "World Visibility Infer", description: "从 located_in 关系推断所有角色的可见性", parameters: Type.Object({ storyTime: storyTimeOpt }), promptSnippet: "推断角色可见性", execute: async (p, x: any) => { const st = resolveStoryTime(p, x.storyTime); await p.wg.inferVisibility(st); return { content: [{ type: "text", text: `可见性推断完成 @ ${st}` }], details: { ok: true, storyTime: st } }; }}),
    tool({ name: "world_query", label: "World Query", description: "检索实体（默认 hybrid 混合检索）", parameters: Type.Object({ query: Type.String(), topK: Type.Optional(Type.Number()), typeFilter: Type.Optional(entityType), storyTime: storyTimeOpt, mode: Type.Optional(Type.Union([Type.Literal("fulltext"), Type.Literal("vector"), Type.Literal("hybrid")])) }), promptSnippet: "检索世界图实体", execute: async (p, x: any) => { const results = await p.search.search(x.query, { topK: x.topK, typeFilter: x.typeFilter, storyTime: resolveStoryTime(p, x.storyTime), mode: x.mode }); return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results, count: results.length } }; }}),
    tool({ name: "world_story_times", label: "World Story Times", description: "列出所有出现过的 storyTime（去重升序），供 storyTime 快照选择器使用", parameters: Type.Object({}), promptSnippet: "列出世界图故事时间点", execute: async p => { const storyTimes = await p.wg.listStoryTimes(); return { content: [{ type: "text", text: JSON.stringify(storyTimes) }], details: { storyTimes, count: storyTimes.length } }; }}),
  ];
}
