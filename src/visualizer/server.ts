/**
 * server.ts — world-graph 可视化 HTTP 服务辅助函数（统一服务内部使用）
 *
 * 本文件只保留 unified-server 导入的静态服务与请求体解析 helper。
 * 独立启动入口（startVisualizer / VisualizerServer）已移除。
 *
 * 静态服务：uiDir 默认为 <仓库根>/frontend-demo。
 * - 开发态：src/visualizer/server.ts 上两级 = 仓库根
 * - 构建态：dist/visualizer/server.js 上两级 = 仓库根
 * - 同步态：novel/.pi/extensions/narrative-engine/visualizer/server.js
 *   上两级落在 extensions/ 下（错误），因此回退探测 ../visualizer-ui
 *   （= 扩展目录根，sync.mjs 将 visualizer-ui 复制到那里）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
export function resolveDefaultUiDir(): string {
  const candidates = [
    resolve(__dirname, "../../frontend-demo"),
    resolve(__dirname, "../frontend-demo"),
    resolve(__dirname, "../../visualizer-ui"),
    resolve(__dirname, "../visualizer-ui"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** 读取 POST 请求体（JSON），空体返回 null，解析失败抛错 */
export function readBody(req: IncomingMessage): Promise<unknown> {
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
export async function serveStatic(res: ServerResponse, uiDir: string, pathname: string): Promise<void> {
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
