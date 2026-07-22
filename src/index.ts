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
  // 工具：world_status（本 Task 仅注册此一个，其余在 Task 4-8）
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
      // EventLog.readAll 存在但 WorldGraph 未公开暴露 eventLog（私有字段）
      // eventCount 留待 Task 6 在 world_event_apply 实现时补充
      // relationCount 同理（遍历实体调 getRelations 低效，留 Task 6 完善）
      const status = {
        currentStoryTime,
        entityCount: entities.length,
      };
      const text = [
        `currentStoryTime: ${currentStoryTime ?? "(未设置)"}`,
        `实体数: ${status.entityCount}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { status },
      };
    },
  });
}
