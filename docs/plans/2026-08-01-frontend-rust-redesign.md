# 前端 Rust 重设计（2026-08-01）

> 状态：**设计已对齐，待审阅**
> 依据用户决策：Web 先行（完成后再打包 Tauri）、框架由我选定、统一 API 协议、Rust 重做 3D
> 代码事实来源：src/visualizer/routes.ts（envelope 定义 L41-L47）、src/app/routes-ext.ts（复用 _ok/_fail）、src/app/routes-chat.ts（同 envelope）、src/app/unified-server.ts（路由分发）、tauri-app/（Tauri 2 骨架现状）

## 1. 背景

现有前端 `visualizer-ui/` 是 Vue3 + Element Plus + three.js 纯 HTML，已可满足浏览查看，但：

- 无聊天 UI（API 已就绪，界面缺）
- 无编排器控制面（/api/schedule/* 未做 HTTP 化，Web 无法推进剧情）
- JS 前端对 AI 迭代不友好：类型弱、运行时错误多、重构风险大

目标：**放弃旧前端，用 Rust 从 0 重写**，Web 形态先行，跑通后再打包 Tauri 桌面应用（tauri-app 骨架已存在，仅需把 frontendDist 指向 Rust 前端产物）。

## 2. 技术选型（含理由）

| 项 | 选择 | 理由 |
|---|---|---|
| 运行形态 | Web 先行（Rust → WASM），Tauri 打包后置 | 用户决策；同一份 WASM 产物可被 Tauri WebView 直接加载 |
| 前端框架 | **Leptos** | 见下 |
| 3D 渲染 | **three-d**（wgpu 生态高层场景图） | 见下 |
| 构建工具 | **trunk**（Rust WASM 一键构建 + 静态服务） | 本地开发起 dev server，产物 dist/ 供 Tauri frontendDist 复用 |
| HTTP/SSE | reqwest（wasm 支持 fetch）/ gloo-net + futures-util 流 | WASM 环境标准方案 |
| 状态 | Leptos 信号（signal） | 编译期响应式，无运行时 diff |

### 2.1 为什么 Leptos

用户把框架决策交给我，我选 **Leptos**，核心理由是「AI 友好」：

1. **编译期信号系统**：响应式依赖在编译期由宏检查，AI 生成的动态逻辑错误在编译期暴露，不像 JS 前端要到运行时才炸
2. **无虚拟 DOM**：信号粒度更新，3D canvas 混入时无 diff 干扰
3. **纯 Rust 模板**（view! 宏）：无 JSX 心智负担，AI 生成一致性好，且与项目「零运行时魔法」的风格一致
4. **WASM 先行 + 后打包顺畅**：trunk 产物即 Tauri frontendDist

备选（不选的理由）：Dioxus（hooks 运行时检查弱于 Leptos 编译期检查）、Yew（生态冷却）、Slint/egui（Web 形态与复杂视觉定制受限）。

### 2.2 为什么 three-d（3D 网络图）

用户要求 Rust 重做 3D。选 **three-d**（`asny/three-d`，基于 wgpu）：

- 场景图 API（Mesh/Line/Points + OrbitCamera），贴合「节点 + 连线」网络图需求
- WebGPU 后端，Chrome/Edge 已稳定支持，本地化渲染性能好
- 相比 bevy（完整 ECS 引擎，编译几分钟，对应用过度）与裸 wgpu（全部自写渲染管线）处于合适粒度

**存疑（实施 S2 验证）**：three-d 版本间 API 变动较大，S2 需按当前版本重查其 Scene/Mesh/OrbitCamera API 与 WebGPU 示例；若维护状态不理想，退路为**裸 wgpu 自写场景**（wgpu 教程语料充足，AI 可驾驭）。

## 3. 统一 API 协议

现状（已查证）：三组路由共用 envelope `{ ok, data, error }`：

```jsonc
// 成功
{ "ok": true,  "data": {...}, "error": null }
// 失败
{ "ok": false, "data": null, "error": { "code": "MISSING_FIELD", "message": "..." } }
```

协议化的三件事：

### 3.1 协议契约文档（新增 docs/api/protocol.md）

集中整理现有约定，作为 Rust 前端与 TS 服务端的共享契约：

- envelope 格式（已统一，无需改服务端）
- **错误码全表**：MISSING_FIELD / INVALID_BODY / PATH_ESCAPE / FILE_NOT_FOUND / NOVEL_JSON_NOT_FOUND / WORLD_DB_NOT_FOUND / TEMPLATE_NOT_FOUND / FILE_EXISTS / MTIME_CONFLICT / UPDATE_RUNNING / NO_ACTIVE_PROJECT / PROJECT_OPEN / MIGRATION_REQUIRED / EMBEDDER_UNAVAILABLE / STORY_TIME_REQUIRED / ENTITY_NOT_FOUND / VALIDATION_ERROR / BUSINESS_ERROR / SEARCH_UNAVAILABLE / DEBUG_UNAVAILABLE / CHAT_BUSY / MODEL_NOT_READY / NOT_FOUND / INTERNAL_ERROR
- SSE 事件格式：chat 的 message_update / debug 的 span 事件（含字段结构）
- storyTime 约定：`ch<NNN>.ev<NNN>` 3 位零填充
- 分页/查询参数约定（storyTime 必填端点、includeClosed 等）

### 3.2 补缺口：/api/schedule/*（服务端小改）

Web 前端要推进剧情，必须有编排器 HTTP 端点。新增 4 个（对齐 MCP 4 工具语义，复用 OrchestratorService）：

| 端点 | 语义 |
|---|---|
| POST /api/schedule/dispatch | 派发事件（plan 返回 planId / yolo 自动落地） |
| POST /api/schedule/commit | 提交 plan |
| POST /api/schedule/discard | 丢弃 plan |
| GET /api/schedule/queue | 队列状态 |

实现位置：新 `src/app/routes-schedule.ts`，unified-server 分发链加一环（参照 routes-chat.ts 模式）。服务端改动小且独立，不触碰数据层。

### 3.3 Rust 端 client

`frontend/` 内建 `api` 模块：serde 类型对齐协议（EntitySnapshot / StateDeclaration / EventRecord / envelope / 错误码），fetch 封装 + SSE 流解析（gloo-net 或手写 fetch reader）。新增功能只要协议对齐，前端加类型即可，无需改服务端（用户诉求）。

## 4. 前端架构

### 4.1 目录（新 cargo workspace，与 tauri-app 并存）

```
narrative-engine/
├── frontend/                     # 新 Rust 前端（cargo workspace）
│   ├── Cargo.toml                # workspace: core + web
│   ├── crates/
│   │   ├── core/                 # 领域类型 + api client + 状态逻辑（无 UI，可单测）
│   │   └── web/                  # Leptos 组件 + 3D 场景 + 路由
│   ├── dist/                     # trunk 产物（Tauri frontendDist 指向此处）
│   └── index.html                # trunk 入口
├── visualizer-ui/                # 旧前端：保留不删（Web 验收后废弃）
└── tauri-app/                    # Tauri 壳：完成后 frontendDist 改指 frontend/dist
```

### 4.2 页面地图（遵循既有 GUI 偏好）

暗色专业主题 + 半透明浮动面板（不过度玻璃拟态）+ 网格背景 + 节点卡片（160×72 色码）：

| 页 | 内容 | 复用 API |
|---|---|---|
| 项目 | 项目列表/创建/激活、打开目录 | /api/projects/* |
| 世界图 | 3D 场景（three-d）+ 节点卡片 + 直角折线连线（UE blueprint 风）+ 实体列表/详情/编辑 | /api/status, graph, entities, relations, visibility, events |
| 事件链 | 事件列表 + 因果回溯 + storyTime 快照选择 | /api/events, events/:id/chain |
| 编排 | 聊天输入 + queue/plan/commit 控制面（新增） | /api/chat/*, /api/schedule/* |
| 调试 | SSE 流实时查看 | /api/debug/* |
| 文件 | 章节 markdown 编辑器 | /api/files/* |
| 设置 | 模型配置（LlmConfigStore slot）、规则集、novel.json | /api/admin/* |

### 4.3 3D 实现要点

- 节点 = 卡片平面（sprite/plane mesh，160×72 纹理，类型色码沿用现有 convention）
- 连线 = 圆柱/线段，关系标签可选
- 布局：力导向（自实现简单 spring，或 three-d 内置）；用户偏好网格背景，场景后加 blueprint 网格
- 相机：OrbitCamera 拖拽/缩放/旋转；选中节点 → 右侧详情面板联动

### 4.4 聊天 SSE 与状态

- POST /api/chat/message 接收即回 → GET /api/chat/events 长连接 SSE，按 message_update 事件增量渲染
- 编排器控制：dispatch 后轮询/推送 queue 状态，plan 模式给 commit/discard 按钮

## 5. 分步实施计划

| 步 | 内容 | 验证 |
|---|---|---|
| S1 | 协议契约文档（docs/api/protocol.md）+ /api/schedule/* 服务端 | npm test 全绿 + 手工 curl 4 端点 |
| S2 | frontend 脚手架：cargo workspace + Leptos + trunk + three-d 跑通「hello 3D 场景」 | trunk serve 浏览器出 3D 场景；**验证 three-d 当前版 API**（存疑点） |
| S3 | api client：serde 类型 + fetch + SSE 解析（core crate，单测对齐协议样例） | cargo test |
| S4 | 页面骨架：路由 + 项目页 + 世界图 3D + 实体详情 | 浏览器走通 项目→世界图→实体 |
| S5 | 完整页面：事件链 / 编排聊天 / 调试 / 文件 / 设置 | 各页面对接真实 API |
| S6 | 视觉打磨：主题、半透明面板、蓝图网格、动效 | 对照既有 GUI 偏好验收 |
| S7 | Web 验收 → Tauri 打包（frontendDist 指向） | tauri build 出桌面包（后置） |

S1-S6 是本次范围；S7 是「打包的事情」，用户确认后再做。

## 6. 存疑与待确认

1. **three-d 当前版本 API**（S2 验证；备选裸 wgpu）
2. **WebGPU 浏览器兼容**：Chrome/Edge 稳定；Firefox 需 flag（本地应用可接受，Web 先行阶段以 Chrome 为主）
3. **SSE 在 WASM 的读取方式**：gloo-net 的 EventSource 或手写 fetch reader，S3 验证
4. 旧 visualizer-ui/ 何时删除：Web 验收后（避免并行维护）

## 7. 不做的事（本期）

- 不重构服务端数据层（数据层零改动，协议已够用）
- 不改 unified-server 现有 envelope（已统一）
- 不做移动端
