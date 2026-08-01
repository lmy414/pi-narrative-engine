/**
 * unified-server.test.ts — 应用化统一服务集成测试
 *
 * 通过 startUnifiedServer({ registry, port: 0 }) 起真实 HTTP 服务验证：
 * - /api/projects/*  scan / meta / active / activate / close（launch-pi、
 *   open-folder 会 spawn 系统终端/文件管理器，不在测试范围）
 * - 世界图路由与活跃项目绑定：未激活 409、激活后可用、切换后数据隔离
 * - /api/files/*     tree / read / write / create / delete + 乐观锁 + 路径安全
 * - /api/admin/*     config(.env) / rulesets / novel-json / embedder status
 *   （doctor 与 version 会 spawn pi/git，update 走 git，均不在测试范围）
 * - /api/admin/update/stream 无活跃项目且无 targetDir 时的错误事件
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "underworld-graph";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { startUnifiedServer } from "../src/app/unified-server.ts";
import type { UnifiedServer } from "../src/app/unified-server.ts";

let root: string;
let projA: string;
let projB: string;
let appConfigDir: string;
let registry: ProjectRegistry;
let server: UnifiedServer;
let base: string;

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
  server = await startUnifiedServer({
    registry,
    port: 0,
    repoRoot: root,
    templatesDir: join(root, "templates"),
    uiDir,
    appConfigDir,
  });
  base = server.url;
});

after(async () => {
  server.close();
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

test("files/tree: 列出项目乙的 markdown", async () => {
  const r = await api("/files/tree");
  assert.equal(r.ok, true);
  const paths = (nodes: any[]): string[] =>
    nodes.flatMap((n) => [n.path, ...(n.children ? paths(n.children) : [])]);
  const all = paths(r.data.tree);
  assert.ok(all.includes("正文/ch001.md"));
  assert.ok(all.includes("novel.json") === false, "非 .md 不列入");
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

test("admin/update/stream: 无 targetDir 且能解析时返回 SSE 错误事件或执行", async () => {
  // 活跃项目存在 → targetDir 缺省为活跃项目扩展目录；repoRoot 是 tmp 目录
  // （非 git 仓库），runUpdate 应立即产出 error 事件并结束
  const res = await fetch(`${base}api/admin/update/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  const first = text.split("\n\n")[0];
  assert.ok(first.startsWith("data: "));
  const evt = JSON.parse(first.slice("data: ".length));
  assert.equal(evt.stage, "error");
});

// ============ /api/admin/app-config ============

test("admin/app-config: 读取默认配置 → 更新 → 回读", async () => {
  const def = await api("/admin/app-config");
  assert.equal(def.ok, true);
  assert.equal(def.data.launcher.piExecutable, "pi");

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

// ============ 静态与杂项 ============

test("未知 /api 路由 404；非 API 的 POST 405", async () => {
  const nf = await api("/nothing-here");
  assert.equal(nf.status, 404);
  const res = await fetch(`${base}some-page`, { method: "POST" });
  assert.equal(res.status, 405);
});

// ============ /api/chat/*（未装配 ChatContext → 503） ============

test("chat: 未装配 ChatContext 时 /api/chat/* 返回 503 CHAT_UNAVAILABLE", async () => {
  const r = await api("/chat/status");
  assert.equal(r.status, 503);
  assert.equal(r.error?.code, "CHAT_UNAVAILABLE");
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