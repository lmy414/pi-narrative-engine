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
import type { StateDeclaration, VisibilityDeclaration, EventRecord } from "./types.ts";
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

const VisibilityNode = defineNode("Visibility", {
  schema: z.object({
    visibilityId: z.string(),
    characterId: z.string(),
    declarationId: z.string(),
    state: z.enum(["known"]),
    confidence: z.number(),
    source: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
    isExplicit: z.boolean(),
  }),
});

const declaresEdge = defineEdge("declares");

const graph = defineGraph({
  id: "world",
  nodes: {
    Entity: { type: EntityNode },
    Fact: { type: FactNode },
    Relation: { type: RelationNode },
    Visibility: { type: VisibilityNode },
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

  async processEvent(event: EventRecord): Promise<void> {
    // 写入 JSONL 事件日志（先写日志，确保因果链可回溯）
    await this.eventLog.append(event);

    switch (event.type) {
      case "birth":
        await this.birthEntity(
          event.entityId,
          "character",  // [存疑] processEvent birth 未传 entityType，临时默认 character
          Object.fromEntries(
            (event.newFacts ?? []).map((f) => [f.property, f.value]),
          ),
          event.storyTime,
        );
        break;

      case "death":
        await this.killEntity(event.entityId, event.storyTime);
        break;

      case "change":
        // 闭合旧声明
        for (const inv of event.invalidated ?? []) {
          const facts = await this.store.nodes.Fact.find();
          const oldFact = facts.find(
            (f: any) => f.declarationId === inv.declarationId && f.validTo === INFINITY,
          );
          if (oldFact) {
            await this.store.nodes.Fact.update(oldFact.id, { validTo: event.storyTime });
          }
        }
        // 写入新声明
        for (const fact of event.newFacts ?? []) {
          const declarationId = `decl-${fact.entityId}-${fact.property}-${event.storyTime}`;
          await this.store.nodes.Fact.create({
            declarationId,
            entityId: fact.entityId,
            property: fact.property,
            value: fact.value,
            modality: fact.modality,
            validFrom: event.storyTime,
            validTo: INFINITY,
          });
        }
        break;
    }
  }

  async traceCauses(eventId: string): Promise<EventRecord[]> {
    return this.eventLog.traceBack(eventId);
  }

  async setVisibility(
    characterId: string,
    declarationId: string,
    opts: {
      state: "known";
      confidence: number;
      source: string;
      validFrom: string;
      isExplicit: boolean;
    },
  ): Promise<void> {
    const visibilityId = `vis-${characterId}-${declarationId}-${opts.validFrom}`;
    await this.store.nodes.Visibility.create({
      visibilityId,
      characterId,
      declarationId,
      state: opts.state,
      confidence: opts.confidence,
      source: opts.source,
      validFrom: opts.validFrom,
      validTo: INFINITY,
      isExplicit: opts.isExplicit,
    });
  }

  async getVisibilityForCharacter(characterId: string, storyTime: string): Promise<VisibilityDeclaration[]> {
    const all = await this.store.nodes.Visibility.find();
    return all
      .filter((v: any) => v.characterId === characterId
        && v.validFrom <= storyTime
        && (v.validTo === INFINITY || storyTime < v.validTo))
      .map((v: any) => ({
        characterId: v.characterId,
        declarationId: v.declarationId,
        state: v.state,
        confidence: v.confidence,
        source: v.source,
        validFrom: v.validFrom,
        validTo: v.validTo,
        isExplicit: v.isExplicit,
      })) as VisibilityDeclaration[];
  }

  async getAllDeclarationsAt(storyTime: string): Promise<StateDeclaration[]> {
    const facts = await this.store.nodes.Fact.find();
    return facts
      .filter((f: any) => f.validFrom <= storyTime
        && (f.validTo === INFINITY || storyTime < f.validTo))
      .map((f: any) => ({
        declarationId: f.declarationId,
        entityId: f.entityId,
        property: f.property,
        value: f.value,
        modality: f.modality,
        validFrom: f.validFrom,
        validTo: f.validTo,
      })) as StateDeclaration[];
  }

  async getAllRelationsAt(storyTime: string): Promise<Array<{
    relationId: string; sourceId: string; targetId: string;
    label: string; validFrom: string; validTo: string;
  }>> {
    const rels = await this.store.nodes.Relation.find();
    return rels
      .filter((r: any) => r.validFrom <= storyTime
        && (r.validTo === INFINITY || storyTime < r.validTo))
      .map((r: any) => ({
        relationId: r.relationId,
        sourceId: r.sourceId,
        targetId: r.targetId,
        label: r.label,
        validFrom: r.validFrom,
        validTo: r.validTo,
      }));
  }

  async inferVisibility(storyTime: string): Promise<void> {
    const { inferVisibility: impl } = await import("./character-view.ts");
    await impl(this, storyTime);
  }

  async getCharacterView(
    characterId: string,
    storyTime: string,
    opts: { modalityFilter?: Modality[] } = {},
  ): Promise<StateDeclaration[]> {
    const { characterView } = await import("./character-view.ts");
    return characterView(this, characterId, storyTime, opts);
  }

  async getAllEntities(storyTime: string): Promise<EntitySnapshot[]> {
    const entities = await this.store.nodes.Entity.find();
    const valid = entities.filter(
      (e: any) => e.validFrom <= storyTime
        && (e.validTo === INFINITY || storyTime < e.validTo),
    );
    const snapshots: EntitySnapshot[] = [];
    for (const ent of valid) {
      const snap = await this.getEntityAt(ent.entityId, storyTime);
      if (snap) snapshots.push(snap);
    }
    return snapshots;
  }
}
