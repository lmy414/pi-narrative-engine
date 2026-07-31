# SDK 检索能力（@nicia-ai/typegraph）

> 属于 [API 文档索引](README.md)。`underworld-graph` 包启用 `@nicia-ai/typegraph@0.40.0` 的内置检索能力。

### Graph Schema 中的可检索字段

| 节点类型 | 字段 | 装饰器 | 用途 |
|----------|------|--------|------|
| Entity | `embedding` | `embedding(512).optional()` | 向量检索（cosine） |
| Fact | `property` | `searchable({ language: "zh" })` | 全文检索属性名 |
| Fact | `valueText` | `searchable({ language: "zh" }).optional()` | 全文检索属性值 |
| Fact | `embedding` | `embedding(512).optional()` | 向量检索事实 |

### StoreSearch API（通过 `wg.search`）

```typescript
// 全文检索
const fulltextHits = await wg.search.fulltext("Fact", {
  query: "Macbeth",
  limit: 10,
  // 可选: mode, language, minScore, includeSnippets, where, offset
});

// 向量检索
const vectorHits = await wg.search.vector("Entity", {
  fieldPath: "embedding",
  queryEmbedding: number[],  // 512 维
  limit: 10,
  // 可选: metric, minScore, efSearch, where, offset
});

// 混合检索（RRF 融合）
const hybridHits = await wg.search.hybrid("Fact", {
  vector: { fieldPath: "embedding", queryEmbedding: number[] },
  fulltext: { query: "Macbeth" },
  limit: 10,
  // 可选: fusion, where, offset
});

// 重建全文索引（数据迁移后用）
await wg.search.rebuildFulltext();
```

### QueryBuilder API（通过 `wg.query()`）

```typescript
const results = await wg.query()
  .from("Entity")
  .whereNode({ entityId: "macbeth" })
  .traverse("declares")
  .to("Fact")
  .select()
  .execute();
```

### Hit 结构

```typescript
// 全文检索命中
type FulltextSearchHit<N> = {
  node: N;          // 完整节点对象
  score: number;    // 相关性分数
  rank: number;     // 1-based 排名
  snippet?: string; // 高亮片段（includeSnippets: true 时有值）
};

// 向量检索命中
type VectorSearchHit<N> = {
  node: N;
  score: number;
  rank: number;
};

// 混合检索命中
type HybridSearchHit<N> = {
  node: N;
  score: number;          // RRF 融合分数
  rank: number;
  vector?: VectorSearchHit<N>;
  fulltext?: FulltextSearchHit<N>;
};
```
