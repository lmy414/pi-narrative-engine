/**
 * main.ts — unified-server 独立启动入口
 *
 * 双模式：
 * - 开发：scripts/app-server.mjs 以 tsx 拉起（路径自动探测）
 * - 生产：esbuild 打包为 server/main.js，由 Tauri sidecar 以内置 Node 运行
 *   （此时入口同级的 frontend-demo/ templates/ 为打包资源，存在即显式传入，
 *   不存在回退开发模式自动探测）
 *
 * 用法：
 *   node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed] [--config-dir <dir>]
 *   node server/main.js          [--project <dir>] [--port 7421] [--embed] [--config-dir <dir>]
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { Embedder } from "../embedder.ts";
import { createDebugBus } from "../debug/bus.ts";
import { LlmConfigStore } from "../orchestrator/llm-config.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";
import { ChatContext } from "./chat-context.ts";
import { setSchedulerDefaultMode } from "../chat/scheduler-tools.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { activateStartupProject } from "./startup-project.ts";
import { startUnifiedServer } from "./unified-server.ts";
import { _defaultConfigDir, readAppConfig } from "@pi/admin";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  projectDir: string | null;
  port: number;
  embed: boolean;
  configDir: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { projectDir: null, port: 7421, embed: false, configDir: null };
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
    } else if (a === "--config-dir" && argv[i + 1]) {
      args.configDir = resolve(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed] [--config-dir <dir>]");
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

  // 应用配置目录：--config-dir（测试/冒烟隔离）优先，缺省平台目录
  const configDir = args.configDir ?? _defaultConfigDir();
  const appConfig = await readAppConfig(configDir);

  // 主会话/子代理共用配置中心：启动时用 app-config 持久化的 slot 映射水合
  const llmStore = new LlmConfigStore();
  for (const [slot, cfg] of Object.entries(appConfig.llm.slots)) {
    if (!cfg) continue;
    llmStore.setConfig(slot as LlmSlot, {
      model: { provider: cfg.provider as KnownProvider, name: cfg.model },
    });
  }
  // B7：会话级默认执行模式水合（dispatch 未显式传 mode 时生效）
  setSchedulerDefaultMode(appConfig.scheduler.defaultMode);

  // 调试总线（/api/debug/* + 编排四阶段/chat span 埋点；默认开启，types 无级别开关）
  const debugBus = createDebugBus();

  const registry = new ProjectRegistry({ embedder });
  // 启动项目：--project 优先；其次 app-config 记住的 lastProjectDir（失败只警告不阻断）
  const startupHandle = await activateStartupProject(registry, {
    cliProjectDir: args.projectDir,
    lastProjectDir: appConfig.launcher.lastProjectDir,
    warn: (msg) => console.error(`[app-server] ${msg}`),
  });
  if (startupHandle) {
    console.log(`[app-server] 已激活项目: ${startupHandle.meta.name}（${startupHandle.dir}）`);
  }

  // 主会话运行时上下文（/api/chat/*）：模型配置与子代理同源（LlmConfigStore，env 兜底）
  const chatContext = new ChatContext({
    registry,
    llmStore,
    configDir,
    embedder,
    debugBus,
  });

  const server = await startUnifiedServer({
    registry,
    port: args.port,
    embedder,
    chatContext,
    configDir,
    appConfigDir: configDir,
    llmConfigStore: llmStore,
    debugBus,
    // 生产打包布局：入口同级资源存在即显式传入；不存在走开发模式自动探测
    uiDir: existsSync(resolve(__dirname, "frontend-demo"))
      ? resolve(__dirname, "frontend-demo")
      : undefined,
    templatesDir: existsSync(resolve(__dirname, "templates", "novel"))
      ? resolve(__dirname, "templates", "novel")
      : undefined,
    repoRoot: existsSync(resolve(__dirname, "templates")) ? __dirname : undefined,
  });
  console.log(`[app-server] 统一服务已启动: ${server.url}`);
  if (!embedder) {
    console.log("[app-server] 未加载向量模型，检索使用 fulltext 模式（加 --embed 启用 hybrid）");
  }
  console.log("[app-server] 按 Ctrl+C 停止");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[app-server] 正在关闭…");
    void Promise.all([registry.closeAll(), server.close()])
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[app-server] 关闭失败:", error);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[app-server] 启动失败:", err);
  process.exit(1);
});
