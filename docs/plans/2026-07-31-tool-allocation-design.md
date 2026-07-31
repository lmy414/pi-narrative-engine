# 工具分配方案（参考级）

> 日期：2026-07-31
> 状态：参考文档，非最终执行决策
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策）
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）
>
> 定位：本文档是在上述两份锁定决策的基础上，对"31 个现有工具如何按子代理定位重新分配"做的探索性分析，供后续实施时参考。具体落地以实施时源码为准。

## 一、问题陈述

当前 `src/index.ts` 通过 6 个 `registerXxxTools` 函数向 PI 主会话注册 31 个工具，全部对主会话可见。子代理编排器落地后，4 类子代理（planner / 角色 / 可见推理 / 渲染器）需要各自携带工具集进入 `Agent` 类实例的 `initialState.tools`。

本文档探索：**31 个工具能否按子代理定位拆分？拆分后的归属是什么？**

## 二、31 个工具清单（按域）

| 域 | 工具数 | 文件 | 工具清单 |
|---|---|---|---|
| world_* | 18 | `src/tools/world-tools.ts` | `world_status` / `world_entity_create` / `world_entity_kill` / `world_entity_get` / `world_entity_update_summary` / `world_entity_history` / `world_relation_add` / `world_relation_close` / `world_relations` / `world_relation_history` / `world_event_apply` / `world_event_chain` / `world_character_view` / `world_visibility_set` / `world_visibility_close` / `world_visibility_infer` / `world_query` / `world_story_times` |
| render_* | 5 | `src/tools/render-tools.ts` | `render_append` / `render_modify` / `render_preview` / `render_check` / `render_rule_set` |
| role_* | 2 | `src/tools/role-tools.ts` | `role_interact` / `role_rule_set` |
| scheduler_* | 3 | `src/tools/scheduler-tools.ts` | `scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` |
| import_* | 2 | `src/tools/import-tools.ts` | `import_novel` / `import_character_card` |
| visualizer | 1 | `src/tools/visualizer-tools.ts` | `open_visualizer` |

## 三、核心观察

子代理设计文档 §3.2-§3.5 设想的工具清单，与当前 31 个工具**不是均分关系**，而是"主要消费方 + 包装变体"关系。三个关键事实：

1. **同一工具会被多个子代理共用**：`world_entity_get` / `world_relations` / `world_query` / `world_character_view` 是 planner / 角色代理 / 可见推理代理都要用的只读查询。
2. **角色代理需要"受限变体"**：`world_character_view` 在角色代理这里要被编排器包装成"只能查自己 characterId、只返回该角色可见 Fact"的版本，不是原版工具。
3. **批处理工具的退役/降级**：
   - `role_interact`（当前批处理角色池）将被"角色代理 Agent × N"直接替代
   - `render_append/modify/preview` 在编排器内部由渲染器代理直接调底层 `readChapter/writeChapter`，这三个工具退化为"主会话手动渲染入口"

## 四、按消费方分组

| 分组 | 工具数 | 工具清单 | 主要消费方 |
|---|---|---|---|
| **A. 主会话专属**（编排入口/系统操作） | 7 | `scheduler_dispatch` / `scheduler_commit` / `scheduler_discard` / `open_visualizer` / `import_novel` / `import_character_card` / `world_status` | 主会话（不进子代理） |
| **B. 主会话写设定**（用户直接建/改世界图） | 9 | `world_entity_create` / `world_entity_kill` / `world_entity_update_summary` / `world_relation_add` / `world_relation_close` / `world_event_apply` / `world_visibility_set` / `world_visibility_close` / `world_visibility_infer` | 主会话（写设定场景） |
| **C. 只读查询**（多代理共用） | 8 | `world_entity_get` / `world_entity_history` / `world_relations` / `world_relation_history` / `world_event_chain` / `world_character_view` / `world_query` / `world_story_times` | planner / 角色代理（受限变体） / 可见推理 / 主会话 |
| **D. 渲染器工具** | 5 | `render_append` / `render_modify` / `render_preview` / `render_check` / `render_rule_set` | 渲染器代理（前 3 个）+ 主会话（后 2 个校验） |
| **E. 角色池批处理**（待退役） | 2 | `role_interact` / `role_rule_set` | 角色代理 Agent × N 替代 `role_interact`；`role_rule_set` 退化为编排器内部读取 |

## 五、4 类子代理的工具分配

### 5.1 planner 子代理（只读世界图，决定检索策略）

| 工具 | 用途 | 是否包装 |
|---|---|---|
| `world_character_view` | 查角色可见性，决定哪些角色看哪些信息 | 否（planner 看全部真相） |
| `world_entity_get` | 查实体快照 | 否 |
| `world_relations` | 查关系 | 否 |
| `world_query` | 检索实体 | 否 |
| `world_status` | 看时间锚点/统计 | 否 |
| `world_story_times` | 列时间点 | 否 |
| `world_event_chain` | 因果回溯 | 否 |

无需包装变体——planner 看全部真相，不做可见性约束。

### 5.2 角色代理（每个角色一个 Agent 实例，受可见性约束）

| 工具 | 用途 | 是否包装 |
|---|---|---|
| `character_view_limited` | 查自己看见什么 | **是**：`world_character_view(characterId=固定)` |
| `entity_get_limited` | 查实体快照 | **是**：只返回该角色可见的 Fact |
| `relations_limited` | 查关系 | **是**：只返回该角色可见的关系 |
| `query_limited` | 检索实体 | **是**：只返回该角色可见的结果 |

**关键设计**：不是原版工具，而是 `agents/tools.ts` 在构造 Agent 时为每个角色生成"绑定 characterId + 加可见性过滤"的包装版 AgentTool。子代理设计文档 §6 已设想的"受限工具"机制——编排器根据 planner 的可见性分配，为每个角色构造受限的 world-graph 查询工具。

### 5.3 可见推理代理（消费角色产出，写扩散到世界图）

| 工具 | 用途 | 是否包装 |
|---|---|---|
| `world_entity_get` | 看当前状态决定写什么 | 否 |
| `world_relations` | 查关系 | 否 |
| `world_event_chain` | 因果回溯 | 否 |
| `world_event_apply` | **核心**：写 change 事件 | 否 |
| `world_visibility_set` | 设置可见性变化 | 否 |
| `world_visibility_close` | 闭合可见性 | 否 |
| `world_visibility_infer` | 推断可见性 | 否 |
| `world_relation_add` | 角色交互产生新关系时 | 否 |
| `world_relation_close` | 闭合关系 | 否 |

吸收原 `knowledge-mapper-llm.ts` 的 declarationId 映射职责（子代理设计文档 §3.4 已锁定）。

### 5.4 渲染器代理（消费角色产出 + 扩散结果，写章节）

| 工具/API | 用途 | 来源 |
|---|---|---|
| `readChapter` | 读已有章节衔接上下文 | `@pi/renderer` 底层 API |
| `writeChapter` / `renderToFile` | 写正文 | `@pi/renderer` 底层 API |
| `render_rule_set` 内容 | 读规则集 | 编排器内部直接 `loadRuleSet()` |

**注意**：当前 `render_append/modify/preview` 是"主会话工具"，内部已调 `renderToFile/renderText`。渲染器子代理可以直接复用 `@pi/renderer` 暴露的 `renderToFile/renderText/readChapter` API，**不必把 `render_append` 工具本身改造成 AgentTool**，减少一层间接。

## 六、主会话保留的工具

主会话仍需要：

- **A 组全部 7 个**（编排入口 + 系统）
- **B 组全部 9 个**（用户写设定场景，主会话 LLM + skill 自主判断 → 直接调）
- **C 组全部 8 个**（用户问"林冲现在在哪"主会话直接查）
- **D 组后 2 个**（`render_check` / `render_rule_set` 校验和查看）
- **E 组后 1 个**（`role_rule_set` 查看）

**主会话工具数 = 27**。比 31 减少了 4 个（`role_interact` 退役 + `render_append/modify/preview` 三个工具由渲染器子代理直接调底层 API 替代）。

## 七、可行性结论

✅ **可行**，但有几个落地约束需要明确：

1. **"拆分"不是均分**：4 类子代理共消费约 18 个工具（含受限变体），其中 9 个写入类是可见推理独占，4 个只读查询类是 planner + 角色代理（受限）+ 可见推理共用。
2. **角色代理的"受限变体"是新增工作**：需要在 `agents/tools.ts` 写包装函数，把 `world_character_view` 等改造成"绑定 characterId + 加可见性过滤"的 AgentTool。
3. **`role_interact` 退役需谨慎**：在编排器+角色代理 Agent 落地前，主会话仍可能调 `role_interact`，要保留过渡期。
4. **渲染器代理直接调底层 API**：不强行把 `render_append` 包装成 AgentTool，减少一层间接。
5. **主会话工具数仍然偏多（27 个）**：影响 LLM 工具选择准确率。SDK 集成架构文档 §九.6 提到的"Profile 预设"机制是后续优化方向——按场景（写设定 / 推进剧情 / 校验）切换工具子集。

## 八、与既有设计文档的关系

| 维度 | 本文档 | SDK 集成架构文档 | 子代理编排器设计文档 |
|---|---|---|---|
| 关注点 | 31 个工具如何按子代理定位分配 | narrative-engine 如何与 PI SDK 集成 | 编排器内部如何编排子代理 |
| 状态 | 参考级（非最终决策） | 架构决策已锁定 | 设计确认 |
| 工具层面 | 详列每个工具的归属与包装 | 仅提及"31 工具迁移要点"作为后续工作 | 仅列出每类子代理的工具设想（§3.2-§3.5） |
| 角色代理受限工具 | §5.2 明确 4 个受限变体 | 不涉及 | §6 设想机制，未列具体工具 |

本文档填补了 SDK 集成架构文档 §九.1（"31 个工具从 `pi.registerTool` 到 `defineTool` + `customTools` 的迁移要点"）的工具层面细节，并把子代理设计文档 §3.2-§3.5 的工具设想落实到具体工具名。

## 九、后续实施时的待确认点

1. **受限变体的过滤边界**：`world_query` 受限版是"先做 hybrid 检索再按 characterId 可见性过滤"，还是"检索时就限制"？前者实现简单但有信息泄漏风险，后者需要 Search 层改造。需查 `Search` 类是否支持 visibility 过滤参数。
2. **`render_append/modify/preview` 是否保留为主会话工具**：如果保留，主会话可以直接调它们手动渲染（不走编排器），用于"重写某段"等场景；如果不保留，主会话只能通过 `scheduler_dispatch` 走完整编排链路。倾向保留。
3. **Profile 预设的粒度**：主会话 27 个工具按场景切分子集（写设定 / 推进剧情 / 校验 / 导入 / 可视化），各 Profile 暴露的工具数是多少？需在主会话 LLM 选择准确率和功能可达性间权衡。
4. **`world_event_apply` 的双重身份**：主会话写设定时直接调（用户口述"林冲杀王伦"→ 写一个事件）vs 可见推理代理写扩散时调（编排器内部生成 change 事件）。两者调用上下文不同，是否需要为可见推理代理做"不允许 `userInput` 字段"等约束？
