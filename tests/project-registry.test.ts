/**
 * project-registry.test.ts — 多项目世界图注册表测试
 *
 * 覆盖：
 * - openProject: 正常打开（wg/search/meta 就绪）、幂等缓存、
 *   novel.json 缺失、world.db 缺失
 * - setActive / getActive: 激活切换、自动打开
 * - closeProject: 释放句柄、关闭活跃项目时指针置空、no-op
 * - listOpen / closeAll
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorldGraph } from "@pi/world-graph";
import { ProjectRegistry, RegistryError } from "../src/app/project-registry.ts";

let root: string;
let projA: string;
let projB: string;
let emptyProj: string;

/** 造一个最小可用项目：novel.json + world.db + 一个事件 */
async function makeProject(dir: string, name: string): Promise<void> {
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
    newFacts: [{ entityId: `e-${name}`, property: "name", value: name, modality: "fact" }],
  });
  wg.close();
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "registry-test-"));
  projA = join(root, "proj-a");
  projB = join(root, "proj-b");
  emptyProj = join(root, "proj-empty");
  await makeProject(projA, "甲");
  await makeProject(projB, "乙");
  // 只有 novel.json、没有 world.db 的项目
  mkdirSync(emptyProj, { recursive: true });
  writeFileSync(
    join(emptyProj, "novel.json"),
    JSON.stringify({ name: "空", engine: "narrative-engine", engineVersion: "0.1.0" }),
    "utf8",
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("openProject: 正常打开并返回句柄", async () => {
  const registry = new ProjectRegistry();
  const handle = await registry.openProject(projA);
  assert.equal(handle.meta.name, "甲");
  assert.equal(handle.forceFulltext, true, "无 embedder 时应 forceFulltext");
  const entities = await handle.wg.getAllEntities("t1");
  assert.equal(entities.length, 1);
  await registry.closeAll();
});

test("openProject: 幂等（重复打开返回同一缓存句柄）", async () => {
  const registry = new ProjectRegistry();
  const h1 = await registry.openProject(projA);
  const h2 = await registry.openProject(projA);
  assert.equal(h1, h2);
  assert.equal(registry.listOpen().length, 1);
  await registry.closeAll();
});

test("openProject: novel.json 缺失报 NOVEL_JSON_NOT_FOUND", async () => {
  const registry = new ProjectRegistry();
  await assert.rejects(registry.openProject(join(root, "不存在")), (e) => {
    assert.ok(e instanceof RegistryError);
    assert.equal((e as RegistryError).code, "NOVEL_JSON_NOT_FOUND");
    return true;
  });
});

test("openProject: world.db 缺失报 WORLD_DB_NOT_FOUND", async () => {
  const registry = new ProjectRegistry();
  await assert.rejects(registry.openProject(emptyProj), (e) => {
    assert.ok(e instanceof RegistryError);
    assert.equal((e as RegistryError).code, "WORLD_DB_NOT_FOUND");
    return true;
  });
});

test("openProject: allowInit 自动初始化空库（新项目闭环）", async () => {
  const registry = new ProjectRegistry();
  const handle = await registry.openProject(emptyProj, { allowInit: true });
  assert.equal(handle.meta.name, "空");
  // 空库：无实体无事件，但可正常查询
  const status = await handle.wg.listStoryTimes();
  assert.deepEqual(status, []);
  await registry.closeAll();
});

test("setActive: allowInit 激活新项目后世界图可用", async () => {
  const registry = new ProjectRegistry();
  const handle = await registry.setActive(emptyProj, { allowInit: true });
  assert.equal(registry.getActive(), handle);
  // 初始化后可写入事件
  await handle.wg.processEvent({
    eventId: "evt-init-test",
    type: "birth",
    storyTime: "t1",
    entityId: "e-new",
    entityType: "character",
    newFacts: [{ entityId: "e-new", property: "name", value: "新角色", modality: "fact" }],
  });
  const entities = await handle.wg.getAllEntities("t1");
  assert.equal(entities.length, 1);
  await registry.closeAll();
});

test("setActive: 激活并自动打开，getActive 返回活跃句柄", async () => {
  const registry = new ProjectRegistry();
  assert.equal(registry.getActive(), null);
  const a = await registry.setActive(projA);
  assert.equal(registry.getActive(), a);
  const b = await registry.setActive(projB);
  assert.equal(registry.getActive(), b);
  assert.notEqual(registry.getActive(), a);
  assert.equal(registry.listOpen().length, 2, "两个项目都应保持打开");
  const names = registry.listOpen().map((o) => `${o.name}:${o.active}`).sort();
  assert.deepEqual(names, ["乙:true", "甲:false"]);
  await registry.closeAll();
});

test("closeProject: 关闭活跃项目时活跃指针置空", async () => {
  const registry = new ProjectRegistry();
  await registry.setActive(projA);
  await registry.closeProject(projA);
  assert.equal(registry.getActive(), null);
  assert.equal(registry.listOpen().length, 0);
  // 未打开的项目 close 为 no-op
  await registry.closeProject(projB);
});

test("closeAll: 释放全部句柄", async () => {
  const registry = new ProjectRegistry();
  await registry.setActive(projA);
  await registry.openProject(projB);
  await registry.closeAll();
  assert.equal(registry.listOpen().length, 0);
  assert.equal(registry.getActive(), null);
});
