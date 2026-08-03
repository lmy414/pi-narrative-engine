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
import { isAbsolute, join, relative, resolve } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  listFileTree,
  readProjectFile,
  writeProjectFile,
  createProjectFile,
  deleteProjectFile,
  renameProjectFile,
  readEnvFile,
  writeEnvFile,
  getPiStatus,
  readAllRulesets,
  writeRuleset,
  resetRuleset,
  runDoctor,
  compareVersions,
  getEmbedderStatus,
  clearEmbedderCache,
  warmupEmbedder,
  readNovelJson,
  writeNovelJson,
  readAppConfig,
  writeAppConfig,
  RULESET_NAMES,
  LLM_SLOT_NAMES,
  type RulesetName,
  type PiStatusDeps,
  type EmbedderLike,
  type AppConfigUpdates,
  type LlmSlotName,
} from "@pi/admin";
import {
  discoverProjects,
  getProjectMeta,
  createProject,
  openInFileManager,
} from "@pi/novel-launcher";
import { _ok as ok, _fail as fail } from "../visualizer/routes.ts";
import type { LlmConfigStore, LlmSlot } from "../orchestrator/llm-config.ts";
import type { ProjectRegistry } from "./project-registry.ts";
import { getSlotStatus } from "./llm-resolver.ts";

/** /api/admin/llm 端点的装配依赖（null 时 llm 端点 503） */
export interface LlmApiDeps {
  store: LlmConfigStore;
  /** 可写 AuthStorage（set/remove 落盘 auth.json） */
  authStorage: AuthStorage;
  /** slot/key 变更回调（主会话热生效，尽力而为） */
  onChange?: () => void;
}

export interface ExtApiContext {
  registry: ProjectRegistry;
  /** 扩展仓库根（doctor / version 用） */
  repoRoot: string;
  /** 规则集模板目录（reset 用） */
  templatesDir: string;
  /** LLM 状态依赖（authStorage + resolveModel；null 时 pi-status 降级展示） */
  piStatus: PiStatusDeps | null;
  /** LLM 配置端点依赖（/api/admin/llm*；null 时这些端点 503） */
  llm: LlmApiDeps | null;
  /** embedder 实例（embedder status/warmup 用，可为 null） */
  embedder: EmbedderLike | null;
  /** 应用配置目录（缺省为平台默认目录，测试注入临时目录） */
  appConfigDir?: string;
}

/** 错误 code → HTTP 状态映射（缺省 400） */
const ERROR_STATUS: Record<string, number> = {
  MISSING_FIELD: 400,
  INVALID_BODY: 400,
  INVALID_EXT: 400,
  INVALID_SLOT: 400,
  INVALID_MODEL: 400,
  PATH_ESCAPE: 403,
  FILE_NOT_FOUND: 404,
  NOT_A_FILE: 404,
  DIR_NOT_FOUND: 404,
  NOVEL_JSON_NOT_FOUND: 404,
  WORLD_DB_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  FILE_EXISTS: 409,
  MTIME_CONFLICT: 409,
  NO_ACTIVE_PROJECT: 409,
  MIGRATION_REQUIRED: 409,
  PROJECT_OPEN: 409,
  EMBEDDER_UNAVAILABLE: 501,
  LLM_UNAVAILABLE: 503,
};

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

/** 持久化 lastProjectDir（书签性质：写失败不阻断 activate/close 主流程） */
async function persistLastProjectDir(ctx: ExtApiContext, dir: string | null): Promise<void> {
  try {
    await writeAppConfig({ launcher: { lastProjectDir: dir } }, ctx.appConfigDir);
  } catch {
    // app-config 不可写时静默跳过——书签丢失不影响激活/关闭本身
  }
}

/** 取 LLM 端点依赖，未装配时抛 LLM_UNAVAILABLE（503） */
function requireLlm(ctx: ExtApiContext): LlmApiDeps {
  if (!ctx.llm) {
    const err = new Error("LLM 配置端点未装配（服务未注入 LlmConfigStore）") as Error & {
      code?: string;
    };
    err.code = "LLM_UNAVAILABLE";
    throw err;
  }
  return ctx.llm;
}

/** 校验 slot 名合法（5 个 LlmSlot 之一） */
function assertLlmSlot(name: string): asserts name is LlmSlotName {
  if (!(LLM_SLOT_NAMES as readonly string[]).includes(name)) {
    const err = new Error(
      `未知 slot: ${name}（可选 ${LLM_SLOT_NAMES.join("/")}）`,
    ) as Error & { code?: string };
    err.code = "INVALID_SLOT";
    throw err;
  }
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
  // POST /api/files/rename — body { path, newPath }（B8：重命名/移动，只许 .md）
  if (sub === "rename" && method === "POST") {
    const obj = requireBody(body, ["path", "newPath"]);
    ok(res, await renameProjectFile(requireActiveDir(ctx), String(obj.path), String(obj.newPath)));
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
  // M-Collab-4 修复：扫描根白名单校验——app-config launcher.defaultScanRoots 非空时，
  // root 必须落在其中某个根目录（或其子目录）内，否则 403；白名单为空（首次配置）放行。
  // 纵深防御：即使鉴权被绕过，恶意请求也无法用 scan 探测文件系统任意路径。
  if (sub === "scan" && method === "GET") {
    const root = url.searchParams.get("root");
    if (!root) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 root");
      return;
    }
    const appConfig = ctx.appConfigDir ? await readAppConfig(ctx.appConfigDir) : null;
    const allowedRoots = appConfig?.launcher.defaultScanRoots ?? [];
    if (allowedRoots.length > 0) {
      const resolved = resolve(root);
      const within = allowedRoots.some((allowed) => {
        const rel = relative(resolve(allowed), resolved);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      });
      if (!within) {
        fail(
          res,
          403,
          "SCAN_ROOT_NOT_ALLOWED",
          `扫描根目录不在白名单内（app-config launcher.defaultScanRoots），已拒绝：${resolved}`,
        );
        return;
      }
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
  // allowInit=true：新建项目无 world.db 时自动初始化空库（闭环：新建→激活→创作）
  if (sub === "activate" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const handle = await ctx.registry.setActive(String(obj.dir), { allowInit: true });
    await persistLastProjectDir(ctx, handle.dir);
    ok(res, { dir: handle.dir, name: handle.meta.name, forceFulltext: handle.forceFulltext });
    return;
  }

  // POST /api/projects/migrate — body { dir }（schema 迁移：备份 + migrateSchema）
  if (sub === "migrate" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const result = await ctx.registry.migrateProject(String(obj.dir));
    ok(res, result);
    return;
  }

  // POST /api/projects/create — body { dir, name?, force? }
  if (sub === "create" && method === "POST") {
    const obj = requireBody(body, ["dir"]);
    const result = await createProject(String(obj.dir), {
      name: obj.name !== undefined ? String(obj.name) : undefined,
      force: obj.force === true,
      templatesDir: ctx.templatesDir,
    });
    ok(res, result, 201);
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
    const dir = String(obj.dir);
    const wasActive = ctx.registry.getActive()?.dir === dir;
    await ctx.registry.closeProject(dir);
    // 关闭的是当前活跃项目 → 清除"记住的项目"（下次启动停入口页）
    if (wasActive) await persistLastProjectDir(ctx, null);
    ok(res, { dir });
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

  // GET /api/admin/pi-status — LLM 状态只读（pure-SDK：AuthStorage + LlmConfigStore）
  if (sub === "pi-status" && method === "GET") {
    ok(res, ctx.piStatus
      ? getPiStatus(ctx.piStatus)
      : { model: null, hasKey: false, piVersion: null, warnings: ["未装配 LLM 状态依赖"] });
    return;
  }

  // ===== LLM 配置（slot 映射持久化到 app-config.json；apiKey 权威存储为 auth.json）=====

  // GET /api/admin/llm — 5 个 slot 的配置/解析/来源/hasKey（不返回 key 明文）
  if (sub === "llm" && segments.length === 2 && method === "GET") {
    const deps = requireLlm(ctx);
    const slots: Record<string, unknown> = {};
    for (const slot of LLM_SLOT_NAMES) {
      slots[slot] = getSlotStatus(deps.store, deps.authStorage, slot as LlmSlot);
    }
    ok(res, { slots });
    return;
  }

  // PUT /api/admin/llm/slot — body { slot, provider, model }（校验模型存在后持久化 + 即时生效）
  if (sub === "llm" && name === "slot" && segments.length === 3 && method === "PUT") {
    const deps = requireLlm(ctx);
    const obj = requireBody(body, ["slot", "provider", "model"]);
    const slot = String(obj.slot);
    assertLlmSlot(slot);
    const provider = String(obj.provider).trim();
    const modelId = String(obj.model).trim();
    if (!provider || !modelId) {
      const err = new Error("provider 与 model 不能为空") as Error & { code?: string };
      err.code = "INVALID_BODY";
      throw err;
    }
    // pi-ai 模型表校验（第二参数为字面量联合，运行时 string 无法静态匹配，同 llm-config.ts 的 as never 约定）
    if (!getModel(provider as KnownProvider, modelId as never)) {
      const err = new Error(
        `模型不存在: provider=${provider} model=${modelId}`,
      ) as Error & { code?: string };
      err.code = "INVALID_MODEL";
      throw err;
    }
    await writeAppConfig({ llm: { slots: { [slot]: { provider, model: modelId } } } }, ctx.appConfigDir);
    deps.store.setConfig(slot as LlmSlot, {
      model: { provider: provider as KnownProvider, name: modelId },
    });
    deps.onChange?.();
    ok(res, getSlotStatus(deps.store, deps.authStorage, slot as LlmSlot));
    return;
  }

  // DELETE /api/admin/llm/slot/:slot — 清除该 slot 配置（持久化 + store 同步）
  if (sub === "llm" && name === "slot" && segments.length === 4 && method === "DELETE") {
    const deps = requireLlm(ctx);
    const slot = segments[3];
    assertLlmSlot(slot);
    await writeAppConfig({ llm: { slots: { [slot]: null } } }, ctx.appConfigDir);
    deps.store.clear(slot as LlmSlot);
    deps.onChange?.();
    ok(res, getSlotStatus(deps.store, deps.authStorage, slot as LlmSlot));
    return;
  }

  // PUT /api/admin/llm/key — body { provider, apiKey }（写 auth.json；不返回明文）
  if (sub === "llm" && name === "key" && segments.length === 3 && method === "PUT") {
    const deps = requireLlm(ctx);
    const obj = requireBody(body, ["provider", "apiKey"]);
    const provider = String(obj.provider).trim();
    const apiKey = String(obj.apiKey).trim();
    if (!provider || !apiKey) {
      const err = new Error("provider 与 apiKey 不能为空") as Error & { code?: string };
      err.code = "INVALID_BODY";
      throw err;
    }
    deps.authStorage.set(provider, { type: "api_key", key: apiKey });
    deps.onChange?.();
    ok(res, { provider, hasKey: true });
    return;
  }

  // DELETE /api/admin/llm/key/:provider — 从 auth.json 移除该 provider 凭据
  if (sub === "llm" && name === "key" && segments.length === 4 && method === "DELETE") {
    const deps = requireLlm(ctx);
    const provider = segments[3];
    if (!provider) {
      const err = new Error("provider 不能为空") as Error & { code?: string };
      err.code = "INVALID_BODY";
      throw err;
    }
    deps.authStorage.remove(provider);
    deps.onChange?.();
    ok(res, { provider, hasKey: false });
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
      // M-Sec-3 修复：novel.json 是项目清单文件，此前不校验任何字段直接整体写入，
      // 可写入非法结构破坏文件。校验：顶层必须是对象 + 已知字段必须是字符串。
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        const err = new Error("novel.json 更新体必须是 JSON 对象") as Error & { code?: string };
        err.code = "INVALID_BODY";
        throw err;
      }
      for (const key of [
        "name",
        "engine",
        "engineVersion",
        "worldGraphDir",
        "chaptersDir",
        "storyTimeFormat",
        "createdAt",
      ]) {
        if (key in obj && typeof obj[key] !== "string") {
          const err = new Error(`novel.json 字段 ${key} 必须是字符串（收到 ${JSON.stringify(obj[key])}）`) as Error & { code?: string };
          err.code = "INVALID_BODY";
          throw err;
        }
      }
      ok(res, await writeNovelJson(requireActiveDir(ctx), obj));
      return;
    }
  }

  // GET/PUT /api/admin/app-config — 应用级配置（无需活跃项目）
  if (sub === "app-config" && segments.length === 2) {
    if (method === "GET") {
      ok(res, await readAppConfig(ctx.appConfigDir));
      return;
    }
    if (method === "PUT") {
      const obj = requireBody(body, []);
      const updates: AppConfigUpdates = {};
      if (obj.launcher && typeof obj.launcher === "object") {
        updates.launcher = obj.launcher as AppConfigUpdates["launcher"];
      }
      if (obj.embedder && typeof obj.embedder === "object") {
        updates.embedder = obj.embedder as AppConfigUpdates["embedder"];
      }
      ok(res, await writeAppConfig(updates, ctx.appConfigDir));
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
