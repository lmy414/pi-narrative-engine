#!/usr/bin/env node
/**
 * export-world-state.mjs — 导出世界图当前状态快照（v3 D12 方案 B，2026-08-09）
 *
 * 背景：world.db（SQLite 二进制）无法 git diff/merge，不入库（gitignore *.db）；
 * 剧情可追溯靠 events.jsonl（权威日志，入库）。本脚本把**当前世界状态**导出为
 * 可 diff 的 JSON 快照（.pi/world-graph-v3/world-state.json），入库作存档点——
 * db 丢失时可由 events.jsonl + 快照恢复。
 *
 * 用法：
 *   node scripts/export-world-state.mjs [--project <dir>]
 *   缺省项目：novel/（与 reembed-novel.mjs 一致）
 *
 * 提交节奏（结构 v3 文档）：每完成一章提交 = 正文 + events.jsonl + world-state.json
 */
import { WorldGraph } from "underworld-graph";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const projectDir = process.argv.includes("--project")
  ? resolve(process.argv[process.argv.indexOf("--project") + 1])
  : resolve(repoRoot, "..", "novel");
const wgDir = resolve(projectDir, ".pi", "world-graph-v3");
const outputPath = resolve(wgDir, "world-state.json");

const wg = await WorldGraph.create({
  dbPath: resolve(wgDir, "world.db"),
  eventLogPath: resolve(wgDir, "events.jsonl"),
});

// 当前时刻 = 最新 storyTime（与 reembed-novel.mjs 一致）
const times = await wg.listStoryTimes();
const storyTime = times[times.length - 1] ?? null;

const [entities, relations, declarations] = storyTime
  ? await Promise.all([
      wg.getAllEntities(storyTime),
      wg.getAllRelationsAt(storyTime),
      wg.getAllDeclarationsAt(storyTime),
    ])
  : [[], [], []];

const snapshot = {
  meta: {
    exportedAt: new Date().toISOString(),
    project: projectDir,
    storyTime,
    counts: {
      entities: entities.length,
      relations: relations.length,
      declarations: declarations.length,
    },
  },
  entities,
  relations,
  declarations,
};

await mkdir(wgDir, { recursive: true });
await writeFile(outputPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

console.log(`[export] 项目: ${projectDir}`);
console.log(`[export] 当前 storyTime: ${storyTime ?? "（空库）"}`);
console.log(
  `[export] 导出: 实体 ${snapshot.meta.counts.entities} / 关系 ${snapshot.meta.counts.relations} / 声明 ${snapshot.meta.counts.declarations}`,
);
console.log(`[export] 已写入: ${outputPath}`);

await wg.close();
