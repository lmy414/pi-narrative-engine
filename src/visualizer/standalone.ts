/**
 * standalone.ts — world-graph 可视化的独立入口（由 scripts/visualizer.mjs 以 tsx 拉起）
 *
 * 用法：
 *   node scripts/visualizer.mjs [--db <dir>] [--port 7421] [--embed]
 *
 * - --db    世界图数据目录（含 world.db / events.jsonl），
 *           默认 ../novel/.pi/world-graph-v2/（相对仓库根）
 * - --port  监听端口，默认 7421
 * - --embed 加载向量模型（Xenova/bge-small-zh-v1.5，首次下载较慢），
 *           启用 vector/hybrid 检索；不加载时检索强制 fulltext
 *           （Search.fulltext 不触碰 embedder，传 null 占位即可）
 */
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldGraph } from "@pi/world-graph";
import { Embedder } from "../embedder.ts";
import { Search } from "../search.ts";
import { startVisualizer } from "./server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

interface CliArgs {
  dbDir: string;
  port: number;
  embed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dbDir: resolve(repoRoot, "..", "novel", ".pi", "world-graph-v2"),
    port: 7421,
    embed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db" && argv[i + 1]) {
      args.dbDir = resolve(argv[++i]);
    } else if (a === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
      if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
        console.error(`[visualizer] 非法端口: ${args.port}`);
        process.exit(1);
      }
    } else if (a === "--embed") {
      args.embed = true;
    } else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/visualizer.mjs [--db <dir>] [--port 7421] [--embed]");
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const dbPath = join(args.dbDir, "world.db");
  const eventLogPath = join(args.dbDir, "events.jsonl");
  if (!existsSync(dbPath)) {
    console.error(`[visualizer] 世界图数据库不存在: ${dbPath}`);
    console.error("[visualizer] 请先在小说工程中运行过叙事引擎（生成 world.db），或用 --db 指定数据目录。");
    process.exit(1);
  }

  const wg = await WorldGraph.create({ dbPath, eventLogPath });

  let search: Search;
  let forceFulltext: boolean;
  if (args.embed) {
    console.log("[visualizer] 正在加载向量模型（首次需下载，请稍候）…");
    const embedder = new Embedder();
    search = new Search(wg, embedder);
    forceFulltext = false;
  } else {
    // fulltext 不依赖 embedder（见 src/search.ts），传 null 占位
    search = new Search(wg, null as unknown as Embedder);
    forceFulltext = true;
  }

  const server = await startVisualizer({ wg, search, port: args.port, forceFulltext });
  console.log(`[visualizer] 世界图可视化已启动: ${server.url}`);
  console.log(`[visualizer] 数据目录: ${args.dbDir}`);
  if (forceFulltext) {
    console.log("[visualizer] 未加载向量模型，检索使用 fulltext 模式（加 --embed 启用 hybrid）");
  }
  console.log("[visualizer] 按 Ctrl+C 停止");

  const shutdown = (): void => {
    console.log("\n[visualizer] 正在关闭…");
    server.close();
    try {
      wg.close();
    } catch {
      // 忽略关闭错误
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[visualizer] 启动失败:", err);
  process.exit(1);
});
