/**
 * server.ts — world-graph 可视化 HTTP 服务（node:http，零新增依赖）
 *
 * 双入口共用：
 * - standalone（scripts/visualizer.mjs → src/visualizer/standalone.ts）
 * - pi 扩展内（src/index.ts 的 open_visualizer 工具）
 *
 * 静态服务：uiDir 默认为 <仓库根>/visualizer-ui。
 * - 开发态：src/visualizer/server.ts 上两级 = 仓库根
 * - 构建态：dist/visualizer/server.js 上两级 = 仓库根
 * - 同步态：novel/.pi/extensions/narrative-engine/visualizer/server.js
 *   上两级落在 extensions/ 下（错误），因此回退探测 ../visualizer-ui
 *   （= 扩展目录根，sync.mjs 将 visualizer-ui 复制到那里）。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldGraph } from "@pi/world-graph";
import type { Search } from "../search.ts";
import type { DebugBus } from "../debug/types.ts";
import { handleApi } from "./routes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface StartVisualizerOptions {
  wg: WorldGraph;
  search?: Search | null;
  port?: number;
  uiDir?: string;
  /** standalone 无 embedder 时置 true：/api/search 强制 fulltext */
  forceFulltext?: boolean;
  /** 调试事件总线（注入后启用 /api/debug/* 端点） */
  debugBus?: DebugBus;
}

export interface VisualizerServer {
  url: string;
  port: number;
  close(): void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** 解析默认 uiDir：兼容开发/构建（上两级）与同步到扩展目录（上一级）两种布局 */
function resolveDefaultUiDir(): string {
  const candidates = [
    resolve(__dirname, "../../visualizer-ui"),
    resolve(__dirname, "../visualizer-ui"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** 读取 POST 请求体（JSON），空体返回 null，解析失败抛错 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolvePromise(null);
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", rejectPromise);
  });
}

/** 静态文件服务：防路径穿越，未知文件 404 */
async function serveStatic(res: ServerResponse, uiDir: string, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = normalize(join(uiDir, rel));
  if (!filePath.startsWith(normalize(uiDir))) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

/**
 * 启动可视化服务。
 * port 缺省 7421；传 0 由系统分配（测试用），实际端口从返回值读取。
 */
export function startVisualizer(opts: StartVisualizerOptions): Promise<VisualizerServer> {
  const uiDir = opts.uiDir ?? resolveDefaultUiDir();
  const ctx = {
    wg: opts.wg,
    search: opts.search ?? null,
    forceFulltext: opts.forceFulltext ?? false,
    debugBus: opts.debugBus ?? null,
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // 仅匹配 /api 或 /api/...，避免 /api.js 这类静态文件被误判为 API
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        let body: unknown = null;
        if (req.method === "POST") {
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
        await handleApi(ctx, req, res, url, body);
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
    server.listen(opts.port ?? 7421, () => {
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
