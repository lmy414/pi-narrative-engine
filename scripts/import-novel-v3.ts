/**
 * import-novel-v3.ts — V3 导入器独立 CLI
 *
 * 不依赖 pi 扩展加载机制，直接调用 runImportPipeline。
 * 用于本地测试 / 真实 EPUB 端到端验证。
 *
 * 用法：
 *   npx tsx scripts/import-novel-v3.ts --epub <path> [options]
 *
 * 选项：
 *   --epub <path>            EPUB 文件路径（必填）
 *   --world-graph <path>    世界图存储目录（默认: novel/.pi/world-graph-v3）
 *   --chapters <1,2,3>       限定导入章节（逗号分隔，1-based）
 *   --model <id>             LLM 模型名（默认: deepseek-v4-flash）
 *   --api-key <key>          DeepSeek API key
 *   --concurrency <N>        章节并行限流（默认: 3）
 *   --resume-from-stage <N>  从指定阶段恢复（1-8）
 *   --no-embed               跳过向量补齐（调试用）
 *   -h, --help               显示帮助
 *
 * API key 读取顺序：--api-key → ~/.pi/agent/auth.json → $DEEPSEEK_API_KEY
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Embedder } from "../src/embedder.ts";
import { runImportPipeline } from "@pi/novel-importer";

// ============================================================================
// 参数解析
// ============================================================================

interface CliOptions {
  epub: string;
  worldGraph: string;
  chapters?: number[];
  model: string;
  apiKey: string;
  concurrency: number;
  resumeFromStage?: number;
  noEmbed: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const opts: CliOptions = {
    epub: "",
    worldGraph: "",
    model: "deepseek-v4-flash",
    apiKey: "",
    concurrency: 3,
    noEmbed: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--epub") opts.epub = args[++i] ?? "";
    else if (a === "--world-graph") opts.worldGraph = args[++i] ?? "";
    else if (a === "--chapters") {
      opts.chapters = (args[++i] ?? "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
    } else if (a === "--model") opts.model = args[++i] ?? "";
    else if (a === "--api-key") opts.apiKey = args[++i] ?? "";
    else if (a === "--concurrency") opts.concurrency = parseInt(args[++i] ?? "3", 10);
    else if (a === "--resume-from-stage") {
      opts.resumeFromStage = parseInt(args[++i] ?? "1", 10);
    } else if (a === "--no-embed") opts.noEmbed = true;
    else if (a === "-h" || a === "--help") {
      console.log(`import-novel-v3 — V3 小说导入器 CLI

用法:
  npx tsx scripts/import-novel-v3.ts --epub <path> [options]

选项:
  --epub <path>            EPUB 文件路径（必填）
  --world-graph <path>     世界图存储目录（默认: novel/.pi/world-graph-v3）
  --chapters <1,2,3>       限定导入章节（逗号分隔，1-based）
  --model <id>             LLM 模型名（默认: deepseek-v4-flash）
  --api-key <key>          DeepSeek API key
  --concurrency <N>        章节并行限流（默认: 3）
  --resume-from-stage <N>  从指定阶段恢复（1-8）
  --no-embed               跳过向量补齐（调试用）

环境变量:
  DEEPSEEK_API_KEY         API key（命令行未指定时读取）
  EPUB_PATH                 EPUB 路径（命令行未指定时读取；规避 PS5 中文参数编码问题）
`);
      process.exit(0);
    }
  }

  if (!opts.epub) {
    // 回退到环境变量（PS5 调用 native exe 时中文命令行参数会被 GBK 编码破坏，
    // 用环境变量传中文路径可规避：PS5 传 env 给子进程走 UTF-16→UTF-8 转换）
    opts.epub = process.env.EPUB_PATH || "";
  }
  if (!opts.epub) {
    console.error("Error: --epub 必填（可用 --epub <path> 或 EPUB_PATH 环境变量；用 -h 查看帮助）");
    process.exit(1);
  }

  if (!opts.worldGraph) {
    // M4b 修复（2026-07-30）：改为相对路径（原硬编码开发者本机 Windows 路径）
    // 缺省指向 <cwd>/novel/.pi/world-graph-v3（与扩展运行时一致）
    opts.worldGraph = path.resolve("novel", ".pi", "world-graph-v3");
  }

  // API key 读取顺序：命令行 → ~/.pi/agent/auth.json → 环境变量
  if (!opts.apiKey) {
    try {
      const raw = readFileSync(
        path.join(process.env.USERPROFILE || "", ".pi", "agent", "auth.json"),
        "utf8",
      );
      const json = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
      const authJson = JSON.parse(json);
      if (authJson.deepseek?.key) opts.apiKey = authJson.deepseek.key;
    } catch {
      /* ignore */
    }
  }
  if (!opts.apiKey) opts.apiKey = process.env.DEEPSEEK_API_KEY || "";
  if (!opts.apiKey) {
    console.error("Error: 无法获取 API key（--api-key / ~/.pi/agent/auth.json / $DEEPSEEK_API_KEY 均未找到）");
    process.exit(1);
  }

  return opts;
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const opts = parseArgs(process.argv);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  V3 小说导入器");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  EPUB:        ${opts.epub}`);
  console.log(`  世界图目录:  ${opts.worldGraph}`);
  if (opts.chapters) console.log(`  章节范围:    ${opts.chapters.join(",")}`);
  console.log(`  模型:        ${opts.model}（默认: deepseek-v4-flash）`);
  console.log(`  并发数:      ${opts.concurrency}`);
  if (opts.resumeFromStage) console.log(`  恢复阶段:    ${opts.resumeFromStage}`);
  console.log(`  向量补齐:    ${opts.noEmbed ? "禁用" : "启用"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // 实例化 Embedder（除非 --no-embed）
  let embedder;
  if (!opts.noEmbed) {
    console.log("[init] 加载 Embedder（Xenova/bge-small-zh-v1.5）...");
    embedder = new Embedder();
    await embedder.init();
    console.log("[init] Embedder 就绪\n");
  }

  // 运行管道
  const result = await runImportPipeline(
    {
      epubPath: opts.epub,
      worldGraphDir: opts.worldGraph,
      chapters: opts.chapters,
      model: opts.model,
      apiKey: opts.apiKey,
      concurrency: opts.concurrency,
      resumeFromStage: opts.resumeFromStage,
      cwd: process.cwd(),
      embedder,
    },
    (stage, name, msg, p) => {
      const prefix = `[stage ${stage}/8] ${name}`;
      const suffix = p ? ` (${p.done}/${p.total})` : "";
      console.log(`${prefix}${suffix}: ${msg}`);
    },
  );

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  导入完成");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  实体数:    ${result.entityCount}`);
  console.log(`  事件数:    ${result.eventCount}`);
  console.log(`  关系数:    ${result.relationCount}`);
  console.log(`  可见性数:  ${result.visibilityCount}`);
  console.log(`  存储目录:  ${result.worldGraphDir}`);
  console.log(`  dump:      ${result.dumpPath}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
