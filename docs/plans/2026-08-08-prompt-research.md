# 提示词工程调研报告（编码助手 × 酒馆 × pi SDK）

> 日期：2026-08-09
> 状态：📋 **调研完成（三线素材已核实），优化方向待用户决策后实施**
> 依据：`docs/plans/2026-08-08-prompt-engineering-audit.md`（问题 4，D1 产出路径）
> 调研对象：① 编码助手 agent 提示词工程（Claude Code 实测 system prompt / Anthropic 官方方法论 / AGENTS.md·Cursor 规范 / pi SDK 与 HanaAgent 组装实现）② 酒馆 SillyTavern 角色扮演约束机制（官方文档 + 主仓库源码 + 角色卡 V2 规范）③ 本工程主 agent 与四子代提示词现状（代码查证）
> 关联：phase2 G5（叙事增强）、`hanako-reference.md`（设计参考手册）、结构 v3（D5 联动）

---

## 一、TL;DR（结论速览）

1. **现状不是"=0"，而是"两代并存 + 关键缺口"**：子包（role-pool / renderer）有较成熟的提示词设计（定界防注入、注意力排序、字段缺失表），但 pure-SDK 后的 orchestrator 新链路用的是简化硬编码版本，**role-pool 的成熟模板未接入**；更严重的是 **`renderRuleSet`（渲染规则集）在 chat-context 加载后从未注入 renderer**——novel 的「规则集.md」在新链路中完全丢失（`src/orchestrator.ts:188` 声明、`src/app/chat-context.ts:360-371` 加载、`runRenderer` 不使用）。
2. **主 agent 提示词 = pi 默认模板，零定制**：novel 项目无 `.pi/SYSTEM.md`，主会话走 pi-coding-agent 通用编码助手提示词（"You are an expert coding assistant..."）。
3. **酒馆最强的单点机制 = PHI 尾置加权**：历史之后的指令比历史之前的权重高得多——写作风格/本场约束放在用户消息末尾（离输出最近）比放 system 开头有效得多。本工程已有零散实践（渲染规则集设计注明"用户消息末尾注意力最强位"），但新链路丢失。
4. **酒馆"示例对话 = 风格锁定最有效手段"**：`mes_example` few-shot 是角色口吻保持的核心武器，本工程角色卡字段（`personality`/`mes_example`/`first_mes`）全部未使用。
5. **编码助手可迁移的核心**：子代理提示词短小（Claude Code Explore 仅 871 tokens）+ 主代理 briefing 自包含（绝不委托理解、给路径行号、说清 done 状态）+ 五层模块化 + 输出契约可验证 + 委派节流 + 验证独立。
6. **HanaAgent/pi SDK 可迁移的核心**：静态前缀/动态尾部 cache 分界、per-session prompt 快照冻结、记忆分层注入、工具自描述三档（snippet/guidelines/SKILL.md）、`<available_skills>` XML。

---

## 二、现状盘点（2026-08-09 代码查证）

### 2.1 五个 agent 的提示词现状

| Agent | 系统提示词 | 用户消息 | 现状判定 |
|---|---|---|---|
| **主 agent** | pi-coding-agent 默认模板（"You are an expert coding assistant..."）+ SYSTEM.md 机制（**novel 无 SYSTEM.md**，`src/chat/main-session.ts:11`） | 用户口述 | 零定制；面向编码的默认提示词在服务叙事任务 |
| **planner** | `packages/scheduler/src/prompts.ts:28` buildPlannerSystemPrompt：规则集 + 检索能力清单（6 工具逐条说明）+ recordedAsOf 说明 + 任务 + 数量建议（5-15/≤30）+ 信息差原则 | buildPlannerUserMessage：事件指令/故事时间/角色清单/执行建议 | **四子代中最好**：有任务边界、能力清单、数量约束；但无示例、无自检 |
| **role** | `src/orchestrator.ts:635-643` buildRoleSystemPrompt：角色规则集 + `你是角色/角色描述` + executionHints + SUBMIT_ONLY 后缀 | buildRoleUserMessage：事件指令/故事时间/entityId/scenario + 前序角色（合并单条） | **简化版**：丢了 role-pool 子包成熟设计（见 2.2）；角色卡仅用 name/description/scenario，personality/mes_example 未用 |
| **reasoner** | `src/orchestrator.ts:202-205` REASONING_SYSTEM_PROMPT **1 段硬编码**（约 100 字职责描述） | 事件 + 角色产出 JSON 直拼 | 无规则集、无字段语义表、无自检门 |
| **renderer** | `src/orchestrator.ts:208-211` RENDERER_SYSTEM_PROMPT **1 段硬编码**（约 100 字） | 事件/章节路径/锚点/角色产出/扩散结果 JSON 直拼 | **renderRuleSet 未注入（缺口）**；renderer 子包成熟模板（`packages/renderer/src/prompts.ts`：职责边界/字段缺失表/输出协议/注意力排序）未接入 |

### 2.2 两代提示词并存（关键发现）

| 代 | 位置 | 设计水平 | 现链路使用 |
|---|---|---|---|
| 子包代（较成熟） | `packages/role-pool/src/prompts.ts`（定界标记防注入 `─── 角色规则集开始/结束 ───`、静态/动态冲突规则+示例、用户消息注意力排序"角色卡在前入戏/事件指令在末尾"、cast 名单、entityId 填写规则、动态层按 label 分组） | 有结构 | **未被 orchestrator 使用**（`buildSystemPrompt` 无 src/ 调用者） |
| 子包代（较成熟） | `packages/renderer/src/prompts.ts`（RENDERER_SYSTEM_PROMPT：职责边界"你不决定发生了什么，只决定怎么写"、字段缺失表、渲染原则、输出协议；buildUserMessage：已有上下文→叙事指令→角色池数据→规则集（末尾最强）） | 有结构 | 仅 renderer 子包旧调用链使用；新链路未接 |
| 新链路代（简化） | `src/orchestrator.ts` 硬编码 + 拼接 | 裸拼 | 当前实际生效 |

**结论**：优化无需从零开始——**先把子包成熟模板接回 orchestrator 新链路，再叠加调研所得的新机制**。

### 2.3 规则集三件套（novel 实际使用，35/24/46 行）

- `planner 规则集.md`：检索策略（5 条）、信息差原则、数量控制（3-8 条）、property 中文词表——有内容，无示例
- `规则集.md`（渲染）：文风 3 条/格式 4 条/禁止 2 条——最短，最需要 few-shot 示范与结构
- `角色规则集.md`：扮演原则 4 条、输出纪律 4 条、state_changes 词表、relation 词表、静态/动态层说明——有词表约束（好），无示例（缺）
- 共同缺口：**零 few-shot、无自检指令、无"与已写正文衔接"引导、无版本与评估**

### 2.4 角色卡字段使用（SillyTavernCard，`packages/scheduler/src/types.ts:25`）

| 字段 | 酒馆定位 | 本工程现状 |
|---|---|---|
| name | 角色名 | ✅ 进 role system prompt |
| description | 常驻设定（permanent token） | ✅ 进 role system prompt（仅一句"角色描述：..."） |
| personality | 常驻性格 | ❌ **未使用** |
| scenario | 常驻场景 | ⚠️ 仅进 role 用户消息（"当前场景"） |
| first_mes | 开场白（仅一次，风格锚） | ❌ **未使用** |
| mes_example | 示例对话（风格锁定最强手段） | ❌ **未使用** |
| creator_notes | 元数据（永不进 prompt） | ✅ 正确未用 |

---

## 三、调研线 A：编码助手 agent 提示词工程

> 素材：Claude Code v2.1.226 实测 system prompt（515 个条件拼接片段，镜像仓库逐字提取）、Anthropic 官方 best-practices 全文、agents.md 官方规范、Cursor Rules 官方文档、pi SDK 源码 + HanaAgent 组装实现（本地查证）。

### A1. Claude Code 系统提示词五层结构

不是单一字符串，是 **500+ 片段按环境条件拼接**：

1. **身份层**：一句话角色定义（"You are an interactive agent that helps users with software engineering tasks"）
2. **能力/边界层**：能力主张 + 行为边界（不做不需要的错误处理、不加多余功能、被拒调用不得原样重试）
3. **规则层**：动作安全（可逆/本地自由做，不可逆/外发先确认）、工具使用规则、委托约束
4. **工作流层**：TodoWrite 任务分解（做完即标完成，不批量）、计划-执行-验证循环
5. **输出层（输出契约）**：首句预告动作、回合结束 1-2 句总结（"What changed and what's next. Nothing else"）、`file_path:line_number` 引用、禁 emoji

### A2. 常用技术清单（Anthropic 官方，每条含"为何有效"）

| 技术 | 做法 | 对叙事引擎的翻译 |
|---|---|---|
| 清晰指令 | 把模型当"聪明但没有上下文的新员工"，按编号步骤 | 子代理任务写成编号步骤 |
| Few-shot 3-5 个 | `<example>` 包裹，最可靠的格式/语气/结构引导 | **角色口吻示例、检索计划示例、渲染文风示范段** |
| XML 标签 | `<instructions>/<context>/<input>` 无歧义解析 | 提示词分区用定界标记（role-pool 已实践） |
| 少说"不要" | "要流畅散文"优于"不要用 markdown"；提示风格污染输出风格 | 渲染器"要白描"应正面表述 |
| 自检/质量门 | "Before you finish, verify your answer against..." | 每个子代理加"提交前核对"一步 |
| 防幻觉 | 未读过的代码不得臆测，先查后答 | role 代理"动态层没有的，就是不知道"（已实践✅） |
| 防过度工程 | 明确禁止作用域外行为 | 子代理"不得调用无关工具"（SUBMIT_ONLY 已实践✅） |
| 输出契约 | "报告限 200 词"变成可验证约束 | diffusion/render 结果字段语义表 |
| 默认行动 | `<default_to_action>` 扭转"默认建议"倾向 | 可选项 |

### A3. 子代理体系（对多代理编排最直接）

- **子代理提示词短小**：Explore 仅 871 tokens——一句话身份 + 硬边界（只读禁令清单）+ 工具清单 + 输出方式。**任务上下文放主代理 briefing，不放角色**。
- **写作五规则**（`writing-subagent-prompts.md`）：
  1. **自包含**：像对刚进房间的同事 briefing——它没看过对话，写清目标/已知/已排除
  2. **绝不委托理解**（最强调）：禁止写"based on your findings, fix the bug"——必须给文件路径、行号、具体改动
  3. 要短输出就明说（"report in under 200 words"）
  4. 查证给精确命令、调查给问题本身
  5. 生硬命令式 brief 产出肤浅工作
- **委派节流**（`subagent-delegation-restraint.md`）：小任务内联做、不并行拆分小任务、派了就不重做、宁少派但一次派好
- **结果协议**：worker 结果以结构化信封到达（id/status/summary/result/usage），主代理**不得编造未到达的结果**
- **验证独立**："Prove the code works, don't just confirm it exists"；验证代理与实现代理分离，验证者怀疑报告
- **继续 vs 新开决策表**：纠正失败→继续；验证他人代码→新开（新鲜视角）；方向全错→新开

### A4. 项目级指令文件规范

- **AGENTS.md**（agents.md 官方）："a README for agents"；monorepo 每包一份，**离被编辑文件最近的优先**，父级合并；放构建/测试命令、代码约定、可编程校验
- **CLAUDE.md**（Claude Code）：写常用命令与"需读多文件才能理解的大图景"；**不写废话指令、不列易发现结构、不写通用实践**
- **Cursor Rules**：`alwaysApply` 常驻 / `globs` 按文件匹配 / 仅 description 由 agent 判断；单条 <500 行；只在反复出错时添加

### A5. pi SDK + HanaAgent 提示词组装（本地源码查证）

- **SDK 分工**：pi-agent-core 只透传 systemPrompt（`agent.ts:73`、`agent-loop.ts:291-296`）；pi-coding-agent 是组装器（`agent-session.ts:893-927` `_rebuildSystemPrompt`，工具集变化时重算）
- **默认模板顺序**（`system-prompt.ts:130-172`）：身份行 → `Available tools:`（仅 snippet 提供的列出）→ `Guidelines:`（按工具推导 + 恒有 Be concise）→ `<project_context>`（AGENTS.md/CLAUDE.md）→ skills XML → 日期/cwd
- **SYSTEM.md 注入**：项目 `.pi/SYSTEM.md` 优先、agentDir 兜底（`resource-loader.ts:853-865`）；APPEND_SYSTEM.md 同机制——**本工程主 agent 的定制入口现成可用，novel 建 SYSTEM.md 即生效**
- **HanaAgent 七层组装**（`core/agent.ts` 1255-1519）：身份+环境 → 用户档案 → 人格（identity+yuan+ishiki 三件套模板回落链）→ 行为指南（硬编码 sections，条件注入）→ 记忆 → provider 补丁 → skills
- **cache 分界线**（`agent.ts:1268-1278, 1521-1523`）：静态前缀（身份/人格/行为指南）在前，动态漂移（记忆/时间戳）统一放尾部——**跨 session 前缀 cache 命中**；prompt 在会话创建时**快照冻结**（`session-coordinator.ts:2035-2041`），老会话不随记忆编译漂移
- **记忆注入形态**：memory.md 拼为 `# 记忆` section，前置"记忆使用规则"三段式（无声参与/不许提"我记得"/对话优先于记忆）；滚动摘要固定格式契约（Key Facts + Timeline 三级标题，校验+repair）；时间上下文校正防幻觉时间戳
- **工具自描述三档**：promptSnippet（一行，进工具列表）→ promptGuidelines（多条，进 Guidelines）→ SKILL.md（懒加载全文，`<available_skills>` XML）——**本工程 4 子代工具（character_action/retrieval_plan/diffusion_result/render_result）可补三档自描述**

---

## 四、调研线 B：酒馆 SillyTavern 角色扮演约束机制

> 素材：官方文档原始 markdown（characterdesign/worldinfo/Prompts/AN/Regex/Summarize）、主仓库源码（openai.js 拼接顺序/PromptManager/world-info.js/regex engine）、角色卡 V2 规范（原仓库已删，镜像 malfoyslastname/character-card-spec-v2）、本地酒馆客户端 `D:\claude\安卓酒馆\phantom-chat-temp`。

### B1. 角色卡字段设计（V1/V2）

- V2 字段：`name / description / personality / scenario / first_mes / mes_example / creator_notes / system_prompt / post_history_instructions / alternate_greetings / character_book / tags / creator / character_version / extensions`
- **Permanent（每次生成必发）**：name、description、personality、scenario
- **非永久**：first_mes（仅开场一次——"模型从首条消息学到的风格/长度约束比其他任何部分都强，按期望回复长度写"）；mes_example（**有空间才插、按块被挤出**，`<START>` 块分隔 + `{{char}}:`/`{{user}}:` 前缀；可 pin 强制保留）
- creator_notes 永不进 prompt（纯元数据）
- 角色卡级 override：system_prompt（Main Prompt override）/ post_history_instructions（PHI override），`{{original}}` 宏保留全局
- 量化警告：2048 context 模型塞 1000-token 角色定义，"记忆"减半——**永久层要克制**（本工程 description 直拼需注意）

### B2. prompt 构建顺序（openai.js populateChatCompletion 实测）

```
worldInfoBefore → main(system) → worldInfoAfter → charDescription → charPersonality
→ scenario → personaDescription → controlPrompts → [nsfw] → [jailbreak=PHI]
→ enhanceDefinitions → bias → 扩展注入 → in-chat injections(@Depth) → dialogueExamples → chatHistory
```

- 默认 prompt_order：`main → worldInfoBefore → charDescription → charPersonality → scenario → nsfw → worldInfoAfter → dialogueExamples → chatHistory → jailbreak`
- **PHI（Post-History Instructions）尾置 = 约束力最强单点**：官方原文 "system instructions written *after* the conversation history have a much stronger weight… than instructions written *before*"；历史之后的指令可覆盖主提示
- 示例对话在聊天历史之前（few-shot 风格范例，context 紧张按块挤出）
- 主提示效力随历史增长衰减 → 用 AN/PHI 在历史末尾重申

### B3. 世界书 World Info（设定按需注入）

- 条目字段：`keys（主关键词）/ secondary_keys / content / selective（AND_ANY/AND_ALL/NOT_ANY/NOT_ALL）/ constant（常驻无需关键词）/ insertion_order / extensions.depth（@深度插入）/ position / role / probability（触发概率）/ scan_depth / match_whole_words` 等
- 插入位置：before（角色定义前）/ after / atDepth（聊天历史@深度）/ EMTop / EMBottom
- **预算机制**：Context % 是所有激活条目合计 token 上限，超限按 priority 丢弃——**设定按需注入而非全量塞入**
- 典型用途（文档明言）：lorebook 百科全书、**存放"记忆"**、模块化角色细节
- 本地简化版（phantom-chat-temp）：仅 title/keywords/content/enabled——缺 constant 与 depth 两维

### B4. 正则 Regex（输出清洗 / 隐藏约束）

- `findRegex + replaceString + trimStrings + minDepth/maxDepth + markdownOnly/promptOnly`（仅显示层/仅出站 prompt 层，**临时性不改源数据**）+ affects 作用源（AI Response / User Input / World Info…）
- 用途：去模型格式残留、把特定模式统一改写、深度限定近程消息

### B5. 其他约束手段

- **Author's Note**：任意位置插入（After Scenario / In-chat @ Depth），**插入频率**（每 N 次输入插一次）；"越接近 prompt 底部影响越大"；周期重申约束（如每章"不得重复形容词"）比一次性系统指令抗遗忘
- **Summarize 扩展**：每 N 条消息生成摘要 + `{{summary}}` 宏注入 + 注入位置可配 + 随编辑回滚——**直接映射"章节摘要注入下一章"**
- **采样参数**：`repetition_penalty / frequency_penalty / presence_penalty / seed` 对文风稳定性直接作用（引擎"文风稳定性"旋钮）
- **停止字符串**：角色/用户名字 + 示例分隔符进停止列表（防串角、防泄漏示例块）
- **可观测性**：Prompt Inspector 查看最终拼装 prompt——引擎应暴露"本次请求最终 prompt"

---

## 五、落地映射（三线机制 → 五 agent 优化清单）

> 供实施决策参考；每项标注机制来源（酒=酒馆 / CC=Claude Code·Anthropic / H=HanaAgent·pi SDK）与优先级。

### 5.1 主 agent（现状：pi 默认，零定制）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| M1 | **novel 建 `.pi/SYSTEM.md`**：叙事引擎主笔身份 + 口述→事件工作流 + 输出契约；pi SDK 注入点现成（`resource-loader.ts:853`），零代码改动 | H/CC | ★★★ |
| M2 | SYSTEM.md 按五层模块化（身份/能力边界/规则/工作流/输出），静态前缀+动态尾部（cache 分界） | CC/H | ★★★ |
| M3 | 记忆注入（G5-1 联动）：`# 记忆` section + 记忆使用规则三段式 | H | ★★☆ |

### 5.2 planner（现状：四子代中最好，缺示例与自检）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| P1 | 补 1-2 条检索计划 few-shot 示例（`<example>` 包裹，展示"信息差分配"正例+反例） | CC/酒 | ★★★ |
| P2 | 自检门："提交前核对：每条 assignTo 的接收者是否可能知道该信息？" | CC | ★★☆ |
| P3 | 规则集+能力清单+任务说明之间用定界标记（防规则集污染结构） | 酒/role-pool | ★★☆ |

### 5.3 role（现状：简化版 + 角色卡字段大量未用——**最大优化空间**）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| R1 | **接回 role-pool 子包成熟模板**（定界标记/冲突规则/注意力排序/cast 名单/entityId 规则）并增强——现成资产，非从零写 | 存量 | ★★★ |
| R2 | **角色卡字段全用**：personality → system 常驻；description 保持（克制长度）；scenario 常驻；**mes_example → few-shot 对话示例**（风格锁定最强手段，`<START>` 块分隔） | 酒 | ★★★ |
| R3 | **PHI 尾置**：本场风格/说话方式指令放用户消息末尾（事件指令之后，离输出最近）而非 system 开头 | 酒 | ★★★ |
| R4 | 前序角色输出保持合并单条（已有 M-Qual-5 ✅），补"引用前序行动而非复述"提示 | CC | ★☆☆ |
| R5 | 输出契约显式化：action/thought/state_changes 字段语义表（对标 renderer 子包字段缺失表样式） | 存量/酒 | ★★☆ |

### 5.4 reasoner（现状：1 段硬编码，无规则集）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| RE1 | 补输出契约：diffusion_result 字段语义表 + 写入判据（"该变化是角色行为直接导致的吗？不臆测内心/不替角色做决定"） | 存量 renderer 样式 | ★★★ |
| RE2 | 自检门："写入前核对世界图现状（先查后写）" | CC | ★★☆ |
| RE3 | 世界图写工具三档自描述（snippet/guidelines） | H | ★☆☆ |

### 5.5 renderer（现状：1 段硬编码 + **renderRuleSet 丢失**）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| RN1 | **修复 renderRuleSet 注入缺口**：渲染规则集注入 renderer 用户消息末尾（注意力最强位，与规则集.md 头部注明的设计一致） | 存量设计 | 🔴 必修 |
| RN2 | **接回 renderer 子包成熟模板**（职责边界"你只决定怎么写"、字段缺失表、输出协议） | 存量 | ★★★ |
| RN3 | 补 few-shot 文风示范段（规则集文风 1-2 段示例，展示白描/对话格式） | 酒/CC | ★★★ |
| RN4 | 章节衔接指令："chapter_read 后，先概述前文最后状态，再续写，不重复铺垫"（对齐 G5-2 前情引用） | CC | ★★☆ |
| RN5 | 周期性重申（AN 频率机制）：渲染规则集在每次渲染都注入即等效于"每章重申"——RN1 修复后天然达成 | 酒 | ★☆☆ |

### 5.6 跨 agent（工程机制）

| # | 措施 | 来源 | 优先级 |
|---|---|---|---|
| X1 | **提示词版本表 + 效果基线**（D4 决策点）：编排成功率/子代理 errorCount/render_check 违规数/正文锚点合规率，每次优化可回退可比对 | CC（"先定义成功标准再谈优化"） | ★★★ |
| X2 | SUBMIT_ONLY 后缀统一化：从"⚠️ 重要约束"升级为结构化"输出协议"段（含字段契约+禁止并行调用其他工具+禁止编造） | CC | ★★☆ |
| X3 | 提示词模块化落文件：全局层（引擎身份/输出契约）→ 项目层（三件套）→ 任务层 → 角色层；与结构 v3（D5）联动设计 | 酒/CC/H | ★★☆ |
| X4 | 评估可观测性：暴露"本次请求最终 prompt"（调试总线扩展） | 酒 | ★☆☆ |
| X5 | 采样参数旋钮：文风稳定性（repetition_penalty/seed）经 LlmConfigStore 暴露 | 酒 | ★☆☆ |

---

## 六、开放决策点（实施前对齐）

| # | 决策点 | 候选方向 |
|---|---|---|
| D1 | **实施顺序** | 建议：① RN1 缺口修复（必修，独立小步）② R1/RN2 接回子包成熟模板 ③ R2/R3/RN3 few-shot+PHI（新增机制）④ M1 主 agent SYSTEM.md ⑤ X1 基线先行（建议优化前先建基线，与 D4 一致） |
| D2 | **few-shot 素材来源** | 用现有 novel 正文中符合规则集文风的段落提炼（人工/半自动），还是先写示范段（LLM 生成+人工审定） |
| D3 | **mes_example 来源** | novel 角色卡目前无 mes_example 字段数据——需补数据（用户/作者编写或从既有正文提炼），还是先以系统写示范 |
| D4 | **与 G5 的耦合** | 提示词优化独立先行（推荐，本报告即第一步），记忆注入/前情引用（M3/RN4）并入 G5 实施 |
| D5 | **规则集三件套是否随结构 v3 重构** | 若 v3 引入分层，提示词分层与规则集结构联动设计（本报告 §5.6 X3） |
| D6 | **评估基线** | 建议优化前先跑一轮基线采集（编排成功率/违规数/锚点合规率） |

> 已决策项见 **§九 D7**（planner 规则集三块内容退位为引擎自维护）、**D8**（角色规则集整体收回引擎自维护）与 **D9**（渲染规则集收回、只保留文风规则给外部编辑）；结构 v3 定案（D10/D11）见 `2026-08-08-novel-project-structure-v3.md` §七，均 2026-08-09。

---

## 七、来源索引

**本工程（现状）**
- `src/orchestrator.ts:198-211`（SUBMIT_ONLY/REASONING/RENDERER 硬编码）、`635-657`（role 拼装）
- `src/agents/*.ts`（4 子代理工厂，结构一致：systemPrompt+tools+messages 直传）
- `packages/scheduler/src/prompts.ts`（planner 提示词）、`packages/scheduler/src/types.ts:25`（SillyTavernCard）
- `packages/role-pool/src/prompts.ts`（成熟代 role 模板）、`packages/renderer/src/prompts.ts`（成熟代 renderer 模板）
- `src/chat/main-session.ts:11`（SYSTEM.md 预留）、`src/app/chat-context.ts:360-371`（三件套加载，renderRuleSet 未注入）
- `templates/novel/` 三件套 + `../novel/` 实际使用副本

**编码助手**
- Anthropic best-practices 镜像：github.com/bobkovmd/claude-docs（docs.anthropic.com 原址 301 至 platform.claude.com，本环境不可达）
- Claude Code system prompt 逐字提取：github.com/Piebald-AI/claude-code-system-prompts（v2.1.226；关键：`agent-prompt-explore.md` 871 tokens、`writing-subagent-prompts.md`、`subagent-delegation-restraint.md`、`coordinator-mode-orchestration.md`、`memory-instructions.md`）
- agents.md 官方规范；cursor.com/docs/rules
- pi SDK 源码：`D:\claude\pi-ex\pi-ex\packages\agent\src\agent.ts:73`、`agent-loop.ts:291-296`、`harness/agent-harness.ts:339-351`；`packages/coding-agent/src/core/agent-session.ts:893-927`、`resource-loader.ts:853-879`、`system-prompt.ts:130-172`
- HanaAgent：`D:\claude\openhanako\core\agent.ts:1255-1523`（七层组装+cache 分界）、`session-coordinator.ts:2035-2107`（快照冻结+resourceLoader 代理）、`lib/memory/compile.ts`（增量编译）、`lib/memory/rolling-summary-format.ts`（摘要格式契约）

**酒馆**
- SillyTavern 官方文档 raw：characterdesign / worldinfo / Prompts（index/advancedformatting/context-template/instructmode）/ Author's-Note / Regex / Summarize / personas
- 源码（release）：`public/scripts/openai.js`（拼接顺序）、`PromptManager.js`（prompt 项属性）、`world-info.js`（条目字段）、`extensions/regex/engine.js`、`default/content/presets/openai/Default.json`
- 角色卡 V2 规范镜像：github.com/malfoyslastname/character-card-spec-v2（原 Zarutian/CharcoalStyles 仓库已删除）
- 本地：`D:\claude\安卓酒馆\phantom-chat-temp\client\screens\character-edit\index.tsx`（含 reply_style 结构化文风字段）、`world-edit\index.tsx`

## 八、备注

- 本报告为调研产出：**不实施、不改提示词、不改代码**；实施前需用户决策 §六。
- 与 `hanako-reference.md` 的关系：本报告是问题 4 的专项调研，hanako-reference 是通用设计参考手册（§2 模式库中 2.3 工具与 Agent 条目与此处 H 线素材同源）。
- 记录人：ZCode（2026-08-09）。

## 九、用户决策记录（2026-08-09）

> 状态：📋 **已记录（决策已定，实施待启动）**——本次仅记录决策到文档，不改代码、不改规则集文件。

### D7｜planner 规则集三块内容退位为引擎自维护

**决策原话**：检索策略（5 条）、信息差原则、数量控制（3-8 条）不再提供编辑，作为引擎自维护内容。

**决策解读**：
- 这三块描述的是**引擎行为**（怎么检索、信息怎么分配、检索多少条），不是作品/叙事内容，不应放在用户可编辑的规则集中
- 归引擎自维护 = 内容固化进引擎（`packages/scheduler/src/prompts.ts` 的 `buildPlannerSystemPrompt` 内置段），用户不再通过 `planner 规则集.md` 编辑

**背景事实（查证）**：现状存在重叠与矛盾——
- `planner 规则集.md`（用户可编辑）含：检索策略 5 条、信息差原则 3 条、数量控制（3-8 条宁精勿滥）、property 中文词表、旧数据兼容说明
- 引擎内置（`prompts.ts:28-88`）已有：检索能力清单（6 工具含用途）、recordedAsOf 说明、任务段、数量建议（**5-15 条、≤30 防爆炸**）、信息差原则 3 条
- **矛盾点**：规则集.md 数量控制"3-8 条宁精勿滥" vs 引擎内置"5-15 条"——两套建议并存且不一致；检索策略与能力清单的"用途"行高度重叠

**实施要点（未来实施时按此执行）**：
1. `packages/scheduler/src/prompts.ts`：把检索策略 5 条并入能力清单段（或独立"检索策略"段）；信息差原则两处合并去重；数量控制统一为用户钦定的 **3-8 条**（原 5-15 删除）；"≤30 防上下文爆炸"为独立硬上限，是否保留/收敛待实施时确认（见待确认项）
2. `planner 规则集.md` 注入保留：`buildPlannerSystemPrompt` 的 `${plannerRuleSet}` 参数保持兼容，文件退位后内容为空即跳过
3. `templates/novel/planner 规则集.md` 与 `novel/planner 规则集.md`：移除三块，头部定位说明更新为"检索行为由引擎内置维护"
4. 现有测试（`packages/scheduler/tests/prompts.test.ts`）不覆盖 planner 提示词，无断言破坏风险；实施时补 planner 提示词单测（对齐"以完备测例为荣"）

**待确认项**：
- **property 中文词表归属**：用户未点名。词表是引擎与世界图的数据契约（Fact 表中文属性名），性质上与三块相同；本次不动，实施时请示是否一并归引擎
- **数量硬上限**：原引擎"≤30 条避免上下文爆炸"是独立工程保护；建议值统一 3-8 后，硬上限保留还是收敛（如 ≤15），实施时确认

**关联**：与 §5.2 P1-P3（planner 补 few-shot/自检/定界标记）同属 planner 提示词优化，实施时合并推进。

### D8｜角色规则集收回引擎自维护（2026-08-09）

**决策原话**：角色扮演规则也不再开放外部编辑，收回引擎自维护。

**决策解读**：
- `角色规则集.md`（46 行，`templates/novel/` + `novel/` 副本）整体退位——不再作为用户可编辑的外部规则集
- 其内容（扮演原则 4 条、输出纪律 4 条、state_changes 属性名词表、relation_update 关系标签词表、静态/动态层说明）全部固化进引擎，由引擎自维护
- 与 D7 的关系：D7 是 planner 规则集三块内容退位（部分）；D8 是角色规则集**整体**退位（全部）

**背景事实（查证）**：
- 注入链路：`角色规则集.md` → `loadRoleRuleSet`（`packages/role-pool/src/rule-loader.ts`）→ role-pool `role-pool.ts:119` `buildSystemPrompt(member, ctx.ruleSet, cmd.executionHints)`（system prompt 开头）→ 另经 `chat-context.ts:360-371` → `OrchestratorOptions.roleRuleSet` → `orchestrator.ts:637` buildRoleSystemPrompt parts[0]
- 其他消费方：`src/chat/role-tools.ts:84-85` 的 `role_interact`（interact 时加载）与 `role_rule_set`（查看工具，主 agent 可读）
- 内容性质：全部为引擎行为约束与数据契约（词表为 world-graph 中文属性名/关系标签约定），无作品侧内容——与 D7 的"词表归属待确认项"同性质，D8 一并覆盖

**实施要点（未来实施时按此执行）**：
1. 扮演原则/输出纪律/词表固化进 role-pool 子包（`buildSystemPrompt` 内置，或子包内置模板文件），替换外部 `ruleSet` 参数注入；`ruleSet` 参数保持兼容（空即跳过）
2. `orchestrator.ts` buildRoleSystemPrompt 的 `roleRuleSet` 同样内置化
3. `templates/novel/角色规则集.md` 与 `novel/角色规则集.md` 退位（删除或改定位说明）
4. `role_rule_set` 查看工具行为调整：改为返回引擎内置内容（或下线）
5. 三件套剩余：`规则集.md`（渲染器文风）仍开放编辑——**是否也收回待用户确认**（§5.5 RN1 修复后其约束力生效）
6. 实施时补 role 提示词单测（对齐"以完备测例为荣"）

**待确认项**：
- 渲染规则集（`规则集.md`）是否同样收回（用户未提及；若收回则三件套全部引擎化，规则集文件体系整体退位）
- `角色规则集.md` 文件本身：删除还是保留为空壳说明（实施时确认，倾向删除并同步 templates 与 novel 脚手架）

**关联**：D7（planner 规则集退位）、§5.3 R1-R5（role 提示词优化，其中 R1 接回子包成熟模板与本次内置化天然合并）。

### D9｜渲染规则集收回，只保留文风规则给外部编辑（2026-08-09）

**决策原话**：只保留文风给外部编辑。

**决策解读**（回答 D8 待确认项①）：
- 渲染规则集（现行 `规则集.md`，文风/格式/禁止）收回引擎自维护，**不再开放外部编辑**
- **唯一保留的外部编辑面 = 文风规则**——文风（怎么写）属于作品/作者内容，开放给用户编辑；其余渲染行为（格式/禁止/输出契约）归引擎
- 与 D11（结构 v3 规则集文件夹）联动：外部文风 = `规则集/文风规则.md`；`检查规则.md`（checker 校验规则）与 `自定义规则.md` 归属未明说，记录待确认

**背景事实**：
- 现行 `规则集.md`（24 行模板）内容：文风 3 条（白描/对话简洁/节奏）、格式 4 条（段落/「」/无标题/无元注释）、禁止 2 条（不补缺失维度/不剧透）——文风与格式/禁止混在一个文件
- **实施拆分建议**：文风部分 → `规则集/文风规则.md`（外部可编辑）；格式/禁止/输出契约 → 引擎内置（renderer 子包成熟模板 `packages/renderer/src/prompts.ts` 已有对应内容：输出协议/字段缺失表，可承接）
- 注入缺口：`renderRuleSet` 加载后未注入 renderer（§5.5 RN1 🔴）——实施时一并修复，注入形态改为渐进披露（见 D11）

**待确认项**：
- `检查规则.md` / `自定义规则.md` 的编辑归属（"只保留文风"之外是否全部引擎自维护）
- 文风规则在渲染器内的注入形态：渐进披露按需读取（D11 已定）下的细节

**关联**：D8 待确认项①闭环；D11（规则集文件夹）；§5.5 RN1-RN5（renderer 优化）。
