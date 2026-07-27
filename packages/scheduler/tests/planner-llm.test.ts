// tests/planner-llm.test.ts
/**
 * parseRetrievalItem 单测（P0-2 修复，2026-07-27）
 *
 * 验证 LLM 输出的 params.recordedAsOf 字段被正确解析到 RetrievalItem.params.recordedAsOf
 * 若不解析，recordedAsOf 永远是 undefined，P0-2 双时态检索修复完全无效
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetrievalItem } from "../../../src/planner-llm.ts";

// ----------------------------------------------------------------------------

test("parseRetrievalItem: 解析 params.recordedAsOf 字段", () => {
  const raw = {
    type: "character_view",
    params: {
      entityId: "linchong",
      recordedAsOf: "tx-2026-07-27T10:00:00Z",
    },
    assignTo: ["linchong"],
    label: "test",
  };
  const item = parseRetrievalItem(raw);
  assert.equal(item.params.recordedAsOf, "tx-2026-07-27T10:00:00Z");
});

test("parseRetrievalItem: recordedAsOf 缺失时返回 undefined", () => {
  const raw = {
    type: "character_view",
    params: {
      entityId: "linchong",
      // 无 recordedAsOf
    },
    assignTo: ["linchong"],
    label: "test",
  };
  const item = parseRetrievalItem(raw);
  assert.equal(item.params.recordedAsOf, undefined);
});

test("parseRetrievalItem: recordedAsOf 非字符串时返回 undefined", () => {
  const raw = {
    type: "character_view",
    params: {
      entityId: "linchong",
      recordedAsOf: 12345, // 非字符串
    },
    assignTo: ["linchong"],
    label: "test",
  };
  const item = parseRetrievalItem(raw);
  assert.equal(item.params.recordedAsOf, undefined);
});

test("parseRetrievalItem: params 缺失时不抛错", () => {
  const raw = {
    type: "character_view",
    // 无 params
    assignTo: ["linchong"],
    label: "test",
  };
  const item = parseRetrievalItem(raw);
  assert.equal(item.params.recordedAsOf, undefined);
  assert.equal(item.params.entityId, undefined);
});

test("parseRetrievalItem: 其他字段解析不受影响", () => {
  const raw = {
    type: "search_vector",
    params: {
      query: "酒馆",
      nodeType: "Entity",
      limit: 5,
      fieldPath: "embedding",
      recordedAsOf: "tx-test",
    },
    assignTo: ["linchong"],
    label: "酒馆检索",
  };
  const item = parseRetrievalItem(raw);
  assert.equal(item.type, "search_vector");
  assert.equal(item.params.query, "酒馆");
  assert.equal(item.params.nodeType, "Entity");
  assert.equal(item.params.limit, 5);
  assert.equal(item.params.fieldPath, "embedding");
  assert.equal(item.params.recordedAsOf, "tx-test");
  assert.deepEqual(item.assignTo, ["linchong"]);
  assert.equal(item.label, "酒馆检索");
});
