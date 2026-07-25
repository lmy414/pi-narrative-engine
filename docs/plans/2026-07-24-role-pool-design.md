> ✅ **状态：已实施**（`packages/role-pool/`，本文保留作设计依据）。

# 角色代理池（@pi/role-pool）设计文档

> **状态**: 设计 spec，待用户审阅后进入实施计划
> **日期**: 2026-07-24
> **前置**: 渲染器（@pi/renderer）已完成；世界图（@pi/world-graph）已实现；调度器尚未设计
> **范围**: 仅角色代理池子包 + 扩展层 2 个 pi 工具。调度器、伏笔存储不在本次范围

---

## 1. 定位与架构

### 1.1 角色池在引擎中的位置

```
调度器（未来，本次不设计）
  ├─ 解析用户输入为五要素 + 事件指令
  ├─ 检索世界图，为每个角色预取 staticCard + dynamicFacts
  ├─ 构建 CastMember[] + InteractCommand
  ├─ 调用 role_interact
  │     ↓
  │  @pi/role-pool（本次设计，无状态 LLM 编排）
  │     ├─ 角色 1 → LLM(tool call) → RoleAgentOutput
  │     ├─ 角色 2 → LLM(含角色1的公开action) → RoleAgentOutput
  │     └─ ...
  │     ↓
  │  返回 InteractResult { outputs, errors }
  │     ↓
  ├─ 提取 state_changes → 通过 world_event_apply 写扩散
  ├─ 投影为 RoleOutput[]（7字段，去掉 state_changes）
  └─ 调用 render_append
```

角色池与渲染器对称：
- **渲染器**：把结构化数据（RoleOutput[]）→ 文本
- **角色池**：把事件指令 + 演员表 → 结构化数据（RoleAgentOutput[]）

角色池**无状态**：不碰世界图、不写文件、不做扩散提取、不做伏笔存储。所有状态由调用方（调度器）持有和传递。

### 1.2 设计决策汇总

| # | 决策点 | 定案 | 理由 |
|---|--------|------|------|
| 1 | 设计范围 | 仅角色池，明确对调度器的接口契约 | 与渲染器设计模式一致；调度器单独设计 |
| 2 | 交互模型 | 串行可见行动（后动者见先动者 action，不见 thought） | 支持对话/对抗场景；信息隔离 |
| 3 | LLM 调用模式 | tool call（定义 character_action 工具） | 结构化可靠；与 novel-importer 一致 |
| 4 | 扮演定位 | 混合视角（角色卡第一人称 + 叙事约束第三人称） | Oz Project 可信代理 + 可控性 |
| 5 | 基础 prompt | 外部文件 角色规则集.md（与 规则集.md 并列） | 作者可修改扮演规则无需改代码 |
| 6 | 静态层格式 | 酒馆角色卡 JSON 直接复用（SillyTavern V2 卡） | 支持导入酒馆角色卡 |
| 7 | 输入契约 | 调度器预取，传卡 + 事实 + 事件指令 | 角色池不碰世界图，纯 LLM 编排 |
| 8 | 输出 schema | 8 字段 RoleAgentOutput（去掉 foreshadowings） | 伏笔存储未设计，YAGNI；待伏笔存储设计时加回 |
| 9 | 包结构 | 子包 @pi/role-pool + 扩展层 2 个 pi 工具 | 与 renderer/novel-importer 一致 |
| 10 | 角色间可见性 | 传全部先动者 action，LLM 自行判断感知 | 最简方案；角色规则集.md 约束反元游戏 |
| 11 | 错误处理 | 单角色失败跳过，记录 errors，不中断 | 让调用方决策重试 |
| 12 | 静态/动态冲突 | 动态层优先，显式提醒 LLM | 状态演化原则（参考酒馆实现） |

---

## 2. 数据契约

### 2.1 输入类型

```typescript
/**
 * SillyTavern V2 角色卡（结构子集）
 * 子包内重新声明为 interface，不依赖外部包
 * 原样注入 prompt（JSON 字符串）
 */
interface SillyTavernCard {
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  [key: string]: unknown;  // 允许额外字段（酒馆卡扩展字段）
}

/**
 * 状态声明快照（Fact 节点的结构子集）
 * 调度器通过 wg.getCharacterView(characterId, storyTime) 预取
 */
interface FactSnapshot {
  declarationId: string;
  entityId: string;
  property: string;
  value: unknown;
  valueText?: string;
  modality: "fact" | "belief" | "hypothesis";
  validFrom: string;
}

/**
 * 单个演员的输入
 */
interface CastMember {
  characterId: string;
  /** 静态层：酒馆角色卡 JSON */
  staticCard: SillyTavernCard;
  /** 动态层：角色当前可见的状态声明 */
  dynamicFacts: FactSnapshot[];
}

/**
 * 角色池调用命令
 */
interface InteractCommand {
  /** 事件指令（自然语言，调度器从用户输入解析） */
  eventInstruction: string;
  /** 故事时间（如 ch-2） */
  storyTime: string;
  /** 演员表，按出场顺序排列 */
  cast: CastMember[];
}
```

### 2.2 输出类型

```typescript
/**
 * 角色代理完整输出（8 字段）
 * 满足项目记忆硬约束（去掉 foreshadowings，待伏笔存储设计时加回）
 */
interface RoleAgentOutput {
  /** 行动者 */
  actor: string;
  /** 可观察的行动描述 */
  action: string;
  /** 行动对象（可选） */
  target?: string;
  /** 角色情绪（可选） */
  emotion?: string;
  /** 关系变更（可选） */
  relation_update?: { target: string; label: string }[];
  /** 内心独白（可选，其他角色不可见） */
  thought?: string;
  /** 获得的知识（可选） */
  knowledge_gained?: string[];
  /** 角色提议的状态变更（可选，调度器校验后写为 Fact） */
  state_changes?: StateChange[];
}

/**
 * 状态变更提议
 * 调度器将其转换为 newFacts，通过 world_event_apply 写入世界图
 */
interface StateChange {
  /** 目标实体（通常是 actor 自己，但也可能改变他人/环境） */
  entityId: string;
  /** 属性路径（如 mood / location / health） */
  property: string;
  /** 新值 */
  value: unknown;
  /** 认识论地位 */
  modality: "fact" | "belief" | "hypothesis";
}

/**
 * 先动者行动摘要（传给后动者，信息隔离）
 * 只含公开信息，不含 thought/emotion/state_changes/knowledge_gained
 */
interface PriorAction {
  actor: string;
  action: string;
  target?: string;
}

/**
 * 角色池返回结果
 */
interface InteractResult {
  /** 成功的角色输出（按 cast 顺序） */
  outputs: RoleAgentOutput[];
  /** 失败的角色（不中断，跳过记录） */
  errors: { characterId: string; error: string }[];
}

/**
 * LLM 调用器（注入式，便于单测 mock）
 * tool call 模式：返回已解析的 RoleAgentOutput
 */
type RoleLlmCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<RoleAgentOutput>;

/**
 * 角色池调用上下文
 */
interface RoleCtx {
  llm: RoleLlmCaller;
  /** 角色规则集.md 全文（由调用方通过 loadRoleRuleSet 读取后传入） */
  ruleSet: string;
}
```

### 2.3 与渲染器 RoleOutput 的投影关系

```
RoleAgentOutput（8字段）  ──调度器投影──→  RoleOutput（7字段）
  actor                    →  actor
  action                   →  action
  target                   →  target
  emotion                  →  emotion
  relation_update          →  relation_update
  thought                  →  thought
  knowledge_gained         →  knowledge_gained
  state_changes            →  ×（调度器提取写扩散，不传渲染器）
```

---

## 3. 核心串行编排

### 3.1 interact 函数

```typescript
async function interact(
  cmd: InteractCommand,
  ctx: RoleCtx,
): Promise<InteractResult> {
  const outputs: RoleAgentOutput[] = [];
  const errors: { characterId: string; error: string }[] = [];
  const priorActions: PriorAction[] = [];

  for (const member of cmd.cast) {
    try {
      const systemPrompt = buildSystemPrompt(member, ctx.ruleSet);
      const userMessage = buildUserMessage(cmd, member, priorActions);
      const output = await ctx.llm(systemPrompt, userMessage);
      outputs.push(output);
      // 累积公开行动（不含 thought/emotion/state_changes）
      priorActions.push({
        actor: output.actor,
        action: output.action,
        target: output.target,
      });
    } catch (err) {
      errors.push({
        characterId: member.characterId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 跳过失败角色，继续后续角色
    }
  }

  return { outputs, errors };
}
```

### 3.2 信息隔离原则

- **传给后动者的 PriorAction 只含 `{ actor, action, target }`**
- **不含**：thought（内心独白）、emotion（情绪）、state_changes（状态变更）、knowledge_gained（知识）、relation_update（关系变更）
- 全部先动者 action 都传给后动者，由 LLM 根据角色所处位置和感知能力自行判断能感知什么
- 角色规则集.md 约束反元游戏（见第 4 节）

### 3.3 LLM 调用（tool call 模式）

`RoleLlmCaller` 接口见 [2.2 节](#22-输出类型)。

定义 `character_action` 工具 schema（typebox），强制 LLM 通过 tool call 返回结构化数据。pi-ai 的 `complete` 配合 `tools` 参数实现。

应对 LLM 不返回 tool call 的已知问题（项目记忆教训）：
- `thinkingLevel: "minimal"`
- `timeout: 600000`（600s）
- system prompt 强化："你必须调用 character_action 工具输出，不要返回纯文本"
- 若 LLM 返回纯文本而非 tool call，抛出错误（由 interact 的 try-catch 捕获，记入 errors）

---

## 4. Prompt 构建

### 4.1 System Prompt 结构

```
[角色规则集.md 全文]
← 共享基础规则（扮演原则、输出格式、信息隔离、反元游戏、tool call 强制）

═══════════════════════════

⚠️ 重要规则：当静态层与动态层冲突时，以动态层为准。
动态层记录角色当前最新状态，静态层是长期不变的基础信息。
```

### 4.2 User Message 结构（角色信息在前，事件指令在末尾）

```
─── 你的角色卡（静态层）───
{
  "name": "林冲",
  "description": "豹头环眼，燕颔虎须，八十万禁军教头...",
  "personality": "隐忍、重义、刚烈",
  "scenario": "..."
}
─── 以上为静态层 ───

─── 你的当前状态（动态层）───
- mood: 愤怒（fact）
- location: 山神庙（fact）
- health: 轻伤（belief）
- knowledge: 知道陆虞候陷害自己（fact）
─── 以上为动态层 ───

[故事时间] ch-2

[先动者行动]（仅首个角色为空）
- 林冲：举起酒杯向师父行礼
- 武松：拍桌大笑，问林冲为何叹息

[事件指令]
诺艾尔走进武器店，想买一把新剑。

请根据你的角色卡、当前状态、事件指令，以及先动者的行动，
决定你在这个场景中的行动。
你必须调用 character_action 工具输出，不要返回纯文本。
```

**结构原则**（用户反馈）：
- 角色信息在前 → 让 LLM 先进入角色扮演状态
- 事件指令在末尾 → 注意力最强，驱动行动
- 先动者行动在事件指令之前 → 提供上下文

### 4.3 角色规则集.md 约定

**文件位置**：小说项目根目录（与 `规则集.md` 并列）

**格式**：自由文本 Markdown，建议章节：

```markdown
# 角色规则集

## 扮演原则
- 以角色第一人称思考，输出第三人称结构化数据
- 行动必须符合角色性格和当前状态
- 不得跳脱事件指令设定的场景

## 感知与信息隔离
- 你只能感知到你的角色能感知到的事物
- 根据你的位置、感知能力判断先动者行动是否可感知
- 严禁元游戏（metagame）：不得使用角色不该知道的信息

## 输出格式
- 必须调用 character_action 工具
- action 字段描述可观察的行为
- thought 字段是角色内心独白（其他角色不可见）
- state_changes 只填角色自己能感知的状态变更

## 状态变更
- modality: fact=客观事实 / belief=角色信念 / hypothesis=猜测
- state_changes 的 entityId 通常是 actor 自己，但也可改变他人/环境

## 禁止
- 不得替其他角色行动
- 不得引入场景中不存在的物品/角色
```

**注入位置**：System prompt 开头（作为行为约束，类似 AGENTS.md）

---

## 5. 子包文件结构

### 5.1 packages/role-pool/

```
packages/role-pool/
├── package.json              # @pi/role-pool, private, deps: @mariozechner/pi-ai
├── tsconfig.json             # 继承根 tsconfig
├── src/
│   ├── types.ts              # 类型定义（RoleAgentOutput / CastMember / InteractCommand 等）
│   ├── rule-loader.ts        # 角色规则集.md 读取
│   ├── prompts.ts            # 系统提示词模板 + 用户消息构建
│   ├── role-pool.ts          # 核心串行编排（interact 函数）
│   └── index.ts              # 子包导出
└── tests/
    ├── rule-loader.test.ts
    ├── prompts.test.ts
    ├── role-pool.test.ts     # 串行逻辑、PriorAction 累积、错误跳过
    └── types.test.ts         # 类型守卫/可选字段
```

### 5.2 扩展层 src/

```
src/
├── role-pool-llm.ts          # RoleLlmCaller 的 pi-ai 实现（tool call 模式）
└── index.ts                  # 修改：注册 2 个 role_* pi 工具
```

### 5.3 子包 API 导出

```typescript
// packages/role-pool/src/index.ts
export { loadRoleRuleSet } from "./rule-loader.ts";
export { interact } from "./role-pool.ts";
export type {
  RoleAgentOutput,
  StateChange,
  CastMember,
  SillyTavernCard,
  FactSnapshot,
  InteractCommand,
  PriorAction,
  InteractResult,
  RoleLlmCaller,
  RoleCtx,
} from "./types.ts";
```

---

## 6. 扩展层 pi 工具

### 6.1 role_interact

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventInstruction` | string | 是 | 事件指令（自然语言） |
| `storyTime` | string | 是 | 故事时间（如 ch-2） |
| `cast` | CastMember[] | 是 | 演员表（按出场顺序），每个含 characterId / staticCard / dynamicFacts |

**返回**：`InteractResult`（含 outputs: RoleAgentOutput[] + errors）

**LLM 配置**：从环境变量读取（与渲染器一致）
- `PI_ROLE_MODEL` / `PI_MODEL`（缺省 `deepseek-chat`）
- `PI_ROLE_API_KEY` / `PI_API_KEY` / `DEEPSEEK_API_KEY`

### 6.2 role_rule_set

无参数，返回 `角色规则集.md` 全文。与 `render_rule_set` 对称。

---

## 7. 测试策略

| 测试层 | 文件 | 内容 | LLM |
|--------|------|------|-----|
| 子包单测 | `rule-loader.test.ts` | 读取/缺失/空文件 | 无 |
| 子包单测 | `prompts.test.ts` | system prompt 拼接、user message 结构、静态/动态层注入 | 无 |
| 子包单测 | `role-pool.test.ts` | 串行顺序、PriorAction 累积、错误跳过、空 cast | mock RoleLlmCaller |
| 子包单测 | `types.test.ts` | 可选字段、类型守卫 | 无 |
| 扩展层 | `tests/role-pool-llm.test.ts` | pi-ai 适配、tool call 解析、错误处理 | mock pi-ai complete |
| E2E | `tests/e2e-role-pool.test.ts` | 端到端 2-3 角色事件 | 真实 LLM（需 API key） |

**mock RoleLlmCaller**：直接返回预设的 `RoleAgentOutput`，验证：
- 串行顺序正确
- PriorAction 累积正确（第 N 个角色收到前 N-1 个角色的 action）
- PriorAction 不含 thought/emotion/state_changes
- 单角色失败时跳过且记录 errors
- 空 cast 返回空结果

---

## 8. 与现有模块的衔接

### 8.1 上游：调度器（未来）

调度器实现时：
1. 解析用户输入为事件指令
2. 检索世界图确定参与角色
3. 为每个角色调用 `wg.getCharacterView(characterId, storyTime)` 预取 dynamicFacts
4. 从某处加载 staticCard（酒馆角色卡 JSON，存储方式待定）
5. 构建 `CastMember[]` + `InteractCommand`
6. 调用 `role_interact`
7. 从 `InteractResult.outputs` 提取 `state_changes` → `world_event_apply`
8. 投影为 `RoleOutput[]`（7字段）→ `render_append`

### 8.2 下游：渲染器（已实现）

渲染器的 `RoleOutput`（7字段）是 `RoleAgentOutput`（8字段）的子集。调度器投影时去掉 `state_changes`。渲染器不需要改动。

### 8.3 类型不跨包导入

`SillyTavernCard` 和 `FactSnapshot` 在 `@pi/role-pool` 内用 `interface` 重新声明（结构子集），不导入 `@pi/world-graph` 的 zod schema。与渲染器处理 `RoleOutput` 的方式一致——子包自持类型。

---

## 9. 待定事项（Pending Gaps）

| # | 事项 | 说明 | 影响 |
|---|------|------|------|
| 1 | 静态层存储 | 酒馆角色卡 JSON 存在哪里？Entity.summary（太短）？单独文件？Fact 节点？ | 调度器实现时解决 |
| 2 | 伏笔存储 | pending-impacts.json / accumulators.json 未设计 | foreshadowings 字段暂从输出中去掉 |
| 3 | 调度器 | 解析五要素、检索、预取、投影、扩散写入 | 单独设计 |
| 4 | 主会话 prompt | main-session.md 未实现（项目记忆 Pending Gaps） | 影响用户指令到调度器的路由 |
| 5 | 角色卡导入 | 从酒馆 V2 卡导入到世界图的工具 | 参考 v2-design-notes 4.0 提到的 import-cards.ts |

---

## 10. 不做的事（YAGNI）

- **不做调度器**：本次只设计角色池，调度器单独设计
- **不做伏笔存储**：foreshadowings 字段去掉，待伏笔存储设计时加回
- **不做角色卡导入工具**：存储方式未定，导入工具后续补
- **不做角色池持久化**：项目记忆裁决（2026-07-21），子代理无状态化，动态记忆由世界图统一维护
- **不做可见性矩阵**：传全部先动者 action，LLM 自行判断感知
- **不做多轮交互**：串行单轮，每角色一次 LLM 调用
- **不做并行执行**：串行模型，后动者依赖先动者 action
