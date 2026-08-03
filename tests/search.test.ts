import { test } from "node:test";
import assert from "node:assert/strict";
import { WorldGraph } from "underworld-graph";
import { Search } from "../src/search.ts";
import { Embedder } from "../src/embedder.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// CI 跳过：setup 调 reembedAll(真实 Embedder) 需从 HuggingFace 下载 bge-small-zh，
// 429 rate limit 偶发失败；检索链路由 tests/e2e.test.ts 的 stub + fulltext 覆盖。
const isCI = !!process.env.CI;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "search-test-"));
  const wg = await WorldGraph.create({ dbPath: join(dir, "test.db"), eventLogPath: join(dir, "events.jsonl") });
  await wg.birthEntity("macbeth", "character", { name: "Macbeth", title: "Thane of Cawdor" }, "act1-scene1");
  await wg.birthEntity("duncan", "character", { name: "Duncan", title: "King" }, "act1-scene1");
  const embedder = new Embedder();
  await wg.reembedAll(embedder);
  const search = new Search(wg, embedder);
  return { wg, search };
}

test("Search.fulltext 返回 EntitySearchResult", { skip: isCI }, async () => {
  const { wg, search } = await setup();
  const results = await search.fulltext("Macbeth", { topK: 5, storyTime: "act1-scene1" });
  assert.ok(results.length > 0, "应命中 Macbeth");
  assert.equal(results[0].entityId, "macbeth");
  assert.equal(results[0].matchType, "fulltext");
  wg.close();
});

test("Search.vector 返回 EntitySearchResult", { skip: isCI }, async () => {
  const { wg, search } = await setup();
  const results = await search.vector("Macbeth", { topK: 5, storyTime: "act1-scene1" });
  assert.ok(Array.isArray(results));
  if (results.length > 0) {
    assert.equal(results[0].matchType, "vector");
  }
  wg.close();
});

test("Search.search 默认 hybrid 模式", { skip: isCI }, async () => {
  const { wg, search } = await setup();
  const results = await search.search("Macbeth", { topK: 5, storyTime: "act1-scene1" });
  assert.ok(results.length > 0);
  wg.close();
});
