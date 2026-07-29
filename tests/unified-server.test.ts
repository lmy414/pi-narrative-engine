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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "@pi/world-graph";
import { ProjectRegistry } from "../src/app/project-registry.ts";
import { startUnifiedServer } from "../src/app/unified-server.ts";
import type { UnifiedServer } from "../src/app/unified-server.ts";

let root: string;
let projA: string;
let projB: string;
let snapshotDir: string;
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

  // 应用配置目录与扩展快照（避免写入真实 %APPDATA%）
  appConfigDir = join(root, "appconfig");
  snapshotDir = join(root, "snapshot");
  mkdirSync(join(snapshotDir, "dist"), { recursive: true });
  writeFileSync(
    join(snapshotDir, "package.json"),
    JSON.stringify({ name: "narrative-engine", version: "9.9.9" }),
    "utf8",
  );
  writeFileSync(join(snapshotDir, "dist", "index.js"), "// ext\n", "utf8");

  registry = new ProjectRegistry();
  server = await startUnifiedServer({
    registry,
    port: 0,
    repoRoot: root,
    templatesDir: join(root, "templates"),
    uiDir: join(root, "ui"),
    appConfigDir,
    extensionSnapshotDir: snapshotDir,
  });
  base = server.url;
});

after(async () => {
  server.close();
  await registry.closeAll();
  rmSync(root, { recursive: true, force: true });
});

// ============ /api/projects/* ============

test("projects/scan: 扫到两个项目", async () => {
  const r = await api(`/projects/scan?root=${encodeURIComponent(root)}`);
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.data.projects.length, 2);
  const names = r.data.projects.map((p: any) => p.meta.name).sort();
  assert.deepEqual(names, ["乙", "甲"]); // 按 UTF-16 码元排序：乙(U+4E59) < 甲(U+7532)
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
  assert.equal(graph.data.entities[0].entityId, "e-乙");
});

test("projects/activate: 无 world.db 的项目报 WORLD_DB_NOT_FOUND", async () => {
  const empty = join(root, "proj-empty");
  mkdirSync(empty, { recursive: true });
  writeFileSync(
    join(empty, "novel.json"),
    JSON.stringify({ name: "空", engine: "narrative-engine", engineVersion: "0.1.0" }),
    "utf8",
  );
  const r = await sendJson("POST", "/projects/activate", { dir: empty });
  assert.equal(r.status, 404);
  assert.equal(r.error?.code, "WORLD_DB_NOT_FOUND");
  // 失败不应影响当前活跃项目
  const active = await api("/projects/active");
  assert.equal(active.data.active.name, "乙");
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

// ============ /api/admin/app-config 与扩展管理（§5.1/§5.4） ============

test("admin/app-config: 读取默认配置 → 更新 → 回读", async () => {
  const def = await api("/admin/app-config");
  assert.equal(def.ok, true);
  assert.equal(def.data.extension.mode, "enabled");
  assert.equal(def.data.launcher.piExecutable, "pi");

  const w = await sendJson("PUT", "/admin/app-config", {
    launcher: { defaultScanRoots: [root] },
  });
  assert.equal(w.ok, true);
  assert.equal(w.data.launcher.defaultScanRoots[0], root);

  const back = await api("/admin/app-config");
  assert.equal(back.data.launcher.defaultScanRoots[0], root);
  assert.equal(back.data.extension.mode, "enabled", "未更新字段保留");
});

test("admin/extension/mode: 切换禁用 → 回读 → 恢复启用", async () => {
  const off = await sendJson("PUT", "/admin/extension/mode", { mode: "disabled" });
  assert.equal(off.ok, true);
  assert.equal(off.data.mode, "disabled");

  const cfg = await api("/admin/app-config");
  assert.equal(cfg.data.extension.mode, "disabled");

  const bad = await sendJson("PUT", "/admin/extension/mode", { mode: "bogus" });
  assert.equal(bad.ok, false);

  const on = await sendJson("PUT", "/admin/extension/mode", { mode: "enabled" });
  assert.equal(on.data.mode, "enabled");
});

test("admin/extension/update-check: 未安装时 current 为 null", async () => {
  const r = await api("/admin/extension/update-check");
  assert.equal(r.ok, true);
  assert.equal(r.data.available, "9.9.9");
  assert.equal(r.data.current, null);
  assert.equal(r.data.updateAvailable, false);
});

test("admin/extension/reinstall: 从快照安装并更新配置版本", async () => {
  const r = await sendJson("POST", "/admin/extension/reinstall", { skipNpmInstall: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.npmInstallRan, false);
  assert.ok(r.data.copiedFiles >= 2, "package.json + dist/index.js");

  // 安装后 update-check 应与快照同版
  const check = await api("/admin/extension/update-check");
  assert.equal(check.data.current, "9.9.9");
  assert.equal(check.data.updateAvailable, false);

  // app-config 的版本与重装时间已更新
  const cfg = await api("/admin/app-config");
  assert.equal(cfg.data.extension.version, "9.9.9");
  assert.ok(cfg.data.extension.lastUpdated.includes("T"));
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
