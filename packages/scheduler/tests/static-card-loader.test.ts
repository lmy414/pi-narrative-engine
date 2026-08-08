// tests/static-card-loader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultStaticCardLoader } from "../src/static-card-loader.ts";
import type { WorldGraph } from "underworld-graph";

function makeMockWg(
  entities: Map<string, {
    summary: string;
    properties: Array<{ declarationId: string; entityId: string; property: string; description: string; modality: "fact" | "belief" | "hypothesis" }>;
    validFrom: string;
  }>,
): WorldGraph {
  return {
    async getEntityAt(entityId: string, _storyTime: string) {
      const e = entities.get(entityId);
      if (!e) return undefined;
      return {
        entityId,
        type: "character",
        summary: e.summary,
        properties: e.properties,
        validFrom: e.validFrom,
      };
    },
  } as unknown as WorldGraph;
}

test("defaultStaticCardLoader: 实体不存在返回最小卡", async () => {
  const wg = makeMockWg(new Map());
  const card = await defaultStaticCardLoader(wg, "not_exist", "ch-1");
  assert.equal(card.name, "not_exist");
  assert.equal(card.description, "");
});

test("defaultStaticCardLoader: 从 Entity.summary 提取 description", async () => {
  const wg = makeMockWg(new Map([
    ["linchong", {
      summary: "八十万禁军教头，被陷害流放",
      properties: [],
      validFrom: "ch-0",
    }],
  ]));
  const card = await defaultStaticCardLoader(wg, "linchong", "ch-1");
  assert.equal(card.description, "八十万禁军教头，被陷害流放");
});

test("defaultStaticCardLoader: 从 Fact 提取已知字段（name/personality）", async () => {
  const wg = makeMockWg(new Map([
    ["linchong", {
      summary: "summary",
      properties: [
        { declarationId: "d1", entityId: "linchong", property: "name", description: "林冲", modality: "fact" },
        { declarationId: "d2", entityId: "linchong", property: "personality", description: "刚烈", modality: "fact" },
        { declarationId: "d3", entityId: "linchong", property: "scenario", description: "宋徽宗年间", modality: "fact" },
      ],
      validFrom: "ch-0",
    }],
  ]));
  const card = await defaultStaticCardLoader(wg, "linchong", "ch-1");
  assert.equal(card.name, "林冲");
  assert.equal(card.personality, "刚烈");
  assert.equal(card.scenario, "宋徽宗年间");
});

test("defaultStaticCardLoader: name 字段在 Fact 中时覆盖 entityId", async () => {
  const wg = makeMockWg(new Map([
    ["c1", {
      summary: "",
      properties: [
        { declarationId: "d1", entityId: "c1", property: "name", description: "武松", modality: "fact" },
      ],
      validFrom: "ch-0",
    }],
  ]));
  const card = await defaultStaticCardLoader(wg, "c1", "ch-1");
  assert.equal(card.name, "武松");
});

test("defaultStaticCardLoader: 无 name 字段时 name 默认是 entityId", async () => {
  const wg = makeMockWg(new Map([
    ["c2", {
      summary: "summary",
      properties: [],
      validFrom: "ch-0",
    }],
  ]));
  const card = await defaultStaticCardLoader(wg, "c2", "ch-1");
  assert.equal(card.name, "c2");
});

test("defaultStaticCardLoader: 未知 property 字段被忽略（不进入 card）", async () => {
  const wg = makeMockWg(new Map([
    ["c3", {
      summary: "",
      properties: [
        { declarationId: "d1", entityId: "c3", property: "mood", description: "怒", modality: "fact" },
        { declarationId: "d2", entityId: "c3", property: "location", description: "山神庙", modality: "fact" },
      ],
      validFrom: "ch-0",
    }],
  ]));
  const card = await defaultStaticCardLoader(wg, "c3", "ch-1");
  // mood/location 不在 KNOWN_FIELDS，不应出现在 card 上
  assert.equal((card as Record<string, unknown>).mood, undefined);
  assert.equal((card as Record<string, unknown>).location, undefined);
});
