# Narrative Engine for Pi

基于 [Pi](https://github.com/earendil-works/pi-mono) 智能体的对话驱动 AI 辅助叙事创作引擎扩展。

把 Pi 变成一个叙事创作工具：主 LLM 作为元 AI 与用户对话、理解意图、调用 `narrative_step` 工具驱动七步流水线自动产出叙事文本。

## 架构

```
用户："让张三去酒馆"
  ↓
主 LLM（元 AI）理解意图 → 调用 narrative_step({intent:"add", ...})
  ↓
narrative_step.execute 自动编排流水线：

步骤1  BFS 检索 → worldEntries
步骤2  调度器.plan（LLM #1）→ Schedule
步骤3  角色池.interact（每个角色独立 LLM）→ StructuredOutput[]
步骤4  调度器.diffuse（LLM #2）→ Diffusion[]
步骤5  graph.writeBack（语义化扩散）
步骤6  graph.commit（git）
步骤7  渲染器.render（LLM #3）→ 叙事文本
  ↓
返回主 LLM → 呈现给用户
```

### 上下文隔离

调度器、角色池、渲染器都是独立 `Agent` 实例，`messages = []`，与主会话完全隔离。主会话的代码对话、通用问答不会污染这些子代理。主 LLM 只通过 `narrative_step` 的结构化参数与流水线通信。

### 信息差

调度器在 plan 阶段为每个角色分配可见的世界条目（`visible_entry_ids`）。角色池在构造 user message 时按此过滤，确保角色只能看到自己应该知道的信息。

## 文件结构

```
narrative-engine/
├── index.ts              # Extension 入口 + narrative_step 工具 + 流水线编排
├── types.ts              # 全量类型定义
├── world-graph.ts        # 世界图管理（BFS 检索 / 信息差过滤 / git 集成）
├── scheduler.ts          # 调度器（独立 Agent，plan + diffuse）
├── role-pool.ts          # 角色子代理池（跨事件持久化 Agent 实例）
├── renderer.ts           # 渲染器（独立 Agent，输出叙事文本）
├── import-cards.ts       # 一次性脚本：导入酒馆 V2 角色卡
└── prompts/
    ├── scheduler.md      # 调度器系统提示词
    ├── role-base.md      # 角色子代理通用系统提示词
    └── renderer.md       # 渲染器系统提示词
```

## 使用

### 1. 安装扩展

把 `narrative-engine/` 放到 Pi 的扩展目录（通常是 `<project>/.pi/extensions/narrative-engine/`）。

### 2. 导入角色卡

支持 SillyTavern V2 角色卡（JSON 格式）：

```bash
npx tsx .pi/extensions/narrative-engine/import-cards.ts <tavern-characters-dir>
```

或用环境变量：

```bash
$env:TAVERN_CHARACTERS_DIR = "D:/Chat8/SillyTavern/data/default-user/characters"
npx tsx .pi/extensions/narrative-engine/import-cards.ts
```

会读取目录下所有 `.json` 角色卡，转换成 `CharacterNode` 写入 `.pi/world-graph/characters/`，并把 `character_book.entries` 合并成规则写入 `.pi/world-graph/rules.json`。

### 3. 启动 Pi

```powershell
cd D:\path\to\project
$env:PI_CODING_AGENT_DIR = "$PWD\.pi\agent"
.\pi-test.bat
```

### 4. 开始叙事

直接用自然语言对话，主 LLM 会理解意图并调用 `narrative_step`：

```
诺艾尔去武器店，看到一把巨剑
```

或直接调用工具：

```
narrative_step({
  intent: "add",
  time: "清晨",
  place: "法洛斯·武器店",
  what: "诺艾尔在武器店角落发现一把未完工的巨剑",
  characters: ["诺艾尔"],
  purpose: "初次邂逅武器"
})
```

## 工具

### narrative_step

驱动七步流水线。

| 参数 | 类型 | 说明 |
|---|---|---|
| intent | `"add"` | 意图类型（目前仅支持 add，modify/insert/delete/query 待实现） |
| time | string | 事件发生时间（"清晨"、"黄昏"等） |
| place | string | 事件发生地点 |
| what | string | 事件简述 |
| characters | string[] | 涉及角色名 |
| purpose | string | 事件目的/焦点（可选） |

### query_world_graph

查询世界图当前状态。支持按 target 查询角色/地点/事件，或无参数列出概览。

## 五种意图（规划中）

| 意图 | 说明 | 状态 |
|---|---|---|
| add | 追加新事件 | ✅ |
| modify | 修改历史事件（回退该点之后的所有扩散，从修改点重新走完整流程） | ⏳ |
| insert | 在两个事件之间插入新事件 | ⏳ |
| delete | 删除事件（回退相关扩散） | ⏳ |
| query | 查询世界图 | ⏳ |

## 运行时数据

`.pi/world-graph/` 是运行时生成的，**不入仓库**：

```
world-graph/
├── characters/           # 角色 JSON 文件
├── events.json           # 事件列表
├── relations.json        # 角色关系图
├── rules.json            # 世界规则
├── narrative.txt         # 渲染产物（追加模式）
└── .git/                 # 内部 git repo，每次事件 commit
```

`world-graph/` 本身是一个独立 git 仓库，每次事件触发 `git add -A && git commit`，支持回退到任意历史点。

## 依赖

- Pi 智能体（@earendil-works/pi-agent-core, @earendil-works/pi-ai）
- typebox（JSON Schema 类型系统）
- Node.js（运行 import-cards.ts 脚本）

## License

GPL-3.0-or-later. 详见 [LICENSE](./LICENSE)。

基于 Pi 智能体（@earendil-works/pi-agent-core, @earendil-works/pi-ai）开发。Pi 本身有其独立 license，请遵守相应规定。
