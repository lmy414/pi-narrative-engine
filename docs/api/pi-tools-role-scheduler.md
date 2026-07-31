# PI 扩展工具：role_* + scheduler_* 编排工具域（5 个）

> 属于 [API 文档索引](README.md)。覆盖 `src/tools/role-tools.ts`（`role_interact` / `role_rule_set`）与 `src/tools/scheduler-tools.ts`（`scheduler_dispatch` / `scheduler_commit` / `scheduler_discard`）。
> 底层能力分别由 `@pi/role-pool`（见 [role-pool.md](role-pool.md)）与 `@pi/scheduler`（见 [scheduler.md](scheduler.md)）提供。设计依据：`docs/plans/2026-07-24-role-pool-design.md` / `docs/plans/2026-07-25-scheduler-design.md`。

## `role_interact`

角色池串行演绎：按 `cast` 顺序逐个调用角色代理 LLM，后动者可见先动者的公开 action（不含 thought/emotion/state_changes）。调度器据此提取 state_changes 写扩散、投影为 RoleOutput[] 传渲染器。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventInstruction` | string | 是 | 事件指令（自然语言） |
| `storyTime` | string | 是 | 故事时间（如 ch009.ev006） |
| `cast` | `CastMember[]` | 是 | 演员表，按出场顺序排列。每项含 `characterId`（角色实体 ID）、`staticCard`（静态层：酒馆卡 JSON）、`dynamicFacts`（动态层：角色当前可见的状态声明，含 declarationId/entityId/property/value/valueText?/modality/validFrom） |

**返回**：`details` 为 `InteractResult`：
```json
{
  "outputs": [ /* RoleAgentOutput[]（见 role-pool.md） */ ],
  "errors": [ { "characterId": "x", "error": "..." } ]
}
```
单角色失败跳过记 `errors`，不中断整体。

**行为**：
- LLM 调用器从 PI 本体获取（`makeRoleLlmCaller(piCtx)`，2026-07-29 起复用 PI 配置的模型与 API Key）
- 角色规则集从 `<novelCwd>/角色规则集.md` 读取（每次重读不缓存）

## `role_rule_set`

查看当前角色规则集.md 内容。无需参数。

**返回**：
```json
{
  "content": [{ "type": "text", "text": "（角色规则集全文）" }],
  "details": { "ok": true, "length": 25, "exists": true }
}
```
文件不存在或为空时 `exists: false`、`length: 0`，text 为占位提示。

## `scheduler_dispatch`

调度器派发事件：planner LLM 推导检索计划 → 检索世界图 → role-pool 演绎 →（plan 模式返回；yolo 模式自动 commit 写扩散 + 渲染）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `storyTime` | string | 是 | 故事时间。**强制 `ch{NNN}.ev{NNN}` 3 位零填充格式**（如 `ch009.ev006`）；拒绝 `ch-<N>` 等旧格式（2026-07-30 H3 校验，防止 `ch-10 < ch-2` 时序错乱） |
| `instruction` | string | 是 | 事件指令（自然语言，主会话已加工） |
| `characterIds` | string[] | 是 | 参与角色 ID 列表（主会话已识别） |
| `executionHints` | string | 否 | 执行建议（用户特殊要求，如"林冲要显得绝望"） |
| `mode` | `"plan"` \| `"yolo"` | 否 | 缺省 plan（人在回路）；yolo 自动跑完整条链 |
| `chapterPath` | string | 否 | 章节文件路径（缺省时调度器从 storyTime 推断） |
| `intent` | `"add"` \| `"modify"` \| `"insert"` | 否 | 事件意图（缺省 add） |
| `targetEventId` | string | 否 | modify/insert 模式必填：目标事件 ID |
| `userInput` | string | 否 | 用户口述原文（主会话透传，commit 时落入 EventRecord.userInput） |

> **注**（2026-07-30 M4a）：`locationId` 参数已删除（死字段，调度器未消费）。`StructuredEvent` 中亦已移除。

**返回**（plan 模式）：
```json
{
  "mode": "plan",
  "planId": "plan_...",
  "eventId": "evt_...",
  "chapterPath": "/path/第9章.md",
  "outputs": [ /* RoleAgentOutput[] */ ],
  "errors": [],
  "cast": [ { "characterId": "x", "name": "林冲", "summary": "..." } ],
  "retrievalPlan": { "items": [ /* RetrievalItem[] */ ] }
}
```
yolo 模式额外带 `commitResult`（含 `appliedEventIds` / `writtenText` / `ok`）。

**副作用**：
- `currentStoryTime` 只前进不后退（`storyTime > currentStoryTime` 才更新；modify/insert 锚定历史不会回拉）
- yolo 模式完成后更新项目记忆 memory.md

## `scheduler_commit`

提交 plan 结果：写扩散到世界图（按 entityId 分组生成 change 事件）+ 渲染章节文件。commit 后 planId 失效，不可重复提交。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planId` | string | 是 | scheduler_dispatch 返回的 planId |

**返回**：`details` 为 `CommitResult`：
```json
{
  "ok": true,
  "planId": "plan_...",
  "eventId": "evt_...",
  "appliedEventIds": ["evt_..."],
  "chapterPath": "/path/第9章.md",
  "writtenText": "...",
  "error": undefined,
  "failedEntityIds": undefined,
  "failedRelations": undefined
}
```

**副作用**：只要有 `appliedEventIds` 就更新项目记忆 memory.md（2026-07-30 H2：部分成功时也更新，避免下一轮检索"最近事件"滞后）。

## `scheduler_discard`

丢弃 plan：不写世界图、不渲染。主会话检查 `RoleAgentOutput[]` 后觉得不对劲时调用。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planId` | string | 是 | scheduler_dispatch 返回的 planId |

**返回**：
```json
{ "content": [{ "type": "text", "text": "已丢弃 plan plan_..." }], "details": { "ok": true, "planId": "plan_..." } }
```
plan 不存在（已过期/已被 commit/discard）时 `ok: false`。

## 调度器内部流程速览

- **plan 10 步**：①生成 eventId+planId → ②解析章节路径 → ③planner LLM 推导 RetrievalPlan → ④兜底每角色 ≥1 条 character_view → ⑤逐项执行检索（按 assignTo 分配，label 随 Fact 传递）→ 5.5 解析动态层属主名 → ⑥组装 CastMember → ⑦role-pool.interact → ⑧缓存 plan（内存 + `.pi/scheduler-plans/` 磁盘，TTL 1h）→ ⑨yolo 自动 commit / ⑩plan 等确认
- **commit 8 步**：①取 plan → ②extractStateChanges → 2.5 建立 changeAuthors 映射 → ③按 entityId 分组 → ④写扩散（4.1 invalidated / 4.2 processEvent / 4.2.5 增量 embedding / 4.3 自产自知 / 4.4 knowledge_gained 映射写 Visibility）→ ⑤extractRelations 写关系 → ⑥投影 RoleOutput[] → ⑦按 intent 渲染（add/modify/insert）→ ⑧清理 plan 缓存
- **P0-4 部分成功语义**：写扩散或关系有失败项时 `ok: false` 但 `appliedEventIds` 非空，调用方应同时检查 `ok` / `appliedEventIds` / `failedEntityIds` / `failedRelations`

详见 [scheduler.md](scheduler.md) 与 [role-pool.md](role-pool.md)。
