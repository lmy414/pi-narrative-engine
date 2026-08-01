// src/orchestrator/assembly.ts
/**
 * assembly.ts — 数据层 Ports 装配
 *
 * 依据：docs/plans/2026-08-01-data-layer-ports-execution-plan.md §四 A1
 *
 * 把数据层真实实例（wg / search / embedder）组装为子代理工具可用的
 * OrchestratorPorts 集合。编排器与子代理只依赖 Ports 接口，不依赖具体模块。
 */

import path from "node:path";
import type { WorldGraph } from "underworld-graph";
import type { Search } from "../search.ts";
import type { Embedder } from "../embedder.ts";

export function resolveWorldGraphDir(cwd: string): string {
  return path.join(cwd, ".pi", "world-graph-v3");
}
import {
  createWorldGraphAdapter,
  createSearchAdapter,
  createEmbedderAdapter,
  createFileRulesetAdapter,
  createRendererAdapter,
  createRolePoolAdapter,
} from "../ports/adapters.ts";
import type {
  WorldGraphPort,
  SearchPort,
  EmbedderPort,
  RulesetPort,
  RendererPort,
  RolePoolPort,
} from "../ports/types.ts";

/** 编排器可用的数据层 Ports 集合 */
export interface OrchestratorPorts {
  worldGraph: WorldGraphPort;
  search: SearchPort;
  embedder: EmbedderPort;
  ruleset: RulesetPort;
  renderer: RendererPort;
  rolePool: RolePoolPort;
}

/** 装配真实数据层实例为 Ports 集合 */
export function assemblePorts(deps: {
  wg: WorldGraph;
  search: Search;
  embedder: Embedder;
}): OrchestratorPorts {
  return {
    worldGraph: createWorldGraphAdapter(deps.wg),
    search: createSearchAdapter(deps.search),
    embedder: createEmbedderAdapter(deps.embedder),
    ruleset: createFileRulesetAdapter(),
    renderer: createRendererAdapter(),
    rolePool: createRolePoolAdapter(),
  };
}
