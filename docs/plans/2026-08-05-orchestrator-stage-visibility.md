# 编排页面各阶段产出可视化方案

> 日期：2026-08-05
> 背景：用户在编排页看不到各阶段（调度器/角色/推理/渲染）的中间产出，需要每个阶段的结果都可在页面上查看。

---

## 一、用户需求

在编排页面（studio）可见以下 5 个阶段的产出：

1. **调度器的检索计划**：planner 推导的每项检索内容、分配给哪些角色
2. **每个角色得到的知识**：每个角色在演绎中获得的 `knowledge_gained`
3. **角色演绎的产出和过程**：角色的 action / thought / emotion / relation_update 等完整产出
4. **可见推理的结果**：哪些状态变化写入了世界图（changes）、哪些角色获得了哪些可见性（visibilityChanges）
5. **渲染器渲染的正文预览**：渲染生成的正文文本（Markdown 预览）

---

## 二、现状查证（基于源码）

### 2.1 后端数据：全部已存在

所有产出数据都在 `OrchestratorResult` 中（`src/orchestrator.ts#L104-L123`），无需新增数据采集：

| 阶段 | 字段 | 类型 | 存在时机 |
|---|---|---|---|
| 检索计划 | `retrievalPlan` | `RetrievalPlan` | plan 模式 dispatch 后已有；yolo 模式 dispatch 后已有 |
| 角色知识 | `outputs[].knowledge_gained` | `string[]` | 同上 |
| 角色演绎产出 | `outputs[]`（10 字段：characterId/actor/action/target/emotion/thought/relation_update/knowledge_gained/state_changes） | `RoleAgentOutput[]` | 同上 |
| 角色演绎过程（阶段元信息） | `stages[]`（stage/agent/status/durationMs/provider/model/error） | `PlanStage[]` | 同上 |
| 可见推理结果 | `diffusion`（changes + visibilityChanges + appliedEventIds） | `DiffusionOutput` | yolo 模式 dispatch 后已有；plan 模式 **commit 后**才有 |
| 渲染正文预览 | `render.text` / `commit.writtenText` | `string` | 同上 |
| 落地摘要 | `commit`（appliedEventIds + chapterPath + writtenText + errors） | `CommitSummary` | 同上 |

### 2.2 后端 API 缺口

`GET /api/scheduler/plans/:id` 返回的 `PlanDetail`（`src/orchestrator/service.ts#L105-L121`）目前只暴露了前半链路字段，缺少后半链路的 3 个字段：

```
PlanDetail 目前缺少：
  - diffusion?: DiffusionOutput
  - render?: RenderOutput
  - commit?: CommitSummary
```

yolo 模式的完整结果通过 `queueStatus()` 只能拿到 `resultSummary` 摘要（无正文全文），需要走 `getQueuedEvent(queueId)` 拿到完整 `OrchestratorResult`，但目前没有暴露 HTTP 端点。

### 2.3 前端现状

`frontend-demo/views/studio.js` 变更记录（L24-L25）明确：**2026-08-05 移除了 Plan 卡片、派发表单、scheduler 状态轮询等 UI**。后端 scheduler 端点保留不动。需要重做可视化 UI。

---

## 三、后端改动方案（小）

### 3.1 PlanDetail 补齐 3 字段

**文件**：`src/orchestrator/service.ts`

**PlanDetail 接口**（L105-L121）增加：
```typescript
diffusion?: DiffusionOutput;
render?: RenderOutput;
commit?: CommitSummary;
```

**getPlan() 方法**（L314-L332）在返回 DTO 中透传：
```typescript
diffusion: result.diffusion,
render: result.render,
commit: result.commit,
```

### 3.2 新增 GET /api/scheduler/queue/:id

**文件**：`src/app/routes-scheduler.ts`

用途：yolo 模式或 commit 任务完成后，前端可通过 queueId 拉取完整 `OrchestratorResult`。

实现：复用 `service.getQueuedEvent(queueId)`，未找到返回 404。

---

## 四、前端改动方案（主要工作量）

### 4.1 布局：右侧可折叠抽屉

在 studio 聊天区右侧增加 360px 可折叠抽屉，标题「编排结果」。

结构：5 个阶段的折叠面板（Accordion），按执行顺序从上到下排列。

```
┌─────────────────────────────────────────────────────────────────────┐
│  编排结果  ×                                              │
├───────────────────────────────────────────────────────────┤
│  阶段进度条：planner ✓ → 角色 ✓ → 推理 ○ → 渲染 ○           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ▼ 1. 调度器检索计划                                     │
│    检索项列表（label / type / assignTo 哪些角色）            │
│                                                           │
│  ▼ 2. 角色演绎                                         │
│    每个角色一张卡片：                                       │
│      - 名字 + 头像占位符                                    │
│      - 行动描述（action）                                    │
│      - 内心独白（thought，折叠，默认展开）                     │
│      - 获得知识（knowledge_gained，chip 列表）               │
│      - 关系变更（relation_update，可选）                      │
│      - 情绪（emotion，tag）                                 │
│                                                           │
│  ▼ 3. 可见推理结果                                       │
│    状态变更列表：entity.property = value (modality)          │
│    可见性变更列表：角色 → 声明（source, confidence）          │
│                                                           │
│  ▼ 4. 渲染正文预览                                       │
│    Markdown 渲染的正文预览（复用 files.js flRenderMarkdown）│
│                                                           │
│  ▼ 5. 落地摘要                                          │
│    写入的事件ID列表 + 章节路径 + 写入字数 + 错误信息          │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 4.2 数据流

| 模式 | 触发时机 | 数据来源 |
|---|---|---|
| plan 模式前半链路 | dispatch 返回 planId 后 | `GET /api/scheduler/plans/:id`（阶段 1-2 可见） |
| plan 模式后半链路 | commit 返回 queueId 后 | 同上（轮询直到 status=committed，阶段 3-5 可见） |
| yolo 模式 | dispatch 返回 queueId 后 | `GET /api/scheduler/queue/:id`（轮询直到 done，所有阶段可见） |

轮询间隔：2s。

### 4.3 样式

- 沿用现有 Tailwind + 自定义 CSS 体系（`views.css`）
- 阶段进度条：4 个圆点连接，已完成打 ✓，进行中闪烁，未开始灰色
- 角色卡片：100% 宽，浅灰边框，内部网格布局
- 正文预览：同文件编辑器的代码字体，白色背景，支持滚动

---

## 五、工作量评估

| 模块 | 预估行数 | 优先级 |
|---|---|---|
| 后端 PlanDetail 补齐 3 字段 | ~30 行 | P0 |
| 后端新增 `GET /api/scheduler/queue/:id` 端点 | ~20 行 | P1 |
| 前端编排结果抽屉 UI + 5 阶段面板 | ~300 行 | P0 |
| 前端调度器状态轮询/事件联动 | ~50 行 | P1 |
| 合计 | ~400 行 | |
