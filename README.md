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
├── rule-loader.ts        # RuleLoader：按代理加载工程规则 + 增量演化
├── init-tool.ts          # init_novel 工具：初始化小说工程
├── add-rule-tool.ts      # add_rule 工具：增量添加规则
├── import-cards.ts       # 一次性脚本：导入酒馆 V2 角色卡
├── prompts/
│   ├── scheduler.md      # 调度器系统提示词
│   ├── role-base.md      # 角色子代理通用系统提示词
│   └── renderer.md       # 渲染器系统提示词
└── templates/            # 工程模板（init_novel 拷贝源）
    ├── novel.yaml
    └── 规则/
        ├── 总规则.md
        ├── 内容规则.md
        ├── 文风规则.md
        ├── 检查清单.md
        └── 规则变更日志.jsonl
```

## 小说工程

引擎跑的是"事件流水线"，但一个小说工程不只是事件流——还有作品定位、叙事约束、文风规范、质量门。这些由工程层的 `novel.yaml` + `规则/` 目录定义。

### 工程骨架

```
my-novel/                          # 一个小说工程 = 一个目录
├── novel.yaml                     # 作品元信息（类型/尺度/CP/结局/基底指令）
├── 规则/                           # 规则文件（按消费者分类，可替换）
│   ├── 总规则.md                  # 优先级 + 加载顺序 + 冲突处理（给所有代理）
│   ├── 内容规则.md                # 角色关系 + 剧情红线 + 世界观一致性 + 术语（给调度器+角色）
│   ├── 文风规则.md                # 文风规范 + 参考文风 + 禁止词/敏感词（给渲染器）
│   ├── 检查清单.md                # 渲染后自检项（给渲染器）
│   └── 规则变更日志.jsonl         # 规则增量演化记录
├── 设定/
│   ├── 世界观.md
│   ├── 角色/                      # 软链到 .pi/world-graph/characters/
│   └── 大纲.md
├── 正文/
│   └── 第01章.md
└── .pi/                           # Pi 工作区（不入工程仓库）
    └── world-graph/               # 引擎运行时状态
```

### 规则按代理分注入

规则文件按消费者分类，RuleLoader 在 session 启动时加载并注入对应代理的 system prompt：

| 规则文件 | 消费者 | 注入时机 |
|---|---|---|
| `总规则.md` + `novel.yaml.base_directive` | 所有代理（基底） | 始终 |
| `内容规则.md` | 调度器 + 角色 | plan + role 阶段 |
| `文风规则.md` | 渲染器 | render 阶段 |
| `检查清单.md` | 渲染器 | 渲染后自检 |

**规则可替换**：RuleLoader 按目录扫描 `.md` 文件，不硬编码文件名。换文件内容 = 换规则，下次 `narrative_step` 即生效（setRules 后会重建子代理 agent）。

### 规则增量演化

规则不是一次性定义的——在叙事过程中，用户说"诺艾尔不该说脏话"，主 LLM 调用 `add_rule` 工具自动路由到对应文件并写变更日志：

```
用户："诺艾尔不该说脏话"
  ↓ 主 LLM 调用
add_rule({
  content: "诺艾尔不使用脏话",
  category: "内容规则",
  context: "第5事件后用户强调角色一致性"
})
  ↓ 自动
追加到 规则/内容规则.md
写入 规则/规则变更日志.jsonl
  ↓ 失效缓存 + 重注入
下次 narrative_step 即生效
```

## 使用

### 1. 安装扩展

把 `narrative-engine/` 放到 Pi 的扩展目录（通常是 `<project>/.pi/extensions/narrative-engine/`）。

### 2. 初始化小说工程

启动 Pi 后，让主 LLM 调用 `init_novel`：

```
init_novel({ target_dir: "D:/my-novel", title: "辉石城的黎明", genre: "奇幻+百合" })
```

会创建完整工程骨架（novel.yaml + 规则/ + 设定/ + 正文/），从 templates 拷贝默认规则文件。之后修改 `novel.yaml` 填入作品定位，编辑 `规则/` 下的文件定义叙事约束。

### 3. 导入角色卡

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

### 4. 启动 Pi

```powershell
cd D:\path\to\project
.\pi-test.bat
```

session 启动时 RuleLoader 自动查找 `novel.yaml`（从当前目录向上查 5 层），加载工程规则注入三个子代理。无 `novel.yaml` 时引擎正常运行（规则为空）。

### 5. 开始叙事

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

叙事过程中增量加规则：

```
add_rule({
  content: "诺艾尔不使用脏话",
  category: "内容规则",
  context: "用户强调角色一致性"
})
```

## 工具

### narrative_step

驱动七步流水线。

| 参数 | 类型 | 说明 |
|---|---|---|
| intent | `"add"` | 意图类型：add/modify/insert/delete/query |
| time | string | 事件发生时间（"清晨"、"黄昏"等） |
| place | string | 事件发生地点 |
| what | string | 事件简述 |
| characters | string[] | 涉及角色名 |
| purpose | string | 事件目的/焦点（可选） |
| eventId | string | modify/insert/delete 的目标事件ID（可选，仅这三种意图需要） |

### query_world_graph

查询世界图当前状态。支持按 target 查询角色/地点/事件，或无参数列出概览。

### init_novel

初始化小说工程，创建工程骨架。

| 参数 | 类型 | 说明 |
|---|---|---|
| target_dir | string | 工程目标目录（绝对路径） |
| title | string | 作品标题（写入 novel.yaml，可选） |
| genre | string | 类型（可选） |

### add_rule

增量添加规则，自动路由到对应分类文件。

| 参数 | 类型 | 说明 |
|---|---|---|
| content | string | 规则内容（自然语言） |
| category | `"总规则"` | 规则分类：总规则/内容规则/文风规则/检查清单 |
| context | string | 规则诞生的上下文（何时为何所加） |
| related_event_id | string | 相关事件ID（可选，便于追溯） |

## 五种意图

所有意图均已实现。modify/insert/delete 通过 git rollback 回退世界状态，rollback 的 `git reset --hard` 会把 `narrative.txt` 一并回退到目标点，之后新渲染以 append 模式在回退文本上追加。

| 意图 | 说明 | 状态 |
|---|---|---|
| add | 追加新事件 | ✅ |
| modify | 回退到目标事件之前，用新参数重新执行该事件（后续事件丢失，需手动重放） | ✅ |
| insert | 回退到目标事件之后（保留目标事件），插入新事件 | ✅ |
| delete | 回退到目标事件之前，删除该事件及其后续，不走流水线 | ✅ |
| query | 返回世界图概览（角色 + 事件列表），不走流水线 | ✅ |

### rollback 语义

- `rollback(eventId)`：`git reset --hard <commitSha>^` + 删除目标事件及之后 → 用于 modify/delete
- `rollbackToAfter(eventId)`：`git reset --hard <commitSha>` + 删除目标事件之后（保留目标事件）→ 用于 insert
- rollback 后清空所有子代理（scheduler/rolePool/renderer）累积上下文，下次从回退后的世界图重建

### 限制

modify/insert/delete 后的后续事件不会自动重放（需手动重新添加）。完整自动重放涉及多次 LLM 调用，暂未实现。

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
