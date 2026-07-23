/**
 * Task 2 单元测试：storytime.ts
 *
 * 测试范围：
 * - formatStoryTime 格式化 + 边界校验
 * - parseStoryTime 解析 + 非法输入
 * - isValidStoryTime 校验
 * - nextStoryTime 同章递增 + 跨章
 * - compareStoryTime 字典序
 *
 * 核心约束（spec L207-218）：
 * - 字符串字典序 = 故事时间序
 * - 3 位零填充
 * - 跨章节自然递增：ch001.ev007 < ch002.ev001
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatStoryTime,
  parseStoryTime,
  isValidStoryTime,
  nextStoryTime,
  compareStoryTime,
  STORY_TIME_REGEX,
  MAX_CHAPTER,
  MAX_EVENT_PER_CHAPTER,
} from "../src/storytime.ts";

// ============================================================================
// formatStoryTime
// ============================================================================

test("formatStoryTime: 基本格式化（3 位零填充）", () => {
  assert.equal(formatStoryTime(1, 1), "ch001.ev001");
  assert.equal(formatStoryTime(11, 5), "ch011.ev005");
  assert.equal(formatStoryTime(100, 50), "ch100.ev050");
});

test("formatStoryTime: 边界值 999", () => {
  assert.equal(formatStoryTime(999, 999), "ch999.ev999");
});

test("formatStoryTime: chapter < 1 抛错", () => {
  assert.throws(() => formatStoryTime(0, 1), RangeError);
  assert.throws(() => formatStoryTime(-1, 1), RangeError);
});

test("formatStoryTime: chapter > 999 抛错（超过 3 位）", () => {
  assert.throws(() => formatStoryTime(1000, 1), RangeError);
});

test("formatStoryTime: event < 1 抛错", () => {
  assert.throws(() => formatStoryTime(1, 0), RangeError);
  assert.throws(() => formatStoryTime(1, -1), RangeError);
});

test("formatStoryTime: event > 999 抛错", () => {
  assert.throws(() => formatStoryTime(1, 1000), RangeError);
});

test("formatStoryTime: 非整数抛错", () => {
  assert.throws(() => formatStoryTime(1.5, 1), RangeError);
  assert.throws(() => formatStoryTime(1, 1.5), RangeError);
  assert.throws(() => formatStoryTime(NaN, 1), RangeError);
});

// ============================================================================
// parseStoryTime
// ============================================================================

test("parseStoryTime: 基本解析", () => {
  assert.deepEqual(parseStoryTime("ch001.ev001"), { chapter: 1, event: 1 });
  assert.deepEqual(parseStoryTime("ch011.ev005"), { chapter: 11, event: 5 });
  assert.deepEqual(parseStoryTime("ch999.ev999"), { chapter: 999, event: 999 });
});

test("parseStoryTime: 非法格式抛错", () => {
  assert.throws(() => parseStoryTime("invalid"), Error);
  assert.throws(() => parseStoryTime(""), Error);
  assert.throws(() => parseStoryTime("ch001.ev01"), Error); // 2 位而非 3 位
  assert.throws(() => parseStoryTime("ch01.ev001"), Error); // 2 位而非 3 位
  assert.throws(() => parseStoryTime("ch001ev001"), Error); // 缺少点号
  assert.throws(() => parseStoryTime("ch001.ev001x"), Error); // 多余字符
  assert.throws(() => parseStoryTime("ch001.ev000"), Error); // event=0 不合法
});

// ============================================================================
// isValidStoryTime
// ============================================================================

test("isValidStoryTime: 合法 storyTime 返回 true", () => {
  assert.equal(isValidStoryTime("ch001.ev001"), true);
  assert.equal(isValidStoryTime("ch011.ev005"), true);
  assert.equal(isValidStoryTime("ch999.ev999"), true);
});

test("isValidStoryTime: 非法 storyTime 返回 false", () => {
  assert.equal(isValidStoryTime("invalid"), false);
  assert.equal(isValidStoryTime(""), false);
  assert.equal(isValidStoryTime("ch01.ev1"), false);
  assert.equal(isValidStoryTime("ch1.ev1"), false);
  assert.equal(isValidStoryTime("ch0001.ev0001"), false);
});

test("STORY_TIME_REGEX: 正则常量可独立使用", () => {
  assert.ok(STORY_TIME_REGEX.test("ch001.ev001"));
  assert.ok(!STORY_TIME_REGEX.test("ch01.ev1"));
});

// ============================================================================
// nextStoryTime
// ============================================================================

test("nextStoryTime: 同章内 event+1", () => {
  assert.equal(nextStoryTime("ch001.ev001"), "ch001.ev002");
  assert.equal(nextStoryTime("ch011.ev005"), "ch011.ev006");
});

test("nextStoryTime: event=999 时跨章进入下一章 event=1", () => {
  assert.equal(nextStoryTime("ch001.ev999"), "ch002.ev001");
  assert.equal(nextStoryTime("ch010.ev999"), "ch011.ev001");
});

test("nextStoryTime: ch999.ev999 已到上限抛错", () => {
  assert.throws(() => nextStoryTime("ch999.ev999"), Error);
});

test("nextStoryTime: 非法 storyTime 抛错", () => {
  assert.throws(() => nextStoryTime("invalid"), Error);
  assert.throws(() => nextStoryTime("ch01.ev1"), Error);
});

// ============================================================================
// compareStoryTime
// ============================================================================

test("compareStoryTime: a < b 返回 -1", () => {
  assert.equal(compareStoryTime("ch001.ev001", "ch001.ev002"), -1);
  assert.equal(compareStoryTime("ch001.ev007", "ch002.ev001"), -1); // 跨章
  assert.equal(compareStoryTime("ch001.ev999", "ch002.ev001"), -1);
});

test("compareStoryTime: a > b 返回 1", () => {
  assert.equal(compareStoryTime("ch001.ev002", "ch001.ev001"), 1);
  assert.equal(compareStoryTime("ch002.ev001", "ch001.ev999"), 1); // 跨章
});

test("compareStoryTime: a === b 返回 0", () => {
  assert.equal(compareStoryTime("ch001.ev001", "ch001.ev001"), 0);
  assert.equal(compareStoryTime("ch999.ev999", "ch999.ev999"), 0);
});

test("compareStoryTime: 字典序 = 时间序的核心约束", () => {
  // spec L215: 跨章节自然递增 ch001.ev007 < ch002.ev001
  assert.equal(compareStoryTime("ch001.ev007", "ch002.ev001"), -1);
  // 字符串字典序也应一致
  assert.equal("ch001.ev007" < "ch002.ev001", true);
});

// ============================================================================
// 常量导出
// ============================================================================

test("常量: MAX_CHAPTER 和 MAX_EVENT_PER_CHAPTER", () => {
  assert.equal(MAX_CHAPTER, 999);
  assert.equal(MAX_EVENT_PER_CHAPTER, 999);
});
