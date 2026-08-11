// src/data/world-graph-data-access.ts
/**
 * 世界图统一数据管道——世界图读写唯一入口
 *
 * 职责边界（依据 docs/plans/2026-08-10-worldgraph-dataaccess-and-visibility.md §四）：
 * - 透传：Port 方法原样转发，无加工。
 * - 加工：只放世界图单资源域内的读取加工（当前仅 inferVisibilityAt）。
 *   跨资源编排（retcon 改写编排、导入流程编排等）不放进本类，防上帝类。
 * - 无会话状态：不持有 currentStoryTime；storyTime 解析在工具层（resolveStoryTime 注入）。
 *
 * 纪律（2026-08-11 执行）：
 * - INFINITY 哨兵未从 underworld-graph 包入口导出（已查档核实），此处本地声明，
 *   与仓库 types.ts:147 的 `export const INFINITY = "Infinity"` 等值。
 * - inferVisibilityAt 逐行对齐仓库 character-view.ts:54-90，不擅优化串行 N+1。
 */
import type { WorldGraphPort } from "../ports/types.ts";

/** 未闭合哨兵（与 underworld-graph 等值；该常量未从包入口导出） */
const INFINITY = "Infinity";

export class WorldGraphDataAccess {
  private constructor(private readonly port: WorldGraphPort) {}
  static create(port: WorldGraphPort): WorldGraphDataAccess {
    return new WorldGraphDataAccess(port);
  }

  // —— 透传读取 ——
  getEntityAt(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }) {
    return this.port.getEntityAt(entityId, storyTime, opts);
  }
  getCharacterView(
    characterId: string,
    storyTime: string,
    opts?: {
      modalityFilter?: ("fact" | "belief" | "hypothesis")[];
      recordedAsOf?: string;
    },
  ) {
    return this.port.getCharacterView(characterId, storyTime, opts);
  }
  getRelations(entityId: string, storyTime: string, opts?: { recordedAsOf?: string }) {
    return this.port.getRelations(entityId, storyTime, opts);
  }
  getAllDeclarationsAt(storyTime: string) {
    return this.port.getAllDeclarationsAt(storyTime);
  }
  listStoryTimes() {
    return this.port.listStoryTimes();
  }
  getAllRelationsAt(storyTime: string, opts?: { recordedAsOf?: string }) {
    return this.port.getAllRelationsAt(storyTime, opts);
  }
  getVisibilityForDeclaration(
    declarationId: string,
    storyTime?: string,
    opts?: { recordedAsOf?: string },
  ) {
    return this.port.getVisibilityForDeclaration(declarationId, storyTime, opts);
  }
  getAllEntities(storyTime: string, opts?: { recordedAsOf?: string }) {
    return this.port.getAllEntities(storyTime, opts);
  }
  getAllEvents() {
    return this.port.getAllEvents();
  }
  recordedNow() {
    return this.port.recordedNow();
  }
  getEntityHistory(entityId: string, opts?: { recordedAsOf?: string }) {
    return this.port.getEntityHistory(entityId, opts);
  }
  getRelationHistory(entityId?: string, opts?: { recordedAsOf?: string }) {
    return this.port.getRelationHistory(entityId, opts);
  }
  traceCauses(eventId: string) {
    return this.port.traceCauses(eventId);
  }

  // —— 透传写入 ——
  processEvent(event: Parameters<WorldGraphPort["processEvent"]>[0]) {
    return this.port.processEvent(event);
  }
  birthEntity(
    entityId: string,
    type: string,
    initialProps: Record<string, string>,
    storyTime: string,
  ) {
    return this.port.birthEntity(
      entityId,
      type as Parameters<WorldGraphPort["birthEntity"]>[1],
      initialProps,
      storyTime,
    );
  }
  killEntity(entityId: string, storyTime: string) {
    return this.port.killEntity(entityId, storyTime);
  }
  updateEntitySummary(entityId: string, summary: string, storyTime: string) {
    return this.port.updateEntitySummary(entityId, summary, storyTime);
  }
  addRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
    opts?: { description?: string },
  ) {
    return this.port.addRelation(sourceId, targetId, label, storyTime, opts);
  }
  closeRelation(sourceId: string, targetId: string, label: string, storyTime: string) {
    return this.port.closeRelation(sourceId, targetId, label, storyTime);
  }
  setVisibility(
    characterId: string,
    declarationId: string,
    opts: Parameters<WorldGraphPort["setVisibility"]>[2],
  ) {
    return this.port.setVisibility(characterId, declarationId, opts);
  }
  closeVisibility(characterId: string, declarationId: string, storyTime: string) {
    return this.port.closeVisibility(characterId, declarationId, storyTime);
  }
  updateFactEmbedding(declarationId: string, vec: number[]) {
    return this.port.updateFactEmbedding(declarationId, vec);
  }

  // —— 加工：可见性推理 ——
  /**
   * 基础设施关系推断（对齐仓库 character-view.ts:54-90）。
   * 遍历 storyTime 时刻全部 located_in 关系，把 target 实体的有效声明标记为
   * source 角色可见；validFrom = max(rel.validFrom, decl.validFrom)。
   *
   * C2（2026-08-07）：opts.recordedAsOf 传入全部读取（retcon 事务隔离）；
   * 写入侧（setVisibility）仍为 live 写入。
   */
  async inferVisibilityAt(
    storyTime: string,
    opts?: { recordedAsOf?: string },
  ): Promise<void> {
    const allRels = await this.port.getAllRelationsAt(storyTime, opts);
    const locatedIn = allRels.filter((r) => r.label === "located_in");
    for (const rel of locatedIn) {
      const targetDecls = await this.port.getEntityAt(rel.targetId, storyTime, opts);
      if (!targetDecls) continue;
      for (const decl of targetDecls.properties) {
        // 幂等 + 撤销回填保护（2026-08-05，评审 P1）：
        // 全历史判定（含已闭合记录），而非只看当前有效窗口。
        const mine = (
          await this.port.getVisibilityForDeclaration(decl.declarationId, undefined, opts)
        ).filter((v) => v.characterId === rel.sourceId);
        if (mine.some((v) => v.validFrom <= storyTime
          && (v.validTo === INFINITY || storyTime < v.validTo))) {
          continue;
        }
        let validFrom = rel.validFrom > decl.validFrom ? rel.validFrom : decl.validFrom;
        if (mine.some((v) => v.validTo !== INFINITY && v.validTo <= storyTime)) {
          validFrom = storyTime;
        }
        if (validFrom > storyTime) continue;
        await this.port.setVisibility(rel.sourceId, decl.declarationId, {
          state: "known",
          confidence: 1,
          source: "witnessed",
          validFrom,
          isExplicit: false,
        });
      }
    }
  }
}