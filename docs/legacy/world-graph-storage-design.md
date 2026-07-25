> 📜 **状态：历史参考**（存储设计笔记，bi-temporal/向量方案的概念源头；现行 API 见 docs/api.md §5）。

# 世界图存储与版本管理设计（已完成部分）

> **状态**: 核心机制已确定，细节待补充
> **来源**: v2-design-notes.md 9.5-9.10 节 + 回退机制 Git 模式
> **日期**: 2026-07-21

---

## 1. 整体架构：双图分离

**核心决策**：整体是两张独立的图，事件节点作为单独的节点，不和世界图一起放。

| 图 | 职责 | 内容 |
|---|---|---|
| **世界图** | 记录一切故事需要的背景信息 | 角色、设定、物品、地点、关系、规则等 |
| **事件图** | 记录整个叙事的流程 | 事件节点、事件间的因果关系、什么发生了什么变化 |

### 双图分离的工程意义

1. **职责清晰**：世界图是"状态"，事件图是"历史"
2. **回退独立**：事件图回退不影响世界图的稳定节点
3. **检索分离**：调度器查世界图获取角色信息，渲染器/用户查事件图获取叙事流程
4. **可视化分离**：世界图可视化看到的是关系网络，事件图可视化看到的是时间线/因果链
5. **写入分离**：世界图接受引擎扩散+用户编辑两条路径；事件图只接受引擎事件写入

### 与 Graphiti 的关键差异

- Graphiti 的 Episodic 节点和 Entity 节点在同一个图内，通过 MENTIONS 边连接
- 本架构将 Episodic 完全独立为"事件图"，与世界图物理分离
- 这是比 Graphiti 更彻底的解耦

---

## 2. 世界图：当前状态快照

### 2.1 世界图的角色定义

**世界图职责**：
- 作为唯一状态中心，存储所有世界背景条目
- 接收并处理两条独立写入路径：
  1. **引擎自然生产**：角色扮演产生的数据写回世界图，更新对应节点状态（扩散写入）
  2. **非引擎自然生产**：主会话工具修改 + 图 UI 修改（用户直接编辑）

**核心写入流程（引擎自然生产）**：
- 子代理扮演 → 产生结构化数据 → 写回世界图 → 更新对应节点状态
- 这是"扩散"的工程实现：事件 → 子代理行为 → 状态变化 → 写回节点

### 2.2 节点分层

**四层节点分类**：

| 层级 | 说明 | 示例 |
|---|---|---|
| **角色层** | 剧情中扮演行动主体的节点 | 主角、配角、反派 |
| **角色互动物层** | 和角色直接交互的物品 | 角色持有的武器、钱袋、信件 |
| **非角色互动物层** | 不和角色交互的物品 | 场景氛围元素：天气、人群、装饰 |
| **背景层** | 世界规则和宏观背景 | 魔法体系、社会制度、历史事件 |

### 2.3 节点生命周期

**核心机制**：每个节点有生命周期，临时性的节点会在演出后消失。

**工程意义**：
- 解决长篇节点爆炸问题——不是所有节点都需要永久保留
- 临时节点的例子：
  - 角色互动物层：临时拿起的物品（吃完的苹果、丢掉的纸条）
  - 非角色互动物层：场景氛围（某场雨、某群路人）
  - 可能也包括临时角色（路人甲、酒馆老板）
- 永久节点的例子：
  - 角色层：主要角色
  - 背景层：世界规则
  - 角色互动物层：角色的标志性物品（主角的佩剑）

### 2.4 世界图的存储原则

**世界图只存储当前事件下世界的状态**：
- 世界图 = 当前时刻的状态快照
- 每个事件对应世界图的一个状态
- 事件 = 两个世界图状态之间的变化（diff）
- **世界图永远只存当前状态，不需要保留历史版本**（历史在事件链里）

**每次事件扩散写入**：
- 直接覆盖世界图字段
- 在事件图中记录变化（diffusions）

**存储格式**：
- JSON 文件存储（每节点一文件）
- 不依赖图数据库（Neo4j 等不要）
- 白盒可见，符合"用户可见、可追变动"约束
- 向量查询作为辅助检索手段，但不作为主存储

---

## 3. 事件图：状态变化记录

### 3.1 事件即状态变化记录（核心机制）

**核心澄清**：事件不仅是用户口述的内容时间线记录，也是整个世界图的状态变化记录。

**类比**：
- 事件图 = Git commit history（每个 commit 是一次状态变化）
- 世界图 = Working directory（当前文件状态）
- 回退 = git reset（移动 HEAD，working directory 相应变化）

### 3.2 事件节点的核心字段

```
- uuid：事件唯一标识（commit hash）
- parent：上一个事件的 uuid（对应 commit 的 parent）
- content：用户口述的事件内容
- diffusions：状态变化记录列表（对应 commit 的 diff）
  - target_uuid：受影响的世界图节点
  - field：被修改的字段
  - old_value：修改前的值
  - new_value：修改后的值
- narrative_text：渲染器生成的故事文本（渲染层产物）
- timestamp：事件发生时间（故事时间）
- created_at：事件写入时间（事务时间）
```

### 3.3 事件图的核心原则

- **事件 = 状态变化的 diff，不是完整状态** → 事件节点轻量
- 一个事件内不可能变了几千个节点——单事件影响范围有限
- 事件图只存储每个事件中**状态的变化**（diff），不是完整状态

---

## 4. 版本管理：Git 模式

### 4.1 Git 对象模型映射

直接参考 Git 的对象模型和逻辑，针对双图场景实现最简版本。

| Git 概念 | 引擎对应实现 |
|---|---|
| **Blob**（文件内容） | 世界图节点/边的当前状态 |
| **Tree**（目录结构） | 世界图的整体状态快照 |
| **Commit**（提交） | 事件节点（含 diffusions + 指向上一事件的 parent） |
| **Ref**（分支/HEAD） | 当前事件指针（指向事件链的 HEAD） |
| **HEAD~N** | 回退 N 个事件 |
| **`git reset`** | 移动 HEAD 指针 + 反向撤销 diffusions |
| **`git revert`** | 保留 HEAD，生成新的反向事件 |
| **`git reflog`** | 事件链历史（所有 HEAD 移动记录） |

### 4.2 核心组件

1. **事件节点 = Git Commit**
   - `uuid`（commit hash）
   - `parent`（上一个事件的 uuid）
   - `content`（用户口述）
   - `diffusions`（状态变化）
   - `narrative_text`（渲染文本）
   - `timestamp` / `created_at`

2. **世界图 = Working Directory**
   - 只存当前状态
   - 每次事件扩散写入 = 直接覆盖字段
   - 不保留历史版本（历史在事件链里）

3. **HEAD 指针**
   - 一个字段，指向当前事件链的最新事件
   - 回退 = 移动 HEAD + 反向撤销 diffusions
   - 重放 = 从 HEAD 开始追加新事件

4. **节点创建事件 = `created_by_event` 字段**
   - 世界图节点带 `created_by_event: event_uuid`
   - 反向撤销时，查此字段判断是否到达创建位置

5. **旧事件链保留**
   - 和 Git 一样，旧 commit 永久保留
   - 通过 HEAD 移动实现"删除"，不物理删除事件节点

---

## 5. 回退机制

### 5.1 回退与重放的统一逻辑

**回退和重放是连续的两步操作，不是独立的场景**

完整流程：
1. 用户发起回退（重写某事件 / 改某节点）
2. 引擎按事件链**反向撤销** diffusions（`new_value` → `old_value`）
3. 一直撤销到**目标节点创建的位置**（该节点首次出现的事件）
4. 从该位置**重新开始叙事**（重新跑子代理，生成新的事件链）

**关键含义**：
- 回退不是"回到过去就停下"，而是"回到过去 + 重新开始"
- 重放的起点 = 受影响节点的创建事件
- 重放 = 重新跑子代理，生成新的事件和扩散

### 5.2 反向撤销的工程实现

- 每个事件节点的 `diffusions` 字段已经记录 `old_value` 和 `new_value`
- 回退到事件 E = 从当前事件开始，依次将 `new_value` 还原为 `old_value`，直到 E
- 时间复杂度 O(M)，M = 要撤销的事件数（通常很小）

**最简流程**：

```python
def rollback(target_event_uuid):
    current = HEAD
    while current != target_event_uuid:
        event = load_event(current)
        # 反向撤销 diffusions
        for diffusion in reversed(event.diffusions):
            world_graph[diffusion.target_uuid][diffusion.field] = diffusion.old_value
        current = event.parent
    HEAD = target_event_uuid
    # 等待用户输入新事件，或按旧事件重跑
```

### 5.3 Git 操作对照

| Git 操作 | 引擎对应操作 |
|---|---|
| `git reset HEAD~N` | 反向撤销 N 个事件的 diffusions |
| Working directory 变化 | 世界图回到目标事件时的状态 |
| 旧 commit 保留 | 旧事件节点保留（不物理删除） |
| 新 commit 覆盖 | 用户新输入事件后，新事件覆盖旧事件 |
| `git revert` | 用户告诉引擎"按原来的事件重新跑" |

### 5.4 两种重放模式

1. **手动重放**（默认）：
   - 引擎回退到目标事件后，等待用户输入新事件
   - 用户新输入的事件覆盖旧事件链
   - 类似 `git reset` 后重新 commit

2. **自动重放**：
   - 用户告诉引擎"按原来的事件重新跑"
   - 引擎按旧事件链的内容，依次重新执行
   - 类似 `git revert`（保留历史，生成新的反向 commit）

### 5.4.1 自动重放的工程实现（replayEvents）

**接口签名**：
```typescript
async replayEvents(
  fromEventUuid: string | null,  // 起点事件（不含），null 表示从链头开始
  toEventUuid: string,           // 终点事件（含）
  chapterId: number              // 新事件归属章节
): Promise<WorldEvent[]>
```

**关键语义**：
- **生成新 uuid**：每个原事件都生成新的 event_<timestamp>_<random>，不复用原 uuid
- **深拷贝 diffusions**：原事件的 diffusions 完整拷贝，重新应用到世界图
- **保留原事件链**：原事件节点不做任何修改（既不删除也不标记 invalid），仍可通过其它分支访问
- **链式 parent**：新事件按生成顺序串成新链，第一个新事件的 parent = fromEventUuid（或当前分支 HEAD）
- **更新当前分支 HEAD**：最后一个新事件成为当前分支的新 HEAD
- **末尾清理 event-scoped**：replayEvents 结束时，对最后一个新事件触发 event-scoped 节点清理

**与 rollback 的关系**：
- replayEvents 不自动 rollback——调用方需自行决定是否先 rollback
- 典型用法：先 `rollback(targetEventUuid)` 撤销到目标位置，再 `replayEvents(null, oldHead, chapterId)` 重放原链

### 5.5 节点创建事件的识别

- 节点创建时，记录是在哪个事件下创建的（`created_by_event: event_uuid`）
- 不需要复杂标记——一个字段就够了
- 反向撤销到某节点时，查 `created_by_event` 就知道是否到达创建位置
- 节点本身的删除 = 不需要特殊处理，反向撤销到创建位置时，节点的 `old_value = null`（创建前不存在），撤销后自然消失

---

## 6. 用户编辑融合机制

### 6.1 用户编辑的语义

- 用户编辑影响的是**当前世界的状态**（直接修改世界图）
- 用户编辑产生的扩散**需要到下一个事件才生效**
  - 即：用户编辑不立即触发扩散，扩散在下一次引擎事件时由子代理处理
- **用户编辑不被记录为事件，也不产生任何 diffusion**——这是涵盖所有用户工具操作的全局规则：
  - `world_node_create`：直接写入世界图，`created_by_event = "user"`，不追加 diffusion
  - `world_node_update`：直接覆盖字段，不追加 diffusion
  - `world_node_delete`：标记 `invalid: true`，不追加 diffusion
  - `world_edge_create` / `world_edge_update` / `world_edge_delete`：同上，均不追加 diffusion
- 用户编辑的"痕迹"通过下一个引擎事件的 `old_value` 间接保留（详见 6.2-6.4）

### 6.2 用户编辑优先原则

用户编辑影响当前世界状态，但扩散到下一个事件才生效。具体实现按"用户编辑优先"原则：

- **用户编辑直接覆盖世界图字段**（当前状态立即变化）
- **下一个引擎事件 E2 的子代理看到的是用户编辑后的状态**
- **E2 的 diffusions 记录 `old_value=用户编辑后的值, new_value=E2扩散后的值`**
- **回退 E2 时，世界图字段恢复为"用户编辑后的值"（即 old_value）**

### 6.3 关键含义

- 用户编辑不会被引擎扩散"吞噬"——它作为 E2 的 `old_value` 被保留
- 回退 E2 后，用户编辑仍然存在（世界图回到 E2 之前的状态，即用户编辑后的状态）
- 用户编辑是"非事件写入"，不在事件图中记录，但通过 E2 的 old_value 间接保留

### 6.4 完整示例

1. 初始：N.field = "value1"（E1 扩散写入）
2. 用户编辑：N.field = "value2"（直接覆盖，无事件记录）
3. E2 事件：子代理看到 N.field = "value2"，扩散后改为 "value3"
   - E2.diffusions = [{target: N, field: field, old_value: "value2", new_value: "value3"}]
4. 回退 E2：N.field 恢复为 "value2"（用户编辑保留）
5. 再回退 E1：N.field 恢复为 "value1"（用户编辑丢失，因为 E1 的 new_value="value1" 被撤销）

---

## 7. 与难题的映射

| 难题 | 解决方式 | 状态 |
|---|---|---|
| **难题 1**（世界图记录） | 双图分离 + 节点四层分层 + 生命周期机制 | ✅ 核心已定 |
| **难题 4**（数据写回） | 事件 diffusions 记录 + 世界图覆盖写入 | ✅ 已定 |
| **难题 5**（事件重写） | Git 模式（事件链 + HEAD + 反向撤销 + 重放） | ✅ 已定 |
| **难题 10**（用户编辑融合） | 用户编辑优先 + 下个事件 baseline + old_value 保留 | ✅ 已定 |

---

## 8. 不采用的方案

- ❌ **Graphiti 的 Bi-temporal Edge**（4 个时间戳 + 失效逻辑）——太复杂，Git 模式更简单
- ❌ **向量数据库作为主存储**——黑盒，不可追变动，重建耗时
- ❌ **周期性快照**——不需要，事件链本身就是完整历史
- ❌ **图数据库依赖**（Neo4j/FalkorDB）——纯 JSON 文件存储，白盒可见
- ❌ **RAG 黑盒检索**——向量查询可作为辅助检索手段，但不作为主存储

---

## 9. 多层图架构（关键架构决策）

### 9.1 核心概念

**世界是一张大图 → 按章节切成小图（分蛋糕）**

```
世界图（完整大图）
├── 第 1 章子图（切片 1）
├── 第 2 章子图（切片 2）
├── 第 3 章子图（切片 3）
└── ...
```

### 9.2 切片的本质

**切片 = 按章节范围过滤大图的视图**

- 节点是全局的，不属于任何章节
- 事件是章节的，每个事件带有 `chapter_id`
- 切片 = 该章节发生的事件 + 这些事件影响的所有节点状态

```
chapter_001_subgraph = {
  events: world_graph.events.filter(e => e.chapter_id === 1)
  nodes: world_graph.nodes.filter(n => n 被第 1 章的事件影响)
  edges: world_graph.edges.filter(e => e 被第 1 章的事件影响)
}
```

### 9.3 与"事件即状态变化记录"的契合

- 节点状态由事件链决定（diffusions）
- 章节只是事件的分组
- 切片本质是"该章节的事件 + 这些事件影响的所有节点"

### 9.4 数据结构变化

**节点**：全局，不属于任何章节（无 chapter_id 字段）

**事件**：新增 `chapter_id: number` 字段，标记所属章节

**边**：全局，不属于任何章节（无 chapter_id 字段，通过创建事件间接归属）

### 9.5 这种设计的好处

| 优势 | 说明 |
|---|---|
| **存储统一** | 所有数据都在世界大图里，不用维护跨章引用 |
| **切片灵活** | 可以按章切，也可以按其他维度切（按角色、按时间线） |
| **回退清晰** | 回退到某章某事件，只影响该切片及之后 |
| **查询灵活** | 可以查单章切片，也可以查整个大图 |
| **长篇稳定** | 单章切片规模可控，不会随章节数增长而膨胀 |
| **并行写作** | 不同章节可以并行写作（各自切片独立） |
| **章节冻结** | 已完成章节的事件不再修改，保证稳定性 |

### 9.6 跨章节回退

- **章节内回退**：只操作本章切片，O(M) 很小
- **跨章节回退**：通过事件链 parent 指针追溯，按章反向撤销
  - 回退到第 2 章的某事件 → 只影响第 2 章及之后
  - 回退到第 1 章的某事件 → 影响第 1 章及之后所有章节

### 9.7 修正后的目录结构

```
novel/.pi/world-graph/
├── nodes/                          # 全局节点（按 type 分目录）
│   ├── character/
│   ├── character-item/
│   ├── scene-prop/
│   └── background/
├── edges/                          # 全局边
├── events/                         # 事件（带 chapter_id 字段）
│   ├── event_001.json              # 含 chapter_id: 1
│   ├── event_002.json
│   └── ...
├── refs/                           # 分支指针
│   ├── HEAD                        # 当前分支名（纯文本，无 .json 后缀）
│   ├── main.json                   # main 分支对象（含 name/head/created_at）
│   └── alt_ending.json             # alt_ending 分支对象
├── chapters/                       # 章节元数据
│   ├── chapter-001.json            # 章节信息（标题、起止事件、摘要）
│   ├── chapter-002.json
│   └── ...
├── indices/                        # 索引
│   ├── name-index.json
│   ├── alias-index.json
│   ├── type-index.json
│   └── chapter-index.json          # chapter_id → [event_uuid] 映射
├── meta.json
└── narrative.txt
```

### 9.8 章节元数据 schema

**chapters/chapter-001.json**：
```jsonc
{
  "chapter_id": 1,
  "title": "第一章 长安城",
  "status": "frozen",              // active | frozen
  "start_event": "event_001",      // 本章第一个事件
  "end_event": "event_015",        // 本章最后一个事件
  "summary": "林墨初到长安，结识赵无极",
  "created_at": "2026-07-21T10:00:00Z",
  "frozen_at": "2026-07-21T15:00:00Z"
}
```

### 9.9 chapter-index.json

```jsonc
{
  "1": ["event_001", "event_002", ..., "event_015"],
  "2": ["event_016", "event_017", ..., "event_028"],
  "3": ["event_029", ...]
}
```

### 9.10 章节切片查询的实现

```typescript
// 获取第 N 章的切片
function getChapterSubgraph(chapterId: number) {
  // 1. 获取该章节所有事件
  const eventUuids = chapterIndex[chapterId];
  const events = eventUuids.map(uuid => loadEvent(uuid));
  
  // 2. 收集这些事件影响的所有节点
  const nodeUuids = new Set();
  for (const event of events) {
    for (const diff of event.diffusions) {
      nodeUuids.add(diff.target_uuid);
    }
  }
  const nodes = [...nodeUuids].map(uuid => loadNode(uuid));
  
  // 3. 收集相关边（节点的边）
  const edges = loadEdges().filter(e => 
    nodeUuids.has(e.source_uuid) || nodeUuids.has(e.target_uuid)
  );
  
  return { events, nodes, edges };
}
```

---

## 10. 节点 Schema 详细设计

### 10.1 字段分类原则

节点字段分两类：

- **引擎字段**（固定）：给引擎内部索引和调用用，schema 固定，所有节点都有
- **语义字段**（灵活）：给 LLM 理解用，可自由扩展

### 10.2 引擎字段（固定）

| 字段 | 类型 | 说明 |
|---|---|---|
| `uuid` | string | 节点唯一标识 |
| `type` | enum | `character` / `character-item` / `scene-prop` / `background` |
| `lifecycle` | enum | `permanent` / `temporary` / `event-scoped` |
| `created_by_event` | string | 节点创建事件 UUID（回退锚点） |
| `created_at` | timestamp | 节点创建时间 |
| `updated_at` | timestamp | 节点最后更新时间 |
| `aliases` | string[] | 别名列表（实体消歧用） |
| `tags` | string[] | 标签（可选，用于辅助检索） |

**lifecycle 枚举值含义**：

| 值 | 说明 | 消失时机 |
|---|---|---|
| `permanent` | 永久保留 | 不消失 |
| `temporary` | 临时节点 | 章节冻结时（`freezeChapter`）自动标记 invalid |
| `event-scoped` | 单事件内 | 事件应用完成后（`applyEvent` 末尾）自动标记 invalid |

> 详见第 12 节"临时节点消失机制"

### 10.3 语义字段（灵活）

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 节点名称（展示用，必填） |
| `summary` | string | 节点摘要（LLM 第一眼看到的字段，必填） |
| `attributes` | object | 自由扩展的语义属性（支持浅层嵌套，最多 2 层） |

**attributes 嵌套规则**：
- 支持 1-2 层嵌套
- 用 dot notation 表达 diffusions 的 field 路径
- 示例：`attributes.relationships.linmo = {trust: 80, attitude: "敌对"}`
- diffusions field: `"attributes.relationships.linmo.trust"`

**attributes 更新时的深合并规则**（`deepMergeAttributes` 工具函数，对齐代码 `storage.ts`）：

| 场景 | 行为 |
|---|---|
| 顶层 key 是基础类型（string/number/boolean） | patch 直接覆盖 base |
| 顶层 key 是数组 | patch 整体替换 base（不合并数组元素） |
| 顶层 key 是 `null` 或 `undefined` | patch 直接覆盖 |
| 顶层 key 是普通对象（非数组），且 patch 中也是普通对象 | **合并第 2 层字段**（第 2 层内部整体替换，不再递归） |
| 第 2 层及更深 | 整体替换（不再递归合并） |

**示例**：
```jsonc
base = { combat: { hp: 100, mp: 50 }, tags: ["a"] }
patch = { combat: { hp: 80 }, tags: ["b"] }
result = { combat: { hp: 80, mp: 50 }, tags: ["b"] }
// combat 是顶层对象 → 合并第 2 层（hp 被 patch 覆盖，mp 保留）
// tags 是数组 → 整体替换
```

**适用场景**：
- `world_node_update` 工具更新 attributes 时
- `world_edge_update` 工具更新 attributes 时
- 引擎 diffusion 应用 `field = "attributes"` 整体替换时（不走深合并，直接覆盖整个 attributes 对象）

**按节点类型的 attributes 示例**：

```jsonc
// 角色节点
{
  "attributes": {
    "personality": "沉默寡言，重情重义",
    "appearance": "身穿青衫，背负长剑",
    "current_mood": "愤怒",
    "abilities": ["剑法", "轻功"],
    "background": "出身没落世家",
    "goal": "寻找杀父仇人"
  }
}

// 角色互动物
{
  "attributes": {
    "owner": "林墨",
    "material": "寒铁",
    "abilities": ["破甲"],
    "history": "曾斩杀北地三十六骑"
  }
}

// 背景节点
{
  "attributes": {
    "elements": ["火", "水", "风", "土"],
    "rules": ["同元素相斥，异元素相生"]
  }
}
```

### 10.4 节点 schema 完整示例

```jsonc
{
  // 引擎字段
  "uuid": "node_linmo",
  "type": "character",
  "lifecycle": "permanent",
  "created_by_event": "event_001",
  "created_at": "2026-07-21T10:00:00Z",
  "updated_at": "2026-07-21T11:30:00Z",
  "aliases": ["林少侠", "青衫剑客"],
  "tags": ["主角", "剑客"],

  // 语义字段
  "name": "林墨",
  "summary": "主角，江湖剑客，出身没落世家，背负杀父之仇",
  "attributes": {
    "personality": "沉默寡言，重情重义",
    "current_mood": "愤怒",
    "abilities": ["剑法", "轻功"],
    "goal": "寻找杀父仇人"
  }
}
```

---

## 11. 边 Schema 详细设计

### 11.1 字段分类原则

同节点：引擎字段（固定）+ 语义字段（灵活）

### 11.2 引擎字段（固定）

| 字段 | 类型 | 说明 |
|---|---|---|
| `uuid` | string | 边唯一标识 |
| `source_uuid` | string | 起点节点 UUID |
| `target_uuid` | string | 终点节点 UUID |
| `type` | string | 边类型（基础枚举 + LLM 自定义扩展） |
| `type_category` | enum | 边类型大类（用于引擎索引） |
| `lifecycle` | enum | 同节点生命周期 |
| `created_by_event` | string | 边创建事件 UUID |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 最后更新时间 |
| `invalid` | boolean | 是否已失效（临时节点消失时标记，不物理删除） |

### 11.3 语义字段（灵活）

| 字段 | 类型 | 说明 |
|---|---|---|
| `fact` | string | 关系事实描述（LLM 必读字段，必填） |
| `attributes` | object | 自由扩展属性（同节点，支持浅层嵌套） |

### 11.4 边 type 设计（混合模式）

**基础枚举**（引擎预定义，优先使用）：

| type | type_category | 说明 |
|---|---|---|
| `owns` | possession | 持有 |
| `knows` | social | 认识 |
| `located_in` | spatial | 位于 |
| `part_of` | composition | 部分 |
| `related_to` | other | 相关（兜底） |

**自定义扩展**：
- LLM 可自由创建新 type（如 `enemy_of`, `mentor_of`, `created_by`）
- 自定义 type 的 `type_category` 默认为 `other`
- 引擎检索时优先用基础枚举，自定义 type 走语义检索

### 11.5 边 schema 完整示例

```jsonc
{
  // 引擎字段
  "uuid": "edge_xxx",
  "source_uuid": "node_linmo",
  "target_uuid": "node_sword",
  "type": "owns",
  "type_category": "possession",
  "lifecycle": "permanent",
  "created_by_event": "event_001",
  "created_at": "2026-07-21T10:00:00Z",
  "updated_at": "2026-07-21T10:00:00Z",
  "invalid": false,

  // 语义字段
  "fact": "林墨持有父亲留下的祖传佩剑",
  "attributes": {
    "obtain_time": "故事开始前",
    "sentiment": "极高"
  }
}
```

### 11.6 不采用 V2 的 valid_from_seq / valid_until_seq

- V2 用序列号做 Bi-temporal
- 新架构改用 Git 模式：边的变化通过事件 diffusions 记录
- 回退时按 diffusions 反向撤销，不需要边自带时间戳
- **边只存当前状态，历史在事件链里**

### 11.7 边的创建/修改/删除都走 diffusions

| 操作 | diffusion 记录 |
|---|---|
| 创建边 | `old_value=null, new_value={完整边对象}` |
| 修改边属性 | `old_value=旧值, new_value=新值` |
| 删除边 | `old_value={完整边对象}, new_value=null` |

---

## 12. 临时节点消失机制

### 12.1 触发时机

按 lifecycle 决定，**自动触发**（无需用户手动调用清理工具）：

| lifecycle | 触发点 | 工程实现 |
|---|---|---|
| `event-scoped` | 事件应用完成后 | `applyEvent()` 末尾调用 `cleanupEventScopedNodes(event.uuid)`——清理 `created_by_event === 当前事件 uuid` 的 event-scoped 节点 |
| `temporary` | 章节冻结时 | `freezeChapter()` 内部调用 `cleanupTemporaryNodes(chapterId)`——清理 `created_by_event` 属于该章节事件列表的 temporary 节点 |
| `permanent` | 不消失 | 无 |

**关键约束**：
- event-scoped 节点的清理锚点是 `created_by_event` 字段——只清理"由当前事件创建的" event-scoped 节点，避免误清理上一事件遗留的同类节点
- temporary 节点的清理锚点是章节事件列表（`chapterIndex[chapterId]`）——只清理"由本章节事件创建的" temporary 节点
- 清理 = 标记 `invalid: true` + 从索引移除（name/alias/type），不物理删除 JSON 文件
- 级联清理：节点 invalid 后，关联边（`source_uuid` 或 `target_uuid` 命中）也标记 invalid

### 12.2 临时节点消失后的处理

**节点本身**：
- 标记为 `invalid: true`（不物理删除，回退时还能恢复）
- 保留所有字段，包括 attributes

**相关边**：
- 级联标记 `invalid: true`（不物理删除）
- 回退到创建位置时，invalid 标记清除，节点和边恢复

**扩散记录**：
- 保留在事件 diffusions 里
- 临时节点对其他永久节点的影响仍然有效

### 12.3 用户手动转临时→永久

允许用户直接修改 lifecycle 字段：
- `temporary` → `permanent`：节点不再消失
- `event-scoped` → `temporary` 或 `permanent`：延长生命周期
- `permanent` → `temporary`：节点会在下个章节结束时消失

---

## 13. 多分支叙事

### 13.1 Git branch 机制映射

| Git 概念 | 引擎对应实现 |
|---|---|
| **Branch**（分支指针） | 故事线指针（指向某事件 UUID） |
| **`git branch xxx`** | 创建新故事线（从当前 HEAD 创建） |
| **`git checkout xxx`** | 切换故事线（移动 HEAD + 重建世界图） |
| **`git branch -d xxx`** | 删除故事线（只删指针，事件节点保留） |
| **`git merge xxx`** | 不支持（叙事无法合并） |

### 13.1.1 deleteBranch 的工程实现约束

`deleteBranch(name)` 接口的硬规则：

| 约束 | 错误信息 |
|---|---|
| 不能删除默认分支 `main` | `Cannot delete default branch: main` |
| 不能删除当前 HEAD 所在分支 | `Cannot delete current branch: <name>`（需先 switchBranch 切走） |
| 分支必须存在 | `Branch not found: <name>` |

**清理动作**：
- 从内存 `branches` Map 中移除
- 删除磁盘文件 `refs/<name>.json`（ENOENT 静默忽略）
- `flushRefs()` 持久化 HEAD 和剩余分支

**不清理的内容**：
- 事件节点**完全保留**（不 GC，不标记 invalid）——这些事件可能被其它分支引用，或是用户后续想恢复的"备份"
- 世界图节点/边不动——`deleteBranch` 不触发 `reverseDiffusions`，世界图保持当前状态
- 如需清理不可达事件，走第 14 节的 GC 流程（LLM 判断 + 用户确认）

### 13.2 数据结构

```
branches:
  main: event_010       # 主线
  alt_ending: event_007 # 替代结局（从事件 7 分叉）
  experiment: event_005 # 实验分支（从事件 5 分叉）

HEAD: main              # 当前所在分支
```

### 13.3 切换分支的工程实现

```
switch_branch(target_branch):
  # 1. 反向撤销当前 HEAD 到分叉点
  fork_point = find_fork_point(HEAD, target_branch)
  rollback(fork_point)
  
  # 2. 正向重放目标分支到它的 HEAD
  target_head = branches[target_branch]
  replay(fork_point, target_head)
  
  # 3. 更新 HEAD 指针
  HEAD = target_branch
```

### 13.4 关键设计点

1. **分支是轻量的**——只是个指针，不复制事件节点
2. **事件节点共享**——分支前的事件被多个分支共享
3. **新事件只属于当前分支**——在哪个分支创建事件，就属于哪个分支
4. **世界图跟着 HEAD 走**——切换分支时重建世界图
5. **不支持 merge**——叙事不像代码可以合并，分支就是平行宇宙

---

## 14. 旧事件节点 GC 机制

### 14.1 旧事件节点的产生场景

- **回退重写**：旧事件链被新事件链覆盖
- **分支删除**：分支独有的事件成为不可达
- **试验性写作**：放弃的写作内容

### 14.2 不可达事件的定义

不在任何分支链路上的事件：
- 从所有分支 HEAD 反向遍历，未访问到的事件就是不可达

### 14.3 清理策略：LLM 语义判断

**核心原则**：默认永久保留，清理时让 LLM 判断哪些值得清理，最终由用户确认。

**必须保留的**（硬规则）：
- 任何分支的锚点事件（分支起点）
- 用户手动标记为"关键"的事件
- 近期事件（7 天内创建的）

**LLM 评估的**（软规则）：
- 事件的叙事价值（重要转折？伏笔？）
- 事件是否被其他事件引用
- 事件的年龄（越老越可能被清理）

**LLM 判断流程**：
```
输入给 LLM：
- 事件内容（用户口述）
- 事件年龄
- 是否被其他事件引用
- 是否是分支锚点
- 是否被用户标记

LLM 输出：
- keep: true/false
- reason: 保留/清理的理由
```

### 14.4 触发时机

| 触发方式 | 说明 |
|---|---|
| **手动 GC** | 用户主动调用 `gc` 命令 |
| **阈值提示** | 不可达事件超过 N 个（如 50）时提示用户 |
| **章节结束** | 章节渲染完成后可选触发（用户配置） |

### 14.5 清理前预览

不让 LLM 直接删，而是先给用户看清单：

```
引擎：检测到 23 个不可达事件，建议清理 15 个

  清理建议：
  ✓ E3 "林墨和赵无极在醉仙楼打斗"（已被 E3' 覆盖，无引用）
  ✗ E5 "赵无极透露杀父真相"（叙事价值高，建议保留）

是否执行清理？(y/n)
```

### 14.6 可撤销

清理前自动备份事件链状态（类似 `git reflog`），用户可恢复。

---

## 15. 文件目录布局

### 15.1 整体目录结构

```
novel/.pi/world-graph/
├── nodes/                          # 全局节点（按 type 分目录）
│   ├── character/                  # 角色层节点
│   │   ├── node_linmo.json
│   │   └── node_zhao.json
│   ├── character-item/             # 角色互动物层节点
│   │   └── node_sword.json
│   ├── scene-prop/                 # 非角色互动物层节点
│   │   └── node_teahouse.json
│   └── background/                 # 背景层节点
│       └── node_magic_system.json
├── edges/                          # 全局边
│   ├── edge_xxx.json
│   └── edge_yyy.json
├── events/                         # 事件（带 chapter_id 字段）
│   ├── event_001.json              # 含 chapter_id: 1
│   ├── event_002.json
│   └── ...
├── refs/                           # 引用（分支指针）
│   ├── HEAD                        # 当前分支名（纯文本，无 .json 后缀）
│   ├── main.json                   # main 分支对象（含 name/head/created_at）
│   └── alt_ending.json             # alt_ending 分支对象
├── chapters/                       # 章节元数据
│   ├── chapter-001.json            # 章节信息（标题、起止事件、摘要）
│   ├── chapter-002.json
│   └── ...
├── indices/                        # 索引
│   ├── name-index.json             # 名称 → UUID 映射
│   ├── alias-index.json            # 别名 → UUID 映射
│   ├── type-index.json             # type → [UUID] 映射
│   └── chapter-index.json          # chapter_id → [event_uuid] 映射
├── meta.json                       # 元数据
└── narrative.txt                   # 渲染层产物（故事文本）
```

### 15.2 存储格式选择

**全部 JSON 文件，不用 SQLite/JSONL**：

| 数据 | 格式 | 理由 |
|---|---|---|
| 节点 | 每节点一个 JSON 文件 | 白盒可见，便于用户/Git 追变动 |
| 边 | 每边一个 JSON 文件 | 同上 |
| 事件 | 每事件一个 JSON 文件 | 同上，便于回退时定位 |
| 分支指针 | 每分支一个文件（内容是 UUID） | 轻量 |
| 索引 | 每类索引一个 JSON 文件 | 启动时加载到内存 |

**不用 JSONL 的理由**：
- JSONL 适合 append-only 日志，但事件需要随机访问（按 UUID）
- JSON 文件支持 Git diff，JSONL 不支持
- 文件数多但每个文件小，性能不是问题

### 15.3 HEAD 指针存储

- `refs/HEAD` 文件：**纯文本**（无 `.json` 后缀），内容是当前分支名字符串（如 `main\n`）
  - 兼容历史格式：若内容带引号（`"main"`），加载时自动 JSON.parse 还原
- `refs/<branch>.json` 文件：**JSON 对象**，包含完整 Branch 结构
  ```jsonc
  {
    "name": "main",
    "head": "event_1784633712_a3b4c5",  // 当前分支 HEAD 事件 UUID，空字符串表示无事件
    "created_at": "2026-07-21T10:00:00Z"
  }
  ```
- 切换分支 = 改 `refs/HEAD` 的内容 + 重建世界图（反向撤销到 fork point + 正向重放到目标分支 HEAD）

### 15.4 索引文件

**name-index.json**：
```jsonc
{
  "entries": {
    "林墨": { "uuid": "node_linmo", "type": "character" },
    "赵无极": { "uuid": "node_zhao", "type": "character" }
  }
}
```

**alias-index.json**：
```jsonc
{
  "entries": {
    "林少侠": "node_linmo",
    "青衫剑客": "node_linmo"
  }
}
```

**type-index.json**：
```jsonc
{
  "character": ["node_linmo", "node_zhao"],
  "character-item": ["node_sword"],
  "scene-prop": ["node_teahouse"],
  "background": ["node_magic_system"]
}
```

**chapter-index.json**（章节切片索引）：
```jsonc
{
  "1": ["event_001", "event_002", "event_003"],
  "2": ["event_004", "event_005", "event_006"],
  "3": ["event_007", "event_008"]
}
```

### 15.5 meta.json

```jsonc
{
  "version": "1.0",
  "created_at": "2026-07-21T10:00:00Z",
  "current_chapter": 3,
  "total_events": 45,
  "warnings": []
}
```

### 15.6 chapters/chapter-001.json

```jsonc
{
  "chapter_id": 1,
  "title": "第一章 长安城",
  "status": "frozen",              // active | frozen
  "start_event": "event_001",      // 本章第一个事件
  "end_event": "event_015",        // 本章最后一个事件
  "summary": "林墨初到长安，结识赵无极",
  "created_at": "2026-07-21T10:00:00Z",
  "frozen_at": "2026-07-21T15:00:00Z"
}
```

---

## 16. 事件节点 Schema（补充 chapter_id）

基于多层图架构，事件节点新增 `chapter_id` 字段：

```
- uuid：事件唯一标识（commit hash）
- parent：上一个事件的 uuid（对应 commit 的 parent）
- chapter_id：所属章节 ID（用于章节切片）
- content：用户口述的事件内容
- diffusions：状态变化记录列表（对应 commit 的 diff）
  - target_uuid：受影响的世界图节点
  - field：被修改的字段
  - old_value：修改前的值
  - new_value：修改后的值
- narrative_text：渲染器生成的故事文本（渲染层产物）
- timestamp：事件发生时间（故事时间）
- created_at：事件写入时间（事务时间）
```

**章节切片查询的实现**：

```typescript
// 获取第 N 章的切片
function getChapterSubgraph(chapterId: number) {
  // 1. 获取该章节所有事件
  const eventUuids = chapterIndex[chapterId];
  const events = eventUuids.map(uuid => loadEvent(uuid));

  // 2. 收集这些事件影响的所有节点
  const nodeUuids = new Set();
  for (const event of events) {
    for (const diff of event.diffusions) {
      nodeUuids.add(diff.target_uuid);
    }
  }
  const nodes = [...nodeUuids].map(uuid => loadNode(uuid));

  // 3. 收集相关边（节点的边）
  const edges = loadEdges().filter(e =>
    nodeUuids.has(e.source_uuid) || nodeUuids.has(e.target_uuid)
  );

  return { events, nodes, edges };
}
```

---

## 17. UUID 生成策略

### 17.1 节点 UUID

格式：`node_<type>_<short_hash>`

- type：character / character-item / scene-prop / background
- short_hash：基于 name + aliases + content 的 hash，8 位
- 示例：`node_character_a3b4c5d6`

**稳定性保证**：
- 相同 name + aliases 生成相同 hash → 实体消歧
- 不同时间创建的同名节点 UUID 相同 → 避免重复
- 用户改名后 hash 变化 → 视为新节点（可手动合并）

### 17.2 边 UUID

格式：`edge_<source_short>_<target_short>_<type>`

- 示例：`edge_linmo_sword_owns`
- 相同 source-target-type 组合生成相同 UUID → 避免重复边

### 17.3 事件 UUID

格式：`event_<timestamp>_<random>`

- timestamp：创建时间戳
- random：6 位随机字符串
- 示例：`event_1721536000_a3b4c5`
- 事件 UUID 不需要稳定，每次创建都是新的

---

## 18. 与难题的映射（完整版）

| 难题 | 解决方式 | 状态 |
|---|---|---|
| **难题 1**（世界图记录） | 双图分离 + 多层图切片 + 节点四层分层 + 生命周期机制 + 引擎/语义字段分类 | ✅ |
| **难题 4**（数据写回） | 事件 diffusions 记录 + 世界图覆盖写入 + 边的 invalid 标记 | ✅ |
| **难题 5**（事件重写） | Git 模式（事件链 + HEAD + 反向撤销 + 重放 + 多分支 + 章节切片） | ✅ |
| **难题 10**（用户编辑融合） | 用户编辑优先 + 下个事件 baseline + old_value 保留 | ✅ |

---

## 19. 优势总结

1. **简单**：抄 Git 成熟心智模型，不需要复杂的 Bi-temporal 逻辑
2. **白盒**：JSON 文件存储，用户可见、可追变动
3. **轻量**：事件节点只存 diff，不存完整状态
4. **可回退**：反向撤销 + 重放，支持任意事件重写
5. **用户编辑友好**：用户编辑优先，不被引擎扩散吞噬
6. **不依赖外部服务**：纯 JSON 文件，不需要图数据库或向量数据库
7. **支持长篇**：多层图切片 + 事件链 + 生命周期机制，避免节点爆炸
8. **支持多分支**：Git branch 模式，平行宇宙并存
9. **字段分类清晰**：引擎字段固定 + 语义字段灵活，兼顾稳定性和扩展性
10. **GC 智能化**：LLM 语义判断 + 用户确认，不写死规则
11. **章节切片**：大图按章切片，单章规模可控，支持并行写作和章节冻结
