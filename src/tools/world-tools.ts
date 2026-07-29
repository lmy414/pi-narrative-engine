/**
 * world-tools.ts — world_graph 工具域注册
 *
 * 注册 18 个 world_* 工具（CRUD + 检索 + 可见性 + 视角 + 历史快照）。
 * 不含叙事生成逻辑（剧情推进由 scheduler 负责）。
 *
 * 工具清单：
 *   状态：world_status
 *   实体：world_entity_create / world_entity_kill / world_entity_get /
 *         world_entity_update_summary / world_entity_history
 *   关系：world_relation_add / world_relation_close / world_relations /
 *         world_relation_history
 *   事件：world_event_apply / world_event_chain
 *   可见性：world_character_view / world_visibility_set / world_visibility_close /
 *           world_visibility_infer
 *   查询：world_query / world_story_times
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type SessionState,
  requireWg,
  requireSearch,
  resolveStoryTime,
} from "../session-state.ts";
import { updateMemory } from "../memory.ts";

export function registerWorldTools(pi: ExtensionAPI, state: SessionState): void {
  // --------------------------------------------------------------------------
  // 状态摘要
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_status",
    label: "World Status",
    description:
      "获取世界图状态摘要（currentStoryTime / 实体数 / 事件数 / 关系数）。无需参数。",
    promptSnippet: "查看世界图当前状态（storyTime/实体数）",
    parameters: Type.Object({}),
    async execute() {
      const g = requireWg(state);
      // currentStoryTime 未设置时用最新 storyTime（审计修复："Infinity" 是 validTo
      // 哨兵值不是真实时刻，字符串比较 'I' < 'c' 会导致 ch* 时刻的实体被全部排除）
      let st = state.currentStoryTime;
      if (!st) {
        const times = await g.listStoryTimes();
        st = times.length > 0 ? times[times.length - 1] : "Infinity";
      }
      const entities = await g.getAllEntities(st);
      const events = await g.getAllEvents();
      const recordedNow = await g.recordedNow();
      const status = {
        currentStoryTime: state.currentStoryTime,
        entityCount: entities.length,
        eventCount: events.length,
        recordedNow,
      };
      const text = [
        `currentStoryTime: ${state.currentStoryTime ?? "(未设置)"}`,
        `统计时刻: ${st}`,
        `实体数: ${status.entityCount}`,
        `事件数: ${status.eventCount}`,
        `recordedNow: ${recordedNow ?? "(空图)"}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { status },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 实体工具
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_entity_create",
    label: "World Entity Create",
    description: "创建实体（诞生）",
    parameters: Type.Object({
      entityId: Type.String(),
      type: Type.Union([
        Type.Literal("character"),
        Type.Literal("location"),
        Type.Literal("item"),
        Type.Literal("concept"),
      ]),
      initialProps: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      storyTime: Type.String(),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      await g.birthEntity(
        params.entityId,
        params.type,
        params.initialProps ?? {},
        params.storyTime,
      );
      state.currentStoryTime = params.storyTime;
      const details = { ok: true, entityId: params.entityId };
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 已创建（${params.type}）@ ${params.storyTime}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_entity_kill",
    label: "World Entity Kill",
    description: "消亡实体",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.String(),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      await g.killEntity(params.entityId, params.storyTime);
      state.currentStoryTime = params.storyTime;
      const details = { ok: true, entityId: params.entityId };
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 已消亡 @ ${params.storyTime}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_entity_get",
    label: "World Entity Get",
    description: "获取实体快照（bi-temporal：storyTime=故事时间轴，recordedAsOf=事务时间轴）",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.Optional(Type.String()),
      recordedAsOf: Type.Optional(Type.String({
        description: "事务时间坐标（world_status 返回的 recordedNow 历史值）。传入后只含该时点之前写入的内容（retcon 隔离）",
      })),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      const snap = await g.getEntityAt(params.entityId, st, { recordedAsOf: params.recordedAsOf });
      return {
        content: [{
          type: "text" as const,
          text: snap ? JSON.stringify(snap) : `未找到实体 ${params.entityId} @ ${st}`,
        }],
        details: {
          entityId: params.entityId,
          storyTime: st,
          snapshot: snap,
          error: snap ? null : "Entity not found at given storyTime",
        },
      };
    },
  });

  pi.registerTool({
    name: "world_entity_update_summary",
    label: "World Entity Update Summary",
    description: "更新实体摘要（作者可见的元信息，纯展示字段，不参与时态/检索/可见性）",
    parameters: Type.Object({
      entityId: Type.String(),
      summary: Type.String(),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      await g.updateEntitySummary(params.entityId, params.summary);
      const details = { ok: true, entityId: params.entityId, summary: params.summary };
      return {
        content: [{ type: "text", text: `实体 ${params.entityId} 摘要已更新` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_entity_history",
    label: "World Entity History",
    description: "查询单个实体的全部版本（含已闭合记录），按 validFrom 升序。返回 Entity 记录数组 + 全部 Fact（含历史）",
    parameters: Type.Object({
      entityId: Type.String(),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const history = await g.getEntityHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(history) }],
        details: history,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 关系工具
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_relation_add",
    label: "World Relation Add",
    description: "创建关系",
    parameters: Type.Object({
      sourceId: Type.String(),
      targetId: Type.String(),
      label: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      await g.addRelation(params.sourceId, params.targetId, params.label, st);
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系 ${params.sourceId} -[${params.label}]-> ${params.targetId} 已创建 @ ${st}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_relation_close",
    label: "World Relation Close",
    description: "闭合关系",
    parameters: Type.Object({
      sourceId: Type.String(),
      targetId: Type.String(),
      label: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      await g.closeRelation(params.sourceId, params.targetId, params.label, st);
      const details = { ok: true, sourceId: params.sourceId, targetId: params.targetId, label: params.label };
      return {
        content: [{ type: "text", text: `关系 ${params.sourceId} -[${params.label}]-> ${params.targetId} 已闭合 @ ${st}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_relations",
    label: "World Relations",
    description: "列出实体的关系",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      const rels = await g.getRelations(params.entityId, st);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels },
      };
    },
  });

  pi.registerTool({
    name: "world_relation_history",
    label: "World Relation History",
    description: "查询关系历史（含已闭合）。不传 entityId 返回全部关系",
    parameters: Type.Object({
      entityId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const history = await g.getRelationHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(history) }],
        details: { relations: history, count: history.length },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 事件工具
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_event_apply",
    label: "World Event Apply",
    description: "应用事件到世界图",
    parameters: Type.Object({
      event: Type.Object({
        eventId: Type.String(),
        type: Type.Union([
          Type.Literal("birth"),
          Type.Literal("death"),
          Type.Literal("change"),
        ]),
        storyTime: Type.String(),
        entityId: Type.String(),
        source: Type.Optional(Type.Union([
          Type.Literal("engine"),
          Type.Literal("user"),
        ])),
        entityType: Type.Optional(Type.Union([
          Type.Literal("character"),
          Type.Literal("location"),
          Type.Literal("item"),
          Type.Literal("concept"),
        ])),
        summary: Type.Optional(Type.String()),
        newFacts: Type.Optional(Type.Array(Type.Object({
          entityId: Type.String(),
          property: Type.String(),
          value: Type.Unknown(),
          modality: Type.Union([
            Type.Literal("fact"),
            Type.Literal("belief"),
            Type.Literal("hypothesis"),
          ]),
        }))),
        invalidated: Type.Optional(Type.Array(Type.Object({
          declarationId: Type.String(),
          property: Type.String(),
        }))),
        causedBy: Type.Optional(Type.String()),
        userInput: Type.Optional(Type.String({
          description: "用户口述原文（写入事件日志，供项目记忆展示）",
        })),
      }),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      await g.processEvent(params.event);
      state.currentStoryTime = params.event.storyTime;
      // 更新项目记忆（失败不阻断事件应用）
      try {
        await updateMemory(g, state.sessionCwd ?? process.cwd());
      } catch (err) {
        console.warn(`[narrative-engine] 更新项目记忆失败: ${err}`);
      }
      const details = { ok: true, eventId: params.event.eventId, type: params.event.type };
      return {
        content: [{ type: "text", text: `事件 ${params.event.eventId}（${params.event.type}）已应用 @ ${params.event.storyTime}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_event_chain",
    label: "World Event Chain",
    description: "获取事件链（按 storyTime 升序）。可传 eventId 进行因果回溯",
    parameters: Type.Object({
      eventId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const events = params.eventId
        ? await g.traceCauses(params.eventId)
        : await g.getAllEvents();
      return {
        content: [{ type: "text", text: JSON.stringify(events) }],
        details: { events, count: events.length },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 可见性工具
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_character_view",
    label: "World Character View",
    description: "获取角色视角（五步过滤后的可见声明；recordedAsOf 可做事务时间隔离）",
    parameters: Type.Object({
      characterId: Type.String(),
      storyTime: Type.Optional(Type.String()),
      recordedAsOf: Type.Optional(Type.String({
        description: "事务时间坐标。传入后角色视角只含该时点之前写入的内容（retcon 隔离）",
      })),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      const view = await g.getCharacterView(params.characterId, st, { recordedAsOf: params.recordedAsOf });
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        details: { view, count: view.length },
      };
    },
  });

  pi.registerTool({
    name: "world_visibility_set",
    label: "World Visibility Set",
    description: "显式设置角色对某声明的可见性",
    parameters: Type.Object({
      characterId: Type.String(),
      declarationId: Type.String(),
      confidence: Type.Number(),
      source: Type.String(),
      isExplicit: Type.Boolean(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      await g.setVisibility(params.characterId, params.declarationId, {
        state: "known",
        confidence: params.confidence,
        source: params.source,
        validFrom: st,
        isExplicit: params.isExplicit,
      });
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId };
      return {
        content: [{ type: "text", text: `可见性已设置：${params.characterId} -> ${params.declarationId}（confidence=${params.confidence}）@ ${st}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_visibility_close",
    label: "World Visibility Close",
    description: "闭合可见性声明：撤销某角色对某声明的可见性",
    parameters: Type.Object({
      characterId: Type.String(),
      declarationId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      await g.closeVisibility(params.characterId, params.declarationId, st);
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId, storyTime: st };
      return {
        content: [{ type: "text", text: `可见性已撤销：${params.characterId} -✗-> ${params.declarationId} @ ${st}` }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "world_visibility_infer",
    label: "World Visibility Infer",
    description: "从 located_in 关系推断所有角色的可见性",
    parameters: Type.Object({
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const st = resolveStoryTime(state, params.storyTime);
      await g.inferVisibility(st);
      const details = { ok: true, storyTime: st };
      return {
        content: [{ type: "text", text: `可见性推断完成 @ ${st}` }],
        details,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 查询工具
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_query",
    label: "World Query",
    description: "检索实体（默认 hybrid 混合检索）",
    parameters: Type.Object({
      query: Type.String(),
      topK: Type.Optional(Type.Number()),
      typeFilter: Type.Optional(Type.Union([
        Type.Literal("character"),
        Type.Literal("location"),
        Type.Literal("item"),
        Type.Literal("concept"),
      ])),
      storyTime: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([
        Type.Literal("fulltext"),
        Type.Literal("vector"),
        Type.Literal("hybrid"),
      ])),
    }),
    async execute(_id, params) {
      const s = requireSearch(state);
      const st = resolveStoryTime(state, params.storyTime);
      const results = await s.search(params.query, {
        topK: params.topK,
        typeFilter: params.typeFilter,
        storyTime: st,
        mode: params.mode,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { results, count: results.length },
      };
    },
  });

  pi.registerTool({
    name: "world_story_times",
    label: "World Story Times",
    description: "列出所有出现过的 storyTime（去重升序），供 storyTime 快照选择器使用",
    parameters: Type.Object({}),
    async execute() {
      const g = requireWg(state);
      const times = await g.listStoryTimes();
      return {
        content: [{ type: "text", text: JSON.stringify(times) }],
        details: { storyTimes: times, count: times.length },
      };
    },
  });
}
