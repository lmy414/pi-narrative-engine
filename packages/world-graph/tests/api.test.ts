import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "../src/world-graph.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

async function withTempWg() {
  const dir = mkdtempSync(join(tmpdir(), "wg-api-"));
  const wg = await WorldGraph.create({
    dbPath: join(dir, "test.db"),
    eventLogPath: join(dir, "events.jsonl"),
  });
  return { wg, dir };
}

test("WorldGraph 暴露 search getter", async () => {
  const { wg } = await withTempWg();
  assert.ok(wg.search, "wg.search 应存在");
  assert.equal(typeof wg.search.fulltext, "function");
  assert.equal(typeof wg.search.vector, "function");
  assert.equal(typeof wg.search.hybrid, "function");
  wg.close();
});

test("WorldGraph 暴露 query 方法", async () => {
  const { wg } = await withTempWg();
  assert.equal(typeof wg.query, "function");
  const q = wg.query();
  assert.ok(q, "query() 应返回 QueryBuilder");
  wg.close();
});

test("WorldGraph 暴露 reembedAll 方法", async () => {
  const { wg } = await withTempWg();
  assert.equal(typeof wg.reembedAll, "function");
  // 空 store 调用应不抛错
  await wg.reembedAll({
    embedEntity: async () => [0],
    embedFact: async () => [0],
  });
  wg.close();
});
