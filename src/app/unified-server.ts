/**
 * unified-server.ts — 应用化统一服务（阶段 1）
 *
 * 一个 HTTP 服务同时承载：
 * - 世界图路由（复用 src/visualizer/routes.ts，上下文取 ProjectRegistry
 *   的活跃项目，支持多项目切换）
 * - /api/files/*     文件编辑器后端（@pi/admin files）
 * - /api/projects/*  项目管理（@pi/novel-launcher + ProjectRegistry）
 * - /api/admin/*     配置管理（@pi/admin）
 * - 静态服务 frontend-demo（旧版 visualizer-ui 已随扩展机制废弃删除）
 *
 * 设计依据：docs/plans/2026-07-29-app-architecture-design.md §4.1、§11
 *
 * 安全前提：只监听 localhost，端点不做鉴权。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmodSync, existsSync } from "node:fs";
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

/** 允许跨源访问的 Origin 白名单（Tauri 壳 + 本机同端口）；无 Origin/Referer（CLI/curl）放行 */
const ALLOWED_ORIGIN_HOSTS = new Set<string>([
  "tauri://localhost",
  "http://tauri.localhost",
]);

function originAllowed(origin: string, port: number): boolean {
  if (ALLOWED_ORIGIN_HOSTS.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
    if (u.port === "") return false; // 缺省端口（80/443）不可能是本服务
    return Number(u.port) === port;
  } catch {
    return false;
  }
}

export interface UnifiedServerOptions {
  /** 多项目注册表（调用方持有，负责 closeAll） */
  registry: ProjectRegistry;
  /** 监听端口，默认 7421；传 0 由系统分配（测试用） */
  port?: number;
  /** 静态资源目录，缺省自动探测 frontend-demo */
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
  /**
   * 共享 AuthStorage 实例（与 LlmConfigStore.apiKeyResolver 同源，保证 admin API
   * 写入的自定义厂商密钥对子代理可见；缺省由本服务自建，读取同一 auth.json）。
   */
  authStorage?: AuthStorage | null;
  /** 主会话运行时上下文（注入后启用 /api/chat/*；null 时端点返回 503） */
  chatContext?: ChatContext | null;
}

export interface UnifiedServer {
  url: string;
  port: number;
  close(): Promise<void>;
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

  // SSE 全局连接上限（🔴-7：防 fd 耗尽；SSE 端点共享配额）
  const MAX_SSE_CONNECTIONS = 10;
  let sseConnectionCount = 0;

  /** 申请/释放 SSE 连接配额；返回是否成功 */
  function tryAcquireSse(): boolean {
    if (sseConnectionCount >= MAX_SSE_CONNECTIONS) return false;
    sseConnectionCount += 1;
    return true;
  }
  function releaseSse(): void {
    sseConnectionCount = Math.max(0, sseConnectionCount - 1);
  }

  // LLM 依赖：authStorage 实例（与主会话运行时实例读写同一 auth.json）；
  // resolveModel 走 LlmConfigStore default slot → env（与 /api/admin/llm 共用 llm-resolver 口径）
  const configDir = opts.configDir ?? opts.appConfigDir ?? _defaultConfigDir();
  const authPath = join(configDir, "pi-agent", "auth.json");
  // M-Sec-4：AuthStorage 仅在新文件创建/写入后 chmod 0o600（目录 0o700），
  // 对旧版本创建的存量 auth.json 不会修正权限，此处显式收紧一次；
  // Windows 上 chmod 为 no-op，文件 ACL 由系统继承控制，注释存疑以备案。
  if (existsSync(authPath)) {
    try {
      chmodSync(authPath, 0o600);
    } catch {
      // 权限收紧失败不影响启动（读取仍由 AuthStorage 负责）
    }
  }
  const authStorage = opts.authStorage ?? AuthStorage.create(authPath);
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
    // M-Sec-1：HTTP 安全头统一下发（writeHead 的同名 header 会覆盖，其余合并保留）。
    // nosniff 防 MIME 嗅探误判；DENY 防点击劫持；no-referrer 防路径/查询泄漏给外部站点
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        // 同源校验：浏览器跨站请求（CSRF / 任意网页操控本地服务）直接 403。
        // 仅校验 /api/*（静态资源与 SSE 无鉴权语义）；无 Origin 的 CLI 客户端放行。
        const origin = req.headers.origin;
        if (origin) {
          const port = server.address() && typeof server.address() === "object"
            ? (server.address() as { port: number }).port
            : (opts.port ?? 7421);
          if (!originAllowed(origin, port)) {
            res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              ok: false,
              data: null,
              error: { code: "ORIGIN_REJECTED", message: "跨站请求被拒绝（Origin 不在白名单）" },
            }));
            return;
          }
          // 白名单内的跨源（Tauri 壳 origin 与 127.0.0.1 变体）回显精确 Origin，替代通配 *
          res.setHeader("access-control-allow-origin", origin);
          res.setHeader("vary", "Origin");
        }
        let body: unknown = null;
        if (req.method === "POST" || req.method === "PUT") {
          try {
            body = await readBody(req);
          } catch (err) {
            const tooLarge = (err as Error & { code?: string }).code === "MAX_BODY_SIZE";
            res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              ok: false,
              data: null,
              error: {
                code: tooLarge ? "MAX_BODY_SIZE" : "INVALID_JSON",
                message: (err as Error).message,
              },
            }));
            return;
          }
        }

        // SSE 端点统一配额（🔴-7：防 fd 耗尽）。识别 /api/chat/events 与 /api/debug/stream；
        // 配额满返回 503，成功连接在 res close 时释放。
        const isSseEndpoint = req.method === "GET" &&
          (url.pathname === "/api/chat/events" || url.pathname === "/api/debug/stream");
        if (isSseEndpoint && !tryAcquireSse()) {
          res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false,
            data: null,
            error: { code: "SSE_LIMIT_REACHED", message: `SSE 连接数已达上限（${MAX_SSE_CONNECTIONS}）` },
          }));
          return;
        }
        if (isSseEndpoint) {
          res.on("close", releaseSse);
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
    // 超时防护（🔴-7）：慢请求头/体超时兜底；SSE 长连接不受影响
    // （requestTimeout 只约束请求接收阶段；响应期由心跳 keep-alive 维持）
    server.headersTimeout = 60_000;
    server.requestTimeout = 30_000;
    server.listen(opts.port ?? 7421, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 7421);
      resolvePromise({
        url: `http://127.0.0.1:${port}/`,
        port,
        async close() {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
          await opts.chatContext?.dispose();
        },
      });
    });
  });
}
