// tests/cache.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setPlan,
  getPlan,
  deletePlan,
  discard,
  resetPlanCache,
  planCacheSize,
  loadAllPlans,
  removePlansDir,
} from "../src/cache.ts";
import type { PlanResult } from "../src/types.ts";

// cache 是模块级单例，跨测试用例污染——每个用例前都清空
// 每个用例使用独立的临时 cwd，避免互相干扰

let tmpCwd: string;

beforeEach(async () => {
  resetPlanCache();
  tmpCwd = await mkdtemp(path.join(tmpdir(), "scheduler-test-"));
  // loadAllPlans 初始化 plansDir + 清空目录残留
  await removePlansDir(tmpCwd);
  await loadAllPlans(tmpCwd);
});

afterEach(async () => {
  // 清理临时目录
  try {
    await rm(tmpCwd, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

function makeMockPlan(planId: string): PlanResult {
  return {
    planId,
    eventId: `evt_${planId}`,
    event: {
      storyTime: "ch-1",
      instruction: "测试",
      characterIds: ["c1"],
    },
    chapterPath: "/tmp/test.md",
    retrievalPlan: { items: [] },
    roleResult: { outputs: [], errors: [] },
    cast: [],
    createdAt: Date.now(),
  };
}

test("cache: setPlan + getPlan 正常存取", () => {
  resetPlanCache();
  const plan = makeMockPlan("plan_001");
  setPlan("plan_001", plan);
  assert.equal(planCacheSize(), 1);
  const got = getPlan("plan_001");
  assert.ok(got);
  assert.equal(got!.planId, "plan_001");
  assert.equal(got!.eventId, "evt_plan_001");
});

test("cache: getPlan 不存在返回 undefined", () => {
  resetPlanCache();
  assert.equal(getPlan("not_exist"), undefined);
});

test("cache: deletePlan 存在的 plan 返回 true", () => {
  resetPlanCache();
  setPlan("plan_1", makeMockPlan("plan_1"));
  assert.equal(planCacheSize(), 1);
  assert.equal(deletePlan("plan_1"), true);
  assert.equal(planCacheSize(), 0);
  assert.equal(getPlan("plan_1"), undefined);
});

test("cache: deletePlan 不存在返回 false", () => {
  resetPlanCache();
  assert.equal(deletePlan("not_exist"), false);
});

test("cache: discard 等同于 deletePlan（不写世界图、不渲染）", () => {
  resetPlanCache();
  setPlan("plan_2", makeMockPlan("plan_2"));
  assert.equal(planCacheSize(), 1);
  assert.equal(discard("plan_2"), true);
  assert.equal(planCacheSize(), 0);
});

test("cache: discard 不存在返回 false", () => {
  resetPlanCache();
  assert.equal(discard("not_exist"), false);
});

test("cache: 多个 plan 共存", () => {
  resetPlanCache();
  setPlan("plan_a", makeMockPlan("plan_a"));
  setPlan("plan_b", makeMockPlan("plan_b"));
  setPlan("plan_c", makeMockPlan("plan_c"));
  assert.equal(planCacheSize(), 3);
  assert.ok(getPlan("plan_a"));
  assert.ok(getPlan("plan_b"));
  assert.ok(getPlan("plan_c"));
});

test("cache: resetPlanCache 清空所有", () => {
  setPlan("plan_a", makeMockPlan("plan_a"));
  setPlan("plan_b", makeMockPlan("plan_b"));
  assert.equal(planCacheSize(), 2);
  resetPlanCache();
  assert.equal(planCacheSize(), 0);
  assert.equal(getPlan("plan_a"), undefined);
});

test("cache: setPlan 同一 planId 覆盖旧值", () => {
  resetPlanCache();
  setPlan("plan_x", makeMockPlan("plan_x"));
  const newPlan = makeMockPlan("plan_x");
  newPlan.event.instruction = "updated";
  setPlan("plan_x", newPlan);
  assert.equal(planCacheSize(), 1);
  assert.equal(getPlan("plan_x")!.event.instruction, "updated");
});

// ============================================================================
// 持久化测试（Pending Gap #6）
// ============================================================================

test("持久化: setPlan 同步写入 JSON 文件", async () => {
  setPlan("plan_persist_1", makeMockPlan("plan_persist_1"));
  // setPlan 异步写盘，等待一下
  await new Promise((r) => setTimeout(r, 50));
  const filePath = path.join(tmpCwd, ".pi", "scheduler-plans", "plan_persist_1.json");
  assert.ok(existsSync(filePath), "plan 文件应存在");
  const content = await readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.planId, "plan_persist_1");
  assert.equal(parsed.event.instruction, "测试");
});

test("持久化: deletePlan 同步删除 JSON 文件", async () => {
  setPlan("plan_del_1", makeMockPlan("plan_del_1"));
  await new Promise((r) => setTimeout(r, 50));
  const filePath = path.join(tmpCwd, ".pi", "scheduler-plans", "plan_del_1.json");
  assert.ok(existsSync(filePath));
  assert.equal(deletePlan("plan_del_1"), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(filePath), "plan 文件应被删除");
});

test("持久化: discard 等同于 deletePlan（同时删文件）", async () => {
  setPlan("plan_discard_1", makeMockPlan("plan_discard_1"));
  await new Promise((r) => setTimeout(r, 50));
  const filePath = path.join(tmpCwd, ".pi", "scheduler-plans", "plan_discard_1.json");
  assert.ok(existsSync(filePath));
  assert.equal(discard("plan_discard_1"), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(filePath));
});

test("持久化: loadAllPlans 从磁盘恢复 plan 到内存", async () => {
  // 写入一个 plan（持久化到磁盘）
  setPlan("plan_load_1", makeMockPlan("plan_load_1"));
  setPlan("plan_load_2", makeMockPlan("plan_load_2"));
  await new Promise((r) => setTimeout(r, 50));

  // 模拟进程重启：清空内存 + 重新加载
  resetPlanCache();
  assert.equal(planCacheSize(), 0);

  const loaded = await loadAllPlans(tmpCwd);
  assert.equal(loaded, 2);
  assert.equal(planCacheSize(), 2);
  assert.ok(getPlan("plan_load_1"));
  assert.ok(getPlan("plan_load_2"));
});

test("持久化: loadAllPlans 跳过已损坏的文件", async () => {
  // 写一个合法 plan
  setPlan("plan_valid", makeMockPlan("plan_valid"));
  await new Promise((r) => setTimeout(r, 50));

  // 写一个损坏的 JSON 文件
  const corruptPath = path.join(tmpCwd, ".pi", "scheduler-plans", "plan_corrupt.json");
  await writeFile(corruptPath, "{ invalid json", "utf8");

  resetPlanCache();
  const loaded = await loadAllPlans(tmpCwd);
  assert.equal(loaded, 1, "应只加载合法 plan");
  assert.ok(getPlan("plan_valid"));
  assert.equal(getPlan("plan_corrupt"), undefined);

  // 损坏文件应被重命名为 .corrupt
  assert.ok(!existsSync(corruptPath), "损坏文件应被移走");
  assert.ok(existsSync(`${corruptPath}.corrupt`), "应存在 .corrupt 文件");
});

test("持久化: TTL 清理 1 小时前的 plan", async () => {
  // 写入一个 2 小时前的 plan（手动构造文件）
  const oldPlan: PlanResult = {
    ...makeMockPlan("plan_expired"),
    createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 小时前
  };
  const filePath = path.join(tmpCwd, ".pi", "scheduler-plans", "plan_expired.json");
  await writeFile(filePath, JSON.stringify(oldPlan), "utf8");

  // 写入一个新 plan
  setPlan("plan_fresh", makeMockPlan("plan_fresh"));
  await new Promise((r) => setTimeout(r, 50));

  resetPlanCache();
  const loaded = await loadAllPlans(tmpCwd);
  assert.equal(loaded, 1, "应只加载未过期的 plan");
  assert.ok(getPlan("plan_fresh"));
  assert.equal(getPlan("plan_expired"), undefined, "过期 plan 不应加载");

  // 过期文件应被删除
  assert.ok(!existsSync(filePath), "过期 plan 文件应被删除");
});

test("持久化: removePlansDir 删除整个目录", async () => {
  setPlan("plan_rm_1", makeMockPlan("plan_rm_1"));
  setPlan("plan_rm_2", makeMockPlan("plan_rm_2"));
  await new Promise((r) => setTimeout(r, 50));

  const dir = path.join(tmpCwd, ".pi", "scheduler-plans");
  assert.ok(existsSync(dir));

  await removePlansDir(tmpCwd);
  assert.ok(!existsSync(dir), "目录应被删除");
  assert.equal(planCacheSize(), 0);
});

test("持久化: 多个 plan 文件可共存（按 planId 命名）", async () => {
  setPlan("plan_coexist_1", makeMockPlan("plan_coexist_1"));
  setPlan("plan_coexist_2", makeMockPlan("plan_coexist_2"));
  setPlan("plan_coexist_3", makeMockPlan("plan_coexist_3"));
  await new Promise((r) => setTimeout(r, 50));

  const dir = path.join(tmpCwd, ".pi", "scheduler-plans");
  const entries = await (await import("node:fs/promises")).readdir(dir);
  const planFiles = entries.filter((n) => n.endsWith(".json"));
  assert.equal(planFiles.length, 3);
});
