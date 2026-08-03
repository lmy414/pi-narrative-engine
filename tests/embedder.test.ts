import { test } from "node:test";
import assert from "node:assert/strict";
import { Embedder } from "../src/embedder.ts";

// CI 跳过：真模型需从 HuggingFace 下载（bge-small-zh），429 rate limit 偶发失败；
// 本地保留真模型验证。e2e 链路由 stub + fulltext 覆盖（tests/e2e.test.ts）。
const isCI = !!process.env.CI;

test("Embedder.embedEntity 接收 EntitySnapshot", { skip: isCI }, async () => {
  const emb = new Embedder();
  const vec = await emb.embedEntity({
    entityId: "macbeth",
    type: "character",
    validFrom: "act1-scene1",
    validTo: "Infinity",
    properties: [
      { declarationId: "d1", entityId: "macbeth", property: "name", value: "Macbeth", modality: "fact", validFrom: "act1-scene1", validTo: "Infinity" },
    ],
  });
  assert.equal(vec.length, 512, "向量应为 512 维");
});

test("Embedder.embedFact 接收 StateDeclaration", { skip: isCI }, async () => {
  const emb = new Embedder();
  const vec = await emb.embedFact({
    declarationId: "d1",
    entityId: "macbeth",
    property: "name",
    value: "Macbeth",
    modality: "fact",
    validFrom: "act1-scene1",
    validTo: "Infinity",
  });
  assert.equal(vec.length, 512);
});

test("Embedder.cosineSimilarity 静态方法保留", () => {
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  assert.equal(Embedder.cosineSimilarity(a, b), 1);
});

test("Embedder.embed 通用文本向量化保留", { skip: isCI }, async () => {
  const emb = new Embedder();
  const vec = await emb.embed("Macbeth");
  assert.equal(vec.length, 512);
});
