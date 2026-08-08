/**
 * routes.ts — world-graph 可视化服务的 JSON API 路由
 *
 * 全部端点挂在 /api 前缀下，统一响应 envelope：
 *   成功 { ok: true, data, error: null }
 *   失败 { ok: false, data: null, error: { code, message } }
 *
 * 写路径一律走 WorldGraph 公开方法；POST /api/events 强制 source: "user"
 * （前端编辑产生的事件与引擎扩散事件区分）。
 *
 * 检索：server 注入可选 Search 实例；standalone 无 embedder 时
 * forceFulltext=true（Search.fulltext 不依赖 embedder，见 src/search.ts）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorldGraph } from "underworld-graph";
import type { EventRecordInput } from "underworld-graph";
import type { Search } from "../search.ts";
import type { DebugBus } from "../debug/types.ts";
import { handleDebugStream, handleDebugEvents, handleDebugClear } from "../debug/sse.ts";

export interface VisualizerContext {
  wg: WorldGraph;
  search: Search | null;
  /** standalone 无 embedder 时为 true：/api/search 强制 fulltext */
  forceFulltext: boolean;
  /** 调试事件总线（null 时 /api/debug/* 返回 503） */
  debugBus: DebugBus | null;
}

type JsonValue = unknown;

function send(res: ServerResponse, status: number, payload: JsonValue): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function ok(res: ServerResponse, data: JsonValue, status = 200): void {
  send(res, status, { ok: true, data, error: null });
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, data: null, error: { code, message } });
}

// 供 routes-ext.ts（unified-server 的 files/projects/admin 薄路由）复用
export { ok as _ok, fail as _fail };

/** 后端生成事件 ID（与引擎现有 evt_<ts>_<rand> 风格一致，见 orchestrator.ts） */
function genEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** storyTime 必填端点的参数提取，缺失时抛带 code 的错误 */
function requireStoryTime(url: URL): string {
  const st = url.searchParams.get("storyTime");
  if (!st) {
    const err = new Error("缺少必填参数 storyTime") as Error & { httpCode?: number; code?: string };
    err.httpCode = 400;
    err.code = "STORY_TIME_REQUIRED";
    throw err;
  }
  return st;
}

/** 最新 storyTime（空图回退 "Infinity"）——0.2.0 D5 起 updateEntitySummary 需要 storyTime */
async function latestStoryTime(wg: WorldGraph): Promise<string> {
  const times = await wg.listStoryTimes();
  return times.length > 0 ? times[times.length - 1]! : "Infinity";
}

/** 请求体字段校验 */
function requireFields(body: unknown, fields: string[]): Record<string, unknown> {
  if (body === null || typeof body !== "object") {
    const err = new Error("请求体必须是 JSON 对象") as Error & { httpCode?: number; code?: string };
    err.httpCode = 400;
    err.code = "INVALID_BODY";
    throw err;
  }
  const obj = body as Record<string, unknown>;
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      const err = new Error(`请求体缺少字段 ${f}`) as Error & { httpCode?: number; code?: string };
      err.httpCode = 400;
      err.code = "MISSING_FIELD";
      throw err;
    }
  }
  return obj;
}

/**
 * 处理 /api 请求。始终写出响应（未知 /api 路由 → 404 NOT_FOUND）。
 * 由 server.ts 在确认 pathname 以 /api 开头后调用。
 */
export async function handleApi(
  ctx: VisualizerContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
): Promise<void> {
  const { wg, search } = ctx;
  const method = req.method ?? "GET";
  // 去掉 /api 前缀后的路径段
  // 🟡（2026-08-08）：畸形 % 编码（如 /%）安全解码返回原样——路由不匹配走 404，
  // 而非在 try 外抛 URIError 得 500
  const segments = url.pathname
    .slice("/api".length)
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  // /api/debug/* 路由特殊处理：SSE 流不能进入常规 try/catch（res 不能 end）
  const [head] = segments;
  if (head === "debug") {
    if (!ctx.debugBus) {
      fail(res, 503, "DEBUG_UNAVAILABLE", "调试总线未启用（未注入 debugBus）");
      return;
    }
    const [, sub] = segments;
    if (sub === "stream" && method === "GET") {
      // SSE 长连接：handleDebugStream 内部自行管理 res 生命周期
      handleDebugStream(ctx.debugBus, req, res);
      return;
    }
    if (sub === "events" && method === "GET") {
      handleDebugEvents(ctx.debugBus, res);
      return;
    }
    if (sub === "clear" && method === "POST") {
      handleDebugClear(ctx.debugBus, res);
      return;
    }
    fail(res, 404, "NOT_FOUND", `未找到路由 ${method} ${url.pathname}`);
    return;
  }

  try {
    if (method === "GET") {
      await handleGet(ctx, res, url, segments);
    } else if (method === "POST") {
      await handlePost(wg, res, segments, body);
    } else if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
    } else {
      fail(res, 404, "NOT_FOUND", `未找到路由 ${method} ${url.pathname}`);
    }
  } catch (err) {
    const e = err as Error & { httpCode?: number; code?: string };
    if (typeof e.httpCode === "number") {
      fail(res, e.httpCode, e.code ?? "BAD_REQUEST", e.message);
    } else if (method === "POST") {
      // 写路径：WorldGraph 方法抛出的均为业务错误（实体不存在/已闭合/zod 校验）
      const isZod = (err as { name?: string }).name === "ZodError";
      fail(res, 400, isZod ? "VALIDATION_ERROR" : "BUSINESS_ERROR", e.message);
    } else {
      fail(res, 500, "INTERNAL_ERROR", e.message);
    }
  }
}

async function handleGet(
  ctx: VisualizerContext,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const { wg, search } = ctx;
  const [head, id, sub] = segments;

  // GET /api/status
  if (head === "status" && segments.length === 1) {
    const storyTimes = await wg.listStoryTimes();
    const latest = storyTimes[storyTimes.length - 1];
    const entities = latest ? await wg.getAllEntities(latest) : [];
    const events = await wg.getAllEvents();
    ok(res, { entityCount: entities.length, eventCount: events.length, storyTimes });
    return;
  }

  // GET /api/graph?storyTime=&includeClosed=
  if (head === "graph" && segments.length === 1) {
    const storyTime = requireStoryTime(url);
    const entities = await wg.getAllEntities(storyTime);
    const includeClosed = url.searchParams.get("includeClosed") === "1";
    const relations = includeClosed
      ? await wg.getRelationHistory()
      : await wg.getAllRelationsAt(storyTime);
    ok(res, { entities, relations });
    return;
  }

  // GET /api/entities/:id?storyTime=  /  GET /api/entities/:id/history
  if (head === "entities" && id) {
    if (sub === "history") {
      const history = await wg.getEntityHistory(id);
      const relations = await wg.getRelationHistory(id);
      // BUG-016：world-graph 的 getEntityHistory 不返回 events 字段，
      // 前端详情抽屉事件 tab 永远显示「暂无事件」。补一层关联查询：
      // 实体参与的事件 = 事件主角 entityId === id ，或 newFacts 中含该实体
      let events: unknown[] = [];
      try {
        const allEvents = await wg.getAllEvents();
        events = allEvents.filter((ev: { entityId: string; newFacts?: Array<{ entityId: string }> }) =>
          ev.entityId === id ||
          (ev.newFacts && ev.newFacts.some((f) => f.entityId === id)),
        );
      } catch (_) {
        // getAllEvents 不可用时（旧版 world-graph），events 留空不阻塞其他 tab
      }
      ok(res, { ...history, relations, events });
      return;
    }
    if (!sub) {
      const storyTime = requireStoryTime(url);
      const snap = await wg.getEntityAt(id, storyTime);
      if (!snap) {
        fail(res, 404, "ENTITY_NOT_FOUND", `实体 ${id} 在 ${storyTime} 不存在`);
        return;
      }
      ok(res, snap);
      return;
    }
  }

  // GET /api/declarations/:declId/visibility?storyTime=
  if (head === "declarations" && id && sub === "visibility") {
    const storyTime = url.searchParams.get("storyTime") ?? undefined;
    const list = await wg.getVisibilityForDeclaration(id, storyTime);
    ok(res, { declarationId: id, visibility: list });
    return;
  }

  // GET /api/search?q=&storyTime=&type=&mode=
  if (head === "search" && segments.length === 1) {
    if (!search) {
      fail(res, 501, "SEARCH_UNAVAILABLE", "检索不可用（未注入 Search 实例）");
      return;
    }
    const q = url.searchParams.get("q");
    if (!q) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 q");
      return;
    }
    const storyTime = requireStoryTime(url);
    const modeParam = url.searchParams.get("mode");
    const mode = ctx.forceFulltext
      ? "fulltext"
      : ((modeParam as "fulltext" | "vector" | "hybrid" | null) ?? "hybrid");
    const typeFilter = url.searchParams.get("type") as
      | "character" | "location" | "item" | "concept" | null;
    const results = await search.search(q, {
      storyTime,
      mode,
      ...(typeFilter ? { typeFilter } : {}),
    });
    ok(res, { results });
    return;
  }

  // GET /api/events  /  GET /api/events/:id/chain
  if (head === "events") {
    if (id && sub === "chain") {
      const chain = await wg.traceCauses(id);
      // 0.2.0 D7：traceCauses 对不存在的 eventId 返回 null → 空数组（前端契约不变）
      ok(res, { events: chain ?? [] });
      return;
    }
    if (segments.length === 1) {
      const events = await wg.getAllEvents();
      ok(res, { events });
      return;
    }
  }

  // GET /api/character-view?characterId=&storyTime=
  if (head === "character-view" && segments.length === 1) {
    const characterId = url.searchParams.get("characterId");
    if (!characterId) {
      fail(res, 400, "MISSING_FIELD", "缺少必填参数 characterId");
      return;
    }
    const storyTime = requireStoryTime(url);
    const view = await wg.getCharacterView(characterId, storyTime);
    ok(res, { view });
    return;
  }

  fail(res, 404, "NOT_FOUND", `未找到路由 GET ${url.pathname}`);
}

async function handlePost(
  wg: WorldGraph,
  res: ServerResponse,
  segments: string[],
  body: unknown,
): Promise<void> {
  const [head, id, sub] = segments;

  // POST /api/events — body 为 EventRecordInput，强制 source: "user"
  if (head === "events" && segments.length === 1) {
    const obj = requireFields(body, ["eventId", "type", "storyTime", "entityId"]);
    const input = { ...obj, source: "user" } as unknown as EventRecordInput;
    await wg.processEvent(input);
    ok(res, { eventId: obj.eventId });
    return;
  }

  // POST /api/entities/:id/summary — body { summary, storyTime? }
  if (head === "entities" && id && sub === "summary") {
    const obj = requireFields(body, ["summary"]);
    // 0.2.0 D5：updateEntitySummary 需要 storyTime（摘要变更写 change 事件可回溯）；
    // body 缺省时取最新 storyTime
    const storyTime = obj.storyTime ? String(obj.storyTime) : await latestStoryTime(wg);
    await wg.updateEntitySummary(id, String(obj.summary), storyTime);
    ok(res, { entityId: id, storyTime });
    return;
  }

  // POST /api/relations — body { sourceId, targetId, label, storyTime, description? }
  if (head === "relations" && segments.length === 1) {
    const obj = requireFields(body, ["sourceId", "targetId", "label", "storyTime"]);
    await wg.addRelation(
      String(obj.sourceId), String(obj.targetId), String(obj.label), String(obj.storyTime),
      obj.description ? { description: String(obj.description) } : undefined,
    );
    ok(res, { sourceId: obj.sourceId, targetId: obj.targetId, label: obj.label });
    return;
  }

  // POST /api/relations/close — body { sourceId, targetId, label, storyTime }
  if (head === "relations" && id === "close") {
    const obj = requireFields(body, ["sourceId", "targetId", "label", "storyTime"]);
    await wg.closeRelation(
      String(obj.sourceId), String(obj.targetId), String(obj.label), String(obj.storyTime),
    );
    ok(res, { sourceId: obj.sourceId, targetId: obj.targetId, label: obj.label });
    return;
  }

  // POST /api/visibility — body { characterId, declarationId, confidence, source, storyTime }
  if (head === "visibility" && segments.length === 1) {
    const obj = requireFields(body, ["characterId", "declarationId", "confidence", "source", "storyTime"]);
    // 🟡 审计修正：source 运行时校验（对齐 modality 端点 400 先例）——
    // 编译期断言不构成「非法值拒绝」，内核 setVisibility 无运行时校验
    const source = String(obj.source);
    if (source !== "experienced" && source !== "informed" && source !== "witnessed") {
      const err = new Error(`source 必须是 experienced|informed|witnessed（收到 ${JSON.stringify(source)}）`) as Error & { code?: string };
      err.code = "INVALID_BODY";
      throw err;
    }
    await wg.setVisibility(String(obj.characterId), String(obj.declarationId), {
      state: "known",
      confidence: Number(obj.confidence),
      source: source as "experienced" | "informed" | "witnessed",
      validFrom: String(obj.storyTime),
      isExplicit: true,
    });
    ok(res, { characterId: obj.characterId, declarationId: obj.declarationId });
    return;
  }

  // POST /api/visibility/close — body { characterId, declarationId, storyTime }
  if (head === "visibility" && id === "close") {
    const obj = requireFields(body, ["characterId", "declarationId", "storyTime"]);
    await wg.closeVisibility(String(obj.characterId), String(obj.declarationId), String(obj.storyTime));
    ok(res, { characterId: obj.characterId, declarationId: obj.declarationId });
    return;
  }

  // ==========================================================================
  // 事件溯源便捷端点（B5）：无物理删除、无原地改——属性编辑/声明闭合/实体退场
  // 全部经 change/death 事件落事件日志（因果可回溯），事件 ID 由后端生成
  // ==========================================================================

  // POST /api/entities/:id/props — body { property, description, modality?, storyTime }
  if (head === "entities" && id && sub === "props") {
    const obj = requireFields(body, ["property", "description", "storyTime"]);
    const property = String(obj.property);
    const storyTime = String(obj.storyTime);
    const modality = obj.modality === undefined ? "fact" : String(obj.modality);
    if (!["fact", "belief", "hypothesis"].includes(modality)) {
      fail(res, 400, "INVALID_BODY", `modality 只能是 fact|belief|hypothesis（收到 ${modality}）`);
      return;
    }
    const snapshot = await wg.getEntityAt(id, storyTime);
    if (!snapshot) {
      fail(res, 404, "ENTITY_NOT_FOUND", `实体不存在（或在该时刻未诞生）: ${id}`);
      return;
    }
    // 当前未闭合声明（有则随 change 事件闭合）
    const current = snapshot.properties.find((p) => p.property === property);
    const eventId = genEventId();
    await wg.processEvent({
      eventId,
      type: "change",
      storyTime,
      entityId: id,
      source: "user",
      invalidated: current ? [{ declarationId: current.declarationId, property }] : undefined,
      // 0.3.0：value → description（string 契约）
      newFacts: [{ entityId: id, property, description: String(obj.description), modality: modality as "fact" | "belief" | "hypothesis" }],
    } as EventRecordInput);
    // 取新声明 ID（processEvent 不返回，按 validFrom 回查）
    const after = await wg.getEntityAt(id, storyTime);
    const created = after?.properties.find((p) => p.property === property);
    ok(res, {
      entityId: id,
      property,
      closedDeclarationId: current?.declarationId ?? null,
      newDeclarationId: created?.declarationId ?? null,
    });
    return;
  }

  // POST /api/declarations/close — body { declarationId, entityId, storyTime }
  if (head === "declarations" && id === "close") {
    const obj = requireFields(body, ["declarationId", "entityId", "storyTime"]);
    const declarationId = String(obj.declarationId);
    const entityId = String(obj.entityId);
    const storyTime = String(obj.storyTime);
    // 读当前声明状态（历史含已闭合），判断存在性与是否已闭合
    const history = await wg.getEntityHistory(entityId);
    const decl = history.facts.find((f) => f.declarationId === declarationId);
    if (!decl) {
      fail(res, 404, "DECLARATION_NOT_FOUND", `声明不存在: ${declarationId}（entityId=${entityId}）`);
      return;
    }
    if (decl.validTo !== "Infinity") {
      fail(res, 409, "DECLARATION_CLOSED", `声明已闭合（validTo=${decl.validTo}）: ${declarationId}`);
      return;
    }
    await wg.processEvent({
      eventId: genEventId(),
      type: "change",
      storyTime,
      entityId,
      source: "user",
      invalidated: [{ declarationId, property: decl.property }],
    } as EventRecordInput);
    ok(res, { declarationId, closed: true });
    return;
  }

  // POST /api/entities/:id/kill — body { storyTime }（实体退场：双时态闭合，非物理删除）
  if (head === "entities" && id && sub === "kill") {
    const obj = requireFields(body, ["storyTime"]);
    const storyTime = String(obj.storyTime);
    const snapshot = await wg.getEntityAt(id, storyTime);
    if (!snapshot) {
      fail(res, 404, "ENTITY_NOT_FOUND", `实体不存在（或在该时刻未诞生/已退场）: ${id}`);
      return;
    }
    // 优先 processEvent type="death"（走事件日志，因果可回溯），而非直调 killEntity
    await wg.processEvent({
      eventId: genEventId(),
      type: "death",
      storyTime,
      entityId: id,
      source: "user",
    } as EventRecordInput);
    ok(res, { entityId: id, killedAt: storyTime });
    return;
  }

  fail(res, 404, "NOT_FOUND", "未找到路由 POST /api/" + segments.join("/"));
}
