/**
 * session-state.ts — session 级状态容器与共享工具
 *
 * 设计：把原 src/index.ts 顶层的模块级状态（wg/embedder/search/...）
 * 封装为可变对象引用，便于拆分到 src/tools/*.ts 的各 register 函数共享。
 *
 * - state 对象在 module 级创建一次（singleton）
 * - 字段在 session_start 时填充，session_shutdown 时清空
 * - 各 register<Domain>Tools 持有同一 state 引用，读最新字段值
 */

import path from "node:path";
import type { WorldGraph } from "underworld-graph";
import type { Embedder } from "./embedder.ts";
import type { Search } from "./search.ts";
import type { VisualizerServer } from "./visualizer/server.ts";
import type { DebugBus } from "./debug/bus.ts";

/**
 * session 级状态。
 * 所有字段在 session_start 时填充；session_shutdown 时清空为 null。
 */
export interface SessionState {
  wg: WorldGraph | null;
  embedder: Embedder | null;
  search: Search | null;
  currentStoryTime: string | null;
  visualizerServer: VisualizerServer | null;
  debugBus: DebugBus | null;
  /** session_start 时记录 cwd，供 import_novel 等工具默认 worldGraphDir 使用 */
  sessionCwd: string | null;
}

/** 创建初始空状态（全部字段 null） */
export function createSessionState(): SessionState {
  return {
    wg: null,
    embedder: null,
    search: null,
    currentStoryTime: null,
    visualizerServer: null,
    debugBus: null,
    sessionCwd: null,
  };
}

/** 工具调用前调用，确保 WorldGraph 已初始化 */
export function requireWg(state: SessionState): WorldGraph {
  if (!state.wg) throw new Error("WorldGraph not initialized (session_start not fired?)");
  return state.wg;
}

/** 工具调用前调用，确保 Search 已初始化 */
export function requireSearch(state: SessionState): Search {
  if (!state.search) throw new Error("Search not initialized (session_start not fired?)");
  return state.search;
}

/** 工具调用前调用，确保 Embedder 已初始化 */
export function requireEmbedder(state: SessionState): Embedder {
  if (!state.embedder) throw new Error("Embedder not initialized (session_start not fired?)");
  return state.embedder;
}

/** 解析 storyTime：优先用参数，否则用 state.currentStoryTime */
export function resolveStoryTime(state: SessionState, explicit?: string): string {
  if (explicit) return explicit;
  if (state.currentStoryTime) return state.currentStoryTime;
  throw new Error("storyTime required (call world_event_apply first or pass storyTime explicitly)");
}

/** 默认存储路径：<cwd>/.pi/world-graph-v3/（与 novel-importer 导入目录一致） */
export function resolveWorldGraphDir(cwd: string): string {
  return path.join(cwd, ".pi", "world-graph-v3");
}
