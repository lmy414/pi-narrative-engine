/**
 * index.ts — narrative-engine 的 pi 扩展入口（V2）
 *
 * 职责：
 * - session_start 时初始化 WorldGraph / Embedder / Search
 * - 注册 13 个 world_* 工具供主会话/scheduler 调用
 * - session_shutdown 时关闭 WorldGraph
 * - 管理 session 级 currentStoryTime
 *
 * 工具集（V2，13 个）：
 *   生命周期：session_start / session_shutdown（pi.on，非 registerTool）
 *   查询类：world_status / world_query / world_entity_get / world_relations / world_event_chain / world_character_view
 *   写入类：world_entity_create / world_entity_kill / world_relation_add / world_relation_close / world_event_apply
 *   可见性：world_visibility_set / world_visibility_infer
 *
 * 存储路径：<cwd>/.pi/world-graph-v2/
 *
 * 主会话不参与叙事原则：
 * - 这些工具只暴露世界图 CRUD 与检索，不内置剧情生成逻辑
 * - 剧情推进由 scheduler 通过 world_event_apply 调用
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { WorldGraph } from "@pi/world-graph";
import { Embedder } from "./embedder.ts";
import { Search } from "./search.ts";

// ============================================================================
// 模块级状态（每次 session_start 重建）
// ============================================================================

let wg: WorldGraph | null = null;
let embedder: Embedder | null = null;
let search: Search | null = null;
let currentStoryTime: string | null = null;

/** 测试辅助：获取内部状态 */
export function getState() {
  return { wg, embedder, search, currentStoryTime };
}

/** 工具调用前调用，确保已初始化 */
function requireWg(): WorldGraph {
  if (!wg) throw new Error("WorldGraph not initialized (session_start not fired?)");
  return wg;
}

function requireSearch(): Search {
  if (!search) throw new Error("Search not initialized (session_start not fired?)");
  return search;
}

/** 解析 storyTime：优先用参数，否则用 currentStoryTime */
function resolveStoryTime(explicit?: string): string {
  if (explicit) return explicit;
  if (currentStoryTime) return currentStoryTime;
  throw new Error("storyTime required (call world_event_apply first or pass storyTime explicitly)");
}

/** 默认存储路径：<cwd>/.pi/world-graph-v2/ */
function resolveWorldGraphDir(cwd: string): string {
  return path.join(cwd, ".pi", "world-graph-v2");
}

// ============================================================================
// 入口
// ============================================================================

export default function (pi: ExtensionAPI) {
  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const dir = resolveWorldGraphDir(ctx.cwd);
    await fs.mkdir(dir, { recursive: true });
    wg = await WorldGraph.create({
      dbPath: path.join(dir, "world.db"),
      eventLogPath: path.join(dir, "events.jsonl"),
    });
    embedder = new Embedder();
    search = new Search(wg, embedder);
    currentStoryTime = null;
    ctx.ui.notify(`[narrative-engine] 已初始化世界图: ${dir}`, "info");
  });

  pi.on("session_shutdown", async () => {
    if (wg) {
      try {
        wg.close();
      } catch {
        // 忽略关闭错误
      }
    }
    wg = null;
    embedder = null;
    search = null;
    currentStoryTime = null;
  });

  // --------------------------------------------------------------------------
  // 工具：world_status（状态摘要）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_status",
    label: "World Status",
    description:
      "获取世界图状态摘要（currentStoryTime / 实体数 / 事件数 / 关系数）。无需参数。",
    promptSnippet: "查看世界图当前状态（storyTime/实体数）",
    parameters: Type.Object({}),
    async execute() {
      const g = requireWg();
      const st = currentStoryTime ?? "Infinity";
      const entities = await g.getAllEntities(st);
      const events = await g.getAllEvents();
      const status = {
        currentStoryTime,
        entityCount: entities.length,
        eventCount: events.length,
      };
      const text = [
        `currentStoryTime: ${currentStoryTime ?? "(未设置)"}`,
        `实体数: ${status.entityCount}`,
        `事件数: ${status.eventCount}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { status },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 实体工具（3 个）
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
      const g = requireWg();
      await g.birthEntity(
        params.entityId,
        params.type,
        params.initialProps ?? {},
        params.storyTime,
      );
      currentStoryTime = params.storyTime;
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
      const g = requireWg();
      await g.killEntity(params.entityId, params.storyTime);
      currentStoryTime = params.storyTime;
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
    description: "获取实体快照（bi-temporal）",
    parameters: Type.Object({
      entityId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
      const snap = await g.getEntityAt(params.entityId, st);
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

  // --------------------------------------------------------------------------
  // 关系工具（3 个）
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
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
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
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
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
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
      const rels = await g.getRelations(params.entityId, st);
      return {
        content: [{ type: "text", text: JSON.stringify(rels) }],
        details: { relations: rels },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 事件工具（2 个）
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
      }),
    }),
    async execute(_id, params) {
      const g = requireWg();
      await g.processEvent(params.event);
      currentStoryTime = params.event.storyTime;
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
      const g = requireWg();
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
  // 可见性工具（3 个）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "world_character_view",
    label: "World Character View",
    description: "获取角色视角（五步过滤后的可见声明）",
    parameters: Type.Object({
      characterId: Type.String(),
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
      const view = await g.getCharacterView(params.characterId, st);
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
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
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
    name: "world_visibility_infer",
    label: "World Visibility Infer",
    description: "从 located_in 关系推断所有角色的可见性",
    parameters: Type.Object({
      storyTime: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
      await g.inferVisibility(st);
      const details = { ok: true, storyTime: st };
      return {
        content: [{ type: "text", text: `可见性推断完成 @ ${st}` }],
        details,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 查询工具（1 个）
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
      const s = requireSearch();
      const st = resolveStoryTime(params.storyTime);
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
}
