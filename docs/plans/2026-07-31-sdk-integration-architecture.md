# SDK 集成架构决策

> 日期：2026-07-31
> 状态：架构决策已锁定，待实施路径评估
> 关联：
> - `docs/plans/2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）
> - `docs/plans/2026-07-29-app-architecture-design.md`（应用架构设计）
> - `docs/audits/2026-07-29-data-flow-audit.md`（数据流审计）

## 一、背景与目标

### 1.1 核心目标

narrative-engine 从 "PI 扩展模式" 改造为 "使用 PI SDK 的独立应用"，实现：

- **每个模块独立**，不依赖 PI 运行时（PI 不再是宿主进程，仅作为库被引用）
- **双模式支持**：常规模式（无 AI，手动管理）+ AI 模式（接入 AI 辅助）
- **独立运行**：世界图（已完成）+ 编排器 + 子代理 + 记忆注入，三步完成后可独立跑

### 1.2 与既有设计的关系

本文档锁定的架构决策，是对 `2026-07-31-subagent-orchestrator-design.md`（子代理编排器设计）的**集成层面补充**。子代理编排器设计描述的是"编排器内部如何工作"，本文档描述的是"narrative-engine 如何与 PI SDK 集成以支撑编排器"。

## 二、关键查证结果（认知校准）

在锁定架构前，以下查证纠正了若干误解：

### 2.1 `pi-embedded-runner` 不是 PI 官方 API

OpenClaw 用的 `pi-embedded-runner` 是 OpenClaw 自己的抽象名称。PI 的 SDK 官方路径只有两条：
- `createAgentSession` / `createAgentSessionRuntime`（pi-coding-agent，session 级）
- `Agent` 类（pi-agent-core，agent 级）

**narrative-engine 的迁移目标基于这两条官方路径，不存在第三条路径。**

### 2.2 包名修订

子代理设计文档 §1.3 写的 `@earendil-works/pi-agent-core`，实际包目录在 `pi-ex/packages/agent/`，README 标题为 `pi-agent-core`。实际 npm 包名以 package.json 为准（待最终确认，但不影响架构决策）。

### 2.3 双模式已部分存在

- **扩展模式**（当前）：31 工具，需 PI 运行时，入口 `src/index.ts`
- **standalone 模式**（已有）：HTTP API，无工具无 LLM，入口 `src/app/main.ts`
- 两个入口互不导入

SDK 模式不是"从零建双模式"，而是"在已有 standalone 骨架上补上 AI 能力"。

### 2.4 既存 bug：4 路 LLM caller 签名错配

`scheduler-llm.ts:52-57` 调用 `makePlannerLlmCaller(ctx)` 和 `makeRendererLlmCaller(ctx)`（单参数 `ExtensionContext`），但 `planner-llm.ts:74` 和 `renderer-llm.ts:22` 的实际签名是 `(model, apiKey, provider)` 三参数。

因为 `build.mjs` 用 esbuild transform-only 不做类型检查，这个错配没被发现。**这是当前代码的既有 bug，迁移前必须先修。**

### 2.5 memory 里的 AgentRuntime 设计从未实现

`AgentRuntime` 接口和 `pi-adapter.ts` 在源码中零命中。设计文档设想了它，但代码没落地。本文档将重新定义它的落地方式。

## 三、架构决策（已锁定）

### 3.1 决策清单

| # | 决策点 | 锁定选择 | 理由 |
|---|---|---|---|
| 1 | 集成层面 | SDK 模式（不用扩展模式） | 每个模块独立，PI 不作为运行时宿主 |
| 2 | 主会话实现 | `createAgentSessionRuntime`（pi-coding-agent） | 完整生命周期：持久化、恢复、压缩、分支、树状导航等 |
| 3 | 子代理实现 | `Agent` 类（pi-agent-core） | 无状态用完即弃，符合子代理设计文档硬约束 |
| 4 | 内容归类 | 主会话 LLM + skill 自主判断 | 不做显式决策模块，通过 skill 告诉主会话能做什么 |
| 5 | 主会话生命周期范围 | 完整集（架构必须包含，当前可不用） | 完整集是 `createAgentSessionRuntime` 的 baseline，不是额外目标 |
| 6 | 编排器 LLM 归属 | 路(a)：工具内调 LLM | 与"信息隔离""主会话不参与叙事"硬约束无冲突 |

### 3.2 主会话：`createAgentSessionRuntime` + `SessionManager`

**定位**：用户直接和 AI 对话的主会话，有完整生命周期。

**能力来源**：`SessionManager` 是 `createAgentSessionRuntime` 的底层依赖，完整集能力自动包含：

| 完整集能力 | 底层 API | 当前暴露策略 |
|---|---|---|
| 持久化 | JSONL 文件自动保存 | 默认开启 |
| 恢复 | `SessionManager.continueRecent()` | API 可用，UI 后补 |
| 压缩 | `appendCompaction()` | 自动触发（超长时） |
| 分支 | `branch()` / `forkFrom()` | API 可用，UI 后补 |
| 树状导航 | `getTree()` / `getBranch()` | 数据结构在，UI 后补 |
| 标签 | `appendLabelChange()` | API 可用 |
| 自定义消息类型 | `appendCustomMessageEntry()` | API 可用 |
| 会话元信息 | `setSessionName()` | API 可用 |

**关键约束**："必须包含，后续慢慢支持" = 架构层用 `createAgentSessionRuntime` 即满足，当前只暴露基础 UI，后续逐步暴露完整集 UI。

### 3.3 子代理：`Agent` 类（pi-agent-core）

**定位**：编排器内部的 4 路 LLM caller（planner / role-pool / renderer / knowledge-mapper）改造为子代理。

**依据**：[pi-agent-core README](file:///d:/claude/pi-ex/pi-ex/packages/agent/README.md) 证实 `Agent` 类符合"轻量 + 无状态 + 用完即弃"：
- 构造即用：`new Agent({initialState: {systemPrompt, model, tools, messages}})`
- prompt 即跑：`await agent.prompt("Hello")`
- subscribe 事件流：`agent_start` / `turn_*` / `message_*` / `tool_execution_*` / `agent_end`
- 工具系统：`AgentTool` 与现有 `pi.registerTool` 结构同构
- abort/reset：支持用完即弃

**与 `createAgentSessionRuntime` 的本质区别**：

| 维度 | `Agent` 类 | `createAgentSessionRuntime` |
|---|---|---|
| 定位 | 轻量 agent loop 引擎 | 完整 session 管理 |
| 状态 | 内存中，无持久化 | jsonl 持久化、session 恢复 |
| 依赖 | 仅 pi-ai + typebox | pi-agent-core + session-manager + extensions loader 等 |
| 生命周期 | new → prompt → 丢弃 | create → prompt → 可恢复 |
| 适用场景 | 子代理（无状态用完即弃） | 主会话（完整生命周期） |

### 3.4 内容归类：主会话 LLM + skill

画板里的"内容归类"决策点（闲聊 / 写设定 / 剧情推进三分支）**不做显式决策模块**。主会话通过 skill 知道能做什么，LLM 自主判断该走哪条路。

### 3.5 编排器：Orchestrator + EventQueue

依据子代理编排器设计文档 §2.1：
- `scheduler_dispatch(event)` 是唯一入口，入队即返回
- EventQueue 是内存队列，后台 worker 逐条执行
- Orchestrator 是纯代码（非 LLM），负责启动各子代理并汇总结果
- 子代理间信息传递：串行模式下，前一角色的输出直接作为下一角色 Agent 的输入消息注入

## 四、目标架构图

```
┌─────────────────────────────────────────────────────────────┐
│  用户层                                                      │
│  Web UI（聊天界面） / 工具触发（按钮） / 可视化面板            │
└──────────────────────────┬──────────────────────────────────┘
                           │ prompt
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  主会话层（AI 模式）  —— createAgentSessionRuntime            │
│  · agent loop + 消息历史                                      │
│  · SessionManager 完整集（持久化/恢复/压缩/分支/树/标签/...）  │
│  · 记忆注入：应用层每轮 prompt 前重读 memory.md 并注入         │
│  · 内容归类：LLM + skill 自主判断（闲聊/写设定/剧情推进）      │
└──────────────────────────┬──────────────────────────────────┘
                           │ 工具调用（scheduler_dispatch 等）
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  编排器 + 子代理层（纯模块，不依赖 PI 运行时）                 │
│                                                              │
│  Orchestrator + EventQueue（纯代码，非 LLM）                  │
│       │                                                      │
│       ├─ planner 子代理     ── Agent 类实例（用完即弃）       │
│       ├─ role-pool 子代理   ── Agent 类实例（串行，信息传递）  │
│       ├─ 可见推理子代理     ── Agent 类实例（扩散写回世界图）  │
│       └─ renderer 子代理    ── Agent 类实例                   │
│                                                              │
│  子代理通过 LlmProvider 接口调 LLM（包装 pi-ai complete()）   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  数据层（已完成或基础设施）                                    │
│  world-graph（已完成） / memory.md / Embedder / Search        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  PI SDK 边界（仅作为库被引用，不作为运行时宿主）               │
│  · @earendil-works/pi-coding-agent  → createAgentSessionRuntime│
│  · @earendil-works/pi-agent-core    → Agent 类                │
│  · @earendil-works/pi-ai            → complete() / getModel() │
└─────────────────────────────────────────────────────────────┘
```

**常规模式（无 AI）**：主会话层不启动，编排器层不调用 LLM，只有数据层 + 可视化面板 + 工具触发（纯工具部分）可用。

## 五、PI 依赖面（最终收敛）

narrative-engine 对 PI 的全部依赖：

| 依赖项 | 来源 | 用途 |
|---|---|---|
| `createAgentSessionRuntime` | pi-coding-agent | 主会话生命周期 |
| `SessionManager` | pi-coding-agent | 主会话持久化/恢复/分支等 |
| `defineTool` / `customTools` | pi-coding-agent | 主会话工具注册 |
| `Agent` 类 | pi-agent-core | 子代理（4 路 caller） |
| `complete()` / `getModel()` / `validateToolCall()` | pi-ai | LLM 调用 |
| `Type` / `StringEnum` | typebox | 工具 schema 定义 |

**这就是全部依赖面。** PI 不再是运行时宿主，只是 3 个 npm 库。

## 六、AgentRuntime 接口的落地方式（修订）

子代理设计文档 §3.1 设想的 `AgentRuntime` 接口，基于 `Agent` 类。本架构决策确认这个方向，但落地方式需要明确：

- **`AgentRuntime` 接口**：定义为"包装 `Agent` 类的子代理运行能力"，不是"包装 `createAgentSession` 的 session 能力"
- **`pi-adapter.ts`**：作为唯一 PI 耦合点，从 PI SDK 获取 model/apiKey 构造 `Agent` 实例
- **未来 PI 独立**：只需替换 `pi-adapter.ts`，子代理代码不修改

**注意**：设计文档原假设的 `@earendil-works/pi-agent-core` 的 `Agent` 类独立于 session 使用，已由 README 证实可行（`new Agent({...})` 不依赖 session）。

## 七、存疑点（必须原型验证）

### 7.1 记忆注入时序

**问题**：`createAgentSessionRuntime` 的 `systemPromptOverride` 是**构造时一次性**的，而记忆注入需要**每轮 prompt 前动态更新** memory.md 内容。

**三种候选解法**：
1. 用 `customMessage` 机制，每轮 prompt 前应用层注入一条 custom message（参与 LLM context）
2. 用 `before_agent_start` 事件钩子（如果 SDK 模式下仍然保留扩展事件）
3. 不用 systemPrompt 注入，改用工具主动读 memory（语义变化）

**状态**：存疑，必须原型验证，不能在没验证的情况下给结论。这是后续研究的重点。

### 7.2 其他待研究点

1. `extensionFactories` 模式下，`before_agent_start` 是否真的保留每轮触发语义
2. SDK session 与 unified-server 的并发模型（一个 session 还是多 session？多项目切换怎么办？）
3. Web UI 驱动 session 的事件流设计（`session.subscribe` 的事件如何映射到 Web UI 的实时更新）
4. `AuthStorage` 在打包应用中的路径（`~/.pi/agent/` 路径依赖如何处理）
5. photon WASM 在 Tauri 打包后的实际加载行为

## 八、与子代理编排器设计文档的关系

本文档锁定的是**集成层面**架构，子代理编排器设计文档描述的是**编排器内部**工作方式。两者关系：

| 维度 | 本文档 | 子代理编排器设计文档 |
|---|---|---|
| 关注点 | narrative-engine 如何与 PI SDK 集成 | 编排器内部如何编排子代理 |
| 主会话 | 用 `createAgentSessionRuntime`（本文档锁定） | 主会话作为编排器入口（§2.1） |
| 子代理实现 | 用 `Agent` 类（本文档锁定） | 子代理是无状态用完即弃的 Agent（§3.1） |
| AgentRuntime | 落地为包装 `Agent` 类（本文档修订） | 设想为解耦边界（§3.1） |
| 编排器内部 | 不涉及 | Orchestrator + EventQueue + 串行信息传递（§2-§3） |

**两份文档不冲突，互补**。本文档解决了子代理设计文档遗留的"AgentRuntime 如何落地"问题。

## 九、后续工作方向

架构决策已锁定，后续进入实施路径评估阶段，需要研究：

1. **31 个工具**从 `pi.registerTool` 到 `defineTool` + `customTools` 的迁移要点
2. **4 路 caller** 如何改造成子代理（`Agent` 类实例）
3. **编排器**从 10 步线性流水线到 EventQueue + Orchestrator 的改造
4. **记忆注入机制**（含存疑点 7.1 的原型验证）
5. **打包影响**（pi-coding-agent + pi-agent-core + pi-ai 三个库的打包验证）
6. **主会话工具**的 Profile 预设（避免 31 工具全量暴露影响 LLM 选择准确率）

## 十、决策溯源

本文档的架构决策基于以下对话过程：

1. 用户提出"利用 PI 的 SDK 模式进行开发和集成"
2. 查证 PI SDK 文档，确认 `createAgentSession` 是官方路径，`pi-embedded-runner` 非官方
3. 用户确认"每个模块独立出来，不依赖 PI 运行时"
4. 用户提供飞书画板，确认目标数据流（主会话 → 内容归类 → 编排器 → 子代理 → 世界图）
5. 用户确认"内容归类靠主会话 LLM + skill 自主判断"
6. 用户确认"子代理用 Agent 类（轻量）"
7. 用户确认"主会话要有完整的生命周期"
8. 用户确认"完整集：必须包含，后续慢慢支持"
9. 架构决策锁定，本文档创建
