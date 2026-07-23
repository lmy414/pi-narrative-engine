# 世界图可视化方案设计（V1）

> **状态**: 设计文档，未实现
> **范围**: 仅世界图层（节点/边/事件链/章节切片）的可视化设计
> **技术栈**: LiteGraph.js + 原生 Koa 本地服务
> **日期**: 2026-07-21

---

## 1. 设计目标

为世界图层提供白盒可见、可编辑的可视化界面，覆盖：

1. **观察**：用户能直观看到世界图当前状态（节点+边）、事件链、章节切片
2. **编辑**：用户能直接增删改节点/边，与引擎写入处于同一层级（参考 [world-graph-storage-design.md §6](./legacy/world-graph-storage-design.md) 用户编辑融合机制）
3. **导航**：在长篇中能快速定位到角色/地点/事件
4. **审计**：能看到节点/边的历史变化轨迹（通过事件链 diffusions）

**非目标**（V1 不做）：
- 子代理交互可视化
- 渲染层文本预览
- 多分支对比视图（V2 再做）
- 实时事件流推送（V1 静态加载）

---

## 2. 技术选型与对比

### 2.1 为什么选 LiteGraph.js

| 维度 | LiteGraph.js | React Flow | AntV G6 | Rete.js |
|---|---|---|---|---|
| **UE 蓝图风格** | ★★★★★ 原生支持 | ★★★ 需自定义 | ★★ 关系图导向 | ★★★★ |
| **依赖** | 纯 JS，零依赖 | React 运行时 | 较重 | Angular/Vue/React 可选 |
| **渲染** | Canvas（性能好） | SVG + DOM | Canvas/SVG | SVG |
| **节点编辑能力** | ★★★★★ ComfyUI 验证 | ★★★★ | ★★★ 偏展示 | ★★★★ |
| **TypeScript** | 有 .d.ts | 原生 TS | 原生 TS | 原生 TS |
| **生态/成熟度** | ComfyUI 在用，活跃 | 最大 | 大厂支持 | 中等 |
| **自定义节点渲染** | onDrawForeground/onDrawBackground | 自定义组件 | 自定义 Node | 自定义 Node |
| **直角折线边** | 原生支持 | 需自定义 | 原生支持 | 原生支持 |
| **包体积** | ~150KB | ~80KB + React | ~500KB | ~300KB |

**结论**：LiteGraph.js 最匹配需求——
- 用户明确偏好 UE 蓝图风格
- pi 扩展是纯 TypeScript 栈，不希望引入 React 运行时
- ComfyUI 的实战验证证明它支持复杂节点图
- Canvas 渲染在万节点规模下性能优于 SVG/DOM

### 2.2 LiteGraph.js 核心能力（用于本方案的部分）

参考 [LiteGraph.js README](https://github.com/jagenjo/litegraph.js)：

- **LGraphNode**：节点基类，通过 `LiteGraph.registerNodeType("ns/name", ctor)` 注册自定义节点
- **LGraph**：图容器，承载所有节点和边
- **LGraphCanvas**：canvas 渲染器+交互层，支持缩放/平移/框选
- **LiteGraph.Editor**：编辑器外壳，带工具栏
- **节点钩子**：`onDrawForeground` / `onDrawBackground` / `onExecute` / `onPropertyChanged`
- **边样式**：`LLink`，支持 `subgraph` 链接、自定义颜色/宽度
- **序列化**：`graph.serialize()` / `LGraph.loadJSON()`，原生 JSON 格式

### 2.3 与存储层的耦合点

LiteGraph.js 自带图模型，但我们**不复用它的图模型作为存储**，只用作**渲染层**：

```
WorldGraphStore（存储 + 内存模型，权威源）
        ↑↓ 双向同步
Visualizer Adapter（适配层，转换数据格式）
        ↑↓
LGraph（LiteGraph 实例，仅渲染用）
```

**原因**：
- 存储层 schema 已定型（引擎字段+语义字段+向量字段），不能被 LiteGraph 的图模型污染
- LiteGraph 的序列化格式与我们的 JSON 文件格式不一致
- 用户编辑需要走我们的写入队列（保证串行化、走 diffusions 记录）

---

## 3. 总体架构

### 3.1 部署形态

```
┌─────────────────────────────────────────────────────────┐
│  pi agent (主进程)                                       │
│  ├─ narrative-engine extension                          │
│  │  ├─ WorldGraphStore（存储 + 内存模型）                │
│  │  ├─ Embedder / Search                                │
│  │  └─ VisualizerServer（Koa，按需启动）  ──────────┐    │
│  │       ├─ 静态资源：HTML/JS/CSS（含 LiteGraph.js） │    │
│  │       └─ JSON API：CRUD world-graph 数据          │    │
│  └─ 其他扩展...                                       │    │
│                                                       │    │
└───────────────────────────────────────────────────────┼────┘
                                                        │
                       浏览器（用户） ──────────────────┘
                       http://localhost:7421
                       ├─ 加载 LiteGraph.js
                       ├─ fetch JSON API
                       └─ 渲染世界图
```

### 3.2 触发方式

通过 pi 工具调用启动：

```
pi tool: open_visualizer
  → 启动 Koa server（端口 7421，可配置）
  → 返回 http://localhost:7421 给用户
  → 用户浏览器打开
```

服务在 pi session 退出时自动关闭。也支持 `--standalone` 模式独立运行（脱离 pi，直接读 JSON 文件）。

### 3.3 目录结构

```
narrative-engine/
├── src/
│   ├── visualizer/
│   │   ├── server.ts          # Koa 服务 + JSON API
│   │   ├── adapter.ts         # WorldGraphStore ↔ LGraph 数据转换
│   │   └── index.ts           # open_visualizer 工具入口
│   └── ...
├── visualizer-ui/             # 前端静态资源（不参与 tsc 编译）
│   ├── index.html
│   ├── app.js                 # 前端主逻辑
│   ├── styles.css
│   ├── vendor/
│   │   ├── litegraph.js       # LiteGraph.js 构建产物
│   │   └── litegraph.css
│   └── nodes/                 # 自定义节点渲染脚本
│       ├── character-node.js
│       ├── item-node.js
│       ├── prop-node.js
│       ├── background-node.js
│       └── event-node.js
└── ...
```

---

## 4. 视图设计

### 4.1 三种视图

| 视图 | 用途 | 切换方式 |
|---|---|---|
| **世界图视图**（默认） | 看当前世界状态，节点+边网络 | 顶部 Tab |
| **事件链视图** | 看叙事流程，时间线/因果链 | 顶部 Tab |
| **章节切片视图** | 看单章影响范围 | 顶部章节下拉 |

三种视图**共享同一份内存数据**，仅渲染方式不同。

### 4.2 世界图视图

**布局策略**：力导向（默认）+ 手动固定

- 启动时用力导向算法自动布局（按边关系聚集）
- 用户拖拽后节点位置固定（写入 `attributes._viz_pos`）
- 提供"重新自动布局"按钮

**视觉分层**（参考 UE 蓝图的区域分组）：

```
┌─────────────────────────────────────────────────┐
│  [character 区域]                                │
│   ●林墨 ──owns──> [item]佩剑                    │
│   ●赵无极                                         │
├─────────────────────────────────────────────────┤
│  [scene-prop 区域]                               │
│   ●醉仙楼                                        │
│   ●长安城                                         │
├─────────────────────────────────────────────────┤
│  [background 区域]                               │
│   ●魔法体系                                      │
│   ●江湖势力                                      │
└─────────────────────────────────────────────────┘
```

四层节点用半透明区域框分组，区域可折叠。

### 4.3 事件链视图

**布局**：从左到右线性排列（按 parent 链）

```
[E1] ──> [E2] ──> [E3] ──> [E4] ──> [E5] (HEAD)
                       │
                       └──> [E3'] (alt 分支)
                              └──> [E4']
```

- 每个事件节点显示：`chapter_id` + `content` 摘要 + `timestamp`
- 点击事件节点 → 右侧面板显示完整 `diffusions`（按节点分组）
- 双击事件 → 跳转到"该事件影响的世界图节点"（在世界图视图中高亮）

### 4.4 章节切片视图

**布局**：左右分栏

- 左栏：章节列表（可多选）
- 右栏：选中章节涉及的节点+边子图

**用途**：检查单章叙事是否覆盖预期角色/地点；对比不同章节的图演化。

---

## 5. 节点视觉设计

### 5.1 卡片尺寸（用户偏好 160×72px）

```
┌────────────────────────────────┐
│ ● 林墨                      [⚙] │  ← 标题栏（24px）：状态点 + 名称 + 设置按钮
├────────────────────────────────┤
│ 主角，江湖剑客，背负杀父之仇    │  ← summary 单行截断（28px）
├────────────────────────────────┤
│ 性格:沉默  情绪:愤怒  目标:复仇 │  ← 关键属性（20px）
└────────────────────────────────┘
   160 × 72 px
```

### 5.2 类型颜色编码

| 节点类型 | 主色 | 含义 |
|---|---|---|
| `character` | `#4A90E2`（蓝） | 角色（行动主体） |
| `character-item` | `#F5A623`（橙） | 角色互动物（武器/信件等） |
| `scene-prop` | `#7ED321`（绿） | 场景氛围物（天气/路人等） |
| `background` | `#9013FE`（紫） | 背景（规则/历史/体系） |
| `event`（事件链视图） | `#D0021B`（红） | 事件节点 |

### 5.3 生命周期视觉标记

| lifecycle | 视觉标记 |
|---|---|
| `permanent` | 实线边框 |
| `temporary` | 虚线边框 + 半透明 |
| `event-scoped` | 点状边框 + 更透明 |
| `invalid: true`（已消失） | 灰色 + 删除线 + 50% 透明度 |

### 5.4 状态点（标题栏左侧）

| 状态 | 颜色 | 含义 |
|---|---|---|
| 绿色 | 正常 | 引擎自然生产 |
| 黄色 | 用户编辑过 | `tags` 含 `user_edited` |
| 蓝色 | 用户创建 | `tags` 含 `user_created` |
| 红色 | embedding_stale | 向量待补充 |

### 5.5 自定义节点实现（LiteGraph.js）

通过 `onDrawForeground` 自定义卡片渲染：

```javascript
class CharacterNode extends LGraphNode {
  constructor(nodeData) {
    this.title = nodeData.name;
    this.properties = { uuid: nodeData.uuid, ...nodeData };
    this.size = [160, 72];
    this.color = "#4A90E2";
    // 不使用 input/output slots，边通过 slot 系统绘制
    this.addInput("edges", "edges");
    this.addOutput("edges", "edges");
  }

  onDrawForeground(ctx) {
    // 绘制 summary 单行
    // 绘制关键属性
    // 绘制状态点
  }

  onDoubleClick() {
    // 打开详情面板
  }

  onPropertyChanged(name, value) {
    // 触发写回 API
  }
}
LiteGraph.registerNodeType("world/character", CharacterNode);
```

---

## 6. 边视觉设计

### 6.1 直角折线（用户偏好）

LiteGraph.js 原生支持 `link_dir` 配置，可设为直角折线模式：

```javascript
graphCanvas.links_render_mode = LGraphCanvas.STRAIGHT_LINK; // 或 SHARP_LINK
```

### 6.2 边颜色编码

按 `type_category`：

| type_category | 颜色 | 含义 |
|---|---|---|
| `possession` | `#F5A623` | 持有 |
| `social` | `#4A90E2` | 社交 |
| `spatial` | `#7ED321` | 空间 |
| `composition` | `#9013FE` | 组合 |
| `other` | `#9B9B9B` | 其他 |

### 6.3 边标签

鼠标悬停时显示 `fact` 字段（tooltip）。可选开启"始终显示 fact"模式。

### 6.4 失效边

`invalid: true` 的边：灰色虚线 + 50% 透明度（默认隐藏，开关可开启）。

---

## 7. 交互设计

### 7.1 全局交互

| 操作 | 行为 |
|---|---|
| 鼠标滚轮 | 缩放 |
| 中键拖拽 / 空格+左键 | 平移画布 |
| 左键拖拽节点 | 移动节点（位置写入 `attributes._viz_pos`） |
| 右键画布 | 全局菜单（视图切换、布局重置、搜索） |
| 右键节点 | 节点菜单（编辑/删除/转永久/查看历史） |
| 右键边 | 边菜单（编辑/删除/查看 diffusion 记录） |
| 双击节点 | 打开详情面板 |
| `Ctrl+F` | 搜索框（按 name/aliases/summary 模糊匹配） |
| `Ctrl+Z` | 撤销（仅前端缓存，未写回的不算） |
| `Esc` | 关闭面板/取消选择 |

### 7.2 详情面板（右侧抽屉）

```
┌────────────────────────────────┐
│ 林墨 [character]                │
├────────────────────────────────┤
│ [基本]                          │
│   UUID: node_linmo              │
│   生命周期: permanent           │
│   创建事件: event_001           │
│   创建时间: 2026-07-21 10:00    │
│   更新时间: 2026-07-21 11:30    │
├────────────────────────────────┤
│ [语义]                          │
│   名称: 林墨                    │
│   别名: 林少侠, 青衫剑客        │
│   摘要: [可编辑文本框]          │
│   标签: 主角, 剑客              │
├────────────────────────────────┤
│ [属性]                          │
│   personality: 沉默寡言...      │
│   current_mood: 愤怒            │
│   goal: 寻找杀父仇人            │
│   [+ 添加属性]                  │
├────────────────────────────────┤
│ [关系]（相邻边列表）             │
│   → owns → 佩剑                 │
│   → knows → 赵无极              │
├────────────────────────────────┤
│ [历史]（影响此节点的事件列表）   │
│   event_001 (创建)              │
│   event_003 (修改 current_mood) │
│   event_007 (修改 relationships)│
└────────────────────────────────┘
```

### 7.3 CRUD 操作

**新建节点**：
- 右键画布 → "新建节点" → 选择类型 → 弹出表单 → 提交
- 走 `POST /api/nodes` 接口
- 标记为 `user_created`

**编辑节点**：
- 双击节点 → 详情面板 → 修改字段 → 失焦自动保存
- 走 `PATCH /api/nodes/:uuid` 接口
- 标记为 `user_edited`

**删除节点**：
- 右键节点 → "删除" → 确认对话框（显示关联边数）
- 走 `DELETE /api/nodes/:uuid` 接口
- 关联边级联标记 `invalid: true`（不物理删除）

**新建边**：
- 从节点 edge slot 拖拽到另一节点 → 弹出边类型选择 → 提交
- 走 `POST /api/edges` 接口

---

## 8. 数据流

### 8.1 读取流程

```
启动 visualizer
  → adapter.scanWorldGraph()
  → 遍历 nodes/edges/events 目录
  → 构造 LGraph 节点列表
  → 前端 app.js fetch /api/graph
  → 渲染到 LGraphCanvas
```

### 8.2 写入流程（用户编辑）

```
用户在 UI 修改节点
  → app.js 调用 PATCH /api/nodes/:uuid
  → VisualizerServer 接收
  → 转发到 WorldGraphStore.updateNode()
  → 走写入队列（串行化）
  → 写入 JSON 文件
  → 更新内存模型
  → 返回成功
  → 前端刷新该节点视觉
```

**关键约束**：所有写入必须走 `WorldGraphStore`，不直接写 JSON 文件。这保证：
- 写入串行化（无竞态）
- 索引同步更新
- 后续可扩展为 diffusions 记录（V2 可选：用户编辑也生成事件）

### 8.3 与引擎写入的并发

- 引擎写入：通过子代理 → diffusions → WorldGraphStore
- 用户写入：通过 visualizer → WorldGraphStore
- 两者都走同一个 `writeQueue`，天然串行化
- 用户编辑时若该节点正被引擎写入：写入队列保证先后顺序，后写者覆盖

### 8.4 实时刷新（V1 简化）

V1 不做 WebSocket 推送。**用户手动点击"刷新"按钮**重新拉取全图。

V2 可加 WebSocket：引擎写入后推送变更到前端，前端局部刷新。

---

## 9. JSON API 设计

### 9.1 端点列表

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/graph` | 获取全图（nodes + edges + 当前 HEAD 事件） |
| GET | `/api/graph?chapter=N` | 获取章节 N 切片 |
| GET | `/api/events` | 获取事件链 |
| GET | `/api/events/:uuid` | 获取单个事件详情（含 diffusions） |
| GET | `/api/branches` | 获取分支列表 |
| POST | `/api/branches/switch` | 切换分支 |
| POST | `/api/nodes` | 新建节点 |
| GET | `/api/nodes/:uuid` | 获取节点详情 |
| PATCH | `/api/nodes/:uuid` | 修改节点字段 |
| DELETE | `/api/nodes/:uuid` | 删除节点（标记 invalid） |
| POST | `/api/edges` | 新建边 |
| PATCH | `/api/edges/:uuid` | 修改边字段 |
| DELETE | `/api/edges/:uuid` | 删除边（标记 invalid） |
| GET | `/api/search?q=...` | 搜索（Fuse.js + 向量） |
| POST | `/api/rollback` | 回退到指定事件 |

### 9.2 响应格式

统一 envelope：

```json
{
  "ok": true,
  "data": { ... },
  "error": null
}
```

或：

```json
{
  "ok": false,
  "data": null,
  "error": { "code": "NODE_NOT_FOUND", "message": "..." }
}
```

---

## 10. 样式设计

### 10.1 整体风格：UE 蓝图风

- 深色背景（`#1a1a1a`）
- 网格点阵（`#2a2a2a`，每 16px 一个点，每 128px 一条粗线）
- 节点：深色半透明背景（`rgba(30, 30, 30, 0.85)`）+ 类型色边框
- 边：类型色 + 直角折线
- 文字：浅灰（`#e0e0e0`），等宽字体（中文用思源黑体，英文用 JetBrains Mono）

### 10.2 半透明浮动面板（用户偏好）

- 详情面板：右侧抽屉，宽 360px，背景 `rgba(20, 20, 20, 0.92)` + `backdrop-filter: blur(8px)`
- 搜索框：顶部居中，宽 400px，同上
- 工具栏：顶部左侧，紧凑图标按钮

### 10.3 动效

- 节点拖拽：跟随鼠标，无延迟
- 边连接：拖拽时显示虚线预览
- 节点 hover：边框高亮 + 轻微放大（1.02x）
- 详情面板开合：200ms ease-out

**避免**：复杂的渐变、过多的玻璃拟态（per user_profile 偏好"subtle semi-transparent floating effects over excessive glassmorphism"）。

---

## 11. 与存储层 schema 的映射

### 11.1 节点字段映射

| WorldGraph Node 字段 | LiteGraph Node 对应 |
|---|---|
| `uuid` | `properties.uuid` |
| `type` | 注册的节点类型（`world/character` 等） |
| `lifecycle` | `properties.lifecycle` + 边框样式 |
| `name` | `this.title` |
| `summary` | `onDrawForeground` 绘制 |
| `attributes` | `properties.attributes` |
| `aliases` | `properties.aliases` |
| `tags` | `properties.tags` + 状态点颜色 |
| `created_by_event` | `properties.created_by_event` |
| `summary_embedding` | 不传到前端（太大），仅后端用 |
| `attributes._viz_pos` | 节点位置（`this.pos`） |

### 11.2 边字段映射

| WorldGraph Edge 字段 | LiteGraph Link 对应 |
|---|---|
| `source_uuid` / `target_uuid` | `link.origin_id` / `link.target_id` |
| `type` | `link.data.type` |
| `type_category` | link 颜色 |
| `fact` | tooltip 数据 |
| `invalid` | link 隐藏/灰显 |
| `attributes` | `link.data.attributes` |

### 11.3 事件节点（事件链视图）

事件节点用独立的 `world/event` 类型：

```javascript
class EventNode extends LGraphNode {
  constructor(eventData) {
    this.title = `E${eventData.uuid.slice(-4)} [ch${eventData.chapter_id}]`;
    this.size = [200, 80];
    this.color = "#D0021B";
    this.properties = eventData;
  }

  onDrawForeground(ctx) {
    // 绘制 content 摘要（2 行）
    // 绘制 timestamp
    // 绘制 diffusions 数量徽章
  }
}
```

事件节点之间通过 `parent` 字段构造边，形成事件链。

---

## 12. 与难题 9 的映射

参考 [v2-design-notes.md §6.2 难题 9](./legacy/v2-design-notes.md)：

| 子问题 | V1 方案 |
|---|---|
| 可视化前端技术选型 | LiteGraph.js（纯 JS，canvas，UE 蓝图风） |
| 节点呈现 | 卡片式 160×72px，类型颜色编码，状态点标记 |
| 边呈现 | 直角折线，类型颜色编码，hover 显示 fact |
| 视图 | 世界图视图 / 事件链视图 / 章节切片视图（Tab 切换） |
| 交互 | 拖拽/缩放/右键菜单/详情面板/搜索 |
| 风格 | UE 蓝图风 + 半透明浮动面板（避免过度玻璃拟态） |

---

## 13. 实现路径（V1 → V2）

### V1（本次实现范围）

- [ ] 仅设计文档（当前文件）
- 不实现代码

### V2（后续）

1. **服务端**：Koa server + JSON API + adapter
2. **前端基础**：HTML + LiteGraph.js 集成 + 世界图视图
3. **节点 CRUD**：四类节点 + 详情面板
4. **边 CRUD**：拖拽连接 + 类型选择
5. **搜索**：Fuse.js 集成
6. **事件链视图**：事件节点 + parent 链渲染

### V3（更远）

- 章节切片视图
- 多分支对比视图
- 实时刷新（WebSocket）
- 撤销/重做栈
- 节点历史轨迹回放

---

## 14. 风险与备选方案

### 14.1 已知风险

1. **LiteGraph.js 维护活跃度**：最后一次提交 2024-01，但 ComfyUI 生态活跃，fork 较多。备选：ComfyUI 的 fork 版本 `ComfyOrg/litegraph.js`。
2. **大图性能**：万节点规模下 canvas 渲染可能卡顿。V2 实现时需做视口裁剪（仅渲染可见区域节点）。
3. **节点位置持久化**：`attributes._viz_pos` 会污染节点 attributes。备选：单独的 `viz-positions.json` 文件存所有节点位置。

### 14.2 备选方案

如果 LiteGraph.js 实战遇到瓶颈：
- **React Flow**：生态最成熟，但需要引入 React 运行时
- **Drawflow**：更轻量，但功能较弱
- **自研**：基于 Canvas + 自己实现节点/边渲染（最后选项）

---

## 15. 不采用的方案

- ❌ **d3.js 自建**：工作量太大，违背"不从 0 开始"原则
- ❌ **Cytoscape.js**：偏关系图谱分析，节点编辑能力弱
- ❌ **Electron 桌面应用**：太重，pi 扩展应保持轻量
- ❌ **复用 LiteGraph 的图模型做存储**：会污染存储层 schema
- ❌ **直接读 JSON 文件（无后端）**：浏览器 file:// 协议无法 fetch 本地文件，且写入无法实现
