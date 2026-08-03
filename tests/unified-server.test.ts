/**
 * unified-server.test.ts — 应用化统一服务集成测试
 *
 * 通过 startUnifiedServer({ registry, port: 0 }) 起真实 HTTP 服务验证：
 * - /api/projects/*  scan / meta / active / activate / close（launch-pi、
 *   open-folder 会 spawn 系统终端/文件管理器，不在测试范围）
 * - 世界图路由与活跃项目绑定：未激活 409、激活后可用、切换后数据隔离
 * - /api/files/*     tree / read / write / create / delete + 乐观锁 + 路径安全
 * - /api/admin/*     config(.env) / rulesets / novel-json / embedder status /
 *   pi-status（doctor 与 version 会 spawn git，均不在测试范围）
 * - /api/scheduler/* dispatch / commit / discard / status（stub 编排服务，不触 LLM）
 * - /api/debug/*     events / clear（debugBus 已注入）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "underworld-graph";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { LlmConfigStore } from "../src/orchestrator/llm-config.ts";
import { ChatContext } from "../src/app/chat-context.ts";
import { createDebugBus } from "../src/debug/bus.ts";
import type { DebugBus } from "../src/debug/types.ts";
import { startUnifiedServer } from "../src/app/unified-server.ts";
import type { UnifiedServer } from "../src/app/unified-server.ts";

let root: string;
let projA: string;
let projB: string;
let appConfigDir: string;
let registry: ProjectRegistry;
let server: UnifiedServer;
let base: string;
let debugBus: DebugBus;
let chatContext: ChatContext;

/**
 * scheduler 端点用 stub 编排服务（不触 LLM；语义对齐 OrchestratorService 形状）
 * plan_ok = 存在的 planId；其他 planId 一律 not found
 */
const stubPlanIds = new Set(["plan_ok"]);
const stubSchedulerService = {
  dispatch(event: { mode?: string }) {
    return { queueId: "q-stub-1", mode: event.mode === "yolo" ? "yolo" : "plan" };
  },
  async commit(planId: string) {
    if (!stubPlanIds.delete(planId)) {
      return {
        ok: false,
        planId,
        appliedEventIds: [] as string[],
        writtenText: "",
        chapterPath: "",
        error: `plan ${planId} not found (expired or never created)`,
      };
    }
    return {
      ok: true,
      planId,
      appliedEventIds: ["evt_a"],
      writtenText: "正文",
      chapterPath: "chapters/ch001.md",
    };
  },
  discard(planId: string) {
    return { ok: stubPlanIds.delete(planId) };
  },
  queueStatus() {
    return { length: 0, items: [] as unknown[] };
  },
  listPlans() {
    return stubPlanIds.has("plan_ok") ? [
      {
        planId: "plan_ok",
        storyTime: "ch001.ev001",
        mode: "plan",
        characterIds: ["char_a"],
        outputCount: 1,
        errorCount: 0,
      },
    ] : [];
  },
  getPlan(planId: string) {
    if (!stubPlanIds.has(planId)) return undefined;
    return {
      planId,
      storyTime: "ch001.ev001",
      mode: "plan",
      characterIds: ["char_a"],
      cast: [{ characterId: "char_a", name: "甲", summary: "角色摘要" }],
      outputs: [{ actor: "char_a", action: "前进" }],
      retrievalPlan: { items: [], description: "" },
      errors: [],
      stages: [
        {
          stage: "planner",
          agent: "planner",
          status: "done",
          durationMs: 12,
          provider: "test-provider",
          model: "test-planner",
        },
        { stage: "role", agent: "role", status: "error", error: "char_a: role failed" },
      ],
    };
  },
};

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}api${path}`, init);
  const json = (await res.json()) as {
    ok: boolean;
    data: any;
    error: { code: string; message: string } | null;
  };
  return { status: res.status, ...json };
}

async function sendJson(method: string, path: string, body: unknown) {
  return api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function makeProject(dir: string, name: string, entityValue: string): Promise<void> {
  mkdirSync(join(dir, ".pi", "world-graph-v3"), { recursive: true });
  mkdirSync(join(dir, "正文"), { recursive: true });
  writeFileSync(
    join(dir, "novel.json"),
    JSON.stringify({
      name,
      engine: "narrative-engine",
      engineVersion: "0.1.0",
      worldGraphDir: ".pi/world-graph-v3",
      chaptersDir: "正文",
      storyTimeFormat: "ch{NNN}.ev{NNN}",
      createdAt: "2026-07-29",
    }),
    "utf8",
  );
  writeFileSync(join(dir, "正文", "ch001.md"), `# ${name} 第一章\n`, "utf8");
  const wg = await WorldGraph.create({
    dbPath: join(dir, ".pi", "world-graph-v3", "world.db"),
    eventLogPath: join(dir, ".pi", "world-graph-v3", "events.jsonl"),
  });
  await wg.processEvent({
    eventId: `evt-birth-${name}`,
    type: "birth",
    storyTime: "t1",
    entityId: `e-${name}`,
    entityType: "character",
    newFacts: [{ entityId: `e-${name}`, property: "name", value: entityValue, modality: "fact" }],
  });
  wg.close();
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "unified-test-"));
  projA = join(root, "proj-a");
  projB = join(root, "proj-b");
  await makeProject(projA, "甲", "阿明");
  await makeProject(projB, "乙", "阿红");

  // 丰富 projB 种子数据：增加 visualizer 测试所需实体/关系/可见性
  {
    const wgB = await WorldGraph.create({
      dbPath: join(projB, ".pi", "world-graph-v3", "world.db"),
      eventLogPath: join(projB, ".pi", "world-graph-v3", "events.jsonl"),
    });
    await wgB.processEvent({
      eventId: "evt-birth-viz1",
      type: "birth",
      storyTime: "t1",
      entityId: "viz1",
      entityType: "character",
      summary: "主角",
      newFacts: [
        { entityId: "viz1", property: "name", value: "阿明", modality: "fact" },
        { entityId: "viz1", property: "mood", value: "平静", modality: "fact" },
      ],
    });
    await wgB.processEvent({
      eventId: "evt-birth-viz2",
      type: "birth",
      storyTime: "t1",
      entityId: "viz2",
      entityType: "location",
      newFacts: [{ entityId: "viz2", property: "name", value: "客栈", modality: "fact" }],
    });
    await wgB.processEvent({
      eventId: "evt-change-mood",
      type: "change",
      storyTime: "t2",
      entityId: "viz1",
      invalidated: [{ declarationId: "decl-viz1-mood-t1", property: "mood" }],
      newFacts: [{ entityId: "viz1", property: "mood", value: "愤怒", modality: "fact" }],
    });
    await wgB.addRelation("viz1", "viz2", "located_in", "t1");
    await wgB.setVisibility("viz1", "decl-viz2-name-t1", {
      state: "known",
      confidence: 1,
      source: "witnessed",
      validFrom: "t1",
      isExplicit: true,
    });
    wgB.close();
  }

  // 应用配置目录（避免写入真实 %APPDATA%）
  appConfigDir = join(root, "appconfig");

  // 模板固件（createProject 内联实现需要）
  const tplDir = join(root, "templates");
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(
    join(tplDir, "novel.json"),
    JSON.stringify({ name: "{{name}}", engine: "narrative-engine", engineVersion: "0.1.0", worldGraphDir: ".pi/world-graph-v3", chaptersDir: "正文", storyTimeFormat: "ch{NNN}.ev{NNN}", createdAt: "{{date}}" }),
    "utf8",
  );
  writeFileSync(join(tplDir, "规则集.md"), "# 规则\n", "utf8");
  writeFileSync(join(tplDir, "planner 规则集.md"), "# planner\n", "utf8");
  writeFileSync(join(tplDir, "角色规则集.md"), "# 角色\n", "utf8");
  writeFileSync(join(tplDir, "_gitignore"), ".env\n", "utf8");
  writeFileSync(join(tplDir, "README.md"), "# {{name}}\n", "utf8");

  // 创建 uiDir 与 dummy api.js（供 /api.js 静态路由回归测试）
  const uiDir = join(root, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "api.js"), "// Viz.api\n", "utf8");

  registry = new ProjectRegistry();
  debugBus = createDebugBus();
  // ChatContext 装配（scheduler 路由依赖）：embedder 用占位对象绕过空值检查，
  // createOrchestratorService 注入 stub，不触 LLM/真实编排装配
  chatContext = new ChatContext({
    registry,
    llmStore: new LlmConfigStore(),
    configDir: appConfigDir,
    embedder: {} as never,
    debugBus,
    createOrchestratorService: async () => stubSchedulerService as never,
  });
  server = await startUnifiedServer({
    registry,
    port: 0,
    repoRoot: root,
    templatesDir: join(root, "templates"),
    uiDir,
    appConfigDir,
    llmConfigStore: new LlmConfigStore(),
    chatContext,
    debugBus,
  });
  base = server.url;
});

after(async () => {
  await server.close();
  await registry.closeAll();
  rmSync(root, { recursive: true, force: true });
});

// ============ /api/projects/* ============

test("projects/scan: 扫到至少两个种子项目", async () => {
  const r = await api(`/projects/scan?root=${encodeURIComponent(root)}`);
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.ok(r.data.projects.length >= 2);
  const names = r.data.projects.map((p: any) => p.meta.name);
  assert.ok(names.includes("甲"));
  assert.ok(names.includes("乙"));
});

test("projects/scan: 缺 root 报 400 MISSING_FIELD", async () => {
  const r = await api("/projects/scan");
  assert.equal(r.status, 400);
  assert.equal(r.error?.code, "MISSING_FIELD");
});

test("projects/meta: 正常读取 / 不存在项目报错", async () => {
  const ok1 = await api(`/projects/meta?dir=${encodeURIComponent(projA)}`);
  assert.equal(ok1.data.meta.name, "甲");
  const bad = await api(`/projects/meta?dir=${encodeURIComponent(join(root, "不存在"))}`);
  assert.equal(bad.ok, false);
});

test("世界图路由：未激活项目时 409 NO_ACTIVE_PROJECT", async () => {
  const r = await api("/status");
  assert.equal(r.status, 409);
  assert.equal(r.error?.code, "NO_ACTIVE_PROJECT");
});

test("projects/activate: 激活后世界图路由可用，数据属于甲", async () => {
  const act = await sendJson("POST", "/projects/activate", { dir: projA });
  assert.equal(act.ok, true);
  assert.equal(act.data.name, "甲");

  const status = await api("/status");
  assert.equal(status.ok, true);
  assert.equal(status.data.entityCount, 1);

  const graph = await api("/graph?storyTime=t1");
  assert.equal(graph.data.entities[0].entityId, "e-甲");

  const active = await api("/projects/active");
  assert.equal(active.data.active.name, "甲");
  assert.equal(active.data.open.length, 1);
});

test("projects/activate: 切换到乙后数据隔离", async () => {
  await sendJson("POST", "/projects/activate", { dir: projB });
  const graph = await api("/graph?storyTime=t1");
  assert.ok(
    graph.data.entities.some((e: any) => e.entityId === "e-乙"),
    "实体列表应包含 e-乙",
  );
});

test("projects/activate→close: lastProjectDir 持久化与清除", async () => {
  const cfgPath = join(appConfigDir, "app-config.json");

  // 激活甲 → app-config 记住
  const act = await sendJson("POST", "/projects/activate", { dir: projA });
  assert.equal(act.ok, true);
  let raw = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(raw.launcher.lastProjectDir, act.data.dir, "activate 应写 lastProjectDir");

  // 关闭当前活跃项目 → 清除
  await sendJson("POST", "/projects/close", { dir: projA });
  raw = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(raw.launcher.lastProjectDir, null, "关闭活跃项目应清 lastProjectDir");

  // 恢复活跃项目乙，不影响后续测试
  await sendJson("POST", "/projects/activate", { dir: projB });
});

test("projects/activate: 无 world.db 的项目自动初始化空库（闭环）", async () => {
  const empty = join(root, "proj-empty");
  mkdirSync(empty, { recursive: true });
  writeFileSync(
    join(empty, "novel.json"),
    JSON.stringify({ name: "空", engine: "narrative-engine", engineVersion: "0.1.0" }),
    "utf8",
  );
  // 闭环设计：activate 允许初始化空库（新建→激活→创作）
  const r = await sendJson("POST", "/projects/activate", { dir: empty });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "空");
  const status = await api("/status");
  assert.equal(status.ok, true);
  assert.equal(status.data.entityCount, 0);
  // 切回当前活跃项目，不影响后续测试
  await sendJson("POST", "/projects/activate", { dir: projB });
});

// ============ 闭环：新建项目 → 激活（自动初始化空库）→ 世界图可用 ============

test("闭环: create → activate(空库自动初始化) → status/graph 可用", async () => {
  const newDir = join(root, "proj-new");
  const created = await sendJson("POST", "/projects/create", { dir: newDir, name: "闭环测试" });
  assert.equal(created.status, 201);

  // 新项目无 world.db，activate 自动初始化
  const act = await sendJson("POST", "/projects/activate", { dir: newDir });
  assert.equal(act.ok, true);
  assert.equal(act.data.name, "闭环测试");

  const status = await api("/status");
  assert.equal(status.ok, true);
  assert.equal(status.data.entityCount, 0, "空库无实体");

  // 写入事件后立即可读
  const ev = await sendJson("POST", "/events", {
    eventId: "evt-loop-1",
    type: "birth",
    storyTime: "ch001.ev001",
    entityId: "e-loop",
    entityType: "character",
    summary: "闭环角色",
    newFacts: [{ entityId: "e-loop", property: "name", value: "小闭", modality: "fact" }],
  });
  assert.equal(ev.ok, true);
  const graph = await api("/graph?storyTime=ch001.ev001");
  assert.equal(graph.data.entities.length, 1);

  // 文件编辑器可用（模板已含规则集；正文目录为空）
  const tree = await api("/files/tree");
  assert.equal(tree.ok, true);

  // 切回项目乙，不影响后续测试
  await sendJson("POST", "/projects/activate", { dir: projB });
});

test("闭环: 模板目录缺失时 create 返回 TEMPLATE_NOT_FOUND", async () => {
  // 本用例临时把模板目录改名验证错误路径，随后恢复
  const { renameSync } = await import("node:fs");
  const tplDir = join(root, "templates");
  const bakDir = join(root, "templates-bak");
  renameSync(tplDir, bakDir);
  try {
    const r = await sendJson("POST", "/projects/create", { dir: join(root, "x") });
    assert.equal(r.status, 404);
    assert.equal(r.error?.code, "TEMPLATE_NOT_FOUND");
  } finally {
    renameSync(bakDir, tplDir);
  }
});

// ============ /api/files/*（在活跃项目乙上） ============

test("files/tree: 列出项目乙的 .md/.json（B8 放宽）", async () => {
  const r = await api("/files/tree");
  assert.equal(r.ok, true);
  const paths = (nodes: any[]): string[] =>
    nodes.flatMap((n) => [n.path, ...(n.children ? paths(n.children) : [])]);
  const all = paths(r.data.tree);
  assert.ok(all.includes("正文/ch001.md"));
  assert.ok(all.includes("novel.json"), "B8：.json 应列入树");
});

test("files: create → write → read → 乐观锁冲突 → delete 全链路", async () => {
  const created = await sendJson("POST", "/files/create", { path: "设定/角色/主角.md" });
  assert.equal(created.status, 201);
  assert.equal(created.data.content, "");

  const written = await sendJson("PUT", "/files/write", {
    path: "设定/角色/主角.md",
    content: "# 主角\n",
    baseMtime: created.data.mtime,
  });
  assert.equal(written.ok, true);
  assert.equal(written.data.content, "# 主角\n");

  const read = await api(`/files/read?path=${encodeURIComponent("设定/角色/主角.md")}`);
  assert.equal(read.data.content, "# 主角\n");

  // 用旧 mtime 再写 → 409
  const conflict = await sendJson("PUT", "/files/write", {
    path: "设定/角色/主角.md",
    content: "冲突\n",
    baseMtime: created.data.mtime,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.error?.code, "MTIME_CONFLICT");

  const del = await sendJson("POST", "/files/delete", { path: "设定/角色/主角.md" });
  assert.equal(del.ok, true);
});

test("files: 路径逃逸 403 / 非法后缀 400", async () => {
  const escape = await api(`/files/read?path=${encodeURIComponent("../outside.md")}`);
  assert.equal(escape.status, 403);
  assert.equal(escape.error?.code, "PATH_ESCAPE");

  const badExt = await sendJson("PUT", "/files/write", { path: "x.exe", content: "x" });
  assert.equal(badExt.status, 400);
  assert.equal(badExt.error?.code, "INVALID_EXT");
});

// ============ /api/admin/*（在活跃项目乙上） ============

test("admin/config: .env 读取（不存在）→ 写入 → 回读", async () => {
  const before1 = await api("/admin/config");
  assert.equal(before1.data.exists, false);

  const written = await sendJson("PUT", "/admin/config", {
    HF_ENDPOINT: "hf-mirror.com",
    PI_DEBUG: "off",
  });
  assert.equal(written.ok, true);
  assert.equal(written.data.values.HF_ENDPOINT, "hf-mirror.com");

  const after1 = await api("/admin/config");
  assert.equal(after1.data.exists, true);
  assert.equal(after1.data.values.HF_ENDPOINT, "hf-mirror.com");
  assert.equal(after1.data.values.PI_DEBUG, "off");
});

test("admin/rulesets: 写入 → 读取三件套", async () => {
  const w = await sendJson("PUT", "/admin/rulesets/render", { content: "渲染规则 v1\n" });
  assert.equal(w.ok, true);
  assert.equal(w.data.content, "渲染规则 v1\n");

  const all = await api("/admin/rulesets");
  const render = all.data.rulesets.find((r: any) => r.name === "render");
  assert.equal(render.content, "渲染规则 v1\n");
});

test("admin/rulesets: 未知规则集名报错", async () => {
  const r = await sendJson("PUT", "/admin/rulesets/unknown", { content: "x" });
  assert.equal(r.status, 400);
});

test("admin/novel-json: 读取 → 更新 → 回读", async () => {
  const before1 = await api("/admin/novel-json");
  assert.equal(before1.data.data.name, "乙");

  const w = await sendJson("PUT", "/admin/novel-json", { name: "乙（改名）" });
  assert.equal(w.ok, true);

  const after1 = await api("/admin/novel-json");
  assert.equal(after1.data.data.name, "乙（改名）");
  assert.equal(after1.data.data.engine, "narrative-engine", "未更新字段应保留");
});

test("admin/embedder/status: 无 embedder 时返回默认模型信息", async () => {
  const r = await api("/admin/embedder/status");
  assert.equal(r.ok, true);
  assert.equal(typeof r.data.model, "string");
  assert.equal(r.data.dim, null, "无 embedder 实例时 dim 为 null");
});

test("admin/embedder/warmup: 无 embedder 时 501", async () => {
  const r = await sendJson("POST", "/admin/embedder/warmup", {});
  assert.equal(r.status, 501);
  assert.equal(r.error?.code, "EMBEDDER_UNAVAILABLE");
});

test("admin/pi-status: 已装配 store，返回形状正确（model 取决于 env 配置）", async () => {
  const r = await api("/admin/pi-status");
  assert.equal(r.ok, true);
  assert.equal(r.data.piVersion, null);
  assert.ok(Array.isArray(r.data.warnings));
  assert.equal(typeof r.data.hasKey, "boolean");
  if (r.data.model !== null) {
    assert.equal(typeof r.data.model.id, "string");
    assert.equal(typeof r.data.model.provider, "string");
  }
});

// ============ /api/admin/llm ============

test("admin/llm: GET 初始状态（configured=null，source 为 env/none）", async () => {
  const r = await api("/admin/llm");
  assert.equal(r.ok, true);
  const slots = r.data.slots;
  assert.deepEqual(
    Object.keys(slots).sort(),
    ["default", "planner", "reasoning", "renderer", "role"],
  );
  assert.equal(slots.default.configured, null);
  assert.ok(["env", "none"].includes(slots.default.source), `初始来源应为 env/none，实际 ${slots.default.source}`);
  // 响应不得包含任何 key 明文字段
  assert.ok(!JSON.stringify(r.data).includes("apiKey"), "响应不含 apiKey 字段");
});

test("admin/llm: PUT slot 校验失败（非法 slot / 未知模型）", async () => {
  const bad = await sendJson("PUT", "/admin/llm/slot", {
    slot: "nope",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.error?.code, "INVALID_SLOT");

  const unknown = await sendJson("PUT", "/admin/llm/slot", {
    slot: "default",
    provider: "deepseek",
    model: "no-such-model-xyz",
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.error?.code, "INVALID_MODEL");
});

test("admin/llm: PUT slot default 生效并持久化；其他 slot 回退 default", async () => {
  const r = await sendJson("PUT", "/admin/llm/slot", {
    slot: "default",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.source, "slot");
  assert.deepEqual(r.data.configured, { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.deepEqual(r.data.resolved, { provider: "deepseek", model: "deepseek-v4-flash" });

  // 持久化到 app-config.json
  const raw = JSON.parse(readFileSync(join(appConfigDir, "app-config.json"), "utf8"));
  assert.deepEqual(raw.llm.slots.default, { provider: "deepseek", model: "deepseek-v4-flash" });

  // 未配置的 planner 经 default 解析
  const all = await api("/admin/llm");
  assert.equal(all.data.slots.planner.configured, null);
  assert.equal(all.data.slots.planner.source, "default");
  assert.equal(all.data.slots.planner.resolved.model, "deepseek-v4-flash");
});

test("admin/llm: PUT key 写 auth.json 且不回传明文；DELETE key 移除", async () => {
  const secret = "sk-test-secret-001";
  const put = await sendJson("PUT", "/admin/llm/key", { provider: "deepseek", apiKey: secret });
  assert.equal(put.ok, true);
  assert.deepEqual(put.data, { provider: "deepseek", hasKey: true });
  assert.ok(!JSON.stringify(put).includes(secret), "PUT key 响应不得包含明文");

  // 落盘到临时 configDir 的 auth.json（存储包含 key 是预期行为）
  const authPath = join(appConfigDir, "pi-agent", "auth.json");
  const authRaw = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(authRaw.deepseek?.type, "api_key");
  assert.equal(authRaw.deepseek?.key, secret);

  // GET /api/admin/llm：hasKey=true 且不含明文
  const all = await api("/admin/llm");
  assert.equal(all.data.slots.default.hasKey, true, "auth.json 有 key 应为 true");
  assert.ok(!JSON.stringify(all).includes(secret), "GET llm 响应不得包含明文");

  const del = await fetch(`${base}api/admin/llm/key/deepseek`, { method: "DELETE" });
  const delJson = (await del.json()) as any;
  assert.equal(delJson.ok, true);
  assert.deepEqual(delJson.data, { provider: "deepseek", hasKey: false });
  const authRaw2 = JSON.parse(readFileSync(authPath, "utf8"));
  assert.ok(!("deepseek" in authRaw2), "DELETE 后 auth.json 不应再有 deepseek");
});

test("admin/llm: PUT/DELETE 参数校验（缺字段 400）", async () => {
  const missKey = await sendJson("PUT", "/admin/llm/key", { provider: "deepseek" });
  assert.equal(missKey.status, 400);
  const empty = await sendJson("PUT", "/admin/llm/key", { provider: " ", apiKey: " " });
  assert.equal(empty.status, 400);
  const missSlot = await sendJson("PUT", "/admin/llm/slot", { slot: "default" });
  assert.equal(missSlot.status, 400);
});

test("admin/llm: DELETE slot 恢复 env/none 解析并落盘", async () => {
  const del = await fetch(`${base}api/admin/llm/slot/default`, { method: "DELETE" });
  const r = (await del.json()) as any;
  assert.equal(r.ok, true);
  assert.equal(r.data.configured, null);
  assert.ok(["env", "none"].includes(r.data.source), `删除后回退 env/none，实际 ${r.data.source}`);

  const raw = JSON.parse(readFileSync(join(appConfigDir, "app-config.json"), "utf8"));
  assert.ok(!("default" in (raw.llm?.slots ?? {})), "app-config 中 default slot 应被删除");

  // 非法 slot 的 DELETE → 400
  const bad = await fetch(`${base}api/admin/llm/slot/nope`, { method: "DELETE" });
  assert.equal(bad.status, 400);
});

// ============ /api/admin/app-config ============

test("admin/app-config: 读取默认配置 → 更新 → 回读", async () => {
  const def = await api("/admin/app-config");
  assert.equal(def.ok, true);
  assert.deepEqual(def.data.launcher.defaultScanRoots, []);

  const w = await sendJson("PUT", "/admin/app-config", {
    launcher: { defaultScanRoots: [root] },
  });
  assert.equal(w.ok, true);
  assert.equal(w.data.launcher.defaultScanRoots[0], root);

  const back = await api("/admin/app-config");
  assert.equal(back.data.launcher.defaultScanRoots[0], root);
  assert.equal(back.data.embedder.model, "Xenova/bge-small-zh-v1.5", "未更新字段保留");
});

// ============ projects/close ============

test("projects/close: 关闭句柄后从 open 列表移除", async () => {
  const before1 = await api("/projects/active");
  assert.ok(before1.data.open.length >= 1);
  await sendJson("POST", "/projects/close", { dir: projA });
  const after1 = await api("/projects/active");
  assert.ok(!after1.data.open.some((o: any) => o.dir === projA));
  assert.equal(after1.data.active.name, "乙", "关闭非活跃项目不影响活跃指针");
});

// ============ /api/scheduler/*（stub 编排服务，不触 LLM） ============

test("scheduler/status: 队列状态 + 待确认 plan 列表形状", async () => {
  stubPlanIds.add("plan_ok");
  const r = await api("/scheduler/status");
  assert.equal(r.ok, true);
  assert.equal(typeof r.data.queue.length, "number");
  assert.ok(Array.isArray(r.data.queue.items));
  assert.ok(Array.isArray(r.data.plans));
  assert.equal(r.data.plans[0].planId, "plan_ok");
  assert.equal(r.data.plans[0].storyTime, "ch001.ev001");
  assert.equal(r.data.plans[0].outputCount, 1);
  assert.equal("stages" in r.data.plans[0], false);
});

test("scheduler/plans/:id: 返回详情，未知 plan 404", async () => {
  stubPlanIds.add("plan_ok");
  const r = await api("/scheduler/plans/plan_ok");
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data).sort(), [
    "cast",
    "characterIds",
    "errors",
    "mode",
    "outputs",
    "planId",
    "retrievalPlan",
    "stages",
    "storyTime",
  ]);
  assert.deepEqual(r.data.stages.map(({ stage, status }: any) => ({ stage, status })), [
    { stage: "planner", status: "done" },
    { stage: "role", status: "error" },
  ]);
  assert.equal("durationMs" in r.data.stages[1], false);
  assert.equal("provider" in r.data.stages[1], false);
  assert.equal("model" in r.data.stages[1], false);

  const nf = await api("/scheduler/plans/plan_ghost");
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "PLAN_NOT_FOUND");
});

test("scheduler/dispatch: 成功返回 queueId/mode（与工具版同构）", async () => {
  const r = await sendJson("POST", "/scheduler/dispatch", {
    storyTime: "ch001.ev001",
    instruction: "测试事件",
    characterIds: ["char_a"],
    mode: "plan",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.queueId, "q-stub-1");
  assert.equal(r.data.mode, "plan");
});

test("scheduler/dispatch: 参数校验 400（缺字段/坏 storyTime/坏 characterIds/坏 mode）", async () => {
  const missing = await sendJson("POST", "/scheduler/dispatch", { storyTime: "ch001.ev001" });
  assert.equal(missing.status, 400);
  assert.equal(missing.error?.code, "MISSING_FIELD");

  const badTime = await sendJson("POST", "/scheduler/dispatch", {
    storyTime: "ch-1",
    instruction: "x",
    characterIds: ["a"],
  });
  assert.equal(badTime.status, 400);
  assert.equal(badTime.error?.code, "INVALID_STORY_TIME");

  const badChars = await sendJson("POST", "/scheduler/dispatch", {
    storyTime: "ch001.ev001",
    instruction: "x",
    characterIds: [],
  });
  assert.equal(badChars.status, 400);
  assert.equal(badChars.error?.code, "INVALID_BODY");

  const badMode = await sendJson("POST", "/scheduler/dispatch", {
    storyTime: "ch001.ev001",
    instruction: "x",
    characterIds: ["a"],
    mode: "turbo",
  });
  assert.equal(badMode.status, 400);
  assert.equal(badMode.error?.code, "INVALID_BODY");
});

test("scheduler/commit: 未知 planId 404；已知 planId 成功", async () => {
  const nf = await sendJson("POST", "/scheduler/commit", { planId: "plan_ghost" });
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "PLAN_NOT_FOUND");

  stubPlanIds.add("plan_ok");
  const yes = await sendJson("POST", "/scheduler/commit", { planId: "plan_ok" });
  assert.equal(yes.ok, true);
  assert.equal(yes.data.planId, "plan_ok");
  assert.deepEqual(yes.data.appliedEventIds, ["evt_a"]);
  const gone = await api("/scheduler/plans/plan_ok");
  assert.equal(gone.status, 404, "commit 后详情删除");

  const miss = await sendJson("POST", "/scheduler/commit", {});
  assert.equal(miss.status, 400);
});

test("scheduler/discard: 未知 planId 404；已知 planId 成功", async () => {
  const nf = await sendJson("POST", "/scheduler/discard", { planId: "plan_ghost" });
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "PLAN_NOT_FOUND");

  stubPlanIds.add("plan_ok");
  const yes = await sendJson("POST", "/scheduler/discard", { planId: "plan_ok" });
  assert.equal(yes.ok, true);
  assert.equal(yes.data.discarded, true);
  const gone = await api("/scheduler/plans/plan_ok");
  assert.equal(gone.status, 404, "discard 后详情删除");
});

test("scheduler/mode: PUT 设置默认模式并持久化；status 附带 defaultMode（B7）", async () => {
  const bad = await sendJson("PUT", "/scheduler/mode", { mode: "turbo" });
  assert.equal(bad.status, 400);

  const put = await sendJson("PUT", "/scheduler/mode", { mode: "yolo" });
  assert.equal(put.ok, true);
  assert.equal(put.data.defaultMode, "yolo");

  const st = await api("/scheduler/status");
  assert.equal(st.data.defaultMode, "yolo");

  const raw = JSON.parse(readFileSync(join(appConfigDir, "app-config.json"), "utf8"));
  assert.equal(raw.scheduler.defaultMode, "yolo", "已持久化到 app-config");

  // 复位，避免影响后续用例
  await sendJson("PUT", "/scheduler/mode", { mode: "plan" });
});

// ============ /api/chat/sessions（B3） ============

test("chat/sessions: 列表与历史消息；未知 id 404", async () => {
  // 在活跃项目（乙）的会话目录造一条历史会话
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionDir = join(projB, ".pi", "sessions");
  const sm = SessionManager.create(projB, sessionDir);
  sm.appendMessage({ role: "user", content: "第一句", timestamp: Date.now() } as never);
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "回答" }],
    timestamp: Date.now(),
  } as never);
  const sessionId = sm.getSessionId();

  const list = await api("/chat/sessions");
  assert.equal(list.ok, true);
  const found = list.data.sessions.find((s: any) => s.id === sessionId);
  assert.ok(found, "列表应包含新会话");
  assert.equal(found.messageCount, 2);
  assert.ok(found.created && found.modified);

  const msgs = await api(`/chat/sessions/${sessionId}/messages`);
  assert.equal(msgs.ok, true);
  assert.equal(msgs.data.messages.length, 2);
  assert.equal(msgs.data.messages[0].role, "user");
  assert.equal(msgs.data.messages[0].text, "第一句");
  assert.equal(msgs.data.messages[1].text, "回答", "Content[] 应提取 text 段");
  assert.ok(msgs.data.messages[0].ts);

  const nf = await api("/chat/sessions/00000000-0000-0000-0000-000000000000/messages");
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "SESSION_NOT_FOUND");
});

// ============ /api/files/rename（B8） ============

test("files/rename: 重命名并改回；非法后缀 400", async () => {
  const r = await sendJson("POST", "/files/rename", {
    path: "正文/ch001.md",
    newPath: "正文/ch001-改名.md",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.path, "正文/ch001-改名.md");

  const badExt = await sendJson("POST", "/files/rename", {
    path: "正文/ch001-改名.md",
    newPath: "novel.json",
  });
  assert.equal(badExt.status, 400, ".json 目标拒绝（只许 .md）");

  const back = await sendJson("POST", "/files/rename", {
    path: "正文/ch001-改名.md",
    newPath: "正文/ch001.md",
  });
  assert.equal(back.ok, true);
});

// ============ /api/debug/*（debugBus 已注入） ============

test("debug/events: 注入 bus 后能看到已发事件", async () => {
  debugBus.emit({ id: "dbg_test_1", ts: Date.now(), traceId: "trace_t", stage: "system", status: "start" });
  const r = await api("/debug/events");
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data.events));
  assert.ok(r.data.events.some((e: any) => e.id === "dbg_test_1"), "应包含刚 emit 的事件");

  const clear = await sendJson("POST", "/debug/clear", {});
  assert.equal(clear.ok, true);
  const after1 = await api("/debug/events");
  assert.equal(after1.data.events.length, 0, "clear 后缓冲为空");
});

// ============ 静态与杂项 ============

test("未知 /api 路由 404；非 API 的 POST 405", async () => {
  const nf = await api("/nothing-here");
  assert.equal(nf.status, 404);
  const res = await fetch(`${base}some-page`, { method: "POST" });
  assert.equal(res.status, 405);
});

// ============ /api/chat/*（已装配 ChatContext；主会话未启动时 status 只读降级） ============

test("chat/status: 主会话未启动时返回 active=false（只读，不触发启动）", async () => {
  const r = await api("/chat/status");
  assert.equal(r.ok, true);
  assert.equal(r.data.active, false);
  assert.equal(r.data.isStreaming, false);
});

// ============================================================================
// 世界图路由（已激活 projB，含丰富种子数据 viz1/viz2）
// ============================================================================

test("GET /api/status 返回 entityCount/eventCount/storyTimes", async () => {
  const r = await api("/status");
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.data.storyTimes, ["t1", "t2"]);
  assert.equal(r.data.entityCount, 3);
  assert.equal(r.data.eventCount, 4);
});

test("GET /api/graph 指定 storyTime 返回实体与关系", async () => {
  const r = await api("/graph?storyTime=t2");
  assert.equal(r.ok, true);
  assert.equal(r.data.entities.length, 3);
  assert.equal(r.data.relations.length, 1);
  assert.equal(r.data.relations[0].label, "located_in");
  const e1 = r.data.entities.find((e: any) => e.entityId === "viz1");
  assert.equal(e1.summary, "主角");
  const mood = e1.properties.find((p: any) => p.property === "mood");
  assert.equal(mood.value, "愤怒", "t2 时刻应看到 change 后的新值");
});

test("GET /api/graph 缺 storyTime → 400 STORY_TIME_REQUIRED", async () => {
  const r = await api("/graph");
  assert.equal(r.status, 400);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "STORY_TIME_REQUIRED");
});

test("GET /api/entities/:id 返回快照；未知实体 404", async () => {
  const r = await api("/entities/viz1?storyTime=t2");
  assert.equal(r.ok, true);
  assert.equal(r.data.entityId, "viz1");

  const missing = await api("/entities/unknown?storyTime=t2");
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "ENTITY_NOT_FOUND");

  const noTime = await api("/entities/viz1");
  assert.equal(noTime.status, 400);
  assert.equal(noTime.error?.code, "STORY_TIME_REQUIRED");
});

test("GET /api/entities/:id/history 含已闭合声明与关系历史", async () => {
  const r = await api("/entities/viz1/history");
  assert.equal(r.ok, true);
  const oldMood = r.data.facts.find(
    (f: any) => f.property === "mood" && f.value === "平静",
  );
  assert.ok(oldMood, "历史应含旧 mood 声明");
  assert.equal(oldMood.validTo, "t2", "旧声明应已在 t2 闭合");
  assert.ok(
    r.data.relations.some((rel: any) => rel.label === "located_in"),
    "历史应含关系记录",
  );
});

test("GET /api/declarations/:declId/visibility 返回可见性记录", async () => {
  const r = await api("/declarations/decl-viz2-name-t1/visibility?storyTime=t1");
  assert.equal(r.ok, true);
  assert.equal(r.data.visibility.length, 1);
  assert.equal(r.data.visibility[0].characterId, "viz1");
  assert.equal(r.data.visibility[0].isExplicit, true);
});

test("GET /api/events 与 /api/events/:id/chain", async () => {
  const all = await api("/events");
  assert.equal(all.ok, true);
  assert.equal(all.data.events.length, 4);

  const chain = await api("/events/evt-change-mood/chain");
  assert.equal(chain.ok, true);
  assert.ok(
    chain.data.events.some((e: any) => e.eventId === "evt-change-mood"),
    "因果链应包含目标事件",
  );
});

test("GET /api/search 在 unified-server 中始终可用（fulltext）", async () => {
  const r = await api("/search?q=阿明&storyTime=t2");
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.ok(r.data.results.length >= 1);
  assert.ok(
    r.data.results.some((res: any) => res.entityId === "viz1"),
    "搜索结果应包含 viz1",
  );
});

test("未知路由 404 NOT_FOUND", async () => {
  const r = await api("/no-such-route");
  assert.equal(r.status, 404);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "NOT_FOUND");
});

test("GET /api.js 走静态服务而非 API 路由（回归：/api 前缀误判）", async () => {
  const res = await fetch(`${base}api.js`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("Viz.api"), "应返回前端 api.js 源码");
});

// ============================================================================
// 写端点（顺序敏感：后续测试依赖此处产生的 t3 数据）
// ============================================================================

test("POST /api/events 应用 change，强制 source=user，旧声明闭合", async () => {
  const r = await sendJson("POST", "/events", {
    eventId: "evt-user-edit",
    type: "change",
    storyTime: "t3",
    entityId: "viz1",
    source: "engine", // 应被服务端强制覆盖为 "user"
    invalidated: [{ declarationId: "decl-viz1-name-t1", property: "name" }],
    newFacts: [{ entityId: "viz1", property: "name", value: "明明", modality: "fact" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.data.eventId, "evt-user-edit");

  // 新值生效
  const snap = await api("/entities/viz1?storyTime=t3");
  const name = snap.data.properties.find((p: any) => p.property === "name");
  assert.equal(name.value, "明明");

  // 旧声明已闭合
  const history = await api("/entities/viz1/history");
  const oldName = history.data.facts.find(
    (f: any) => f.property === "name" && f.value === "阿明",
  );
  assert.equal(oldName.validTo, "t3");

  // events.jsonl 中该事件 source === "user"
  const lines = readFileSync(join(projB, ".pi", "world-graph-v3", "events.jsonl"), "utf-8").trim().split("\n");
  const logged = lines
    .map((l) => JSON.parse(l))
    .find((e: any) => e.eventId === "evt-user-edit");
  assert.ok(logged, "事件应已写入 events.jsonl");
  assert.equal(logged.source, "user", "source 应被强制覆盖为 user");
});

test("POST /api/relations 创建，/api/relations/close 闭合，includeClosed=1 可见", async () => {
  const add = await sendJson("POST", "/relations", {
    sourceId: "viz2",
    targetId: "viz1",
    label: "hosts",
    storyTime: "t3",
  });
  assert.equal(add.ok, true);

  const atT3 = await api("/graph?storyTime=t3");
  assert.ok(atT3.data.relations.some((rel: any) => rel.label === "hosts"));

  const close = await sendJson("POST", "/relations/close", {
    sourceId: "viz2",
    targetId: "viz1",
    label: "hosts",
    storyTime: "t4",
  });
  assert.equal(close.ok, true);

  const atT4 = await api("/graph?storyTime=t4");
  assert.ok(!atT4.data.relations.some((rel: any) => rel.label === "hosts"), "闭合后默认不返回");

  const withClosed = await api("/graph?storyTime=t4&includeClosed=1");
  const closed = withClosed.data.relations.find((rel: any) => rel.label === "hosts");
  assert.ok(closed, "includeClosed=1 应返回已闭合关系");
  assert.equal(closed.validTo, "t4");

  // 重复闭合 → 400 业务错误
  const again = await sendJson("POST", "/relations/close", {
    sourceId: "viz2",
    targetId: "viz1",
    label: "hosts",
    storyTime: "t5",
  });
  assert.equal(again.status, 400);
  assert.equal(again.ok, false);
  assert.equal(again.error?.code, "BUSINESS_ERROR");
});

test("POST /api/visibility 设置，/api/visibility/close 闭合", async () => {
  const set = await sendJson("POST", "/visibility", {
    characterId: "viz1",
    declarationId: "decl-viz1-mood-t2",
    confidence: 0.8,
    source: "informed",
    storyTime: "t3",
  });
  assert.equal(set.ok, true);

  const atT3 = await api("/declarations/decl-viz1-mood-t2/visibility?storyTime=t3");
  assert.equal(atT3.data.visibility.length, 1);
  assert.equal(atT3.data.visibility[0].confidence, 0.8);

  const close = await sendJson("POST", "/visibility/close", {
    characterId: "viz1",
    declarationId: "decl-viz1-mood-t2",
    storyTime: "t4",
  });
  assert.equal(close.ok, true);

  const atT4 = await api("/declarations/decl-viz1-mood-t2/visibility?storyTime=t4");
  assert.equal(atT4.data.visibility.length, 0, "闭合后该时刻不再可见");

  const allHistory = await api("/declarations/decl-viz1-mood-t2/visibility");
  assert.equal(allHistory.data.visibility.length, 1, "不传 storyTime 返回含已闭合的全部历史");
  assert.equal(allHistory.data.visibility[0].validTo, "t4");
});

test("POST /api/entities/:id/summary 更新摘要", async () => {
  const r = await sendJson("POST", "/entities/viz2/summary", { summary: "主要场景" });
  assert.equal(r.ok, true);
  const snap = await api("/entities/viz2?storyTime=t3");
  assert.equal(snap.data.summary, "主要场景");
});

test("POST /api/events 非法 body → 400 VALIDATION_ERROR", async () => {
  const r = await sendJson("POST", "/events", {
    eventId: "evt-bad",
    type: "change",
    storyTime: "t3",
    entityId: "viz1",
    newFacts: [{ entityId: "viz1", property: "x", value: 1, modality: "not-a-modality" }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "VALIDATION_ERROR");
});
// ============ B5：事件溯源便捷端点（props/close/kill） ============

test("entities/:id/props：属性编辑（旧声明闭合 + 新声明生效）；404/400", async () => {
  // 造临时实体（t6 诞生，不影响既有 viz1/viz2 断言）
  await sendJson("POST", "/events", {
    eventId: "evt-b5-birth",
    type: "birth",
    storyTime: "t6",
    entityId: "e-b5",
    entityType: "character",
    newFacts: [{ entityId: "e-b5", property: "name", value: "临时", modality: "fact" }],
  });

  // 首次设置 mood（无旧声明可闭合）
  const r1 = await sendJson("POST", "/entities/e-b5/props", {
    property: "mood",
    value: "平静",
    storyTime: "t6",
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.data.closedDeclarationId, null);
  const decl1 = r1.data.newDeclarationId as string;
  assert.ok(decl1, "应返回新声明 ID");

  // 再次编辑：旧声明闭合 + 新值生效
  const r2 = await sendJson("POST", "/entities/e-b5/props", {
    property: "mood",
    value: "愤怒",
    storyTime: "t7",
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.data.closedDeclarationId, decl1, "应闭合上一版 mood 声明");

  const snap = await api("/entities/e-b5?storyTime=t7");
  assert.equal(snap.data.properties.find((p: any) => p.property === "mood").value, "愤怒");
  const history = await api("/entities/e-b5/history");
  assert.equal(
    history.data.facts.find((f: any) => f.declarationId === decl1).validTo,
    "t7",
    "旧声明应在 t7 闭合",
  );

  // 错误路径
  const nf = await sendJson("POST", "/entities/e-ghost/props", {
    property: "x",
    value: 1,
    storyTime: "t7",
  });
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "ENTITY_NOT_FOUND");
  const bad = await sendJson("POST", "/entities/e-b5/props", {
    property: "x",
    value: 1,
    storyTime: "t7",
    modality: "nope",
  });
  assert.equal(bad.status, 400);
});

test("declarations/close：闭合声明生效；不存在 404；重复闭合 409", async () => {
  const snap = await api("/entities/e-b5?storyTime=t7");
  const decl = snap.data.properties.find((p: any) => p.property === "mood");

  const r = await sendJson("POST", "/declarations/close", {
    declarationId: decl.declarationId,
    entityId: "e-b5",
    storyTime: "t8",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { declarationId: decl.declarationId, closed: true });

  const history = await api("/entities/e-b5/history");
  assert.equal(
    history.data.facts.find((f: any) => f.declarationId === decl.declarationId).validTo,
    "t8",
    "声明应在 t8 闭合",
  );

  const again = await sendJson("POST", "/declarations/close", {
    declarationId: decl.declarationId,
    entityId: "e-b5",
    storyTime: "t9",
  });
  assert.equal(again.status, 409);
  assert.equal(again.error?.code, "DECLARATION_CLOSED");

  const nf = await sendJson("POST", "/declarations/close", {
    declarationId: "decl-ghost",
    entityId: "e-b5",
    storyTime: "t9",
  });
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "DECLARATION_NOT_FOUND");
});

test("entities/:id/kill：实体退场后该时刻快照消失，历史不丢；不存在 404", async () => {
  const r = await sendJson("POST", "/entities/e-b5/kill", { storyTime: "t9" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { entityId: "e-b5", killedAt: "t9" });

  const after = await api("/entities/e-b5?storyTime=t9");
  assert.equal(after.status, 404, "t9 起实体已退场");
  const before = await api("/entities/e-b5?storyTime=t7");
  assert.equal(before.ok, true, "t7 时刻仍可见（双时态闭合，历史不丢）");

  const nf = await sendJson("POST", "/entities/e-ghost/kill", { storyTime: "t9" });
  assert.equal(nf.status, 404);
  assert.equal(nf.error?.code, "ENTITY_NOT_FOUND");
});

test("POST 请求体超上限 → 413 MAX_BODY_SIZE（响应可读，连接不中断）", async () => {
  const big = JSON.stringify({ summary: "z".repeat(2 * 1024 * 1024) });
  const res = await fetch(`${base}api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: big,
  });
  assert.equal(res.status, 413);
  const json = (await res.json()) as { error: { code: string } };
  assert.equal(json.error.code, "MAX_BODY_SIZE");
});

test("恶意 Origin 请求 /api/* → 403 ORIGIN_REJECTED；同源无 Origin 放行", async () => {
  const evil = await fetch(`${base}api/status`, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const evilJson = (await evil.json()) as { error: { code: string } };
  assert.equal(evilJson.error.code, "ORIGIN_REJECTED");

  const sameOrigin = await fetch(`${base}api/status`, {
    headers: { origin: `http://127.0.0.1:${server.port}` },
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(
    sameOrigin.headers.get("access-control-allow-origin"),
    `http://127.0.0.1:${server.port}`,
    "白名单 Origin 回显精确值而非通配 *",
  );
});

test("M-Sec-1：HTTP 安全头统一下发（nosniff / DENY / no-referrer）", async () => {
  const apiRes = await fetch(`${base}api/status`);
  assert.equal(apiRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(apiRes.headers.get("x-frame-options"), "DENY");
  assert.equal(apiRes.headers.get("referrer-policy"), "no-referrer");

  const staticRes = await fetch(`${base}no-such-asset.js`);
  assert.equal(staticRes.status, 404);
  assert.equal(staticRes.headers.get("x-content-type-options"), "nosniff", "静态资源响应同样生效");
  assert.equal(staticRes.headers.get("referrer-policy"), "no-referrer");
});
