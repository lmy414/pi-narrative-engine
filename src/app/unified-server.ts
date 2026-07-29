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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiStatusContext, EmbedderLike } from "@pi/admin";
import { handleApi } from "../visualizer/routes.ts";
import type { VisualizerContext } from "../visualizer/routes.ts";
import {
  serveStatic,
  readBody,
  resolveDefaultUiDir,
} from "../visualizer/server.ts";
import type { DebugBus } from "../debug/types.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { handleExtApi } from "./routes-ext.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface UnifiedServerOptions {
  /** 多项目注册表（调用方持有，负责 closeAll） */
  registry: ProjectRegistry;
  /** 监听端口，默认 7421；传 0 由系统分配（测试用） */
  port?: number;
  /** 静态资源目录，缺省自动探测 visualizer-ui */
  uiDir?: string;
  /** 扩展仓库根（doctor/version/update 用），缺省为仓库根 */
  repoRoot?: string;
  /** 规则集模板目录，缺省 <repoRoot>/templates/novel */
  templatesDir?: string;
  /** PI 上下文（PI 内启动时注入；standalone 为 null） */
  piContext?: PiStatusContext | null;
  /** embedder 实例（启用向量检索时注入） */
  embedder?: EmbedderLike | null;
  /** 调试事件总线（注入后启用 /api/debug/*） */
  debugBus?: DebugBus | null;
}

export interface UnifiedServer {
  url: string;
  port: number;
  close(): void;
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

  const extCtx = {
    registry: opts.registry,
    repoRoot,
    templatesDir: opts.templatesDir ?? resolve(repoRoot, "templates", "novel"),
    piContext: opts.piContext ?? null,
    embedder: opts.embedder ?? null,
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

        // 扩展路由（files/projects/admin）优先；未命中再进世界图路由
        if (await handleExtApi(extCtx, req, res, url, body)) return;

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
