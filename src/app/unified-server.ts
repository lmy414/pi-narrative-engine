/**
 * unified-server.ts — 应用化统一服务（阶段 1）
 *
 * 一个 HTTP 服务同时承载：
 * - 世界图路由（复用 src/visualizer/routes.ts，上下文取 ProjectRegistry
 *   的活跃项目，支持多项目切换）
 * - /api/files/*     文件编辑器后端（@pi/admin files）
 * - /api/projects/*  项目管理（@pi/novel-launcher + ProjectRegistry）
 * - /api/admin/*     配置管理（@pi/admin）
 * - 静态服务 visualizer-ui
 *
 * 设计依据：docs/plans/2026-07-29-app-architecture-design.md §4.1、§11
 *
 * 安全前提：只监听 localhost，端点不做鉴权。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { PiStatusDeps, ResolvedModel, EmbedderLike } from "@pi/admin";
import { _defaultConfigDir } from "@pi/admin";
import { handleApi } from "../visualizer/routes.ts";
import type { VisualizerContext } from "../visualizer/routes.ts";
import {
  serveStatic,
  readBody,
  resolveDefaultUiDir,
} from "../visualizer/server.ts";
import type { DebugBus } from "../debug/types.ts";
import type { LlmConfigStore } from "../orchestrator/llm-config.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { handleExtApi } from "./routes-ext.ts";
import { handleChatApi } from "./routes-chat.ts";
import { handleSchedulerApi } from "./routes-scheduler.ts";
import { resolveSlot } from "./llm-resolver.ts";
import type { ChatContext } from "./chat-context.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface UnifiedServerOptions {
  /** 多项目注册表（调用方持有，负责 closeAll） */
  registry: ProjectRegistry;
  /** 监听端口，默认 7421；传 0 由系统分配（测试用） */
  port?: number;
  /** 静态资源目录，缺省自动探测 visualizer-ui */
  uiDir?: string;
  /** 扩展仓库根（doctor/version 用），缺省为仓库根 */
  repoRoot?: string;
  /** 规则集模板目录，缺省 <repoRoot>/templates/novel */
  templatesDir?: string;
  /** 应用配置目录（agentDir = <configDir>/pi-agent；缺省 = appConfigDir ?? 平台默认目录） */
  configDir?: string;
  /** LLM 配置中心（pi-status 的模型解析源；null 时 pi-status 降级展示） */
  llmConfigStore?: LlmConfigStore | null;
  /** embedder 实例（启用向量检索时注入） */
  embedder?: EmbedderLike | null;
  /** 调试事件总线（注入后启用 /api/debug/*） */
  debugBus?: DebugBus | null;
  /** 应用配置目录（缺省为平台默认目录，测试注入临时目录） */
  appConfigDir?: string;
  /** 主会话运行时上下文（注入后启用 /api/chat/*；null 时端点返回 503） */
  chatContext?: ChatContext | null;
}

export interface UnifiedServer {
  url: string;
  port: number;
  close(): void;
}

/**
 * 从 LlmConfigStore 解析当前模型（pi-status 展示用）
 *
 * 解析链与 chat-context resolveModelConfig 一致：default slot → env。
 * 模型解析复用 llm-resolver.resolveSlot（与 /api/admin/llm 单一口径）；
 * hasKey 由 getPiStatus 内部经 authStorage 回退判定，此处只覆盖配置链。
 */
function resolveModelFromStore(store: LlmConfigStore | null): ResolvedModel | null {
  if (!store) return null;
  const resolved = resolveSlot(store, "default");
  if (!resolved) return null;
  let hasKey = false;
  try {
    store.getApiKey("default");
    hasKey = true;
  } catch {
    // 配置链与 env 均无 key —— getPiStatus 会再查 auth.json
  }
  return { provider: resolved.provider, modelId: resolved.modelId, hasKey };
}

/**
 * 启动统一服务。
 *
 * 世界图路由需要活跃项目：未激活时返回 409 NO_ACTIVE_PROJECT
 * （/api/files|projects|admin 不受此限——projects/activate 本身必须先可用）。
 */
export function startUnifiedServer(opts: UnifiedServerOptions): Promise<UnifiedServer> {
  const repoRoot = opts.repoRoot ?? resolve(__dirname, "../..");
  const uiDir = opts.uiDir ?? resolveDefaultUiDir();

  // LLM 依赖：authStorage 实例（与主会话运行时实例读写同一 auth.json）；
  // resolveModel 走 LlmConfigStore default slot → env（与 /api/admin/llm 共用 llm-resolver 口径）
  const configDir = opts.configDir ?? opts.appConfigDir ?? _defaultConfigDir();
  const authStorage = AuthStorage.create(join(configDir, "pi-agent", "auth.json"));
  const llmStore = opts.llmConfigStore ?? null;
  const piStatusDeps: PiStatusDeps = {
    authStorage,
    resolveModel: () => resolveModelFromStore(llmStore),
  };

  const extCtx = {
    registry: opts.registry,
    repoRoot,
    templatesDir: opts.templatesDir ?? resolve(repoRoot, "templates", "novel"),
    piStatus: piStatusDeps,
    llm: llmStore
      ? {
          store: llmStore,
          authStorage,
          // slot/key 变更后尽力热应用到运行中的主会话；失败时下次会话生效
          onChange: () => {
            void opts.chatContext?.applyLlmChange().catch(() => {
              // 热生效失败（如模型无可用 key）不阻断配置写入，下次会话生效
            });
          },
        }
      : null,
    embedder: opts.embedder ?? null,
    // app-config.json 与 auth.json 同一配置目录（缺省 = configDir，避免写穿到平台默认目录）
    appConfigDir: opts.appConfigDir ?? configDir,
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        let body: unknown = null;
        if (req.method === "POST" || req.method === "PUT") {
          try {
            body = await readBody(req);
          } catch (err) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              ok: false,
              data: null,
              error: { code: "INVALID_JSON", message: (err as Error).message },
            }));
            return;
          }
        }

        // 扩展路由（files/projects/admin）优先；chat/scheduler 路由其次；未命中再进世界图路由
        if (await handleExtApi(extCtx, req, res, url, body)) return;

        if (opts.chatContext) {
          const chatContext = opts.chatContext;
          if (await handleChatApi(
            { chatContext, registry: opts.registry, debugBus: opts.debugBus ?? null },
            req,
            res,
            url,
            body,
          )) return;
          if (await handleSchedulerApi(
            {
              registry: opts.registry,
              getService: (cwd) => chatContext.ensureOrchestratorService(cwd),
              appConfigDir: opts.appConfigDir ?? configDir,
            },
            req,
            res,
            url,
            body,
          )) return;
        } else if (url.pathname.startsWith("/api/chat") || url.pathname.startsWith("/api/scheduler")) {
          // 未注入 chatContext（如无 AI 需求的部署）→ 明确 503
          res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false,
            data: null,
            error: { code: "CHAT_UNAVAILABLE", message: "主会话未启用（服务未装配 ChatContext）" },
          }));
          return;
        }

        const active = opts.registry.getActive();
        if (!active) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false,
            data: null,
            error: {
              code: "NO_ACTIVE_PROJECT",
              message: "尚未激活项目（先 POST /api/projects/activate）",
            },
          }));
          return;
        }
        const vizCtx: VisualizerContext = {
          wg: active.wg,
          search: active.search,
          forceFulltext: active.forceFulltext,
          debugBus: opts.debugBus ?? null,
        };
        await handleApi(vizCtx, req, res, url, body);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(res, uiDir, url.pathname);
        return;
      }
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
    })().catch((err) => {
      // 兜底：任何未捕获异常都返回 500 envelope，绝不让连接悬挂
      try {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: false,
          data: null,
          error: { code: "INTERNAL_ERROR", message: (err as Error).message },
        }));
      } catch {
        // 响应已部分写出时无法再补救
      }
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(opts.port ?? 7421, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 7421);
      resolvePromise({
        url: `http://localhost:${port}/`,
        port,
        close() {
          server.close();
        },
      });
    });
  });
}
