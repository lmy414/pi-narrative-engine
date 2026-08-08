#!/usr/bin/env node
/**
 * reembed-novel.mjs — 为 novel 新库补齐向量（importer 导入时用了 --no-embed）
 * 用法：node scripts/reembed-novel.mjs [--project <dir>]
 * 缺省项目：novel/（安达与岛村新库）
 */
import { WorldGraph } from "underworld-graph";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Embedder } from "../src/embedder.ts";
import { makeEmbedder } from "../packages/novel-importer/src/validate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const projectDir = process.argv.includes("--project")
  ? resolve(process.argv[process.argv.indexOf("--project") + 1])
  : resolve(repoRoot, "..", "novel");
const wgDir = resolve(projectDir, ".pi", "world-graph-v3");

const emb = new Embedder();
await emb.init();
console.log(`[reembed] Embedder 就绪（${emb.constructor.name}）`);

const wg = await WorldGraph.create({
  dbPath: resolve(wgDir, "world.db"),
  eventLogPath: resolve(wgDir, "events.jsonl"),
});
const textEmbedder = { embed: (t) => emb.embed(t) };
await wg.reembedAll(makeEmbedder(textEmbedder));
console.log("[reembed] 全量向量补齐完成");

const times = await wg.listStoryTimes();
const st = times[times.length - 1] ?? "ch001.ev001";
const ents = await wg.getAllEntities(st);
console.log(`[reembed] 验证：实体 ${ents.length} 个，抽查 embedding 非空：`);
for (const e of ents.slice(0, 3)) {
  console.log(` - ${e.name} | props ${e.properties.length} 条`);
}
await wg.close();
console.log(`[reembed] 完成，库：${wgDir}`);
