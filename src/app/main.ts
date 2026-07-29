/**
 * main.ts — unified-server 独立启动入口（由 scripts/app-server.mjs 以 tsx 拉起）
 *
 * 用法：
 *   node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]
 *
 * - --project 启动后立即激活的项目目录（可省略，稍后经
 *   POST /api/projects/activate 切换）
 * - --port    监听端口，默认 7421（仅 127.0.0.1）
 * - --embed   加载向量模型（Xenova/bge-small-zh-v1.5，首次下载较慢），
 *             启用 vector/hybrid 检索；不加载时检索强制 fulltext
 */
import { resolve } from "node:path";
import { Embedder } from "../embedder.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { startUnifiedServer } from "./unified-server.ts";

interface CliArgs {
  projectDir: string | null;
  port: number;
  embed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { projectDir: null, port: 7421, embed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" && argv[i + 1]) {
      args.projectDir = resolve(argv[++i]);
    } else if (a === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
      if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
        console.error(`[app-server] 非法端口: ${args.port}`);
        process.exit(1);
      }
    } else if (a === "--embed") {
      args.embed = true;
    } else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]");
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let embedder: Embedder | null = null;
  if (args.embed) {
    console.log("[app-server] 正在加载向量模型（首次需下载，请稍候）…");
    embedder = new Embedder();
  }

  const registry = new ProjectRegistry({ embedder });
  if (args.projectDir) {
    try {
      const handle = await registry.setActive(args.projectDir);
      console.log(`[app-server] 已激活项目: ${handle.meta.name}（${handle.dir}）`);
    } catch (err) {
      console.error(`[app-server] 激活项目失败: ${(err as Error).message}`);
      console.error("[app-server] 服务仍将启动，可稍后经 /api/projects/activate 激活");
    }
  }

  const server = await startUnifiedServer({ registry, port: args.port, embedder });
  console.log(`[app-server] 统一服务已启动: ${server.url}`);
  if (!embedder) {
    console.log("[app-server] 未加载向量模型，检索使用 fulltext 模式（加 --embed 启用 hybrid）");
  }
  console.log("[app-server] 按 Ctrl+C 停止");

  const shutdown = (): void => {
    console.log("\n[app-server] 正在关闭…");
    server.close();
    void registry.closeAll().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[app-server] 启动失败:", err);
  process.exit(1);
});
