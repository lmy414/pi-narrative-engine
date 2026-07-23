/**
 * Task 0 smoke 测试
 *
 * 验证：
 * 1. @pi/novel-importer 子包可被 workspace 识别
 * 2. runImportPipeline 函数已导出
 * 3. 占位实现按预期抛出 "not implemented yet" 错误
 *
 * 实际管道测试见 Task 11 端到端测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runImportPipeline } from "../src/index.ts";

test("smoke: runImportPipeline is exported as function", () => {
  assert.equal(typeof runImportPipeline, "function");
});

test("smoke: runImportPipeline throws not-implemented error", async () => {
  await assert.rejects(
    () => runImportPipeline({ epubPath: "" }),
    /not implemented yet/,
  );
});
