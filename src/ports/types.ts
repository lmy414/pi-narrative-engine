// src/ports/types.ts
/**
 * ports/types.ts — 数据层 Ports 接口定义（阶段 A 修正版）
 *
 * 依据：docs/plans/2026-08-01-data-layer-ports-execution-plan.md §三
 *
 * 定位：子代理工具的底层能力抽象，非 commit 执行接口。
 * 全部接口零 PI 依赖，真实模块映射在 adapters.ts。
 *
 * 相对调研文档的修正：
 * - WorldGraphPort 不含 search（检索统一走 SearchPort，避免冗余）
 * - setVisibility.source 引用 VisibilitySource 枚举而非手写字面量
 * - RendererPort 用纯 IO 原语（append/modify/insert），不含 renderToFile
 *   （渲染 LLM 调用由渲染器代理自己完成，工具只落地文本）
 * （MemoryPort 已删除 - 2026-08-01 Task7）
 */

import type {
  EntitySnapshot,
  EntityType,
  EventRecord,
  EventRecordInput,
  StateDeclaration,
  _VisibilityDeclaration as VisibilityDeclaration,
} from "underworld-graph";
import type { EntitySearchResult } from "../search.ts";
import type { InteractCommand, InteractResult, RoleLlmCaller } from "@pi/role-pool";

/**
 * 可见性来源（对齐 underworld-graph types.ts 的 VisibilitySource z.enum；
 * 包入口未导出该类型，故以字面量联合声明，结构等价）
 */
export type VisibilitySource = "experienced" | "informed" | "witnessed";

/** 关系快照（对齐 underworld-graph WorldGraph.getRelations 返回结构） */
export interface RelationSnapshot {
  relationId: string;
  sourceId: string;
  targetId: string;
  label: string;
  /** 关系描述文本（仓库 getAllRelationsAt 返回含 description 的超集，可选兼容） */
  description?: string;
  validFrom: string;
  validTo: string;
}

/** 世界图端口：实体/关系/事件/可见性读写抽象（processEvent 真实返回 void） */
export interface WorldGraphPort {
  // 只读
  getEntityAt(
    entityId: string,
    storyTime: string,
    opts?: { recordedAsOf?: string },
  ): Promise<EntitySnapshot | null>;
  getCharacterView(
    characterId: string,
    storyTime: string,
    opts?: {
      modalityFilter?: ("fact" | "belief" | "hypothesis")[];
      recordedAsOf?: string;
    },
  ): Promise<StateDeclaration[]>;
  getRelations(
    entityId: string,
    storyTime: string,
    opts?: { recordedAsOf?: string },
  ): Promise<RelationSnapshot[]>;
  getAllDeclarationsAt(storyTime: string): Promise<StateDeclaration[]>;
  listStoryTimes(): Promise<string[]>;
  /** 读取某时间点全部关系（含 located_in 等）。返回对齐仓库实际结构（含 description） */
  getAllRelationsAt(
    storyTime: string,
    opts?: { recordedAsOf?: string },
  ): Promise<RelationSnapshot[]>;
  /** 读取某声明的可见性记录。storyTime 缺省 = 全历史（含已闭合，幂等/撤销回填判定用） */
  getVisibilityForDeclaration(
    declarationId: string,
    storyTime?: string,
    opts?: { recordedAsOf?: string },
  ): Promise<VisibilityDeclaration[]>;
  getAllEntities(
    storyTime: string,
    opts?: { recordedAsOf?: string },
  ): Promise<EntitySnapshot[]>;
  getAllEvents(): Promise<EventRecord[]>;
  recordedNow(): Promise<string | undefined>;
  /** 单个实体全部版本 + 全部 Fact（含历史），按 validFrom 升序。返回结构对齐仓库 getEntityHistory */
  getEntityHistory(
    entityId: string,
    opts?: { recordedAsOf?: string },
  ): Promise<{
    entities: Array<{
      entityId: string;
      type: EntityType;
      name: string;
      aliases: string[];
      summary: string;
      validFrom: string;
      validTo: string;
    }>;
    facts: Array<
      StateDeclaration & {
        /** 写入时间（事务时间轴墙钟，SDK meta.createdAt）；旧数据可能缺失 */
        createdAt?: string;
        /** 最后修改时间（如闭合 validTo 的时刻，SDK meta.updatedAt） */
        updatedAt?: string;
      }
    >;
  }>;
  getRelationHistory(
    entityId?: string,
    opts?: { recordedAsOf?: string },
  ): Promise<RelationSnapshot[]>;
  // 0.2.0 D7：traceCauses 对不存在的 eventId 返回 null（不再静默截断）
  traceCauses(eventId: string): Promise<EventRecord[] | null>;
  // 写入
  processEvent(event: EventRecordInput): Promise<void>;
  birthEntity(
    entityId: string,
    type: EntityType,
    initialProps: Record<string, string>,
    storyTime: string,
  ): Promise<void>;
  killEntity(entityId: string, storyTime: string): Promise<void>;
  updateEntitySummary(entityId: string, summary: string, storyTime: string): Promise<void>;
  addRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
    opts?: { description?: string },
  ): Promise<void>;
  closeRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void>;
  setVisibility(
    characterId: string,
    declarationId: string,
    opts: {
      state: "known";
      confidence: number;
      source: VisibilitySource;
      validFrom: string;
      isExplicit: boolean;
    },
  ): Promise<void>;
  closeVisibility(characterId: string, declarationId: string, storyTime: string): Promise<void>;
  /** 更新 Fact 向量（无向量引擎时由适配器容错） */
  updateFactEmbedding(declarationId: string, vec: number[]): Promise<void>;
}

/** 检索端口：独立检索抽象（内部包装现有 Search 类） */
export interface SearchPort {
  search(
    query: string,
    opts?: {
      topK?: number;
      typeFilter?: EntityType;
      storyTime?: string;
      mode?: "fulltext" | "vector" | "hybrid";
    },
  ): Promise<EntitySearchResult[]>;
}

/** 嵌入端口：embed 是文本接口，embedEntity/embedFact 是结构化接口 */
export interface EmbedderPort {
  embed(text: string): Promise<number[]>;
  embedEntity(snapshot: EntitySnapshot): Promise<number[]>;
  embedFact(decl: StateDeclaration): Promise<number[]>;
}

/** 规则集端口：映射 loadPlannerRuleSet / loadRoleRuleSet / loadStyleRuleSet（v3 D9） */
export interface RulesetPort {
  loadPlanner(cwd: string): Promise<string>;
  loadRole(cwd: string): Promise<string>;
  loadRender(cwd: string): Promise<string>;
}

/** 渲染器端口：纯 IO 原语，渲染 LLM 调用由渲染器代理完成 */
export interface RendererPort {
  ensureChapterFile(chapterPath: string): Promise<void>;
  readChapter(chapterPath: string): Promise<string>;
  readChapterSection(chapterPath: string, start?: string, end?: string): Promise<string>;
  appendToChapter(chapterPath: string, eventId: string, text: string): Promise<void>;
  modifyChapterSection(chapterPath: string, anchorEventId: string, newText: string): Promise<void>;
  insertChapterSection(
    chapterPath: string,
    afterEventId: string,
    newEventId: string,
    text: string,
  ): Promise<void>;
}

/** 角色池端口：接口保留，本阶段默认适配器未接线（角色由编排器直接驱动 Agent） */
export interface RolePoolPort {
  interact(
    cmd: InteractCommand,
    deps: { llm: RoleLlmCaller; ruleSet: string },
  ): Promise<InteractResult>;
}
