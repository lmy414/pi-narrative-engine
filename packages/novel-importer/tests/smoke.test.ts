/**
 * Task 0 smoke 测试
 *
 * 验证：
 * 1. @pi/novel-importer 子包可被 workspace 识别
 * 2. runImportPipeline 函数已导出
 * 3. 非法 epubPath 在阶段 1（EPUB 分章）即报错
 *
 * 实际管道测试见 Task 11 端到端测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runImportPipeline } from "../src/index.ts";

test("smoke: runImportPipeline is exported as function", () => {
  assert.equal(typeof runImportPipeline, "function");
});

test("smoke: runImportPipeline 非法 epubPath 报错", async () => {
  await assert.rejects(
    () => runImportPipeline({ epubPath: "" }),
    Error,
  );
});
