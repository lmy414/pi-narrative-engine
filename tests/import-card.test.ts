/**
 * import-card.ts 测试：酒馆卡解析（V1/V2/PNG）+ 导入世界图
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

import {
  extractCardData,
  extractPngChunks,
  parseCardFile,
  importCardToWorldGraph,
} from "../src/tools/import-card.ts";

// ---------------------------------------------------------------------------
// extractCardData
// ---------------------------------------------------------------------------

test("extractCardData: V1 平铺卡", () => {
  const card = extractCardData({
    name: "林冲",
    description: "八十万禁军教头",
    personality: "隐忍",
  });
  assert.equal(card.name, "林冲");
  assert.equal(card.description, "八十万禁军教头");
});

test("extractCardData: V2 spec+data 卡", () => {
  const card = extractCardData({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "辉夜",
      description: "从电线杆中出现的金发少女",
      first_mes: "「你就是我的对手吗？」",
      tags: ["vtuber", "游戏"],
    },
  });
  assert.equal(card.name, "辉夜");
  assert.equal(card.first_mes, "「你就是我的对手吗？」");
  assert.deepEqual(card.tags, ["vtuber", "游戏"]);
});

test("extractCardData: 无法识别格式抛错", () => {
  assert.throws(() => extractCardData({ foo: "bar" }), /无法识别/);
});

// ---------------------------------------------------------------------------
// extractPngChunks（手工构造最小 PNG）
// ---------------------------------------------------------------------------

function makePngWithTextChunk(keyword: string, text: string): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.concat([Buffer.from(keyword, "ascii"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  // CRC 不填（解析器不校验）
  return Buffer.concat([sig, chunk]);
}

test("extractPngChunks: tEXt chara chunk（base64 JSON）", () => {
  const cardJson = JSON.stringify({ name: "彩叶", description: "女高中生" });
  const png = makePngWithTextChunk("chara", Buffer.from(cardJson, "utf8").toString("base64"));
  const text = extractPngChunks(png);
  assert.equal(JSON.parse(text).name, "彩叶");
});

test("extractPngChunks: 非 PNG 抛错", () => {
  assert.throws(() => extractPngChunks(Buffer.from("not a png")), /PNG/);
});

test("extractPngChunks: 无卡数据抛错", () => {
  const png = makePngWithTextChunk("other", "hello");
  assert.throws(() => extractPngChunks(png), /未找到/);
});

// ---------------------------------------------------------------------------
// parseCardFile（.json / .png 分发）
// ---------------------------------------------------------------------------

test("parseCardFile: .json V2 卡", async () => {
  const tmp = path.join(os.tmpdir(), `card-test-${Date.now()}.json`);
  await fs.writeFile(tmp, JSON.stringify({
    spec: "chara_card_v2",
    data: { name: "测试", description: "d", personality: "p" },
  }));
  try {
    const card = await parseCardFile(tmp);
    assert.equal(card.name, "测试");
    assert.equal(card.personality, "p");
  } finally {
    await fs.rm(tmp, { force: true });
  }
});

test("parseCardFile: 不支持格式抛错", async () => {
  await assert.rejects(() => parseCardFile("/tmp/card.txt"), /不支持/);
});

// ---------------------------------------------------------------------------
// importCardToWorldGraph（mock wg）
// ---------------------------------------------------------------------------

test("importCardToWorldGraph: birth + 字段 Facts + 自产自知可见性", async () => {
  const events: any[] = [];
  const visibilities: any[] = [];
  const wg = {
    processEvent: async (e: any) => { events.push(e); },
    setVisibility: async (cid: string, did: string, opts: any) => {
      visibilities.push({ cid, did, opts });
    },
  } as any;

  const result = await importCardToWorldGraph(wg, {
    name: "辉夜",
    description: "金发少女",
    personality: "冷淡",
    first_mes: "「哼」",
  }, "ch-1", "ent_char_test0001");

  assert.equal(result.entityId, "ent_char_test0001");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "birth");
  assert.equal(events[0].entityType, "character");
  assert.equal(events[0].summary, "金发少女", "description 应写入 Entity.summary");
  const props = events[0].newFacts.map((f: any) => f.property);
  assert.deepEqual(props, ["name", "personality", "first_mes"], "只写有值字段，description 不进 Fact");
  // 自产自知：每个 Fact 一条 Visibility
  assert.equal(visibilities.length, 3);
  assert.equal(visibilities[0].cid, "ent_char_test0001");
  assert.equal(visibilities[0].did, "decl-ent_char_test0001-name-ch-1");
  assert.equal(visibilities[0].opts.source, "experienced");
});

test("importCardToWorldGraph: 卡无 name 时兜底 entityId", async () => {
  const events: any[] = [];
  const wg = {
    processEvent: async (e: any) => { events.push(e); },
    setVisibility: async () => {},
  } as any;
  const result = await importCardToWorldGraph(wg, { name: "", description: "无名氏" } as any, "ch-1", "ent_char_noname");
  const nameFact = events[0].newFacts.find((f: any) => f.property === "name");
  assert.equal(nameFact.value, "ent_char_noname");
  assert.ok(result.factCount >= 1);
});

// 防止未使用告警（zlib 预留 charx 支持）
void zlib;
