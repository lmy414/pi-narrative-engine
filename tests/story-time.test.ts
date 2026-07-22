import { test } from "node:test";
import assert from "node:assert/strict";

test("index.ts default export 是 function（activate 入口）", async () => {
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.default, "function", "default export 应是 activate function");
});

test("index.ts 导出 getState 用于测试", async () => {
  const mod = await import("../src/index.ts");
  assert.equal(typeof mod.getState, "function", "应导出 getState 测试辅助");
  const state = mod.getState();
  assert.equal(state.currentStoryTime, null, "初始 currentStoryTime 应为 null");
  assert.equal(state.wg, null, "初始 wg 应为 null");
  assert.equal(state.search, null, "初始 search 应为 null");
});
