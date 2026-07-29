/**
 * main.ts — unified-server 独立启动入口
 *
 * 双模式：
 * - 开发：scripts/app-server.mjs 以 tsx 拉起（路径自动探测）
 * - 生产：esbuild 打包为 server/main.js，由 Tauri sidecar 以内置 Node 运行
 *   （此时入口同级的 visualizer-ui/ templates/ extension-snapshot/ 为打包资源，
 *   存在即显式传入，不存在回退开发模式自动探测）
 *
 * 用法：
 *   node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]
 *   node server/main.js          [--project <dir>] [--port 7421] [--embed]
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Embedder } from "../embedder.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { startUnifiedServer } from "./unified-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  const server = await startUnifiedServer({
    registry,
    port: args.port,
    embedder,
    // 生产打包布局：入口同级资源存在即显式传入；不存在走开发模式自动探测
    uiDir: existsSync(resolve(__dirname, "visualizer-ui"))
      ? resolve(__dirname, "visualizer-ui")
      : undefined,
    templatesDir: existsSync(resolve(__dirname, "templates", "novel"))
      ? resolve(__dirname, "templates", "novel")
      : undefined,
    repoRoot: existsSync(resolve(__dirname, "templates")) ? __dirname : undefined,
    extensionSnapshotDir: existsSync(resolve(__dirname, "extension-snapshot"))
      ? resolve(__dirname, "extension-snapshot")
      : existsSync(resolve(__dirname, "..", "..", "tauri-app", "src-tauri", "resources", "server", "extension-snapshot"))
        ? resolve(__dirname, "..", "..", "tauri-app", "src-tauri", "resources", "server", "extension-snapshot")
        : undefined,
  });
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
