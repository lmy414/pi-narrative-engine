#!/usr/bin/env node
/**
 * doctor.mjs — narrative-engine 环境自检（CLI 入口）
 *
 * 2026-07-29 重构：检查逻辑抽取到 @pi/admin 子包（packages/admin/src/doctor.ts）
 * 本文件仅作为 CLI 入口，负责参数解析与输出展示。
 *
 * 用法：npm run doctor [--novel <小说工程目录>]
 *
 * 退出码：全部通过 0；有 ❌ 则 1（⚠️ 不阻断）
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor, formatDoctorReport } from "../packages/admin/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { novel: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--novel" && argv[i + 1]) args.novel = resolve(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 执行检查
// ---------------------------------------------------------------------------

const report = await runDoctor({
  repoRoot,
  novelDir: args.novel ?? undefined,
});

console.log("\n" + "═".repeat(50));
console.log("narrative-engine 环境自检");
console.log("═".repeat(50));
if (args.novel) console.log(`小说工程: ${args.novel}`);
console.log("");

console.log(formatDoctorReport(report));

process.exit(report.ok ? 0 : 1);
