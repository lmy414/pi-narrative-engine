/**
 * routes-ext.ts — unified-server 的扩展 API 薄路由（/api/files|projects|admin）
 *
 * 三组薄 HTTP 层，分别包装：
 * - /api/files/*     → @pi/admin 的 files 模块（文件编辑器后端，§11.3）
 * - /api/projects/*  → @pi/novel-launcher + ProjectRegistry（§11.4）
 * - /api/admin/*     → @pi/admin 其余模块（config-ui 设计文档 §6）
 *
 * 响应 envelope 与 world-graph 路由一致：{ ok, data, error }。
 * 需要活跃项目的端点（files / admin 大部分）从 registry.getActive() 取
 * 项目根，未设置时返回 409 NO_ACTIVE_PROJECT。
 *
 * 安全前提：只监听 localhost，端点不做鉴权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  listFileTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  readEnvFile,
  writeEnvFile,
  getPiStatus,
  readAllRulesets,
  writeRuleset,
  resetRuleset,
  runDoctor,
  compareVersions,
  runUpdate,
  getEmbedderStatus,
  clearEmbedderCache,
  warmupEmbedder,
  readNovelJson,
  writeNovelJson,
  RULESET_NAMES,
  type RulesetName,
  type PiStatusContext,
  type EmbedderLike,
} from "@pi/admin";
import {
  discoverProjects,
  getProjectMeta,
  createProject,
  launchPi,
  openInFileManager,
} from "@pi/novel-launcher";
import { _ok as ok, _fail as fail } from "../visualizer/routes.ts";
import type { ProjectRegistry } from "./project-registry.ts";

export interface ExtApiContext {
  registry: ProjectRegistry;
  /** 扩展仓库根（doctor / version / update 用） */
  repoRoot: string;
  /** 规则集模板目录（reset 用） */
  templatesDir: string;
  /** PI 上下文（standalone 下为 null，pi-status 降级展示） */
  piContext: PiStatusContext | null;
  /** embedder 实例（embedder status/warmup 用，可为 null） */
  embedder: EmbedderLike | null;
}

/** 错误 code → HTTP 状态映射（缺省 400） */
const ERROR_STATUS: Record<string, number> = {
  MISSING_FIELD: 400,
  INVALID_BODY: 400,
  INVALID_EXT: 400,
  PATH_ESCAPE: 403,
  FILE_NOT_FOUND: 404,
  NOT_A_FILE: 404,
  DIR_NOT_FOUND: 404,
  NOVEL_JSON_NOT_FOUND: 404,
  WORLD_DB_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  FILE_EXISTS: 409,
  MTIME_CONFLICT: 409,
  UPDATE_RUNNING: 409,
  NO_ACTIVE_PROJECT: 409,
  EMBEDDER_UNAVAILABLE: 501,
};

/** 一键更新单任务守卫（同一时刻只允许一个 update job） */
let updateRunning = false;

/** 取活跃项目目录，未设置时抛 NO_ACTIVE_PROJECT */
function requireActiveDir(ctx: ExtApiContext): string {
  const active = ctx.registry.getActive();
  if (!active) {
    const err = new Error("尚未激活项目（先 POST /api/projects/activate）") as Error & {
      code?: string;
    };
    err.code = "NO_ACTIVE_PROJECT";
    throw err;
  }
  return active.dir;
}

function requireBody(body: unknown, fields: string[]): Record<string, unknown> {
  if (body === null || typeof body !== "object") {
    const err = new Error("请求体必须是 JSON 对象") as Error & { code?: string };
    err.code = "INVALID_BODY";
    throw err;
  }
  const obj = body as Record<string, unknown>;
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      const err = new Error(`请求体缺少字段 ${f}`) as Error & { code?: string };
      err.code = "MISSING_FIELD";
      throw err;
    }
  }
  return obj;
}

/**
 * 处理 /api/files|projects|admin 请求。
 *
 * @returns true = 已处理（响应已写出）；false = 非扩展路由，调用方继续分发
 */
export async function handleExtApi(
  ctx: ExtApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
): Promise<boolean> {
  const segments = url.pathname
    .slice("/api".length)
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const [head] = segments;
  if (head !== "files" && head !== "projects" && head !== "admin") return false;

  // 更新 SSE 流不能进入常规 try/catch（res 生命周期由流管理）
  if (head === "admin" && segments[1] === "update" && segments[2] === "stream") {
    handleUpdateStream(ctx, res, url);
    return true;
  }

  const method = req.method ?? "GET";
  try {
    if (head === "files") await handleFiles(ctx, method, res, url, segments, body);
    else if (head === "projects") await handleProjects(ctx, method, res, url, segments, body);
    else await handleAdmin(ctx, method, res, segments, body);
  } catch (err) {
    const e = err as Error & { code?: string };
    const code = e.code ?? "INTERNAL_ERROR";
    fail(res, ERROR_STATUS[code] ?? (code === "INTERNAL_ERROR" ? 500 : 400), code, e.message);
  }
  return true;
}

// ============================================================================
// /api/files/*
// ============================================================================

async function handleFiles(
  ctx: ExtApiContext,
  method: string,
  res: ServerResponse,
  url: URL,
  segments: string[],
  body: unknown,
): Promise<void> {
  const [, sub] = segments;

  if (sub === "tree" && method === "GET") {
    ok(res, { tree: await listFileTree(requireActiveDir(ctx)) });
    return;
  }
  if (sub === "read" && method === "GET") {
    const p = url.searchParams.get("path");
    if (!p) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 path");
      return;
    }
    ok(res, await readProjectFile(requireActiveDir(ctx), p));
    return;
  }
  if (sub === "write" && method === "PUT") {
    const obj = requireBody(body, ["path", "content"]);
    ok(res, await writeProjectFile(
      requireActiveDir(ctx),
      String(obj.path),
      String(obj.content),
      obj.baseMtime !== undefined ? String(obj.baseMtime) : undefined,
    ));
    return;
  }
  if (sub === "create" && method === "POST") {
    const obj = requireBody(body, ["path"]);
    ok(res, await createProjectFile(requireActiveDir(ctx), String(obj.path)), 201);
    return;
  }
  if (sub === "delete" && method === "POST") {
    const obj = requireBody(body, ["path"]);
    ok(res, await deleteProjectFile(requireActiveDir(ctx), String(obj.path)));
    return;
  }
  fail(res, 404, "NOT_FOUND", `未找到路由 ${method} ${url.pathname}`);
}

// ============================================================================
// /api/projects/*
// ============================================================================

async function handleProjects(
  ctx: ExtApiContext,
  method: string,
  res: ServerResponse,
  url: URL,
  segments: string[],
  body: unknown,
): Promise<void> {
  const [, sub] = segments;

  // GET /api/projects/scan?root=&maxDepth=
  if (sub === "scan" && method === "GET") {
    const root = url.searchParams.get("root");
    if (!root) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 root");
      return;
    }
    const maxDepthRaw = url.searchParams.get("maxDepth");
    const projects = await discoverProjects(root, {
      maxDepth: maxDepthRaw ? Number(maxDepthRaw) : undefined,
    });
    ok(res, { projects });
    return;
  }

  // GET /api/projects/meta?dir=
  if (sub === "meta" && method === "GET") {
    const dir = url.searchParams.get("dir");
    if (!dir) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 dir");
      return;
    }
    ok(res, { meta: await getProjectMeta(dir) });
    return;
  }

  // GET /api/projects/active — 当前活跃项目 + 已打开列表
  if (sub === "active" && method === "GET") {
    const active = ctx.registry.getActive();
    ok(res, {
      active: active
        ? { dir: active.dir, name: active.meta.name, forceFulltext: active.forceFulltext }
        : null,
      open: ctx.registry.listOpen(),
    });
    return;
  }

  // POST /api/projects/activate — body { dir }
  if (sub === "activate" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const handle = await ctx.registry.setActive(String(obj.dir));
    ok(res, { dir: handle.dir, name: handle.meta.name, forceFulltext: handle.forceFulltext });
    return;
  }

  // POST /api/projects/create — body { dir, name?, force? }
  if (sub === "create" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const result = await createProject(String(obj.dir), {
      name: obj.name !== undefined ? String(obj.name) : undefined,
      force: obj.force === true,
    });
    ok(res, result, 201);
    return;
  }

  // POST /api/projects/launch-pi — body { dir, args? }
  if (sub === "launch-pi" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const result = await launchPi(String(obj.dir), {
      args: Array.isArray(obj.args) ? obj.args.map(String) : undefined,
    });
    ok(res, result);
    return;
  }

  // POST /api/projects/open-folder — body { dir }
  if (sub === "open-folder" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    await openInFileManager(String(obj.dir));
    ok(res, { dir: String(obj.dir) });
    return;
  }

  // POST /api/projects/close — body { dir }（关闭句柄释放 wg）
  if (sub === "close" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    await ctx.registry.closeProject(String(obj.dir));
    ok(res, { dir: String(obj.dir) });
    return;
  }

  fail(res, 404, "NOT_FOUND", `未找到路由 ${method} ${url.pathname}`);
}

// ============================================================================
// /api/admin/*
// ============================================================================

async function handleAdmin(
  ctx: ExtApiContext,
  method: string,
  res: ServerResponse,
  segments: string[],
  body: unknown,
): Promise<void> {
  const [, sub, name] = segments;

  // GET/PUT /api/admin/config — 扩展专属 .env（活跃项目根下）
  if (sub === "config" && segments.length === 2) {
    const envPath = join(requireActiveDir(ctx), ".env");
    if (method === "GET") {
      ok(res, await readEnvFile(envPath));
      return;
    }
    if (method === "PUT") {
      const obj = requireBody(body, []);
      const updates: Record<string, string | undefined> = {};
      for (const key of ["HF_ENDPOINT", "PI_DEBUG", "PI_EMBEDDER_MODEL"] as const) {
        if (key in obj) updates[key] = obj[key] === null ? undefined : String(obj[key]);
      }
      ok(res, await writeEnvFile(envPath, updates));
      return;
    }
  }

  // GET /api/admin/pi-status — PI 状态只读
  if (sub === "pi-status" && method === "GET") {
    const piCtx: PiStatusContext = ctx.piContext ?? {
      model: null,
      modelRegistry: { hasConfiguredAuth: () => false },
    };
    ok(res, await getPiStatus(piCtx));
    return;
  }

  // GET /api/admin/rulesets — 三件套全量
  if (sub === "rulesets" && !name && method === "GET") {
    ok(res, { rulesets: await readAllRulesets(requireActiveDir(ctx)) });
    return;
  }

  // PUT /api/admin/rulesets/:name — body { content }
  if (sub === "rulesets" && name && method === "PUT") {
    assertRulesetName(name);
    const obj = requireBody(body, ["content"]);
    ok(res, await writeRuleset(requireActiveDir(ctx), name, String(obj.content)));
    return;
  }

  // POST /api/admin/rulesets/:name/reset
  if (sub === "rulesets" && name && segments[3] === "reset" && method === "POST") {
    assertRulesetName(name);
    ok(res, await resetRuleset(
      { novelDir: requireActiveDir(ctx), templatesDir: ctx.templatesDir },
      name,
    ));
    return;
  }

  // GET /api/admin/doctor
  if (sub === "doctor" && method === "GET") {
    const active = ctx.registry.getActive();
    ok(res, await runDoctor({
      repoRoot: ctx.repoRoot,
      novelDir: active?.dir,
    }));
    return;
  }

  // GET /api/admin/version — 本地/远程版本对比
  if (sub === "version" && method === "GET") {
    ok(res, await compareVersions(ctx.repoRoot));
    return;
  }

  // GET /api/admin/embedder/status
  if (sub === "embedder" && name === "status" && method === "GET") {
    ok(res, await getEmbedderStatus(ctx.repoRoot, ctx.embedder ?? undefined));
    return;
  }

  // POST /api/admin/embedder/cache/clear
  if (sub === "embedder" && name === "cache" && segments[3] === "clear" && method === "POST") {
    ok(res, await clearEmbedderCache(ctx.repoRoot));
    return;
  }

  // POST /api/admin/embedder/warmup
  if (sub === "embedder" && name === "warmup" && method === "POST") {
    if (!ctx.embedder) {
      fail(res, 501, "EMBEDDER_UNAVAILABLE", "embedder 未加载（启动时未启用向量模型）");
      return;
    }
    ok(res, await warmupEmbedder(ctx.embedder));
    return;
  }

  // GET/PUT /api/admin/novel-json
  if (sub === "novel-json" && segments.length === 2) {
    if (method === "GET") {
      ok(res, await readNovelJson(requireActiveDir(ctx)));
      return;
    }
    if (method === "PUT") {
      const obj = requireBody(body, []);
      ok(res, await writeNovelJson(requireActiveDir(ctx), obj));
      return;
    }
  }

  fail(res, 404, "NOT_FOUND", `未找到路由 ${method} /api/${segments.join("/")}`);
}

function assertRulesetName(name: string): asserts name is RulesetName {
  if (!(RULESET_NAMES as readonly string[]).includes(name)) {
    const err = new Error(`未知规则集: ${name}（可选 ${RULESET_NAMES.join("/")}）`) as Error & {
      code?: string;
    };
    err.code = "MISSING_FIELD";
    throw err;
  }
}

// ============================================================================
// /api/admin/update/stream（SSE）
// ============================================================================

/**
 * GET /api/admin/update/stream?targetDir=
 *
 * 单任务守卫：已有 update 在跑时立即以 error 事件结束（HTTP 仍 200，
 * 因为 SSE 头必须先写）。targetDir 缺省为活跃项目的扩展目录。
 */
function handleUpdateStream(ctx: ExtApiContext, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  });
  const sendEvent = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (updateRunning) {
    sendEvent({ stage: "error", line: "", error: "已有更新任务在进行中" });
    res.end();
    return;
  }

  const targetDir =
    url.searchParams.get("targetDir") ??
    (ctx.registry.getActive()
      ? join(ctx.registry.getActive()!.dir, ".pi", "extensions", "narrative-engine")
      : null);
  if (!targetDir) {
    sendEvent({ stage: "error", line: "", error: "未指定 targetDir 且无活跃项目" });
    res.end();
    return;
  }

  updateRunning = true;
  void (async () => {
    try {
      for await (const evt of runUpdate({ repoRoot: ctx.repoRoot, targetDir })) {
        sendEvent(evt);
        if (evt.stage === "done" || evt.stage === "error") break;
      }
    } catch (err) {
      sendEvent({ stage: "error", line: "", error: (err as Error).message });
    } finally {
      updateRunning = false;
      res.end();
    }
  })();
}
