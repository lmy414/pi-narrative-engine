/**
 * index.ts — narrative-engine 的 pi 扩展入口（V2）
 *
 * 职责：
 * - session_start 时初始化 WorldGraph / Embedder / Search
 * - 注册 27 个工具（18 个 world_* + open_visualizer + import_novel + 5 个 render_* + 2 个 role_*）供主会话/scheduler/前端调用
 * - session_shutdown 时关闭 WorldGraph 与可视化服务
 * - 管理 session 级 currentStoryTime
 *
 * 工具集（V2，27 个，含 role_*）：
 *   生命周期：session_start / session_shutdown（pi.on，非 registerTool）
 *   查询类：world_status / world_query / world_entity_get / world_entity_history / world_relations / world_relation_history / world_event_chain / world_character_view / world_story_times
 *   写入类：world_entity_create / world_entity_kill / world_entity_update_summary / world_relation_add / world_relation_close / world_event_apply
 *   可见性：world_visibility_set / world_visibility_close / world_visibility_infer
 *   可视化：open_visualizer
 *   导入：import_novel
 *   渲染：render_append / render_modify / render_preview / render_check / render_rule_set
 *   角色池：role_interact / role_rule_set
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
import { startVisualizer } from "./visualizer/server.ts";
import type { VisualizerServer } from "./visualizer/server.ts";
import { runImportPipeline } from "@pi/novel-importer";
import {
  loadRuleSet,
  renderToFile,
  renderText,
  readChapter,
  type RenderFileCommand,
  type RenderTextCommand,
  type RoleOutput,
} from "@pi/renderer";
import { makeRendererLlmCaller } from "./renderer-llm.ts";
import { checkNarrative } from "./checker.ts";
import { interact as roleInteract, loadRoleRuleSet } from "@pi/role-pool";
import { makeRoleLlmCaller } from "./role-pool-llm.ts";

// ============================================================================
// 模块级状态（每次 session_start 重建）
// ============================================================================

let wg: WorldGraph | null = null;
let embedder: Embedder | null = null;
let search: Search | null = null;
let currentStoryTime: string | null = null;
let visualizerServer: VisualizerServer | null = null;
/** session_start 时记录 cwd，供 import_novel 等工具默认 worldGraphDir 使用 */
let sessionCwd: string | null = null;

/** 渲染器 LLM 配置（从环境变量读取） */
function getRendererLlmConfig(): { model: string; apiKey: string } {
  const model = process.env.PI_RENDERER_MODEL ?? process.env.PI_MODEL ?? "deepseek-chat";
  const apiKey = process.env.PI_RENDERER_API_KEY ?? process.env.PI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("渲染器 LLM apiKey 未配置（设置 PI_RENDERER_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）");
  }
  return { model, apiKey };
}

/** 角色池 LLM 配置（从环境变量读取） */
function getRoleLlmConfig(): { model: string; apiKey: string } {
  const model = process.env.PI_ROLE_MODEL ?? process.env.PI_MODEL ?? "deepseek-chat";
  const apiKey = process.env.PI_ROLE_API_KEY ?? process.env.PI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("角色池 LLM apiKey 未配置（设置 PI_ROLE_API_KEY / PI_API_KEY / DEEPSEEK_API_KEY 环境变量）");
  }
  return { model, apiKey };
}

/** 角色池结构化输出 schema（render_append / render_modify / render_preview 共用） */
const RoleOutputSchema = Type.Array(Type.Object({
  actor: Type.String(),
  action: Type.String(),
  target: Type.Optional(Type.String()),
  emotion: Type.Optional(Type.String()),
  relation_update: Type.Optional(Type.Array(Type.Object({
    target: Type.String(),
    label: Type.String(),
  }))),
  thought: Type.Optional(Type.String()),
  knowledge_gained: Type.Optional(Type.Array(Type.String())),
}));

/** 测试辅助：获取内部状态 */
export function getState() {
  return { wg, embedder, search, currentStoryTime, visualizerServer, sessionCwd };
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

function requireEmbedder(): Embedder {
  if (!embedder) throw new Error("Embedder not initialized (session_start not fired?)");
  return embedder;
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
    sessionCwd = ctx.cwd;
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
    if (visualizerServer) {
      try {
        visualizerServer.close();
      } catch {
        // 忽略关闭错误
      }
      visualizerServer = null;
    }
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
    sessionCwd = null;
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
      const g = requireWg();
      const st = resolveStoryTime(params.storyTime);
      await g.closeVisibility(params.characterId, params.declarationId, st);
      const details = { ok: true, characterId: params.characterId, declarationId: params.declarationId, storyTime: st };
      return {
        content: [{ type: "text", text: `可见性已撤销：${params.characterId} -✗-> ${params.declarationId} @ ${st}` }],
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

  pi.registerTool({
    name: "world_entity_update_summary",
    label: "World Entity Update Summary",
    description: "更新实体摘要（作者可见的元信息，纯展示字段，不参与时态/检索/可见性）",
    parameters: Type.Object({
      entityId: Type.String(),
      summary: Type.String(),
    }),
    async execute(_id, params) {
      const g = requireWg();
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
      const g = requireWg();
      const history = await g.getEntityHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(history) }],
        details: history,
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
      const g = requireWg();
      const history = await g.getRelationHistory(params.entityId);
      return {
        content: [{ type: "text", text: JSON.stringify(history) }],
        details: { relations: history, count: history.length },
      };
    },
  });

  pi.registerTool({
    name: "world_story_times",
    label: "World Story Times",
    description: "列出所有出现过的 storyTime（去重升序），供 storyTime 快照选择器使用",
    parameters: Type.Object({}),
    async execute() {
      const g = requireWg();
      const times = await g.listStoryTimes();
      return {
        content: [{ type: "text", text: JSON.stringify(times) }],
        details: { storyTimes: times, count: times.length },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 可视化工具（1 个）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "open_visualizer",
    label: "Open Visualizer",
    description:
      "启动 world-graph 可视化服务（幂等：已启动则直接返回现有 URL）。可选 port 参数，缺省 7421。",
    promptSnippet: "启动世界图可视化页面",
    parameters: Type.Object({
      port: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const g = requireWg();
      type Details = {
        ok: boolean;
        url?: string;
        port?: number;
        alreadyRunning?: boolean;
        error?: string;
      };
      if (visualizerServer) {
        const details: Details = {
          ok: true,
          url: visualizerServer.url,
          port: visualizerServer.port,
          alreadyRunning: true,
        };
        return {
          content: [{ type: "text", text: `可视化服务已在运行: ${visualizerServer.url}` }],
          details,
        };
      }
      try {
        visualizerServer = await startVisualizer({
          wg: g,
          search,
          ...(params.port !== undefined ? { port: params.port } : {}),
        });
      } catch (err) {
        const message = `可视化服务启动失败：${(err as Error).message}（可尝试更换 port 参数）`;
        const details: Details = { ok: false, error: message };
        return {
          content: [{ type: "text", text: message }],
          details,
        };
      }
      const details: Details = {
        ok: true,
        url: visualizerServer.url,
        port: visualizerServer.port,
        alreadyRunning: false,
      };
      return {
        content: [{ type: "text", text: `可视化服务已启动: ${visualizerServer.url}` }],
        details,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 导入工具（1 个）— V3 小说导入管道
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "import_novel",
    label: "Import Novel",
    description:
      "从 EPUB 文件导入小说到世界图（V3）。执行 8 阶段管道：EPUB分章→实体预扫描→章节事件流→实体消解→关系抽取→可见性推断→写入world-graph→向量补齐+校验。内部并行 spawn 多个 LLM 子代理处理各章节。长时间运行任务（11章约10分钟）。",
    promptSnippet: "导入小说到世界图（V3，全自动 8 阶段管道）",
    parameters: Type.Object({
      epubPath: Type.String({ description: "EPUB 文件绝对路径" }),
      worldGraphDir: Type.Optional(Type.String({
        description: "world-graph 存储目录（缺省 <cwd>/.pi/world-graph-v3/）",
      })),
      chapters: Type.Optional(Type.Array(Type.Integer(), {
        description: "限定导入章节（1-based），缺省全部",
      })),
      model: Type.Optional(Type.String({
        description: "LLM 模型名（缺省用 pi 配置或环境变量 PI_MODEL）",
      })),
      apiKey: Type.Optional(Type.String({
        description: "LLM API key（缺省读环境变量 DEEPSEEK_API_KEY 或 PI_API_KEY）",
      })),
      concurrency: Type.Optional(Type.Integer({
        description: "章节并行限流（缺省 3）",
        minimum: 1,
        maximum: 10,
      })),
      resumeFromStage: Type.Optional(Type.Integer({
        description: "从指定阶段恢复（1-8，缺省从1开始）",
        minimum: 1,
        maximum: 8,
      })),
    }),
    async execute(_id, params) {
      // 复用已实例化的 Embedder（Xenova/bge-small-zh-v1.5, 512 维）
      // 注入到 runImportPipeline 供 reembedAll 使用
      const emb = requireEmbedder();

      const result = await runImportPipeline({
        epubPath: params.epubPath,
        worldGraphDir: params.worldGraphDir,
        chapters: params.chapters,
        model: params.model,
        apiKey: params.apiKey,
        concurrency: params.concurrency,
        resumeFromStage: params.resumeFromStage,
        cwd: sessionCwd ?? process.cwd(),
        embedder: emb, // 注入 TextEmbedder（Embedder.embed 满足接口）
      });

      const text = [
        `导入完成：`,
        `  实体数: ${result.entityCount}`,
        `  事件数: ${result.eventCount}`,
        `  关系数: ${result.relationCount}`,
        `  可见性数: ${result.visibilityCount}`,
        `  存储目录: ${result.worldGraphDir}`,
        `  dump 文件: ${result.dumpPath}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 渲染器工具（5 个）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "render_append",
    label: "Render Append",
    description:
      "渲染叙事事件并追加到章节文件（append 模式）。读取已有章节全文做上下文，LLM 生成正文后追加到文件末尾。",
    promptSnippet: "渲染事件并追加到章节",
    parameters: Type.Object({
      chapterPath: Type.String({ description: "目标章节文件绝对路径" }),
      eventId: Type.String({ description: "本次渲染对应的事件 ID" }),
      storyTime: Type.String({ description: "故事时间（如 ch-2）" }),
      instruction: Type.String({ description: "叙事指令（自然语言）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRendererLlmConfig();
      const llm = makeRendererLlmCaller(model, apiKey);
      const ruleSet = await loadRuleSet(sessionCwd ?? process.cwd());

      const cmd: RenderFileCommand = {
        mode: "append",
        chapterPath: params.chapterPath,
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
      };

      const result = await renderToFile(cmd, { llm, ruleSet });

      const text = result.ok
        ? `已渲染事件 ${params.eventId} 到 ${params.chapterPath}（append）`
        : `渲染失败：${result.error}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "render_modify",
    label: "Render Modify",
    description:
      "重写章节文件中指定事件锚点区间的文本（modify 模式）。读取锚点区间+上下文，LLM 重新生成后替换原内容。",
    promptSnippet: "重写章节中指定事件的文本",
    parameters: Type.Object({
      chapterPath: Type.String({ description: "目标章节文件绝对路径" }),
      eventId: Type.String({ description: "本次渲染对应的事件 ID（用于记录）" }),
      modifyAnchorEventId: Type.String({ description: "要重写的目标事件 ID" }),
      storyTime: Type.String({ description: "故事时间" }),
      instruction: Type.String({ description: "叙事指令（描述重写方向）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRendererLlmConfig();
      const llm = makeRendererLlmCaller(model, apiKey);
      const ruleSet = await loadRuleSet(sessionCwd ?? process.cwd());

      const cmd: RenderFileCommand = {
        mode: "modify",
        chapterPath: params.chapterPath,
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
        modifyAnchorEventId: params.modifyAnchorEventId,
      };

      const result = await renderToFile(cmd, { llm, ruleSet });

      const text = result.ok
        ? `已重写事件 ${params.modifyAnchorEventId} 的文本（modify）`
        : `重写失败：${result.error}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "render_preview",
    label: "Render Preview",
    description:
      "预览渲染结果（不写入文件）。传入叙事指令和角色池数据，返回 LLM 生成的文本。可传 chapterPath 读取已有章节做上下文。",
    promptSnippet: "预览渲染结果（不写文件）",
    parameters: Type.Object({
      chapterPath: Type.Optional(Type.String({ description: "章节文件路径（用于读取上下文，不写文件）" })),
      eventId: Type.String({ description: "本次渲染对应的事件 ID" }),
      storyTime: Type.String({ description: "故事时间（如 ch-2）" }),
      instruction: Type.String({ description: "叙事指令（自然语言）" }),
      payload: RoleOutputSchema,
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRendererLlmConfig();
      const llm = makeRendererLlmCaller(model, apiKey);
      const ruleSet = await loadRuleSet(sessionCwd ?? process.cwd());

      let context = "";
      let contextWarning: string | undefined;
      if (params.chapterPath) {
        try {
          context = await readChapter(params.chapterPath);
        } catch (err) {
          contextWarning = `上下文读取失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const cmd: RenderTextCommand = {
        mode: "append",
        eventId: params.eventId,
        storyTime: params.storyTime,
        instruction: params.instruction,
        payload: params.payload as RoleOutput[],
        context,
      };

      const text = await renderText(cmd, { llm, ruleSet });

      return {
        content: [{ type: "text", text }],
        details: { ok: true, eventId: params.eventId, preview: true, contextWarning },
      };
    },
  });

  pi.registerTool({
    name: "render_check",
    label: "Render Check",
    description:
      "检验章节文本是否符合规则集。支持 latest（最新事件）/chapter（整章）/range（区间）/full（全文，需 chapterPath）。返回违规清单和修改建议。文本量过大时由主会话拆分多次调用。",
    promptSnippet: "检查章节文本是否符合规则集",
    parameters: Type.Object({
      target: Type.Union([
        Type.Literal("latest"),
        Type.Literal("chapter"),
        Type.Literal("range"),
        Type.Literal("full"),
      ]),
      chapterPath: Type.Optional(Type.String({ description: "章节文件路径" })),
      startEventId: Type.Optional(Type.String({ description: "target=range 时起点" })),
      endEventId: Type.Optional(Type.String({ description: "target=range 时终点（不包含）" })),
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRendererLlmConfig();
      const llm = makeRendererLlmCaller(model, apiKey);
      const ruleSet = await loadRuleSet(sessionCwd ?? process.cwd());

      const result = await checkNarrative(
        {
          target: params.target,
          chapterPath: params.chapterPath,
          startEventId: params.startEventId,
          endEventId: params.endEventId,
        },
        { llm, ruleSet },
      );

      const text = result.error
        ? `检验出错：${result.error}`
        : result.violations.length > 0
        ? `发现 ${result.violations.length} 处违规`
        : "检查通过，无违规";
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "render_rule_set",
    label: "Render Rule Set",
    description: "查看当前规则集.md 内容。无需参数。",
    promptSnippet: "查看规则集内容",
    parameters: Type.Object({}),
    async execute() {
      const ruleSet = await loadRuleSet(sessionCwd ?? process.cwd());
      return {
        content: [{ type: "text", text: ruleSet || "（规则集.md 不存在或为空）" }],
        details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 },
      };
    },
  });

  // --------------------------------------------------------------------------
  // 角色池工具（2 个）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "role_interact",
    label: "Role Interact",
    description:
      "角色池串行演绎：按 cast 顺序逐个调用角色代理 LLM，后动者可见先动者的公开 action（不含 thought/emotion/state_changes）。返回 RoleAgentOutput[]（8 字段）+ 失败记录。调度器据此提取 state_changes 写扩散、投影为 RoleOutput[] 传渲染器。",
    promptSnippet: "角色池演出（串行可见行动，返回结构化输出）",
    parameters: Type.Object({
      eventInstruction: Type.String({ description: "事件指令（自然语言）" }),
      storyTime: Type.String({ description: "故事时间（如 ch-2）" }),
      cast: Type.Array(Type.Object({
        characterId: Type.String({ description: "角色实体 ID" }),
        staticCard: Type.Record(Type.String(), Type.Unknown(), {
          description: "静态层：酒馆角色卡 JSON（name/description/personality 等）",
        }),
        dynamicFacts: Type.Array(Type.Object({
          declarationId: Type.String(),
          entityId: Type.String(),
          property: Type.String(),
          value: Type.Unknown(),
          valueText: Type.Optional(Type.String()),
          modality: Type.Union([
            Type.Literal("fact"),
            Type.Literal("belief"),
            Type.Literal("hypothesis"),
          ]),
          validFrom: Type.String(),
        }), { description: "动态层：角色当前可见的状态声明（调度器通过 world_character_view 预取）" }),
      }), { description: "演员表，按出场顺序排列" }),
    }),
    async execute(_id, params) {
      const { model, apiKey } = getRoleLlmConfig();
      const llm = makeRoleLlmCaller(model, apiKey);
      const ruleSet = await loadRoleRuleSet(sessionCwd ?? process.cwd());

      const result = await roleInteract(
        {
          eventInstruction: params.eventInstruction,
          storyTime: params.storyTime,
          cast: params.cast as Parameters<typeof roleInteract>[0]["cast"],
        },
        { llm, ruleSet },
      );

      const text = result.errors.length > 0
        ? `角色池演出完成：${result.outputs.length} 成功，${result.errors.length} 失败`
        : `角色池演出完成：${result.outputs.length} 个角色输出`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "role_rule_set",
    label: "Role Rule Set",
    description: "查看当前角色规则集.md 内容。无需参数。",
    promptSnippet: "查看角色规则集内容",
    parameters: Type.Object({}),
    async execute() {
      const ruleSet = await loadRoleRuleSet(sessionCwd ?? process.cwd());
      return {
        content: [{ type: "text", text: ruleSet || "（角色规则集.md 不存在或为空）" }],
        details: { ok: true, length: ruleSet.length, exists: ruleSet.length > 0 },
      };
    },
  });
}
