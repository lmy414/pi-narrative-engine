#!/usr/bin/env node
/**
 * 前端测试轮种子脚本：创建 0.3.1 世界图测试库（frontend-test-project）
 * 用 underworld-graph 0.3.1 API 写入：实体（中文词表 property）+ 关系（label+description）
 * + change 事件 + 可见性。供阶段 4 前端测试轮使用（novel 旧库在阶段 5 前不可打开）。
 */
import { WorldGraph } from "underworld-graph";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../.."); // pi-ex/
const PROJ = resolve(ROOT, "frontend-test-project");
const WG_DIR = resolve(PROJ, ".pi/world-graph-v3");

// —— 重建测试库（幂等） ——
rmSync(WG_DIR, { recursive: true, force: true });
mkdirSync(WG_DIR, { recursive: true });
mkdirSync(resolve(PROJ, "正文"), { recursive: true });

const wg = await WorldGraph.create({
  dbPath: resolve(WG_DIR, "world.db"),
  eventLogPath: resolve(WG_DIR, "events.jsonl"),
  storyTimePattern: /^ch\d{3}\.ev\d{3}$/,
});

const T = {
  birth: async (entityId, entityType, props, storyTime, summary) => {
    await wg.processEvent({
      eventId: `evt_seed_${entityId}_${Date.now()}`,
      type: "birth",
      storyTime,
      entityId,
      entityType,
      summary,
      source: "user",
      newFacts: Object.entries(props).map(([property, description]) => ({ entityId, property, description, modality: "fact" })),
    });
  },
  change: async (entityId, property, description, storyTime, invalidated = true, modality = "fact") => {
    const snap = await wg.getEntityAt(entityId, storyTime);
    const current = invalidated ? snap?.properties.find((p) => p.property === property) : undefined;
    await wg.processEvent({
      eventId: `evt_seed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "change",
      storyTime,
      entityId,
      source: "engine",
      invalidated: current ? [{ declarationId: current.declarationId, property }] : undefined,
      newFacts: [{ entityId, property, description, modality }],
    });
  },
};

// —— 角色 ——
await T.birth("ent_char_lin", "character", {
  "名字": "林远航", "性格": "沉稳执着", "背景": "曙光号年轻舰长", "位置": "第七星港", "心情": "平静",
}, "ch001.ev001", "年轻的星舰舰长，执着于寻找失踪的父亲");
await T.birth("ent_char_ailiya", "character", {
  "名字": "艾莉亚", "性格": "神秘内敛", "背景": "游商公会出身的导航员", "位置": "第七星港", "心情": "警惕",
}, "ch001.ev001", "神秘的导航员，似乎知道舰长父亲的下落");
await T.birth("ent_char_laochen", "character", {
  "名字": "老陈", "性格": "刚烈耿直", "背景": "星际联盟退役上将", "位置": "第七星港", "心情": "忧虑",
}, "ch001.ev001", "星际联盟退役上将，林远航的导师");
// 跨实体信念（modality=belief）
await T.change("ent_char_ailiya", "信念.关于_林远航.目的", "怀疑他在暗中寻找星门协议", "ch002.ev003", false, "belief");

// —— 地点 / 物品 / 概念 ——
await T.birth("ent_loc_port", "location", { "名字": "第七星港", "类型": "太空站", "氛围": "繁忙" }, "ch001.ev001", "人类在猎户座旋臂边缘的前哨站");
await T.birth("ent_loc_nebula", "location", { "名字": "迷雾星云", "类型": "星云", "氛围": "神秘" }, "ch003.ev005", "传说中藏有远古文明遗迹的星云");
await T.birth("ent_item_map", "item", { "名字": "破碎星图", "类型": "遗物", "主人": "林远航" }, "ch001.ev002", "父亲留下的星图碎片，指向迷雾星云深处");
await T.birth("ent_item_crystal", "item", { "名字": "共鸣水晶", "类型": "材料" }, "ch002.ev003", "可穿透星云干扰的稀有矿石");
await T.birth("ent_conc_protocol", "concept", { "名字": "星门协议", "类型": "知识" }, "ch001.ev001", "一种古老的星际航行技术");

// —— 时变状态（change 事件，同 property 多次变更 → 声明历史） ——
await T.change("ent_char_lin", "位置", "曙光号舰桥", "ch003.ev005");
await T.change("ent_char_lin", "位置", "迷雾星云", "ch005.ev007");
await T.change("ent_char_lin", "心情", "振奋", "ch005.ev007");
await T.change("ent_char_ailiya", "心情", "释然", "ch005.ev007");

// —— 关系（label 中文枚举 + description） ——
await wg.addRelation("ent_char_lin", "ent_char_ailiya", "同行", "ch001.ev001", { description: "一同在曙光号上航行" });
await wg.addRelation("ent_char_lin", "ent_char_laochen", "师徒", "ch001.ev001", { description: "林远航在老陈麾下服役过" });
await wg.addRelation("ent_char_lin", "ent_item_map", "持有", "ch001.ev002", { description: "破碎星图在舰长手中" });
await wg.addRelation("ent_char_ailiya", "ent_loc_port", "来自", "ch001.ev001", { description: "艾莉亚在第七星港长大" });
await wg.addRelation("ent_char_lin", "ent_loc_nebula", "前往", "ch003.ev005", { description: "曙光号正驶向迷雾星云" });
await wg.addRelation("ent_item_map", "ent_loc_nebula", "指向", "ch001.ev002", { description: "星图碎片标注的位置" });
await wg.addRelation("ent_item_crystal", "ent_conc_protocol", "关联", "ch002.ev003", { description: "共鸣水晶是星门协议的关键材料" });
await wg.addRelation("ent_char_laochen", "ent_conc_protocol", "研究", "ch002.ev003", { description: "老陈生前研究星门协议" });

// —— 可见性（角色自产自知 + 推断） ——
for (const eid of ["ent_char_lin", "ent_char_ailiya", "ent_char_laochen"]) {
  const snap = await wg.getEntityAt(eid, "ch005.ev007");
  for (const decl of snap?.properties ?? []) {
    await wg.setVisibility(eid, decl.declarationId, { state: "known", confidence: 1, source: "experienced", validFrom: "ch001.ev001", isExplicit: true });
  }
}
await wg.inferVisibility("ch005.ev007");

// —— novel.json ——
const fs = await import("node:fs");
fs.writeFileSync(resolve(PROJ, "novel.json"), JSON.stringify({
  name: "前端测试轮项目",
  engine: "narrative-engine",
  engineVersion: "0.1.0",
  worldGraphDir: ".pi/world-graph-v3",
  chaptersDir: "正文",
  storyTimeFormat: "ch{NNN}.ev{NNN}",
  createdAt: new Date().toISOString(),
}, null, 2));

await wg.close();

const status = await (async () => {
  const wg2 = await WorldGraph.create({ dbPath: resolve(WG_DIR, "world.db"), eventLogPath: resolve(WG_DIR, "events.jsonl") });
  const entities = await wg2.getAllEntities("ch005.ev007");
  const times = await wg2.listStoryTimes();
  const events = await wg2.getAllEvents();
  const rels = await wg2.getAllRelationsAt("ch005.ev007");
  await wg2.close();
  return { entities: entities.length, times: times.length, events: events.length, relations: rels.length };
})();
console.log("种子完成:", JSON.stringify(status));
