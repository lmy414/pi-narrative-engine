# underworld-graph API 变更应对预案（依赖面盘点 + 准备措施）

> 日期：2026-08-08
> 状态：📋 **已记录（预案阶段，未实施）**——实施前需按「开放决策点」对齐
> 提出人：用户（问题 3/核心组件前瞻）
> 相关：`underworld-graph`（独立仓库，d:\claude\pi-ex\underworld-graph）、`narrative-engine/package.json`、`src/ports/`、`src/visualizer/routes.ts`、`docs/frontend-requirements.md` §11

---

## 一、需求原话与转述

> 用户原话："核心组件，世界图包即将进行大范围改动（字段的设计重构，整体结构不变，会改变外部的API行为，需要进行提前的考虑）。"

**转述**：underworld-graph 包将进行**字段设计重构**（结构/架构不变，但类型字段与 API 行为会破坏性变化）。引擎作为该包的最大消费者，需要**提前准备**：盘点依赖面、评估影响、制定升级与解耦策略，避免被动的破坏性升级。

## 二、现状盘点（2026-08-08，已查证）

### 2.1 版本事实（三处不一致）

| 位置 | 版本 | 说明 |
|---|---|---|
| `narrative-engine/package.json` | `"underworld-graph": "^0.1.2"` | caret 0.x 语义 = 只允许 0.1.x |
| `node_modules/underworld-graph` | **0.1.2** | 引擎实际运行的版本 |
| `underworld-graph` 仓库 | **0.2.0**（2026-08-07 发布） | **已含破坏性变更**（semver 0.x 破例升 minor） |

**结论**：包的破坏性改动第一波（0.2.0）已落地，引擎尚未升级消费；后续"字段设计重构"是第二波、更大范围。引擎当前处于"旧 API 上运行、新 API 已发布"的夹缝状态。

### 2.2 消费面（直接 import underworld-graph）

- **src/ 10 个文件**：`visualizer/routes.ts`（**最大直连消费点**，18 个 wg 方法）、`search.ts`、`embedder.ts`、`app/project-registry.ts`、`chat/world-tools.ts`、`chat/import-card.ts`、`chat/import-tools.ts`、`orchestrator/assembly.ts`、`ports/types.ts`、`ports/adapters.ts`
- **tests/ 7 个**：chat-routes / chat-scheduler-tools / e2e / search / project-registry / tools / unified-server
- **scripts/ 3 个**：build.mjs / orchestrator-mcp.ts / main-session-tools-smoke.ts
- **主要方法使用**（visualizer/routes.ts 统计）：`search`×8、`processEvent`×4、`getEntityAt`×4、`getAllEvents`×3、`getAllEntities`/`getEntityHistory`/`getRelationHistory`×2、`updateEntitySummary`/`traceCauses`/`setVisibility`/`closeVisibility`/`closeRelation`/`addRelation`/`getAllRelationsAt`/`getCharacterView`/`getVisibilityForDeclaration`/`listStoryTimes` 各×1

### 2.3 已有的解耦层（复用存量）

`src/ports/`（types.ts + adapters.ts）已把**子代理工具路径**（WorldGraphPort / SearchPort / RendererPort）与包解耦，零 PI 依赖。**但未覆盖**：visualizer 路由、search.ts、project-registry、chat 工具——这些仍是直连 `wg`/`search` 句柄，包 API 变化会直接穿透。

### 2.4 已知的历史停滞

CHANGELOG 记载：世界图写接口补齐（`closeDeclaration` / `deleteEntity` / `updateEntityProps`）**依赖 underworld-graph 包新增方法，该包未改，暂缓**——引擎侧有功能缺口，恰好与包重构窗口重叠，可一并规划。

## 三、0.2.0 破坏性变更清单（首波，来自包 CHANGELOG 2026-08-07）

| 变更 | 内容 | 引擎影响点 |
|---|---|---|
| **D5 updateEntitySummary 签名** | `(entityId, summary)` → `(entityId, summary, storyTime)`，storyTime 必填；每次调用写 change 事件 | `visualizer/routes.ts` 的 `wg.updateEntitySummary` 调用直接编译失败；UI 摘要编辑语义变化（摘要变更变可回溯） |
| **D7 traceCauses 返回类型** | `EventRecord[]` → `EventRecord[] \| null`；因果链悬空抛 Error | routes.ts 的 traceCauses 调用需处理 null/异常 |
| **D8 recordedAt 坐标化** | processEvent 缺省 recordedAt 从墙钟 ISO 改为 SDK 事务时钟坐标；旧 ISO 行与新坐标行混排 | 前端事件列表 recordedAt 展示、按时间排序的语义变化 |
| **D2/D3 birth newFacts 语义** | 弃用 Object.fromEntries，逐条写 Fact，透传 entityId/modality，同 property 多条保留（-2/-3 后缀） | 事件日志结构与实体快照重建逻辑（ports adapters / 前端 normalize 层）需核对 |
| **D4 killEntity 级联** | 死亡实体级联闭合未闭合 Relation | 实体退场后的关系查询结果变化（前端"显示已闭合"开关数据） |

**0.2.0 Added（非破坏，机会点）**：`storyTimePattern` 校验选项（推荐 `/^ch\d{3}\.ev\d{3}$/`，与问题 2 的 storyTime 约定联动）、`recordedAsOf` 历史查询、幂等写入入口（birthEntityUpsert / setVisibilityIfAbsent）、可选 strict 模式、embedder 选项。

## 四、风险矩阵（字段设计重构第二波的穿透面）

| 风险 | 穿透路径 | 后果 |
|---|---|---|
| zod schema 字段改名/重构 | ports/types.ts 直接 import 包类型 → 子代理工具 DTO → 前端 §11 契约 → normalize 层 | 编译期可挡一层（TS），但前端契约与 DTO 归一化是运行时静默破坏点 |
| 方法签名变化 | visualizer/routes.ts 等 18 个方法直连点 | 编译失败（好）或行为静默变化（坏，如 D8 recordedAt） |
| 返回结构变化 | search.ts / embedder.ts / 事件日志解析 | 静默错位，测试未必覆盖 |
| 引擎升级滞后 | 引擎吃旧 API，包生态先行 | 功能缺口长期停滞（2.4） |

## 五、提前考虑的准备措施（建议，按性价比排序）

| # | 措施 | 说明 | 成本 |
|---|---|---|---|
| P1 | **依赖版本策略** | 0.x 包破坏性变更频繁：建议锁定精确版本（去掉 caret）或建立"升级 = 专项任务"流程；package.json 注释标明升级触发点 | 低 |
| P2 | **API 契约金丝雀测试** | 新增 `tests/underworld-graph-contract.test.ts`：对**已安装版本**断言引擎用到的每个方法签名与返回结构（升级安装版本即红，静默破坏变显式） | 低 |
| P3 | **调用点清单** | 维护"包 API → 引擎调用点"映射表（本节 §2.2 + 三 的合体），包每次发版先逐条映射再动手 | 低 |
| P4 | **升级执行流程固化** | 包 CHANGELOG 逐条映射 → 改 ports 适配与直连点 → typecheck 全绿 → 全量测试 → 前端测试轮（字段展示变化必测） | 中 |
| P5 | **ports 全覆盖收敛（远期）** | 把 visualizer/search/registry 直连收敛进 ports 适配层，消灭包类型穿透（大工程，需单独评估，不与本次升级绑定） | 高 |
| P6 | **顺带消化 2.4 停滞项** | 借升级窗口一并落地 `closeDeclaration` / `deleteEntity` / `updateEntityProps` 写接口补齐（依赖 0.2.0+ 的新方法） | 中 |

## 六、开放决策点（实施前需对齐）

| # | 决策点 | 候选方向 |
|---|---|---|
| D1 | **升级时机** | 立即适配 0.2.0（破坏面小，先消化首波）/ 等包"字段设计重构"第二波完成后一次到位（避免两次适配） |
| D2 | **依赖声明策略** | 锁精确版本 / 保留 caret + 契约金丝雀兜底（推荐：P1+P2 组合） |
| D3 | **ports 收敛范围** | 维持现状 + 契约测试兜底（推荐近期）/ 启动 ports 全覆盖（远期大工程） |
| D4 | **与问题 2 联动** | 0.2.0 新增 `storyTimePattern` 是否随结构 v3 一起接入（推荐 `/^ch\d{3}\.ev\d{3}$/`，与 storyTimeFormat 约定绑定） |
| D5 | **停滞项窗口** | 写接口补齐（closeDeclaration 等）是否搭本次升级便车 |

## 七、备注

- 本记录为"提前考虑"预案：不实施、不改依赖、不改代码。实施由 D1（升级时机）触发。
- 与问题 1（编排 SSE）、问题 2（结构 v3）相互独立；D4 与问题 2 的 storyTime 约定有联动点。
- 记录人：ZCode（2026-08-08，按问题 1/2 相同流程：先记录）。
