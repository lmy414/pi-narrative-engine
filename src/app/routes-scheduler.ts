// src/app/routes-scheduler.ts
/**
 * routes-scheduler.ts — 编排控制 HTTP API（/api/scheduler/*）
 *
 * 依据：docs/frontend-requirements.md §10 B1（编排控制 HTTP 化）
 *
 * 端点（与 scheduler-tools 的 4 个主会话工具语义完全一致——同一
 * OrchestratorService 实例、同一 EventQueue，HTTP 只是第二个入口）：
 * - POST /api/scheduler/dispatch  body 同 scheduler_dispatch 参数（storyTime/instruction/characterIds/…）
 * - POST /api/scheduler/commit    body { planId }
 * - POST /api/scheduler/discard   body { planId }
 * - GET  /api/scheduler/status    队列状态 + 待确认 plan 列表
 * - GET  /api/scheduler/plans/:id 单个待确认 plan 详情
 *
 * 契约要点：
 * - envelope 与既有路由一致 { ok, data, error }
 * - 需活跃项目（无则 409 NO_ACTIVE_PROJECT）；embedder 未加载 → 501
 * - plan 不存在 → 404 PLAN_NOT_FOUND；commit 失败 → 409 COMMIT_FAILED
 *
 * 安全前提：只监听 localhost，端点不做鉴权。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredEvent } from "@pi/scheduler";
import { readAppConfig, writeAppConfig } from "@pi/admin";
import type { OrchestratorService } from "../orchestrator/service.ts";
import {
  buildDispatchEvent,
  getSchedulerDefaultMode,
  setSchedulerDefaultMode,
} from "../chat/scheduler-tools.ts";
import { _ok as ok, _fail as fail } from "../visualizer/routes.ts";
import type { ProjectRegistry } from "./project-registry.ts";

export interface SchedulerApiContext {
  registry: ProjectRegistry;
  /**
   * 按项目目录取 OrchestratorService（与主会话工具同一实例；
   * 装配经 ChatContext.ensureOrchestratorService，可能抛
   * NO_ACTIVE_PROJECT / EMBEDDER_UNAVAILABLE）
   */
  getService: (cwd: string) => Promise<OrchestratorService>;
  /** 应用配置目录（scheduler.defaultMode 持久化用） */
  appConfigDir?: string;
}

/** 错误 code → HTTP 状态映射（缺省 400） */
const SCHED_ERROR_STATUS: Record<string, number> = {
  MISSING_FIELD: 400,
  INVALID_BODY: 400,
  INVALID_STORY_TIME: 400,
  PLAN_NOT_FOUND: 404,
  NO_ACTIVE_PROJECT: 409,
  COMMIT_FAILED: 409,
  // BUG-014 commit 异步化状态保护
  COMMIT_IN_PROGRESS: 409,
  PLAN_ALREADY_COMMITTED: 410,
  EMBEDDER_UNAVAILABLE: 501,
};

function errWithCode(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** 取活跃项目目录，未激活抛 NO_ACTIVE_PROJECT */
function requireActiveDir(ctx: SchedulerApiContext): string {
  const active = ctx.registry.getActive();
  if (!active) {
    throw errWithCode("NO_ACTIVE_PROJECT", "尚未激活项目（先 POST /api/projects/activate）");
  }
  return active.dir;
}

/** 校验请求体为对象且必填字段存在 */
function requireBody(body: unknown, fields: string[]): Record<string, unknown> {
  if (body === null || typeof body !== "object") {
    throw errWithCode("INVALID_BODY", "请求体必须是 JSON 对象");
  }
  const obj = body as Record<string, unknown>;
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw errWithCode("MISSING_FIELD", `请求体缺少字段 ${f}`);
    }
  }
  return obj;
}

/**
 * 解析 dispatch 请求体为 StructuredEvent（字段校验 + buildDispatchEvent 格式校验）
 *
 * body 形状与 scheduler_dispatch 工具参数对齐（TypeBox schema 见 scheduler-tools.ts）。
 */
function parseDispatchBody(body: unknown): StructuredEvent {
  const obj = requireBody(body, ["storyTime", "instruction", "characterIds"]);

  const storyTime = obj.storyTime;
  const instruction = obj.instruction;
  const characterIds = obj.characterIds;
  if (typeof storyTime !== "string" || storyTime.trim() === "") {
    throw errWithCode("INVALID_BODY", "storyTime 必须是非空字符串");
  }
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw errWithCode("INVALID_BODY", "instruction 必须是非空字符串");
  }
  if (
    !Array.isArray(characterIds) ||
    characterIds.length === 0 ||
    !characterIds.every((c) => typeof c === "string" && c.trim() !== "")
  ) {
    throw errWithCode("INVALID_BODY", "characterIds 必须是非空字符串数组");
  }

  const mode = obj.mode;
  if (mode !== undefined && mode !== "plan" && mode !== "yolo") {
    throw errWithCode("INVALID_BODY", `mode 只能是 plan|yolo（收到 ${JSON.stringify(mode)}）`);
  }
  const executionHints = obj.executionHints;
  if (executionHints !== undefined && typeof executionHints !== "string") {
    throw errWithCode("INVALID_BODY", "executionHints 必须是字符串");
  }
  const chapterPath = obj.chapterPath;
  if (chapterPath !== undefined && typeof chapterPath !== "string") {
    throw errWithCode("INVALID_BODY", "chapterPath 必须是字符串");
  }

  try {
    return buildDispatchEvent({
      storyTime,
      instruction,
      characterIds: characterIds as string[],
      executionHints: executionHints as string | undefined,
      mode: mode as "plan" | "yolo" | undefined,
      chapterPath: chapterPath as string | undefined,
    });
  } catch (err) {
    // storyTime 格式非法（buildDispatchEvent → validateStoryTime）
    throw errWithCode("INVALID_STORY_TIME", (err as Error).message);
  }
}

/**
 * 处理 /api/scheduler/* 请求。命中返回 true（已写出响应），未命中返回 false。
 */
export async function handleSchedulerApi(
  ctx: SchedulerApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/scheduler")) return false;
  const method = req.method ?? "GET";
  const segment = url.pathname.slice("/api/scheduler".length).replace(/\/+$/, "");

  try {
    // POST /api/scheduler/dispatch
    if (segment === "/dispatch" && method === "POST") {
      const cwd = requireActiveDir(ctx);
      const event = parseDispatchBody(body);
      const service = await ctx.getService(cwd);
      ok(res, service.dispatch(event));
      return true;
    }

    // POST /api/scheduler/commit
    // BUG-014：commit 异步化——入队即返回 { ok, queueId, status: 'committing' }；
    // 状态保护错误（COMMIT_IN_PROGRESS / PLAN_ALREADY_COMMITTED）按 SCHED_ERROR_STATUS 映射状态码
    if (segment === "/commit" && method === "POST") {
      const cwd = requireActiveDir(ctx);
      const obj = requireBody(body, ["planId"]);
      const service = await ctx.getService(cwd);
      const result = service.commit(String(obj.planId));
      if (!result.ok) {
        const rawErr = result.error ?? "COMMIT_FAILED";
        // 状态保护错误码直接透传；plan 不存在映射为 PLAN_NOT_FOUND；其余兜底 COMMIT_FAILED
        let code: string;
        if (rawErr === "COMMIT_IN_PROGRESS" || rawErr === "PLAN_ALREADY_COMMITTED") {
          code = rawErr;
        } else if (rawErr.includes("not found")) {
          code = "PLAN_NOT_FOUND";
        } else {
          code = "COMMIT_FAILED";
        }
        const status = SCHED_ERROR_STATUS[code] ?? 400;
        fail(res, status, code, rawErr);
        return true;
      }
      ok(res, result);
      return true;
    }

    // POST /api/scheduler/discard
    // BUG-014：committing 中禁止 discard（防世界图半写状态），返回 409 COMMIT_IN_PROGRESS
    if (segment === "/discard" && method === "POST") {
      const cwd = requireActiveDir(ctx);
      const obj = requireBody(body, ["planId"]);
      const service = await ctx.getService(cwd);
      const planId = String(obj.planId);
      const result = service.discard(planId);
      if (!result.ok) {
        if (result.error === "COMMIT_IN_PROGRESS") {
          fail(res, 409, "COMMIT_IN_PROGRESS", `plan ${planId} 正在提交中，无法 discard`);
        } else {
          fail(res, 404, "PLAN_NOT_FOUND", `plan ${planId} 不存在（已过期或已被 commit/discard）`);
        }
        return true;
      }
      ok(res, { planId, discarded: true });
      return true;
    }

    // GET /api/scheduler/plans/:id
    if (segment.startsWith("/plans/") && method === "GET") {
      const cwd = requireActiveDir(ctx);
      const planId = decodeURIComponent(segment.slice("/plans/".length));
      const service = await ctx.getService(cwd);
      const plan = service.getPlan(planId);
      if (!plan) {
        fail(res, 404, "PLAN_NOT_FOUND", `plan ${planId} 不存在（已过期或已被 commit/discard）`);
        return true;
      }
      ok(res, plan);
      return true;
    }

    // GET /api/scheduler/status（队列状态 + 待确认 plan 列表 + 会话级默认模式）
    if (segment === "/status" && method === "GET") {
      const cwd = requireActiveDir(ctx);
      const service = await ctx.getService(cwd);
      ok(res, {
        queue: service.queueStatus(),
        plans: service.listPlans(),
        defaultMode: getSchedulerDefaultMode(),
      });
      return true;
    }

    // PUT /api/scheduler/mode — body { mode: "plan" | "yolo" }（B7：会话级默认模式，持久化 + 即时生效）
    // M-Collab-3 修复：要求活跃项目上下文（与其他 scheduler 端点语义一致），
    // 避免"在项目外无感知修改全局默认模式"的隐式跨项目影响
    if (segment === "/mode" && method === "PUT") {
      const cwd = requireActiveDir(ctx);
      const obj = requireBody(body, ["mode"]);
      const mode = obj.mode;
      if (mode !== "plan" && mode !== "yolo") {
        throw errWithCode("INVALID_BODY", `mode 只能是 plan|yolo（收到 ${JSON.stringify(mode)}）`);
      }
      await writeAppConfig({ scheduler: { defaultMode: mode } }, ctx.appConfigDir);
      setSchedulerDefaultMode(mode);
      ok(res, { defaultMode: mode });
      return true;
    }

    fail(res, 404, "NOT_FOUND", `未知端点: /api/scheduler${segment || "/"}`);
    return true;
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
    const status = SCHED_ERROR_STATUS[code] ?? (code === "INTERNAL_ERROR" ? 500 : 400);
    fail(res, status, code, err instanceof Error ? err.message : String(err));
    return true;
  }
}
