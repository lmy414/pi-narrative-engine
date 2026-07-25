# 引擎使用指南（主会话必读）

本指南定义叙事引擎的流水线机制与工具使用纪律。
你的身份与意图分类规则见主会话 prompt（main-session.md），本文件只管"怎么正确使用引擎"。

## 1. 流水线全景：scheduler_dispatch 内部发生了什么

一次 `scheduler_dispatch` = 一条完整流水线（你不需要、也不允许手工复现它）：

```
planner LLM 推导检索计划
  → 按计划检索世界图（信息差分配：每条结果指定可见角色）
  → 角色池逐角色扮演（每个角色只拿到自己可见的检索结果）
  → 输出结构化行动（action / state_changes / relation_update / knowledge_gained）
  ├─ mode="plan"：到此返回（planId + outputs），等你审阅
  └─ mode="yolo"：自动继续 ↓
scheduler_commit：
  → state_changes 按实体写扩散（每实体一个 change 事件，旧 Fact 闭合）
  → 自产自知可见性（角色自动看得见自己造成的变化）
  → relation_update 写入世界图
  → 渲染器生成正文 → 写入章节文件（带 eventId 锚点）
  → 项目记忆 memory.md 自动更新
```

**关键推论**：
- 检索计划由 planner LLM 推导，你**不需要**在派发前手工调一堆 `world_*` 查询"准备数据"
- 你传的五要素（storyTime/instruction/characterIds/intent/userInput）是流水线的全部输入
- commit 后世界图、章节文件、记忆文件三者已同步，**不需要**事后再调 `world_event_apply` 补写

## 2. 工具选择决策树（每类场景唯一正确入口）

| 场景 | 唯一入口 | 禁止 |
|------|---------|------|
| 剧情推进（发生了新的事） | `scheduler_dispatch`（→ 审阅 → `scheduler_commit`） | ❌ 用 `world_event_apply` 手写扩散模拟剧情 |
| 重写/插入某场戏 | `scheduler_dispatch(intent="modify"/"insert", targetEventId=...)` | ❌ 先 `render_modify` 改文本再手动补世界图 |
| 查询状态（在哪/关系/谁知道什么） | `world_entity_get` / `world_relations` / `world_character_view` / `world_query` | ❌ 为查询触发 `scheduler_dispatch` |
| 直接改设定（用户明说"把描述改了/加个角色"） | `world_entity_update_summary` / `world_entity_create` 等 | ❌ 走调度器（会生成正文，不是用户要的） |
| 纯文本操作（用户明说"直接改这段文字"） | `render_modify` / `render_append` | ❌ 走调度器 |
| 调试角色扮演（开发场景） | `role_interact` | ❌ 日常剧情推进用它（绕过检索与写扩散） |

## 3. 故事时间纪律

- 格式 `ch{NNN}.ev{NNN}`（章节号.事件序号，3 位零填充），推进规则见主会话 prompt §4.1
- **每次 `scheduler_dispatch` 必须显式给出 storyTime**，不允许省略、不允许复用上一场的值
- 当前进度的唯一权威来源：**项目记忆**（systemPrompt 末尾的 memory.md 内容）→ 其次 `world_status`
- modify/insert 锚定历史事件时，storyTime 用**被锚定事件的值**，不顺延
- 章节号与事件号都是**你**根据用户语义决定的（"下一场"=ev+1，"下一章"=ch+1/ev001），引擎不替你猜

## 4. plan 模式纪律（人在回路）

1. `scheduler_dispatch(mode="plan")` → 得到 planId + outputs
2. 用 1-2 句话向用户概括每个角色做了什么（不展开 JSON）
3. **停下来等用户**。禁止自动连调 `scheduler_commit`
4. 用户认可 → `scheduler_commit(planId)`；不认可 → `scheduler_discard(planId)` 后按反馈重派发
5. planId 一次性：commit/discard 后失效，不可复用

## 5. 事务时间坐标（双时态检索，按需使用）

- `world_status` 返回的 `recordedNow` 是当前事务时间坐标（形如 `r1:0000000000000007:2026-07-25T...`）
- `world_entity_get` / `world_character_view` 接受可选 `recordedAsOf`：只含该时点之前写入的内容
- 用途：改写历史剧情后，想确认"改写前角色知道什么"；日常推进**不需要**使用

## 6. 常见错误清单（自检）

- ❌ `characterIds` 传角色名 → 必须先 `world_query` 消解为 entityId
- ❌ 不传 `userInput` → 用户原话必须透传（项目记忆靠它还原"上一场用户说了什么"）
- ❌ 派发前连环调用多个 `world_*` 查询"做功课" → 检索是 planner 的职责，你只需补全五要素
- ❌ commit 后再用 `world_event_apply` 补状态 → 写扩散已在 commit 完成，重复写入会产生脏数据
- ❌ 用 `import_novel` / `import_character_card` 之外的途径批量造数据
- ❌ 用户说"撤回"时自动回滚世界图 → Git revert 思路：文本用 `render_modify`，状态用新事件显式补偿（见主会话 prompt §5）
