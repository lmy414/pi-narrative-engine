import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  createStore,
  defineNode,
  defineEdge,
  defineGraph,
} from "@nicia-ai/typegraph";
import type { HistoryStore } from "@nicia-ai/typegraph";
import {
  createSqliteBackend,
  generateSqliteMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { z } from "zod";
import { EntityType, Modality } from "./types.ts";
import type { StateDeclaration } from "./types.ts";
import { EventLog } from "./event-log.ts";

const INFINITY = "Infinity";

/**
 * TypeGraph 节点定义 — Entity（实体）与 Fact（状态声明）
 * validFrom/validTo 作为 schema 字段，由应用层管理 bi-temporal 语义
 * "Infinity" 表示未闭合
 */
const EntityNode = defineNode("Entity", {
  schema: z.object({
    entityId: z.string(),
    type: EntityType,
    validFrom: z.string(),
    validTo: z.string(),
  }),
});

const FactNode = defineNode("Fact", {
  schema: z.object({
    declarationId: z.string(),
    entityId: z.string(),
    property: z.string(),
    value: z.unknown(),
    modality: Modality,
    validFrom: z.string(),
    validTo: z.string(),
  }),
});

const RelationNode = defineNode("Relation", {
  schema: z.object({
    relationId: z.string(),
    sourceId: z.string(),
    targetId: z.string(),
    label: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
  }),
});

const declaresEdge = defineEdge("declares");

const graph = defineGraph({
  id: "world",
  nodes: {
    Entity: { type: EntityNode },
    Fact: { type: FactNode },
    Relation: { type: RelationNode },
  },
  edges: {
    declares: { type: declaresEdge, from: [EntityNode], to: [FactNode] },
  },
});

export interface WorldGraphOptions {
  dbPath: string;
  eventLogPath: string;
}

export interface EntitySnapshot {
  entityId: string;
  type: EntityType;
  validFrom: string;
  validTo: string;
  properties: StateDeclaration[];
}

export class WorldGraph {
  private db: Database.Database;
  private store: HistoryStore<typeof graph>;
  private eventLog: EventLog;

  constructor(opts: WorldGraphOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    const drizzleDb = drizzle(this.db);
    this.db.exec(generateSqliteMigrationSQL());
    const backend = createSqliteBackend(drizzleDb);
    this.store = createStore(graph, backend, { history: true });
    this.eventLog = new EventLog(opts.eventLogPath);
  }

  close(): void {
    this.db.close();
  }

  async birthEntity(
    entityId: string,
    entityType: EntityType,
    initialProps: Record<string, unknown>,
    storyTime: string,
  ): Promise<void> {
    await this.store.nodes.Entity.create({
      entityId,
      type: entityType,
      validFrom: storyTime,
      validTo: INFINITY,
    });
    for (const [prop, val] of Object.entries(initialProps)) {
      const declarationId = `decl-${entityId}-${prop}-${storyTime}`;
      await this.store.nodes.Fact.create({
        declarationId,
        entityId,
        property: prop,
        value: val,
        modality: "fact",
        validFrom: storyTime,
        validTo: INFINITY,
      });
    }
  }

  async killEntity(entityId: string, storyTime: string): Promise<void> {
    const entities = await this.store.nodes.Entity.find();
    const ent = entities.find(
      (e: any) => e.entityId === entityId && e.validTo === INFINITY,
    );
    if (!ent) throw new Error(`Entity ${entityId} not found or already dead`);
    await this.store.nodes.Entity.update(ent.id, { validTo: storyTime });
    // 级联关闭该实体所有未闭合 Fact
    const facts = await this.store.nodes.Fact.find();
    for (const f of facts) {
      if (f.entityId === entityId && f.validTo === INFINITY) {
        await this.store.nodes.Fact.update(f.id, { validTo: storyTime });
      }
    }
  }

  async getEntityAt(
    entityId: string,
    storyTime: string,
  ): Promise<EntitySnapshot | null> {
    // bi-temporal 查询：validFrom <= storyTime < validTo
    // "Infinity" 需特殊处理（字符串比较 'I' < 'a' 导致误判）
    const entities = await this.store.nodes.Entity.find();
    const ent = entities.find(
      (e: any) =>
        e.entityId === entityId &&
        e.validFrom <= storyTime &&
        (e.validTo === INFINITY || storyTime < e.validTo),
    );
    if (!ent) return null;
    const facts = await this.store.nodes.Fact.find();
    const props = facts
      .filter(
        (f: any) =>
          f.entityId === entityId &&
          f.validFrom <= storyTime &&
          (f.validTo === INFINITY || storyTime < f.validTo),
      )
      .map(
        (f: any) =>
          ({
            declarationId: f.declarationId,
            entityId: f.entityId,
            property: f.property,
            value: f.value,
            modality: f.modality,
            validFrom: f.validFrom,
            validTo: f.validTo,
          }) as StateDeclaration,
      );
    return {
      entityId,
      type: ent.type,
      validFrom: ent.validFrom,
      validTo: ent.validTo,
      properties: props,
    };
  }

  async addRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void> {
    const relationId = `rel-${sourceId}-${label}-${targetId}-${storyTime}`;
    await this.store.nodes.Relation.create({
      relationId,
      sourceId,
      targetId,
      label,
      validFrom: storyTime,
      validTo: INFINITY,
    });
  }

  async closeRelation(
    sourceId: string,
    targetId: string,
    label: string,
    storyTime: string,
  ): Promise<void> {
    const rels = await this.store.nodes.Relation.find();
    const rel = rels.find(
      (r: any) => r.sourceId === sourceId && r.targetId === targetId
                && r.label === label && r.validTo === INFINITY,
    );
    if (!rel) throw new Error(`Relation ${sourceId}-${label}-${targetId} not found or already closed`);
    await this.store.nodes.Relation.update(rel.id, { validTo: storyTime });
  }

  async getRelations(entityId: string, storyTime: string): Promise<Array<{
    relationId: string;
    sourceId: string;
    targetId: string;
    label: string;
    validFrom: string;
    validTo: string;
  }>> {
    const rels = await this.store.nodes.Relation.find();
    return rels
      .filter((r: any) =>
        (r.sourceId === entityId || r.targetId === entityId)
        && r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo),
      )
      .map((r: any) => ({
        relationId: r.relationId,
        sourceId: r.sourceId,
        targetId: r.targetId,
        label: r.label,
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }
}
