# 旧代码清理逐任务 TDD 执行计划（阶段 B：纯 SDK 全量收敛）

> 日期：2026-08-01
> 状态：✅ 已实施完成（2026-08-01~08-04；盘点见 `docs/plans/2026-08-01-old-code-cleanup-report.md`）
> 决策来源（用户确认）：纯 SDK / 27 个旧业务工具迁移 / skills 与 memory 废弃 / visualizer 统一 unified-server / 删除 PI 应用链路 / `@pi/scheduler` 保留子包只删旧流水线
> 执行约束：所有命令均在 `d:\claude\pi-ex\narrative-engine` 运行；迁移先行、删除殿后；不修改盘点报告；本计划不包含 commit 步骤

## 一、完成定义与命令口径

最终状态必须同时满足：

1. 主会话注册 31 个且仅 31 个 SDK `customTools`：18 world + 5 render + 2 role + 2 import + 4 scheduler；工具名无重复且全部有 `promptSnippet`。
2. `src/index.ts`、`src/tools/`、`src/session-state.ts`、5 个旧 LLM caller、`src/skills/`、`src/memory.ts`、独立 visualizer、PI 启动/扩展安装链路和 scheduler 旧流水线均已删除。
3. unified-server 继续提供项目管理、文件、配置、chat、调试、世界图 API 和 visualizer-ui 静态资源。
4. `npm test` 最终 `fail 0`、`cancelled 0`；测试总数允许因废弃能力删除而下降。
5. `npm run build` 成功；各 workspace 的 `typecheck` 全部成功。

本仓库没有根级 `lint` 或 `typecheck` 脚本。使用以下已查证命令：

```powershell
npm run test:root
npm run test:packages
npm test
npm run build
npm --workspace @pi/role-pool run typecheck
npm --workspace @pi/scheduler run typecheck
npm --workspace @pi/renderer run typecheck
npm --workspace @pi/novel-importer run typecheck
npm --workspace @pi/admin run typecheck
npm --workspace @pi/novel-launcher run typecheck
```

单文件测试统一使用：

```powershell
npx tsx --test <准确测试文件路径>
```

预期：成功命令退出码为 0，Node test runner 汇总中 `fail 0`、`cancelled 0`。TDD 的红灯步骤只接受计划中写明的契约失败；语法错误、模块解析错误或无关测试失败不得当作有效红灯。

## 二、文件变更地图

### 迁移或修改

- `src/agents/tools.ts`
- `src/chat/scheduler-tools.ts`
- `src/orchestrator/assembly.ts`
- `scripts/orchestrator-mcp.ts`
- `src/tools/world-tools.ts` → `src/chat/world-tools.ts`
- `src/tools/render-tools.ts` → `src/chat/render-tools.ts`
- `src/tools/role-tools.ts` → `src/chat/role-tools.ts`
- `src/tools/import-tools.ts` → `src/chat/import-tools.ts`
- `src/tools/import-card.ts` → `src/chat/import-card.ts`
- `src/app/chat-context.ts`
- `src/orchestrator.ts`
- `src/ports/types.ts`
- `src/ports/adapters.ts`
- `src/visualizer/server.ts`
- `src/app/routes-ext.ts`
- `src/app/unified-server.ts`
- `src/app/main.ts`
- `packages/novel-launcher/src/index.ts`
- `packages/novel-launcher/src/types.ts`
- `packages/admin/src/app-config.ts`
- `packages/admin/src/index.ts`
- `packages/scheduler/src/index.ts`
- `visualizer-ui/api.js`
- `visualizer-ui/components/projects-view.js`
- `visualizer-ui/components/settings-view.js`
- `scripts/build.mjs`
- `scripts/package-sidecar.mjs`
- `package.json`
- `tests/agent-tools.test.ts`
- `tests/chat-scheduler-tools.test.ts`
- `tests/tools.test.ts`
- `tests/e2e-renderer.test.ts`
- `tests/role-pool-llm.test.ts`
- `tests/import-card.test.ts`
- `tests/ports-adapters.test.ts`
- `tests/orchestrator-service.test.ts`
- `tests/unified-server.test.ts`
- `tests/frontend-utils.test.ts`
- `packages/admin/tests/app-config.test.ts`

### 删除

- `src/index.ts`
- 清空迁移后的 `src/tools/` 目录
- `src/session-state.ts`
- `src/planner-llm.ts`
- `src/role-pool-llm.ts`
- `src/renderer-llm.ts`
- `src/knowledge-mapper-llm.ts`
- `src/scheduler-llm.ts`
- `src/skills/narrative-engine/SKILL.md`
- `src/memory.ts`
- `src/visualizer/standalone.ts`
- `scripts/visualizer.mjs`
- `scripts/sync.mjs`
- `packages/novel-launcher/src/launch.ts`
- `packages/novel-launcher/tests/launch.test.ts`
- `packages/novel-launcher/tests/launch-extension.test.ts`
- `packages/scheduler/src/plan.ts`
- `packages/scheduler/src/commit.ts`
- `packages/scheduler/src/retrieve.ts`
- `packages/scheduler/src/cache.ts`
- `packages/scheduler/tests/planner-llm.test.ts`
- `packages/scheduler/tests/commit.test.ts`
- `packages/scheduler/tests/retrieve.test.ts`
- `packages/scheduler/tests/cache.test.ts`
- `tests/memory.test.ts`
- `tests/visualizer-server.test.ts`
- `tests/prompts.test.ts`（全文件仅覆盖 skills 与 references 资产）
- `scripts/real-scheduler-demo.ts`（仍直接依赖旧 `role-pool-llm.ts`）

## 三、逐任务 TDD 计划

### Task 0：记录可比较基线

**文件：**不修改文件。

- [ ] 运行根测试基线：

```powershell
npm run test:root
```

预期：退出码 0；当前基线为 663 个全仓测试中的根测试部分，`fail 0`、`cancelled 0`。

- [ ] 运行 workspace 测试基线：

```powershell
npm run test:packages
```

预期：退出码 0，`fail 0`、`cancelled 0`。

- [ ] 运行构建基线：

```powershell
npm run build
```

预期：退出码 0，`dist/` 生成；此时仍会输出 skills/references 复制日志，这是后续待删除行为。

**阶段检查点 0：**若任一基线失败，先记录既有失败并停止清理；不得把既有失败混入后续红灯。

---

### Task 1：迁移三个删除前置契约

**修改：**

- `tests/agent-tools.test.ts`
- `tests/chat-scheduler-tools.test.ts`
- `src/agents/tools.ts`
- `src/chat/scheduler-tools.ts`
- `src/orchestrator/assembly.ts`
- `scripts/orchestrator-mcp.ts`

- [ ] 在 `tests/agent-tools.test.ts` 增加 schema 契约：直接从 `src/agents/tools.ts` 导入 `retrievalPlanSchema`、`characterActionSchema`，验证合法值通过、缺少必填字段失败，并保留现有 terminate tool 测试。

- [ ] 在 `tests/chat-scheduler-tools.test.ts` 将非法 storyTime 用例扩为表驱动，至少覆盖 `ch-9.ev6`、空字符串和合法 `ch009.ev006`；测试只从 `src/chat/scheduler-tools.ts` 触达校验逻辑。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/agent-tools.test.ts tests/chat-scheduler-tools.test.ts
```

预期：失败原因仅为 schema 尚未从新模块导出或新模块仍依赖旧模块；非法 storyTime 必须继续被拦截。

- [ ] 将 `retrievalPlanSchema`、`characterActionSchema` 的 TypeBox 定义从 `src/planner-llm.ts`、`src/role-pool-llm.ts` 移入并导出于 `src/agents/tools.ts`，删除该文件对两个旧 caller 的 import；保持字段、required、枚举和 terminate tool 行为不变。

- [ ] 将 `validateStoryTime` 的实现移入并导出于 `src/chat/scheduler-tools.ts`，删除对 `src/tools/scheduler-tools.ts` 的 import；保持错误消息包含 `storyTime 格式非法`。

- [ ] 将 `resolveWorldGraphDir` 从 `src/session-state.ts` 移入并导出于 `src/orchestrator/assembly.ts`；将 `scripts/orchestrator-mcp.ts` 的 import 改到 assembly。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/agent-tools.test.ts tests/chat-scheduler-tools.test.ts
npm run build
```

预期：两份测试 `fail 0`；构建成功，且 `src/agents/tools.ts`、`src/chat/scheduler-tools.ts`、`scripts/orchestrator-mcp.ts` 不再引用待删除模块。

---

### Task 2：迁移 18 个 world 工具为 SDK customTools

**移动：**`src/tools/world-tools.ts` → `src/chat/world-tools.ts`  
**修改：**`tests/tools.test.ts`

准确工具名：

```text
world_status
world_entity_create
world_entity_kill
world_entity_get
world_entity_update_summary
world_entity_history
world_relation_add
world_relation_close
world_relations
world_relation_history
world_event_apply
world_event_chain
world_character_view
world_visibility_set
world_visibility_close
world_visibility_infer
world_query
world_story_times
```

- [ ] 先改 `tests/tools.test.ts`：测试改为调用 `createWorldTools(provider)` 返回的 `ToolDefinition.execute`，断言 18 个名称顺序稳定、名称唯一、全部有 `promptSnippet`，并至少覆盖实体、关系、事件、可见性、查询、storyTime 缺省与更新六类转发。

- [ ] 增加废弃语义测试：`world_event_apply` 成功后不创建 `.pi/world-graph-v3/memory.md`，provider 的当前 storyTime 更新为事件时间。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/tools.test.ts
```

预期：因 `src/chat/world-tools.ts` 或 `createWorldTools` 尚不存在而失败；不是底层 WorldGraph 行为失败。

- [ ] 移动实现并将 `registerWorldTools(pi, state)` 改为 `createWorldTools(provider): ToolDefinition[]`。provider 只暴露 `wg`、`search`、`cwd`、`currentStoryTime`、更新 storyTime 的方法；移除 `ExtensionAPI`、`SessionState`、`requireWg`、`getCurrentStoryTime`、`updateMemory` 依赖。

- [ ] 保持旧工具的参数 schema、工具名、结果 `content/details` envelope 和错误语义；只替换依赖取得方式。不得复用 `src/agents/world-tools.ts`，后者是子代理受限工具，契约不同。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/tools.test.ts
npm run test:root
```

预期：18 个 SDK 工具契约全部通过；根测试 `fail 0`、`cancelled 0`。

**阶段检查点 1：**world 迁移完成后，`src/chat/world-tools.ts` 不得 import `ExtensionAPI`、`SessionState`、`src/memory.ts` 或 `src/visualizer/*`。

---

### Task 3：迁移 5 个 render 工具并改用 LlmConfigStore

**移动：**`src/tools/render-tools.ts` → `src/chat/render-tools.ts`  
**修改：**`tests/e2e-renderer.test.ts`

准确工具名：`render_append`、`render_modify`、`render_preview`、`render_check`、`render_rule_set`。

- [ ] 在 `tests/e2e-renderer.test.ts` 增加 `createRenderTools(provider)` 契约：5 个名称唯一且都有 `promptSnippet`；用 stub `LlmConfigStore` 验证 renderer slot 的 model/apiKey 被读取；验证 append/modify/preview/check/rule_set 的参数和结果 envelope 保持旧语义。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/e2e-renderer.test.ts
```

预期：因新工厂不存在或仍要求 `ExtensionContext` 而失败。

- [ ] 移动实现，内联 `src/renderer-llm.ts` 中仍需的 renderer 调用逻辑；配置来源改为 provider 的 `llmStore` 与 `cwd`，不保留 `ExtensionContext`、`SessionState` 或旧 caller import。

- [ ] 复用 `@pi/renderer` 已有规则集、章节编辑和校验 API，不复制子包实现。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/e2e-renderer.test.ts
npm --workspace @pi/renderer test
npm --workspace @pi/renderer run typecheck
```

预期：根定向测试和 renderer workspace 全部通过，typecheck 退出码 0。

---

### Task 4：迁移 2 个 role 工具并改用 LlmConfigStore

**移动：**`src/tools/role-tools.ts` → `src/chat/role-tools.ts`  
**修改：**`tests/role-pool-llm.test.ts`

准确工具名：`role_interact`、`role_rule_set`。

- [ ] 将 `tests/role-pool-llm.test.ts` 改为新工厂契约测试：从 `src/chat/role-tools.ts` 导入 `createRoleTools`，断言 2 个名称、`promptSnippet`、role slot 配置读取、`role_interact` 转发和 `role_rule_set` 文件行为；schema 测试已由 Task 1 的 `tests/agent-tools.test.ts` 接管。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/role-pool-llm.test.ts
```

预期：因 `createRoleTools` 尚不存在或仍依赖旧 caller 而失败。

- [ ] 移动实现，内联 `src/role-pool-llm.ts` 中仍需的 role 调用逻辑；配置来源改为 provider 的 `llmStore` 与 `cwd`，移除 `ExtensionAPI`、`SessionState` 和旧 caller import。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/role-pool-llm.test.ts
npm --workspace @pi/role-pool test
npm --workspace @pi/role-pool run typecheck
```

预期：全部通过；新 role 工具不再依赖待删除模块。

---

### Task 5：迁移 import 纯逻辑与 2 个 import 工具

**移动：**

- `src/tools/import-card.ts` → `src/chat/import-card.ts`
- `src/tools/import-tools.ts` → `src/chat/import-tools.ts`

**修改：**`tests/import-card.test.ts`、`tests/e2e.test.ts`

准确工具名：`import_novel`、`import_character_card`。

- [ ] 先将 `tests/import-card.test.ts` 的 import 改到 `src/chat/import-card.ts`，保留 PNG/JSON 卡片解析、字段提取和导入世界图的全部断言。

- [ ] 在 `tests/e2e.test.ts` 增加 `createImportTools(provider)` 契约：2 个名称唯一且有 `promptSnippet`；stub provider 验证 `embedder/cwd/wg/currentStoryTime` 透传，成功导入后更新 storyTime。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/import-card.test.ts tests/e2e.test.ts
```

预期：因新路径或新工厂不存在而失败。

- [ ] 移动 `import-card.ts`，只改引用路径，不改变纯逻辑。

- [ ] 移动 `import-tools.ts` 并改为 `createImportTools(provider): ToolDefinition[]`；移除 `ExtensionAPI`、`SessionState`、`requireWg`、`requireEmbedder`，保持参数 schema 和结果 envelope。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/import-card.test.ts tests/e2e.test.ts
npm --workspace @pi/novel-importer test
npm --workspace @pi/novel-importer run typecheck
```

预期：全部通过，卡片解析与小说导入行为不变。

---

### Task 6：组装 31 个主会话 SDK 工具

**修改：**

- `src/app/chat-context.ts`
- `tests/chat-scheduler-tools.test.ts`
- `tests/chat-routes.test.ts`

- [ ] 在 `tests/chat-scheduler-tools.test.ts` 增加主会话工具集合契约：调用从 `src/app/chat-context.ts` 导出的纯组装 helper，断言总数 31、`new Set(names).size === 31`、全部有 `promptSnippet`，并断言五组数量为 scheduler 4 / world 18 / render 5 / role 2 / import 2。

- [ ] 在 `tests/chat-routes.test.ts` 保留并扩展项目切换用例，确认 host 重建后 provider 读取新项目的 `wg/search/cwd/storyTime`，旧项目状态不泄漏。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/chat-scheduler-tools.test.ts tests/chat-routes.test.ts
```

预期：31 工具断言失败，当前只有 4 个 scheduler 工具。

- [ ] 在 `src/app/chat-context.ts` 建立项目级 provider：从 `ProjectRegistry.getActive()` 取得 `wg/search/dir`，从 options 取得 `embedder/llmStore`，维护每项目 `currentStoryTime`；不得加入 visualizer、skills、memory 或 PI 扩展生命周期字段。

- [ ] 让 `ensureHost()` 的 `customTools` 依次组合 `createSchedulerTools`、`createWorldTools`、`createRenderTools`、`createRoleTools`、`createImportTools`。纯组装 helper 必须可被测试直接调用，不启动真实 LLM。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/chat-scheduler-tools.test.ts tests/chat-routes.test.ts
npm run test:root
```

预期：31 工具契约、路由契约和根测试全部通过。

**阶段检查点 2：**执行源码检索，预期只剩待删除旧文件自身引用旧架构：

```powershell
rg -n "ExtensionAPI|SessionState|updateMemory|open_visualizer" src/chat src/app/chat-context.ts
```

预期：无输出，退出码 1 表示未命中，属于通过。

---

### Task 7：删除 MemoryPort 与运行时 memory 更新

**修改：**

- `tests/ports-adapters.test.ts`
- `tests/orchestrator-service.test.ts`
- `src/ports/types.ts`
- `src/ports/adapters.ts`
- `src/orchestrator/assembly.ts`
- `src/orchestrator.ts`

**删除：**`src/memory.ts`、`tests/memory.test.ts`

- [ ] 先在 `tests/orchestrator-service.test.ts` 增加保留行为契约：plan commit 与 yolo 后半链路仍返回世界图应用结果和章节写入结果，结果中不要求 memory update/error 字段。

- [ ] 从 `tests/ports-adapters.test.ts` 删除 `MemoryPort` 专属用例与 import；保留 WorldGraph/Search/Embedder/Ruleset/Renderer/RolePool 的全部适配器用例。

- [ ] 运行保护测试：

```powershell
npx tsx --test tests/ports-adapters.test.ts tests/orchestrator-service.test.ts
```

预期：在实现删除前，若测试已改为新契约，应因 `ports.memory` 仍为必填或结果仍含 memory 分支而失败；世界图和章节相关断言不得失败。

- [ ] 从 `src/ports/types.ts` 删除 `MemoryPort` 和聚合 ports 中的 `memory` 字段；从 `src/ports/adapters.ts` 删除 `createMemoryAdapter` 及 memory import；从 `src/orchestrator/assembly.ts` 删除 memory 装配。

- [ ] 从 `src/orchestrator.ts` 删除 post-role pipeline 中的 `ports.memory.update(cwd)` 及 memory 错误汇总，不改变 reasoning 与 renderer 的独立容错顺序。

- [ ] 删除 `src/memory.ts` 与 `tests/memory.test.ts`。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/ports-adapters.test.ts tests/orchestrator-service.test.ts
npm run test:root
```

预期：全部通过；检索 `MemoryPort|createMemoryAdapter|updateMemory|memory\.update` 不再命中源码和测试。

---

### Task 8：把独立 visualizer 契约收敛到 unified-server

**修改：**

- `tests/unified-server.test.ts`
- `src/visualizer/server.ts`
- `src/app/unified-server.ts`

**删除：**`src/visualizer/standalone.ts`、`scripts/visualizer.mjs`、`tests/visualizer-server.test.ts`

- [ ] 将 `tests/visualizer-server.test.ts` 的 15 组契约迁入 `tests/unified-server.test.ts`，使用已激活项目覆盖：status、graph、graph 缺 storyTime、entity、history、visibility、events/chain、search unavailable、未知 API、`/api.js` 静态资源、event 写入、relation add/close、visibility set/close、summary 更新、非法 body。

- [ ] 先运行迁移后的保护测试：

```powershell
npx tsx --test tests/unified-server.test.ts
```

预期：新增断言全部通过；若 unified-server 缺少任何独立服务已有契约，则该断言失败，先补齐共享路由再删除入口。

- [ ] 将 `src/visualizer/server.ts` 收敛为 unified-server 仍使用的 `serveStatic`、`readBody`、UI 路径解析 helper；删除 `startVisualizer`、`VisualizerServer` 和独立 listen/close 逻辑。同步调整 `src/app/unified-server.ts` import。

- [ ] 删除 standalone、启动脚本和独立服务测试。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/unified-server.test.ts
npm run test:root
```

预期：统一服务覆盖全部保留契约；`startVisualizer|VisualizerServer|visualizer/standalone|scripts/visualizer` 无源码引用。

**阶段检查点 3：**visualizer-ui 仍由 unified-server 提供，`GET /api.js` 返回静态 JS 而非 API 404；世界图写 API 的 source/校验语义不变。

---

### Task 9：删除 PI 扩展入口、旧工具目录、skills 与旧 caller

**删除：**

- `src/index.ts`
- 迁移后空的 `src/tools/`
- `src/session-state.ts`
- `src/planner-llm.ts`
- `src/role-pool-llm.ts`
- `src/renderer-llm.ts`
- `src/knowledge-mapper-llm.ts`
- `src/scheduler-llm.ts`
- `src/skills/narrative-engine/SKILL.md`

- [ ] 运行删除前保护门：

```powershell
npm run test:root
npm run build
```

预期：均通过，证明新架构已不靠旧文件提供能力。

- [ ] 检索旧模块被引用位置：

```powershell
rg -n "planner-llm|role-pool-llm|renderer-llm|knowledge-mapper-llm|scheduler-llm|session-state|src/tools|src/skills" src scripts tests packages
```

预期：命中只允许位于本任务即将删除的文件或纯历史说明；任何保留源码命中必须先迁移，不能直接删除。

- [ ] 删除上述文件，并删除仅覆盖 skills/references 资产的 `tests/prompts.test.ts` 与直接依赖旧 caller 的 `scripts/real-scheduler-demo.ts`。

- [ ] 运行绿灯：

```powershell
npm run test:root
npm run build
```

预期：测试和构建均通过；`dist/index.js`、`dist/tools/`、`dist/skills/` 不再生成。

---

### Task 10：删除项目启动 PI 的后端与 novel-launcher 实现

**修改：**

- `src/app/routes-ext.ts`
- `packages/novel-launcher/src/index.ts`
- `packages/novel-launcher/src/types.ts`
- `tests/unified-server.test.ts`

**删除：**

- `packages/novel-launcher/src/launch.ts`
- `packages/novel-launcher/tests/launch.test.ts`
- `packages/novel-launcher/tests/launch-extension.test.ts`

- [ ] 在 `tests/unified-server.test.ts` 增加删除契约：`POST /api/projects/launch-pi` 返回 404 `NOT_FOUND`；同时保留 scan/meta/create/activate/close 项目管理测试。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/unified-server.test.ts
```

预期：删除契约失败，因为端点当前仍存在；项目管理用例通过。

- [ ] 从 `src/app/routes-ext.ts` 删除 `launchPi` import、`POST /api/projects/launch-pi` 分支及 extension mode/path 参数拼装。

- [ ] 从 novel-launcher 删除 `launch.ts`、`launchPi` 导出、`LaunchOptions`/`LaunchResult` 与 extension 启动参数类型；保留 `discoverProjects`、`readProjectMeta`、`createProject`、`openFolder` 及其测试。

- [ ] 删除两份仅覆盖 PI 启动的测试。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/unified-server.test.ts
npm --workspace @pi/novel-launcher test
npm --workspace @pi/novel-launcher run typecheck
```

预期：launch-pi 为 404；其余项目管理能力通过；workspace typecheck 成功。

---

### Task 11：删除扩展 mode/update-check/reinstall 与快照配置

**修改：**

- `packages/admin/src/app-config.ts`
- `packages/admin/src/index.ts`
- `packages/admin/tests/app-config.test.ts`
- `src/app/routes-ext.ts`
- `src/app/unified-server.ts`
- `src/app/main.ts`
- `tests/unified-server.test.ts`

- [ ] 将 `packages/admin/tests/app-config.test.ts` 改为只验证非扩展配置：`launcher.defaultScanRoots`、`launcher.piExecutable`（暂保留既有通用配置字段）、`embedder.model` 的默认值、深合并和原子写；删除 install/reinstall/checkExtensionUpdate/_copyDir 测试。

- [ ] 在 `tests/unified-server.test.ts` 增加三个删除契约：`PUT /api/admin/extension/mode`、`GET /api/admin/extension/update-check`、`POST /api/admin/extension/reinstall` 均返回 404；保留 `/api/admin/app-config` 非扩展字段读写测试。

- [ ] 运行红灯：

```powershell
npx tsx --test packages/admin/tests/app-config.test.ts tests/unified-server.test.ts
```

预期：三个端点删除契约失败；非扩展配置测试通过。

- [ ] 从 `AppConfig`、`AppConfigUpdates`、默认配置和合并逻辑删除 `extension` 段；删除 `defaultGlobalExtPath`、`InstallExtensionOptions/Result`、`_copyDir`、npm install helper、`installExtension`、`reinstallExtension`、`checkExtensionUpdate` 及对应导出。

- [ ] 从 `src/app/routes-ext.ts` 删除三个 extension 端点和相关 admin imports；从 `UnifiedServerOptions`、routes context、`src/app/main.ts` 和测试 fixture 删除 `extensionSnapshotDir`。

- [ ] 运行绿灯：

```powershell
npx tsx --test packages/admin/tests/app-config.test.ts tests/unified-server.test.ts
npm --workspace @pi/admin test
npm --workspace @pi/admin run typecheck
```

预期：删除端点均 404；通用 app-config、文件、规则集、embedder、doctor/version/update 测试继续通过。

**阶段检查点 4：**`launchPi|launch-pi|extensionSnapshotDir|reinstallExtension|checkExtensionUpdate|extension/mode|extension/update-check|extension/reinstall` 在 `src packages tests` 中无命中。

---

### Task 12：删除前端 PI 启动与扩展管理 UI/API

**修改：**

- `visualizer-ui/api.js`
- `visualizer-ui/components/projects-view.js`
- `visualizer-ui/components/settings-view.js`
- `tests/frontend-utils.test.ts`

- [ ] 在 `tests/frontend-utils.test.ts` 增加静态契约：读取上述三个前端文件，断言不包含 `/projects/launch-pi`、`launchPi`、`/admin/extension/`、`reinstallExtension`、`extConfig`、`extCheck` 和“启动 PI”按钮文本；同时断言项目 activate/create/open-folder 与现有设置 API 仍存在。

- [ ] 运行红灯：

```powershell
npx tsx --test tests/frontend-utils.test.ts
```

预期：因旧 API、状态和按钮仍存在而失败；既有纯函数测试通过。

- [ ] 从 `api.js` 删除 `launchPi`、`setExtensionMode`、`checkExtensionUpdate`、`reinstallExtension` API。

- [ ] 从 `projects-view.js` 删除 `launchPi` 方法、启动中状态与“启动 PI”按钮；保留激活、创建、打开文件夹和项目元数据操作。

- [ ] 从 `settings-view.js` 删除 extension mode/check/reinstall 的 state、mounted 调用、methods、概览版本展示、扩展管理与扩展升级区块；保留项目 `.env`、规则集、embedder、doctor/version/update 和高级设置。

- [ ] 运行绿灯：

```powershell
npx tsx --test tests/frontend-utils.test.ts
npm run test:root
```

预期：静态删除契约与全部根测试通过。

---

### Task 13：删除 `@pi/scheduler` 旧流水线，保留新架构依赖

**修改：**`packages/scheduler/src/index.ts`  
**删除：**

- `packages/scheduler/src/plan.ts`
- `packages/scheduler/src/commit.ts`
- `packages/scheduler/src/retrieve.ts`
- `packages/scheduler/src/cache.ts`
- `packages/scheduler/tests/planner-llm.test.ts`
- `packages/scheduler/tests/commit.test.ts`
- `packages/scheduler/tests/retrieve.test.ts`
- `packages/scheduler/tests/cache.test.ts`

- [ ] 删除前先运行引用清单：

```powershell
rg -n "@pi/scheduler" src scripts tests packages
```

预期保留引用必须属于以下符号：`StructuredEvent`、`RetrievalPlan`、`SillyTavernCard`、`_buildPlannerSystemPrompt`、`_buildPlannerUserMessage`、`_insertChapterSection`、`defaultStaticCardLoader`，以及 `types/prompts/chapter-edit/chapter-resolver/static-card-loader/utils/debug` 中实际使用的类型/helper。`src/index.ts` 的 `loadAllPlans` 引用应已随 Task 9 删除。

- [ ] 先运行保留能力测试：

```powershell
npx tsx --test packages/scheduler/tests/chapter-edit.test.ts packages/scheduler/tests/chapter-resolver.test.ts packages/scheduler/tests/static-card-loader.test.ts packages/scheduler/tests/prompts.test.ts packages/scheduler/tests/utils.test.ts packages/scheduler/tests/debug.test.ts tests/orchestrator-service.test.ts tests/ports-adapters.test.ts tests/chat-scheduler-tools.test.ts
```

预期：全部通过。

- [ ] 从 `packages/scheduler/src/index.ts` 删除 `plan`、`commit`、`discard`、`loadAllPlans`、缓存内部导出、retrieve 内部导出和仅供旧流水线使用的类型导出；保留上述新架构实际引用。

- [ ] 删除四个旧流水线源码和四份专属测试。

- [ ] 运行绿灯：

```powershell
npm --workspace @pi/scheduler test
npm --workspace @pi/scheduler run typecheck
npm run test:root
```

预期：scheduler 保留测试、typecheck 和根测试全部通过；`plan.ts|commit.ts|retrieve.ts|cache.ts` 不再存在。

**阶段检查点 5：**不得仅因旧测试删除而接受测试通过；chapter edit/path、planner prompts、static card、utils/debug 以及 orchestrator/chat 使用方必须仍有绿灯。

---

### Task 14：清理 build、sync、sidecar 和 package 元数据

**修改：**

- `scripts/build.mjs`
- `scripts/package-sidecar.mjs`
- `package.json`

**删除：**`scripts/sync.mjs`

- [ ] 在修改前运行现状检查：

```powershell
rg -n "skills|references|extension-snapshot|skip-snapshot|pi\.extensions|sync\.mjs" scripts package.json tauri-app
```

预期：命中 `build.mjs` 的 skills/references 复制、`package-sidecar.mjs` 的 snapshot 参数与复制、根 package 的 `pi.extensions`/`sync`/`dev`；`tauri.conf.json` 不会单独命中 extension-snapshot。

- [ ] 从 `scripts/build.mjs` 删除 skills 与 references 资产复制；保留逐文件 TypeScript 转译和 `.ts` specifier 重写。

- [ ] 从 `scripts/package-sidecar.mjs` 删除 `--skip-snapshot` 参数、`skipSnapshot` 状态、extension-snapshot 复制、相关 `dist` 前置要求和目录说明；保留 server bundle、运行依赖、visualizer-ui、templates 和 Node runtime。

- [ ] 删除 `scripts/sync.mjs`；从 `package.json` 删除 `sync`、`dev` 和 `pi.extensions`，保留 `build`、`test`、`test:packages`、`test:root`。

- [ ] `tauri-app/src-tauri/tauri.conf.json` 当前只通配 `resources/server/**/*`，无需修改；打包验证只确认生成目录中不再含 `extension-snapshot/`。

- [ ] 运行打包绿灯：

```powershell
npm run build
node scripts/package-sidecar.mjs --out .tmp-sidecar-cleanup-check --skip-install
```

预期：构建成功且无 skills/references 日志；sidecar 命令成功，输出仅含 `runtime/`、`server/main.js`、`server/package.json`、`server/visualizer-ui/`、`server/templates/`，不含 `extension-snapshot/`。

- [ ] 删除临时验证目录 `.tmp-sidecar-cleanup-check`，不得把验证产物纳入源码变更。

---

### Task 15：全量验证与残留审计

**文件：**不再修改业务文件；若本任务发现失败，回到对应 Task 修复并重跑该阶段检查点。

- [ ] 运行所有 workspace typecheck：

```powershell
npm --workspace @pi/role-pool run typecheck
npm --workspace @pi/scheduler run typecheck
npm --workspace @pi/renderer run typecheck
npm --workspace @pi/novel-importer run typecheck
npm --workspace @pi/admin run typecheck
npm --workspace @pi/novel-launcher run typecheck
```

预期：六条命令全部退出码 0。

- [ ] 运行分层回归：

```powershell
npm run test:packages
npm run test:root
```

预期：两条命令均 `fail 0`、`cancelled 0`。

- [ ] 运行最终全量测试与构建：

```powershell
npm test
npm run build
```

预期：均退出码 0；最终测试数量记录实际值，不要求维持 663；`dist/` 只含保留的 SDK 应用源码。

- [ ] 审计 31 个工具契约：

```powershell
npx tsx --test tests/chat-scheduler-tools.test.ts tests/tools.test.ts tests/e2e-renderer.test.ts tests/role-pool-llm.test.ts tests/e2e.test.ts
```

预期：工具总数、唯一性、`promptSnippet`、分域执行契约全部通过。

- [ ] 审计禁止残留：

```powershell
rg -n "ExtensionAPI|SessionState|MemoryPort|createMemoryAdapter|updateMemory|open_visualizer|startVisualizer|launchPi|launch-pi|extensionSnapshotDir|reinstallExtension|checkExtensionUpdate|extension/mode|extension/update-check|extension/reinstall|loadAllPlans|_getPlan|pi\.extensions|sync\.mjs" src scripts tests packages visualizer-ui package.json
```

预期：无输出；退出码 1 表示未命中，属于通过。若命中仅为历史注释，应删除失效注释；`docs/` 不在本次残留审计和修改范围。

- [ ] 审计应保留入口：

```powershell
rg -n "createSchedulerTools|createWorldTools|createRenderTools|createRoleTools|createImportTools|startUnifiedServer|serveStatic|readBody|_insertChapterSection|_buildPlannerSystemPrompt|defaultStaticCardLoader" src packages
```

预期：每个符号至少有定义或实际引用；不存在只导出不使用的迁移工具。

**最终阶段检查点：**

- `npm test` 与 `npm run build` 全绿。
- 六个 workspace typecheck 全绿。
- 主会话 31 个工具，无重复，全部可见。
- unified-server 的项目、文件、配置、chat、调试、世界图和静态 UI 测试全绿。
- 无 PI 扩展入口、memory、独立 visualizer、launch/reinstall/sync、scheduler 旧流水线残留。
- 不运行依赖 `NE_LLM_API_KEY` 的真实 LLM 冒烟作为必选门槛；具备环境时可另行执行，不影响本阶段验收。

## 四、失败处理规则

1. 红灯必须与当前任务新增契约直接对应；模块语法错误、错误路径或其他域回归不算有效红灯。
2. 每个 Task 的绿灯未通过，不得进入下一个删除任务。
3. 删除测试前，必须先把仍需保留的行为迁到现有测试文件；不得用“删除失败测试”代替修复。
4. 若准确接口与本计划不一致，以当前源码和依赖 `.d.ts` 为准，先更新本计划对应任务再实施，不臆猜接口。
5. 不修改 `docs/plans/2026-08-01-old-code-cleanup-report.md`；不在本计划执行中创建报告或额外计划文件。
