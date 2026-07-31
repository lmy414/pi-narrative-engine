# 使用说明（USAGE）

> 面向创作者的完整操作手册。部署见 [SETUP.md](SETUP.md)，API 参考见 [api/README.md](api/README.md)。

## 目录

- [1. 基本概念](#1-基本概念)
- [2. 口述创作（日常主流程）](#2-口述创作日常主流程)
- [3. plan 与 yolo：审阅模式](#3-plan-与-yolo审阅模式)
- [4. 修改与插入](#4-修改与插入)
- [5. 导入已有作品](#5-导入已有作品)
- [6. 规则集：控制文风与扮演](#6-规则集控制文风与扮演)
- [7. 可视化](#7-可视化)
- [8. 世界图直接操作](#8-世界图直接操作)
- [9. 多项目管理](#9-多项目管理)
- [10. FAQ](#10-faq)

---

## 1. 基本概念

| 概念 | 说明 |
|------|------|
| **世界图** | 引擎的记忆。实体（角色/地点/物品/概念）+ 状态声明（Fact）+ 关系 + 可见性，全部带故事时间（bi-temporal），旧状态不删只闭合 |
| **storyTime** | 故事时刻，统一格式 `ch{NNN}.ev{NNN}`：`ch`+3 位零填充=章节号，`.ev`+3 位零填充=章内事件序号（如 `ch009.ev006` = 第 9 章第 6 场）。同章推进 ev+1，进新章 ch+1 且 ev 从 001 开始 |
| **项目记忆** | `.pi/world-graph-v3/memory.md`。引擎自动维护（勿手改）：当前 storyTime、在场角色、最近事件（含你的口述原文）。新会话自动注入，跨会话不丢进度 |
| **信息差** | 每个角色只能看到自己可见的声明。角色的"记忆"由可见性记录决定，**自产自知**（自己造成的状态变化自动可见） |
| **事件** | 一场戏 = 一次派发 = 世界图里的一组 change 事件 + 章节文件里的一段锚点正文 |

**你的角色**：你是导演。口述发生了什么，引擎负责：检索背景 → 角色扮演 → 更新世界 → 写正文。

## 2. 口述创作（日常主流程）

在小说工程目录启动 pi 后，直接说：

```
"彩叶在咖啡厅打工时，辉夜走进来点单，认出她是 KASSEN 里的对手"
```

主会话自动完成：意图识别（剧情推进）→ 五要素补全（时间/地点/角色/指令）→ 角色名消解为 entityId → 派发调度器。

**你能说的各种形态**：

| 你说 | 引擎做 |
|------|--------|
| "下一场：……" | 继续推进剧情 |
| "把刚才那段重写一下，辉夜要更冷淡" | 重写上一事件（modify） |
| "在 XX 之后加一段他犹豫的描写" | 在指定事件后插入（insert） |
| "林冲现在在哪？他和陆谦关系如何？" | 世界图查询（不写不改） |
| "把彩叶的描述改一下 / 加一个新角色" | 直接编辑世界图节点 |
| "撤回上一段" | 章节文本重写；世界图状态通过新事件显式回滚（Git revert 思路，不自动 reset） |

## 3. plan 与 yolo：审阅模式

| 模式 | 行为 | 适用 |
|------|------|------|
| **plan**（缺省） | 跑到角色输出即停，给你审阅；你说"可以"才写图+渲染 | 关键剧情、人物弧转折 |
| **yolo** | 一条链自动跑完（检索→扮演→写图→渲染） | 连续推进、批量生产 |

plan 审阅时你会看到：检索计划 + 每个角色的 action / emotion / thought / state_changes / relation_update。不满意就说"不对，重做"（plan 丢弃，不产生任何副作用）。

## 4. 修改与插入

- **modify**（重写某事件）："把 XX 那场戏重写一下，要求 ……"——锚点区间正文被替换；世界图不撤销原状态（补偿事件语义）
- **insert**（某事件后插入）："在 XX 之后加一段 ……"——新正文插入锚点后，世界图照常扩散

章节文件格式（`正文/第<N>章-标题.md`）：

```markdown
<!-- engine v0.01 -->

<!-- event: evt_xxx -->

第一段正文……

<!-- event: evt_yyy -->

第二段正文……
```

锚点之内是引擎的地盘；锚点之间你可以手动改（引擎下次只在新区间写入）。

## 5. 导入已有作品

> [!WARNING]
> 以下两个导入器均为**测试实现**：功能链路已验证，**不保证数据质量**，后续将重写。
> 导入产出的世界图数据建议仅用于试验。

### 5.1 导入小说（import_novel）

```
"导入这本小说：E:/下载/xxx.epub"
```

8 阶段管道（EPUB 分章 → 实体预扫描 → 章节事件流 → 实体消解 → 关系抽取 → 可见性推断 → 写图 → 向量补齐 + 校验），11 章约 10 分钟。导入后直接口述续写（storyTime 自动衔接）。

已知数据质量局限（重写时解决）：实体消解可能合错/漏合；事件粒度不均；空章节历史上产生过占位 Fact（已修源头，旧数据不保证）；角色间关系抽取稀疏。

### 5.2 导入酒馆角色卡（import_character_card）

```
"导入这张卡：D:/path/to/诺艾尔.json"（也支持 .png 内嵌卡）
```

卡字段写入世界图（description → Entity.summary，其余 → 同名 Facts + 自产自知可见性），之后调度器重组静态卡即得完整酒馆卡，角色可直接上场。

已知局限：`character_book`（lorebook）不支持；**不抽取卡内描述的角色关系**（如"两人是旅伴"需手动 `world_relation_add` 补录）。

## 6. 规则集：控制文风与扮演

小说工程根目录三个 .md，**改了立即生效**（每次调用重读）：

| 文件 | 控制谁 | 写什么 |
|------|--------|--------|
| `规则集.md` | 渲染器 | 文风、格式（「」对话）、禁止词、视角限制 |
| `planner 规则集.md` | 检索计划 | 检索策略、信息差原则（宁少勿多） |
| `角色规则集.md` | 角色池 | 扮演原则、输出纪律、反元游戏约束 |

模板由 `npm run init` 生成，都是纯自由文本——像写 AGENTS.md 一样写它们。

## 7. 可视化

```
"打开可视化"
```

打开 `http://localhost:7421/`：按 storyTime 快照浏览实体/关系演变（两级时间轴：章节→事件）、搜索定位、事件链、角色视角、手动编辑（编辑产生 `source:"user"` 事件）。

### 7.1 两种入口

- **PI 内触发**：口述"打开可视化"，PI 调 `open_visualizer` 工具拉起可视化服务（端口 7421）并返回 URL，浏览器访问即可。
- **Tauri 应用**：启动 Tauri 桌面应用，sidecar 自动拉起 unified-server（端口 7421），应用窗口内嵌 WebView 直接加载可视化前端。

### 7.2 页面导航（v0.1.0-alpha.1 应用化后）

| 页面 | 入口 | 功能 |
|------|------|------|
| 工作台 / 事件链 / 调试 | 顶部导航 | 原有三页（快照浏览 / 事件链 / 调试 DAG），Element Plus 旧体系 |
| 项目管理 | "项目"页 | 扫描/新建/激活项目，启动 PI 创作（应用内置模式专属） |
| 编辑器 | "编辑器"页 | 浏览项目文件树，读写章节文件/规则集/novel.json |
| 设置 | "设置"页 | 编辑应用配置（扩展模式/PI 路径/扫描根/向量模型），重装扩展，检查更新 |
| 更新流 | "更新"页 | git pull + 重建 + 重装扩展的 SSE 日志流（应用内置模式专属） |

> **阶段 2b 未实施**：工作台/事件链/调试三页仍用 Element Plus 旧体系，与新增四页的原型设计体系共存，视觉不统一。

### 7.3 调试 tab

**调试 tab**（2026-07-27 新增）：顶部页签切换到"调试"后，前端订阅 SSE 流，按 `traceId` 聚合显示调度链 DAG——`scheduler_dispatch` / `scheduler_commit` 的每个内部阶段（plan / retrieve / role.turn × N / commit.step.4 × N / commit.step.4.4 / commit.step.5 / commit.step.7）都画成一个节点，按 `start→end` 时序连线。节点状态色编码：蓝色脉冲=进行中、绿色=成功、红色=出错。点节点看 payload / 耗时 / 错误详情。

触发方式：开可视化后切到"调试"页签，然后说一句推进剧情（如"下一场：林冲在草料场"）。`scheduler_dispatch` 一跑就能看到 DAG 实时生长。

## 8. 世界图直接操作

绕过调度器的精细操作（告诉主会话即可）：

- "给诺艾尔和露西亚加一条旅伴关系" → `world_relation_add`
- "把彩叶的 summary 改成……" → `world_entity_update_summary`
- "林冲在 ch-3 时看到了什么？" → `world_character_view`
- "列出 ch-2 到 ch-5 的所有事件" → `world_event_chain`

## 9. 多项目管理

### 9.1 项目级 sync 模式（开发者）

一个目录 = 一个小说工程，无全局注册表：

```bash
cd narrative-engine
npm run init -- ../小说B --name 小说B
cd ../小说B && pi   # 独立世界图、独立章节、独立规则集
```

引擎升级：回 narrative-engine 跑 `npm run build && npm run sync -- --target <小说B>/.pi/extensions/narrative-engine`，然后 pi 里 `/reload`。

### 9.2 应用内置模式（Tauri 应用）

Tauri 应用内通过 `ProjectRegistry` 管理多项目：在"项目"页扫描/新建/激活项目，每个项目独立 WorldGraph 句柄。
引擎升级走应用内重装扩展（settings 页 → 重装扩展，或 `POST /api/admin/extension/reinstall`），无需手动 sync。

详细操作见 [app-mode.md](app-mode.md)。

## 10. FAQ

**Q: 工具报 "WorldGraph not initialized"？**
A: 九成是 better-sqlite3 绑定缺失：`cd .pi/extensions/narrative-engine && npm rebuild better-sqlite3`，然后 `/reload`。跑 `npm run doctor -- --novel <目录>` 能确诊（doctor 会连 sharp / onnxruntime-node 一起查）。

**Q: pi 启动就报 sharp 模块错误 / 扩展整个加载失败？**
A: sharp 原生绑定缺失（transformers.js 静态 import 链）。`cd .pi/extensions/narrative-engine && npm rebuild sharp` 后重启。详见 SETUP.md §3.2。

**Q: 新会话/切换会话后，引擎还记得上次写到哪吗？**
A: 记得。`.pi/world-graph-v3/memory.md`（项目记忆）在每次事件写入后自动更新：当前 storyTime、在场角色、最近事件（含你的口述原文）。新会话启动时自动注入主会话上下文，storyTime 锚点也会从事件日志恢复。

**Q: 改写了历史剧情后，想查“改写前角色知道什么”？**
A: 用双时态检索：先 `world_status` 记下改写前的 `recordedNow` 坐标，再 `world_character_view` / `world_entity_get` 传 `recordedAsOf=<坐标>`——结果只含该时点之前写入的内容，后续改写不可见。

**Q: scheduler_dispatch 报 "fetch failed"？**
A: 向量模型没缓存且 huggingface.co 不可达。`export HF_ENDPOINT=https://hf-mirror.com` 后重启；首次成功下载后离线可用。`hf-mirror.com` 也不可达时改用作者自维护的备用镜像：`export HF_ENDPOINT=https://emaostudio.online/hf-mirror`。

**Q: 角色"失忆"了？**
A: 2026-07-25 前的版本有自盲 bug（已修）。如果还有，检查角色规则集是否过大挤掉了动态层。

**Q: 渲染文风不对？**
A: 改 `规则集.md`——渲染器对它绝对服从。也可用 `render_check` 校验已有章节是否违规。

**Q: 如何回退某段剧情？**
A: 章节文本用 modify 重写；世界图状态通过新事件显式改回（"把彩叶的 mood 改回平静"）。引擎刻意不做自动 reset（保护时序完整性）。

**Q: 调试 tab 显示空 / 报 "DEBUG_UNAVAILABLE"？**
A: 两种可能：① 你跑的是 standalone 模式（`node scripts/visualizer.mjs`），该模式不创建 `debugBus`，调试 tab 不可用——只能在 pi 会话内的 `open_visualizer` 用；② 设了环境变量 `PI_DEBUG=off`，会话级调试总线被禁用——`unset PI_DEBUG` 后重启 pi。

**Q: 调试 tab 的 DAG 看不到 commit.step.4.4？**
A: 正常。4.4 步（knowledge_gained → 可见性）只在 `SchedulerCtx.knowledgeMapper` 注入时才执行；未注入 mapper 时跳过，对应节点不会出现在 DAG 中。注入由 pi 启动配置决定，详见 api/scheduler.md / api/debug-bus.md。

**Q: 想关掉调试模块省内存？**
A: `export PI_DEBUG=off` 后重启 pi。调试总线为 null，所有 `startSpan` 调用为 no-op，零开销。环形缓冲容量 2000，正常运行下内存占用可忽略，一般无需关闭。
