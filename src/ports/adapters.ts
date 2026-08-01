// src/ports/adapters.ts
/**
 * adapters.ts — 数据层 Ports 默认适配器（薄包装，零 PI 依赖）
 *
 * 依据：docs/plans/2026-08-01-data-layer-ports-execution-plan.md §四 A1
 *
 * 每个适配器 10-30 行，直接映射真实模块 API：
 * - WorldGraphPort → underworld-graph WorldGraph
 * - SearchPort → src/search.ts Search
 * - EmbedderPort → src/embedder.ts Embedder
 * - RulesetPort → loadPlannerRuleSet / loadRoleRuleSet / loadRuleSet
 * （MemoryPort 已删除 - 2026-08-01 Task7）
 * - RendererPort → @pi/renderer chapter-io + @pi/scheduler insertChapterSection
 * - RolePoolPort → 本阶段未接线（角色由编排器直接驱动 Agent）
 */

import type { WorldGraph } from "underworld-graph";
import type { Search } from "../search.ts";
import type { Embedder } from "../embedder.ts";
import { loadPlannerRuleSet } from "../planner-rule-loader.ts";
import { loadRoleRuleSet } from "@pi/role-pool";
import {
  loadRuleSet,
  ensureChapterFile,
  readChapter,
  readChapterSection,
  _appendToChapter,
  _modifyChapterSection,
} from "@pi/renderer";
import { _insertChapterSection } from "@pi/scheduler";
import type {
  WorldGraphPort,
  SearchPort,
  EmbedderPort,
  RulesetPort,
  RendererPort,
  RolePoolPort,
} from "./types.ts";

/** 世界图适配器：直接映射 wg 方法 */
export function createWorldGraphAdapter(wg: WorldGraph): WorldGraphPort {
  return {
    getEntityAt: (entityId, storyTime, opts) => wg.getEntityAt(entityId, storyTime, opts),
    getCharacterView: (characterId, storyTime, opts) =>
      wg.getCharacterView(characterId, storyTime, opts),
    getRelations: (entityId, storyTime, opts) => wg.getRelations(entityId, storyTime, opts),
    getAllDeclarationsAt: (storyTime) => wg.getAllDeclarationsAt(storyTime),
    listStoryTimes: () => wg.listStoryTimes(),
    traceCauses: (eventId) => wg.traceCauses(eventId),
    processEvent: (event) => wg.processEvent(event),
    addRelation: (sourceId, targetId, label, storyTime) =>
      wg.addRelation(sourceId, targetId, label, storyTime),
    closeRelation: (sourceId, targetId, label, storyTime) =>
      wg.closeRelation(sourceId, targetId, label, storyTime),
    setVisibility: (characterId, declarationId, opts) =>
      wg.setVisibility(characterId, declarationId, opts),
    closeVisibility: (characterId, declarationId, storyTime) =>
      wg.closeVisibility(characterId, declarationId, storyTime),
    inferVisibility: (storyTime) => wg.inferVisibility(storyTime),
    updateFactEmbedding: (declarationId, vec) => wg.updateFactEmbedding(declarationId, vec),
  };
}

/** 检索适配器：直接映射 Search 类 */
export function createSearchAdapter(search: Search): SearchPort {
  return {
    search: (query, opts) => search.search(query, opts),
  };
}

/** 嵌入适配器：直接映射 Embedder */
export function createEmbedderAdapter(emb: Embedder): EmbedderPort {
  return {
    embed: (text) => emb.embed(text),
    embedEntity: (snapshot) => emb.embedEntity(snapshot),
    embedFact: (decl) => emb.embedFact(decl),
  };
}

/** 文件规则集适配器：包装 3 个 loadXxxRuleSet */
export function createFileRulesetAdapter(): RulesetPort {
  return {
    loadPlanner: (cwd) => loadPlannerRuleSet(cwd),
    loadRole: (cwd) => loadRoleRuleSet(cwd),
    loadRender: (cwd) => loadRuleSet(cwd),
  };
}

/** 渲染器适配器：包装 @pi/renderer 章节原语 + @pi/scheduler 锚点插入 */
export function createRendererAdapter(): RendererPort {
  return {
    ensureChapterFile: (p) => ensureChapterFile(p),
    readChapter: (p) => readChapter(p),
    readChapterSection: (p, start, end) => readChapterSection(p, start, end),
    appendToChapter: (p, eventId, text) => _appendToChapter(p, eventId, text),
    modifyChapterSection: (p, anchorEventId, newText) =>
      _modifyChapterSection(p, anchorEventId, newText),
    insertChapterSection: (p, afterEventId, newEventId, text) =>
      _insertChapterSection(p, afterEventId, newEventId, text),
  };
}

/** 角色池适配器：本阶段未接线（角色由编排器直接驱动 Agent），接口保留 */
export function createRolePoolAdapter(): RolePoolPort {
  return {
    async interact() {
      throw new Error("RolePoolPort 未接线：角色由编排器直接驱动 Agent");
    },
  };
}
