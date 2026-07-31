# `@pi/novel-importer` 包 API

> 属于 [API 文档索引](README.md)。V3 小说导入器子包（workspace 子包，`private: true`），通过 `import_novel` 工具暴露（见 [pi-tools-import.md](pi-tools-import.md)）。
> 源码 `packages/novel-importer/src/`。详见 spec: `.trae/specs/import-novel-v3/spec.md`（仓库外）。

## 公共导出面（软隔离后）

```typescript
import { runImportPipeline } from "@pi/novel-importer";
import type { ProgressNotifier } from "@pi/novel-importer";
```

**公共 API 仅 `runImportPipeline`**。其余（schemas / stages / epub / resolve / write / validate / storytime / types）均为 `_` 前缀内部导出（`_scanEntitiesGlobal`、`_resolveEntities`、`_writeToGraph`、`_validateGraph` 等），仅供本包测试经相对路径访问，不保证稳定。`ImportPipelineOptions` / `ImportPipelineResult` / `TextEmbedder` 等类型同样为 `_` 前缀。

## 主入口

```typescript
const result = await runImportPipeline({
  epubPath: "/path/to/novel.epub",
  worldGraphDir: "/path/to/world-graph-v3",  // 缺省 <cwd>/.pi/world-graph-v3/
  chapters: [1, 2, 3],        // 可选：限定章节
  model: "deepseek-v4-flash",     // 可选：LLM 模型
  apiKey: process.env.DEEPSEEK_API_KEY,  // 可选：API key
  concurrency: 3,             // 可选：章节并行限流
  resumeFromStage: 1,         // 可选：从阶段 N 恢复
  cwd: process.cwd(),         // 注入 cwd 用于默认 worldGraphDir
  embedder: embedderInstance, // 注入 TextEmbedder（满足 { embed(text): number[] } 接口）
});
```

### `ImportPipelineOptions`（`_ImportPipelineOptions`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `epubPath` | string | 是 | EPUB 文件绝对路径 |
| `worldGraphDir` | string | 否 | 存储目录（缺省 `<cwd>/.pi/world-graph-v3/`） |
| `chapters` | number[] | 否 | 限定导入章节（1-based），缺省全部 |
| `model` | string | 否 | LLM 模型名（缺省 `PI_MODEL` 环境变量） |
| `apiKey` | string | 否 | LLM API key（缺省 `DEEPSEEK_API_KEY` 或 `PI_API_KEY`） |
| `concurrency` | number | 否 | 章节并行限流（缺省 3） |
| `resumeFromStage` | number | 否 | 从阶段 N 恢复（1-8） |
| `cwd` | string | 否 | 用于解析默认 worldGraphDir |
| `embedder` | `TextEmbedder` | 否 | 注入嵌入器（缺省阶段 8 跳过 reembedAll） |

### `ImportPipelineResult`（`_ImportPipelineResult`）

```typescript
interface ImportPipelineResult {
  entityCount: number;
  eventCount: number;
  relationCount: number;
  visibilityCount: number;
  worldGraphDir: string;
  dumpPath: string;  // _v3_dump.json 路径
}
```

## 内部模块结构（`_` 前缀，参考）

| 模块 | 内部导出（节选） | 用途 |
|------|------------------|------|
| `pipeline.ts` | `runImportPipeline`（公共） | 主入口，编排 8 阶段 |
| `epub.ts` | `_readChaptersFromEpub` / `_htmlToPlainText` / `_parallelWithLimit` | EPUB 分章 |
| `stages.ts` | `_scanEntitiesGlobal` / `_generateAllChapterEvents` / `_extractAllRelations` / `_inferAllVisibilities` | 各阶段编排 |
| `resolve.ts` | `_resolveEntities` / `_makeLlmCaller` / `_DEFAULT_SIMILARITY_THRESHOLD` / `_SUSPICIOUS_LOWER_BOUND` | 实体消解（三级策略） |
| `write.ts` | `_buildCausedByChain` / `_writeToGraph` / `_buildChapterIndex` / `_buildAliasIndex` | 写入 world-graph |
| `validate.ts` | `_makeEmbedder` / `_reembedAll` / `_validateGraph` | P0/P1 校验 + 向量补齐 |
| `storytime.ts` | `_formatStoryTime` / `_nextStoryTime` / `_STORY_TIME_REGEX` 等 | storyTime 生成与校验 |
| `schemas.ts` | `_ChapterEventsSchema` / `_entityInventoryTool` 等 | LLM tool-call schema |

## 实体消解三级策略

1. **精确匹配**：别名完全相等（含全角/半角归一化）
2. **字符串相似度**：Jaro-Winkler 相似度 ≥ `DEFAULT_SIMILARITY_THRESHOLD`（0.85）自动合并
3. **LLM 判断**：相似度在 `[SUSPICIOUS_LOWER_BOUND, DEFAULT_SIMILARITY_THRESHOLD)`（即 `[0.6, 0.85)`）区间，由 LLM 判断是否同一实体

## P0 校验项（失败抛错退出）

- 实体引用完整性（change 事件 `new_facts` 的 entityId 在 Entity 表中存在；`entity_hint` 必须命中 canonicalMap）
- 事件因果链无环且完整（`causedBy` 必须指向链内 eventId；首事件 `causedBy = undefined`）
- 章节完整性（每章至少有事件覆盖）
- 每个 canonical 实体 ≥1 个 birth 事件
- birth 事件 `entityType` 必填
- storyTime 格式校验（`^ch\d{3}\.ev\d{3}$`）
- entityId 唯一性（aliasIndex 中 canonical entityId 无重复）

## P1 校验项（警告继续）

- 重复 birth（write.ts 写入时已去重，此处显式降级为 P1，仅通过 `skippedEvents` 统计报告）
- 属性名建议白名单（`knownProps` 平名表；`belief.` / `hypothesis.` 前缀豁免）

## 向量补齐（阶段 8）

- `_makeEmbedder(textEmbedder)` 从 `TextEmbedder` 构造 WorldGraph 兼容的 embedder：**Entity 向量拼接 `summary + properties`**（与运行时 `Embedder.embedEntity` 不同——后者不含 summary），Fact 向量拼接 `property:value`
- 未注入 embedder 时跳过 reembedAll（`embeddingSkipped: true` 警告）
