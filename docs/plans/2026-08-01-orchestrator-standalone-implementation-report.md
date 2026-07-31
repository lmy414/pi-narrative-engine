# 子代理编排器实现落地报告（2026-08-01）

> 依据：docs/plans/2026-07-31-subagent-orchestrator-design.md（设计）
> docs/plans/2026-07-31-orchestrator-standalone-research.md（调研，已修正硬伤）
> docs/plans/2026-07-31-orchestrator-standalone-implementation.md（执行计划）
>
> 本文记录阶段 0/1 及 LLM 配置演进的实际落地情况，供下一阶段（阶段 2 / 配置中心）接手。

## 一、目标回顾

把调度器 10 步线性流水线改造成**真子代理编排**：4 类子代理（planner / 角色 / 可见推理 / 渲染器）各自带 agent loop、能自主调用工具、多轮推理后产出结构化结果；编排器与 PI 完全解耦，可独立以 MCP stdio server 形态被外部客户端拉起。

## 二、实现范围（时间线）

| 节点 | 内容 | 提交 |
|---|---|---|
| 2026-07-31 | 阶段 0/1：子代理工厂 + 产出收集 + 事件队列 + MCP stdio 包装 + 端到端验证 | c4db7e3 |
| 2026-08-01 | 修复 admin 测试挂起（预先存在 bug） | 16a198b |
| 2026-08-01 | LLM 配置演进①：探测链（客户端名映射 + Codex auth.json） | 0848cd3 → 用户转向 |
| 2026-08-01 | LLM 配置演进②：独立配置中心 LlmConfigStore（每 slot 独立 provider/model/apiKey） | 8021792 |
| 2026-08-01 | LLM 配置演进③：撤 AgentRuntime 自造层，直接复用 pi-ai 统一 API | 316708f |

## 三、架构要点

### 1. 子代理（src/agents/）
- 4 个工厂（planner-agent / role-agent / reasoning-agent / renderer-agent）构造 `Agent`（@earendil-works/pi-agent-core）：
  `initialState = { systemPrompt, model, tools: [产出工具], messages }` + `streamFn` + `getApiKey`
- 每个子代理**只有一个"产出提交"工具**（retrieval_plan / character_action / diffusion_result / render_result），
  `terminate: true` + `executionMode: "sequential"`；systemPrompt 尾部强制约束"结论必须且只能通过产出工具一次提交"
- **终止语义（已查证）**：agent-loop 的 terminate 是 **all 语义**（同轮 batch 全部 terminate 才停），
  因此产出工具串行执行保证单工具提交即终止

### 2. 产出收集（src/agents/collect.ts）
- `collectSubmission(agent, toolName)` 订阅 agent 事件流：
  - `tool_execution_end` 且工具名匹配 → 从 `event.result.details` 提取结构化产出
  - `agent_end` 未提交 → reject（"未提交产出"）
- 编排器对每个子代理：`collectSubmission → agent.prompt("") → await promise`

### 3. 编排（src/orchestrator.ts）
- `run(event)`：planner → 角色（串行，前序输出注入下一角色）→ yolo 模式追加推理 + 渲染
- 角色循环内某角色失败不阻断其他角色（错误收集进 `errors`）

### 4. 队列与 MCP（src/event-queue.ts / src/orchestrator/）
- `EventQueue`：内存队列 + 单消费者 worker（processing 防重入），dispatch 入队即返回 queueId
- MCP 暴露 4 个调度工具：scheduler_dispatch / scheduler_commit（占位）/ scheduler_discard（占位）/ scheduler_queue_status
- 内部子代理工具**不暴露**（用户澄清：内部工具私有）

### 5. LLM 配置（src/orchestrator/llm-config.ts）——最终形态
- **直接复用 pi-ai 统一 API**：getModel（provider+模型ID→Model）、streamSimple（统一流式调用）、getEnvApiKey（provider→标准 env key）
- `LlmConfigStore` 配置中心雏形：`setConfig(slot, { provider, name, apiKey? })` → `getModel(slot)` / `getApiKey(slot)`
- 解析链：**slot 显式 → default → env 兜底**（NE_LLM_PROVIDER/MODEL + NE_LLM_API_KEY/getEnvApiKey）
- slot 标识：planner / role / reasoning / renderer / default
- pi 适配器（pi-adapter.ts，唯一 PI 耦合文件）：`createLlmConfigFromCtx(ctx)` 产出同形态 LlmConfig

## 四、关键查证结论（以查档求证为荣）

| 查证点 | 结论 |
|---|---|
| terminate 语义 | all 语义（agent-loop.js `shouldTerminateToolBatch`）→ 产出工具 sequential |
| AgentOptions | 不暴露 `shouldStopAfterTurn` → 终止只能靠 terminate:true |
| getModel 未命中 | 返回 undefined 不抛错（models.js:11-14）→ 显式校验，配置错误立即报错 |
| provider→env key | pi-ai `getEnvApiKey` 内置完整映射（env-api-keys.js），不自维护 |
| 模型 ID 分区 | openai 分区 key 无前缀（`gpt-5.1`）；`openai/gpt-5.1` 属 openrouter 分区 |
| MCP clientInfo | `mcp.server.getClientVersion()` 官方读取器（握手后填充）——客户端名映射已弃用 |

## 五、验证结果

- **单测**：全量 622/622 通过（新增 llm-config.test.ts 15 例：env 探测 + store 每 slot 独立/default 回退/env 兜底/模型未命中抛错）
- **e2e**：MCP Client → stdio server → dispatch → 轮询 queue_status → status=done（真实 LLM 链路，planner+角色完成）
- **build**：42 文件正常（dist 为 gitignore 产物，由 npm run build 生成）
- **回归**：scheduler / role-pool / renderer / novel-importer / admin / novel-launcher 全绿

## 六、修复的历史问题

1. **admin 测试挂起**（预先存在，本次范围外顺手修）：pi-status.test.ts 的 `setImmediate` 误用 promise 版（node:timers/promises 不接受回调），mock child 的 close 永不触发 → 改 `node:timers`
2. **MCP 接入测试"未提交产出"误报**：无效 API key（配置占位符）→ deepseek 401 → 子代理无产出。诊断日志定位，非代码 bug

## 七、已知限制（阶段 2 待接线）

- `scheduler_commit` / `scheduler_discard` 为占位（未接数据层）
- `scheduler_queue_status` 只返回状态不含编排结果内容
- 子代理不接触世界图/文件（无 world_* 工具、不写章节），全部产出经 tool call 收集
- **按 slot 独立模型的读取入口未做**（配置文件 / MCP 参数）——留给配置中心
- 单模型兜底（env）当前对所有 slot 生效；每 slot 独立模型需代码 setConfig

## 八、下一步建议（用户研究中）

- **阶段 2**：数据层 Ports 接线（WorldGraph / Renderer / Embedder）、commit 落地、结果内容暴露（queue_status 返回 result）
- **配置中心**：slot 模型配置的持久化（配置文件/数据库）+ 注入入口，统一管理"每个子代理用什么模型"
- 子代理容错：LLM 非确定性导致未提交产出时重试机制
