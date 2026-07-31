# `Search` 类与 `Embedder` 类 API

> 属于 [API 文档索引](README.md)。位于 `src/search.ts` 与 `src/embedder.ts`（扩展层内部类，非子包导出）。

## `Search` 类（SDK StoreSearch 薄包装）

```typescript
import { Search } from "narrative-engine/src/search.ts";

const search = new Search(wg, embedder);
```

### 构造函数

```typescript
constructor(wg: WorldGraph, embedder: Embedder)
```

### 方法

#### `search(query, opts?): Promise<EntitySearchResult[]>`

统一检索入口，默认 `hybrid` 模式。

**参数**：
| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `query` | string | 是 | - | 查询文本 |
| `opts.topK` | number | 否 | `10` | 返回数量上限 |
| `opts.typeFilter` | EntityType | 否 | - | 实体类型过滤 |
| `opts.storyTime` | string | 是 | - | 故事时间（**必填**，用于 bi-temporal 过滤；缺失抛错） |
| `opts.mode` | `"fulltext"` \| `"vector"` \| `"hybrid"` | 否 | `"hybrid"` | 检索模式 |

#### `fulltext(query, opts?): Promise<EntitySearchResult[]>`

仅全文检索。搜 Fact 节点的 `property` + `valueText` 字段（FTS5）。

#### `vector(query, opts?): Promise<EntitySearchResult[]>`

仅向量检索。先将 `query` 通过 `embedder.embed()` 转向量，再搜 Entity 节点的 `embedding` 字段（cosine 相似度）。

#### `hybrid(query, opts?): Promise<EntitySearchResult[]>`

混合检索。RRF 融合 fulltext + vector 结果。搜 Fact 节点（同时有 searchable + embedding 字段）。

### `EntitySearchResult` 接口

```typescript
interface EntitySearchResult {
  entityId: string;
  type: EntityType;
  score: number;              // 相关性分数（越高越相关）
  matchType: "fulltext" | "vector" | "hybrid";
  snapshot: EntitySnapshot;   // 实体快照（含 properties）
}
```

## `Embedder` 类（Xenova 向量化）

```typescript
import { Embedder } from "narrative-engine/src/embedder.ts";

const embedder = new Embedder();  // 默认 Xenova/bge-small-zh-v1.5, 512 维
```

### 构造函数

```typescript
constructor(model?: string, dim?: number)
// 默认: model = "Xenova/bge-small-zh-v1.5"（可用 PI_EMBEDDER_MODEL 环境变量覆盖）, dim = 512
```

### 实例方法

| 方法 | 说明 |
|------|------|
| `async init(): Promise<void>` | 懒加载模型（首次调用时下载/加载，多次调用安全） |
| `async embed(text: string): Promise<number[]>` | 通用文本向量化，返回 512 维归一化向量 |
| `async embedBatch(texts: string[]): Promise<number[][]>` | 批量向量化（提高吞吐） |
| `async embedEntity(snapshot: EntitySnapshot): Promise<number[]>` | 实体向量化（拼接 `entityId + type + properties`，**不含 summary**） |
| `async embedFact(decl: StateDeclaration): Promise<number[]>` | 事实向量化（拼接 `property + value + modality`） |
| `getDimension(): number` | 获取向量维度（512） |

### 静态方法

| 方法 | 说明 |
|------|------|
| `static cosineSimilarity(a, b): number` | 计算余弦相似度（向量已归一化，等价于点积） |
| `static euclideanDistance(a, b): number` | 计算欧氏距离 |

### 配置

**镜像**（国内用户）：通过 `HF_ENDPOINT` 环境变量切换 HuggingFace 镜像（导入时映射为 transformers.js 的 `env.remoteHost`）
```bash
export HF_ENDPOINT=https://hf-mirror.com
```

`hf-mirror.com` 不可达时可用作者自维护的备用镜像：
```bash
export HF_ENDPOINT=https://emaostudio.online/hf-mirror
```

**模型文件**：~50MB（量化 ONNX），首次运行时下载到本地缓存。

**缓存路径**（2026-07-25 修正认知）：`<模块所在 node_modules>/@xenova/transformers/.cache/`
（transformers.js v2 默认缓存位置，**不是** `~/.cache/huggingface`）。
sync 保留扩展目录 node_modules，缓存不会因重新同步丢失。

**离线回退**（2026-07-25 新增）：远程加载失败（HF 受限网络 fetch failed）时自动
`localFilesOnly = true` 重试——模型已缓存则完全离线可用。
