# underworld-graph 0.1.2 → 0.3.x 升级计划（引擎适配 + novel 重建）

> 日期：2026-08-08
> 状态：✅ **决策已齐，待开工**
> 目标版本：**0.3.1**（0.3.1 = 0.3.0 API + 协议 GPL→MIT，无接口变化；本文所有「0.3.0 契约」即 0.3.1 契约）
> 提出人：用户（上游世界图包大更新同步升级）
> 前置文档：`docs/plans/2026-08-08-underworld-graph-api-change-preparedness.md`（0.2.0 预案，本文档 supersede 其 D1 升级时机决策）
> 上游设计：`underworld-graph/docs/field-redesign-plan-2026-08-08.md`、包 CHANGELOG 0.2.0/0.3.0

---

## 一、背景与版本事实

引擎一次消化两波破坏性变更（0.2.0 + 0.3.0）：

| 位置 | 现状 | 目标 |
|---|---|---|
| `narrative-engine/package.json:25` | `^0.1.2`（node_modules 实装 0.1.2） | `0.3.1`（精确锁定，决策 ④） |
| `packages/scheduler/package.json:17`、`packages/novel-importer/package.json:17` | `"*"` | `0.3.1` |
| `packages/novel-launcher/package.json:25` | `^0.1.0` | `0.3.1` |
| `package-lock.json:6986-6987` | 有 extraneous 本地 0.1.0 file: 链接残留 | 清理重装 |
| `novel/.pi/world-graph-v3/` | 旧库（events.jsonl 89 行，中英属性混合中间态） | 备份废弃 + importer 重导入（决策 ③） |

0.3.0 已核实的类型契约（`underworld-graph/dist`）：

- `StateDeclaration`：删 `value/valueText`，必填 `description: string`（searchable zh，进全文索引）
- `EventRecord.newFacts[]`：`value` → `description: string`（必填）
- `EntitySnapshot`：新增 `name: string`（缺省 ""）+ `aliases: string[]`（缺省 []）；包侧在 birth/改名（property=名字）时自动同步快照
- `Relation`：新增 `description`（缺省 ""），`label` 收窄为简单类型词；`addRelation` opts 加 `description`
- `birthEntity`：`initialProps`/`extraFacts` 值域收窄为 string，非 string 显式抛错
- 叠加 0.2.0：`updateEntitySummary(entityId, summary, storyTime)` storyTime 必填；`traceCauses` 返回 `EventRecord[] | null`；recordedAt 坐标化；killEntity 级联闭合 Relation；birth newFacts 逐条写 Fact（同 property 多条保留，`-2`/`-3` 后缀）

## 二、决策记录（2026-08-08 用户拍板）

| # | 决策点 | 结论 |
|---|---|---|
| ① | 前端实体属性展示形态 | **声明列表展示**：全量保留 + modality 徽标 + validFrom；概览位（graph Inspector / 搜索卡片 / 事件链内联）用声明卡片精简版（property + description 截断 + modality 徽标，点击进详情），**不做折对象** |
| ② | import-card 的 name 键 | **改写为「名字」**，吃包侧 name 快照自动同步，前端直读 `Entity.name` |
| ③ | novel 旧库处置 | **备份废弃 + importer 重导入**：旧库打包归档到 `.pi/` 外，清空 world-graph-v3 从 0 初始化，用 novel-importer 重导入 `正文/` + `chapters/`，alias-index 随导入重新积累 |
| ④ | 搭车项 | **全选**：契约金丝雀测试（预案 P2）+ 写接口补齐（closeDeclaration / deleteEntity / updateEntityProps，预案 §2.4/P6）+ 依赖版本精确锁定（预案 P1） |

## 三、修改面清单（已查证，file:line）

### A. 编译期破坏点

| 位置 | 改动 |
|---|---|
| `src/visualizer/routes.ts:318` | `updateEntitySummary` 补第三个必填参数 `storyTime` |
| `src/visualizer/routes.ts:271`、`src/chat/world-tools.ts:89`、`src/agents/world-tools.ts:118` | `traceCauses` 处理 `\| null` 返回与悬空 causedBy 抛错 |
| newFacts 构造点 7 处：`src/chat/world-tools.ts:88`、`src/agents/world-tools.ts:392-400`、`src/chat/import-card.ts:180-200`、`src/visualizer/routes.ts:403`、`packages/novel-importer/src/write.ts:205-209,256-262`、`packages/role-pool/src/transforms.ts:50-51`、`frontend-demo/app.js:580` | `value` → `description`；类型 `unknown` → `string`；TypeBox schema 同步（LLM 可见契约） |
| `src/chat/world-tools.ts:79` | `initialProps` schema 值域收窄 string |
| 类型 import 传导：`src/ports/types.ts:24`、`src/embedder.ts:20`、`packages/scheduler/src/types.ts:11`、`packages/novel-importer/src/validate.ts:26`、`src/search.ts:7` 等 | `StateDeclaration`/`EntitySnapshot` 新形状顺类型系统修复 |

### B. 运行时静默破坏点（编译不报错，重点防区）

1. `src/search.ts:44-45` — fulltext 检索的 searchable 字段假设从 `valueText` 变 `description`，核对注释与行为
2. `src/embedder.ts:139,149` — 嵌入文本拼 `String(prop.value)` → 改 `description`（否则会拼出 `undefined` 进向量库）
3. `packages/role-pool/src/prompts.ts:171,175` — `fact.valueText ?? String(fact.value)` 兜底链改读 `description`
4. 自声明 DTO（不随包编译报错）：`packages/scheduler/src/types.ts:45-46`、`packages/role-pool/src/types.ts:34` 的 `FactSnapshot { value; valueText? }` 手写镜像改 `description`
5. `packages/novel-importer/src/validate.ts:9-11,48-67` — 围绕"properties 不含 valueText"的 `String(p.value)` 兜底逻辑整体重写
6. `frontend-demo/api-client.js:66-72` `declarationsToProperties` — 折对象主枢纽，按决策 ① 改为声明列表透传 + 概览位精简卡片；连带 `api-mock.js:46-47`、`entity-detail.js:50/117/344`、`events.js:142/188/305`、`studio.js:1174/1200`
7. name fallback 全网 12+ 处（`graph.js:124/148/227/253/282/363/373`、`entity-detail.js:85`、`events.js:122`、`api-client.js:107`、`api-mock.js:174-177/276`）— `(e.properties && e.properties.name) || e.entityId` 全部改直读 `entity.name`（空时再兜底 entityId）
8. D8 recordedAt 坐标化 — 核对 `events.js` 事件排序/展示语义

### C. 词表与写入语义

- 引擎无词表常量（property 由 LLM 自由发挥），中文词表已在 novel 规则集落地（`planner 规则集.md:25-33`、`角色规则集.md:20-33`；关系中文 12 枚举 `角色规则集.md:35-41`，`located_in` 保留）——引擎侧只改工具 schema **描述文案**引导：`src/chat/world-tools.ts:84`、`src/agents/world-tools.ts:521` 的 label 示例 "friend / located_in / 敌人" 换中文枚举引导
- `src/chat/import-card.ts:27-39` `CARD_FACT_FIELDS`：name 键改「名字」（决策 ②），其余英文键映射同步评估中文化
- `frontend-demo/app.js:580` 快速记事件 birth 分支 `property:'name'` → 「名字」
- 关系 description：`addRelation` opts / `world_relation_add` 工具 / 前端关系表单（`app.js:602-609`）加可选 description 字段

### D. novel 数据层（决策 ③）

| 资产 | 处置 |
|---|---|
| `world.db`（9.2MB）+ `events.jsonl`（89 行） | 备份归档到 `.pi/` 外 → 废弃 |
| `alias-index.json`、`memory.md`（已过期，停 ch011.ev009）、`chapter-index.json`、`_v3_dump.json`、`.pi/scheduler-plans/`、`.pi/sessions/` | 随库重建，重新积累/生成 |
| `正文/`、`chapters/` | 内容不动，经 novel-importer 重导入 |

### E. 测试面

约 10 个测试文件手写 `value` 键构造 newFacts（`tests/tools.test.ts` 最重 birthEntity×13；`unified-server.test.ts`、`e2e.test.ts`、`import-card.test.ts`、`project-registry.test.ts`、`packages/novel-importer/tests/*`、`packages/novel-launcher/tests/discover.test.ts`）；手写 mock wg 对象形状同步（`chat-routes.test.ts:260`、`chat-scheduler-tools.test.ts:72/92`、`static-card-loader.test.ts:15`）。

## 四、分阶段计划（每阶段一分支，遵守分支策略）

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **1 依赖与编译修复** | 4 处 package.json 锁 `0.3.1`（精确版本，决策 ④）；清 lock 残留重装；A 类全部编译点 | `typecheck` 全绿 |
| **2 运行时语义适配** | B 类 1-5（search/embedder/role-pool/scheduler DTO/validate）+ recordedAt 核对 | 后端测试全绿 |
| **3 写入侧词表** | C 类：工具 schema 描述中文化、import-card name→「名字」、app.js 快速表单、relation description 可选字段 | 相关测试更新通过 |
| **4 前端适配 + 测试轮** | B 类 6-8：声明列表展示（决策 ①）、name 直读 Entity.name、relation.description 展示位、mock 数据新形状。**触发前端测试纪律**：browser_use 逐项实操 + 缺陷登记 + 测试轮文档（`docs/audits/frontend-test-runs/2026-08-XX-wg-030.md`） | 测试轮文档落盘，缺陷经用户决策 |
| **5 novel 库重建** | 备份旧库到 `.pi/` 外归档 → 清空 world-graph-v3 → 初始化新库 → importer 重导入 → alias-index 重新积累 | 重导入校验通过（validate 重写后） |
| **6 收尾** | 契约金丝雀测试 `tests/underworld-graph-contract.test.ts`（P2）；写接口补齐 closeDeclaration / deleteEntity / updateEntityProps（依赖包能力，若包缺方法则登记回上游）；预案文档状态更新为已闭环 | CI 全绿 |

### 阶段依赖与注意

- 阶段 5 依赖阶段 2（importer 的 write.ts/validate.ts 适配完成）与阶段 3（词表）。
- **schema_hash 时序约束**：0.3.0 schema_hash 变化，引擎升级后打开旧库必 MIGRATION_ERROR——阶段 1 合并后、阶段 5 完成前，novel 项目不可打开；期间测试用项目目录隔离。
- 写接口补齐（阶段 6）需先核对包 0.3.0 是否已有对应方法；没有则登记回上游包，不阻塞主线。

## 五、风险

| 风险 | 缓解 |
|---|---|
| B 类静默破坏漏网 | 阶段 2 完成后人工 grep `\.value\b` / `valueText` 残留审计；阶段 6 契约金丝雀兜底未来 |
| 前端声明列表改造面大 | 决策 ① 已明确概览位用精简卡片；测试纪律强制测试轮 |
| novel 重建丢创作状态 | 旧库 + events.jsonl 先归档再清空；重导入后抽样比对章节事件数 |
| 包 0.3.0 缺写接口方法 | 阶段 6 先核对再动手，缺则回上游登记不硬写 |
