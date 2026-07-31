# PI 扩展工具：import_* 导入工具域（2 个）

> 属于 [API 文档索引](README.md)。覆盖 `src/tools/import-tools.ts` 与 `src/tools/import-card.ts`。
> 底层能力由 `@pi/novel-importer`（见 [novel-importer.md](novel-importer.md)）提供。

> [!WARNING]
> **测试实现声明**：`import_novel` 与 `import_character_card` 均为测试实现——
> 功能链路已验证可用，但**不保证数据质量**，后续将重写。导入数据建议仅用于试验。

## `import_novel`

从 EPUB 文件导入小说到世界图（V3）。执行 8 阶段管道，内部并行 spawn 多个 LLM 子代理处理各章节。长时间运行任务（11 章约 10 分钟）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `epubPath` | string | 是 | EPUB 文件绝对路径 |
| `worldGraphDir` | string | 否 | world-graph 存储目录（缺省 `<cwd>/.pi/world-graph-v3/`） |
| `chapters` | number[] | 否 | 限定导入章节（1-based），缺省全部 |
| `model` | string | 否 | LLM 模型名（缺省用 pi 配置或环境变量 `PI_MODEL`） |
| `apiKey` | string | 否 | LLM API key（缺省读 `DEEPSEEK_API_KEY` 或 `PI_API_KEY`） |
| `concurrency` | number | 否 | 章节并行限流（缺省 3，范围 1-10） |
| `resumeFromStage` | number | 否 | 从指定阶段恢复（1-8，缺省从 1 开始） |

**8 阶段管道**：
1. EPUB 分章（`readChaptersFromEpub`）
2. 全书实体预扫描（`scanEntitiesGlobal`）
3. 章节事件流生成（`generateAllChapterEvents`，并行限流）
4. 实体消解编排（`resolveEntities` → canonicalMap + aliasIndex，三级策略：精确匹配 / 字符串相似度 / LLM 判断）
5. 关系抽取（`extractAllRelations`）
6. 可见性推断（`inferAllVisibilities`）
7. 写入 world-graph（`buildCausedByChain` + `writeToGraph`，eventId 生成 + causedBy 拓扑序 + 字段剥离 + state:"known"）
8. 向量补齐 + P0/P1 校验（`validateGraph`，P0 失败抛错退出，P1 警告继续）

**返回**：
```json
{
  "content": [{ "type": "text", "text": "导入完成：\n  实体数: 25\n  事件数: 47\n  关系数: 21\n  可见性数: 162\n  存储目录: /path/to/world-graph-v3\n  dump 文件: /path/to/world-graph-v3/_v3_dump.json" }],
  "details": {
    "entityCount": 25,
    "eventCount": 47,
    "relationCount": 21,
    "visibilityCount": 162,
    "worldGraphDir": "/path/to/world-graph-v3",
    "dumpPath": "/path/to/world-graph-v3/_v3_dump.json"
  }
}
```

**Resume 机制**：
- `resumeFromStage` 允许从指定阶段恢复，跳过已完成的阶段
- 阶段 7（写入）支持磁盘 resume：已写入的 `world.db` / `events.jsonl` 会被复用，不重复写入
- 阶段 1-6 的中间产物保存在 `_v3_dump.json`，resume 时从 dump 恢复

**Embedder 注入**：
- 复用 session 级 `Embedder` 实例（Xenova/bge-small-zh-v1.5, 512 维）
- 阶段 8 调用 `reembedAll` 为所有 Entity/Fact 补齐向量

**2026-07-25 行为修订**：
- 空章节（content 为空/全空白）跳过事件生成（不再产生"本章无内容"占位 Fact）
- change 事件写入时**自动闭合**同 property 未闭合声明（不再依赖 LLM 声明 invalidated）

## `import_character_card`

导入酒馆角色卡（SillyTavern V1/V2/V3，`.json` 或 `.png` 内嵌）到世界图（Pending Gap #5，2026-07-25 实现）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cardPath` | string | 是 | 角色卡文件绝对路径（.json / .png） |
| `entityId` | string | 否 | 指定 entityId（缺省自动生成 `ent_char_xxxxxxxx`） |
| `storyTime` | string | 否 | 诞生时刻（不传用 `currentStoryTime`） |

**导入策略**：
- `card.description` → `Entity.summary`（birth 事件，重组静态卡时映射回 `card.description`）
- 其余 **10 个卡字段** → 同名 Fact：`name / personality / scenario / first_mes / mes_example / creator_notes / tags / system_prompt / post_history_instructions / alternate_greetings`（`CARD_FACT_FIELDS`，空值跳过；name 兜底用 entityId）
- 自产自知：为角色自身写入全部卡字段 Fact 的 Visibility（`source: "experienced"`、`confidence: 1`）
- **不支持**：`character_book`（lorebook）、`extensions` 等酒馆运行时私有字段；**不抽取卡内角色关系**（需手动 `world_relation_add` 补录）

**支持格式**：
- `.json`：V1 平铺（`{ name, description, ... }`）/ V2/V3（`{ spec: "chara_card_v2"|"chara_card_v3", data: {...} }`）
- `.png`：tEXt / 未压缩 iTXt chunk（keyword `chara` / `ccv3`，base64 JSON；iTXt 压缩 chunk 不支持）

**返回**：
```json
{
  "content": [{ "type": "text", "text": "角色卡已导入：诺艾尔（ent_char_f8aba5a5），10 个字段 Facts @ ch009.ev005" }],
  "details": { "entityId": "ent_char_f8aba5a5", "name": "诺艾尔", "factCount": 10, "eventId": "evt_card_import_xxxx" }
}
```

**副作用**：更新 `currentStoryTime = storyTime`
