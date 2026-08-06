# 前端测试轮 · 2026-08-06-model-config-ui

## 元信息
- 触发原因：模型配置 UI 优化（第二轮返工：可用列表默认空 + 勾选启用制）
- 受影响页面：settings（#/settings）「模型配置」面板、「厂商管理」面板、共用「增加配置」弹窗
- 设计要点（用户定稿口径）：
  1. 厂商配置/可用模型**默认空**，不展示任何未配置内容
  2. 点「增加配置」→ 弹窗选厂商（内置/自定义/新建）→ 填 API Key **自动拉取**模型列表
  3. 用户**勾选启用**哪些模型（非全量展示），保存后进入可用列表
  4. 可用列表项可移除；slot 配置从可用列表统一选择
- 受影响文件：
  - 后端：`packages/admin/src/app-config.ts`（llm.providerModels 启用子集：读/写/合并/删除）；
    `src/app/routes-ext.ts`（GET providers 带 enabledModelIds+hasKey；新增 PUT /api/admin/llm/providers/:id/models）
  - 前端：`frontend-demo/views/settings.js`（可用列表只取启用模型；弹窗密钥输入防抖自动拉取、勾选区预勾已启用+全选/清空；
    厂商管理面板默认空只列已配置；测试连通不再覆盖启用子集）、`frontend-demo/api-client.js`（saveLlmProviderModels）、
    `frontend-demo/api-mock.js`（mockBuiltinEnabled + saveLlmProviderModels）、`frontend-demo/styles/views.css`
    （slot 表 5 列、.set-page-head/.set-avail-*/.set-models-head/.set-link-btn）、`frontend-demo/index.html`（缓存版本 20260806-a）
  - 测试：`packages/admin/tests/app-config.test.ts`（providerModels 2 例）、`tests/unified-server.test.ts`（新端点 3 例）
- 服务地址：http://127.0.0.1:7422
- 执行者：AI
- 开始时间：2026-08-06

## 环境说明（坦诚存疑）
- 本执行环境（WSL）无 browser_use 工具，**浏览器逐项实操未执行**；自动化项已完成，交互项待用户验收/下轮 browser_use。
- WSL 内 tsx 因 node_modules 为 Windows 侧安装无法运行，测试均经 Windows node.exe 执行，结果有效。
- `tsc --noEmit` 有 6 处报错，全部位于未改动文件（novel-json/write/chat-context/visualizer-routes），为存量问题，本次改动文件零报错。

## 已完成的自动化验证

- [x] AV-001 语法检查：`node --check` settings.js / api-mock.js / api-client.js 通过
- [x] AV-002 vm 沙箱冒烟（新语义 6 组断言）：
  - 可用列表 = 启用子集（内置 enabledModelIds + 自定义 modelIds；未启用的内置模型不出现）✔
  - 内置启用模型标签同样可移除 ✔
  - 已配置厂商过滤（无启用无密钥的内置厂商不展示）✔
  - 弹窗勾选区仅预勾已启用子集、无 disabled ✔
  - 弹窗初始模型区：内置预勾启用子集 / 未选厂商显示自动拉取提示 ✔
- [x] AV-003 单测（Windows node.exe + tsx）：
  - `packages/admin/tests/app-config.test.ts` 16 项全过（含新增 providerModels 2 例：缺省空/非数组剔除、按键合并/null 删除/未提供保留/落盘回读）
  - `tests/unified-server.test.ts` 70 项全过（含新增 3 例：GET providers 内置 enabledModelIds 默认空；PUT :id/models 内置写子集+GET 回读+落盘+清空；自定义更新 modelIds/未知 404/非数组 400）
  - `tests/frontend-demo.test.ts` + `tests/frontend-api-client.test.ts` 44 项全过；provider-catalog/provider-models/llm-config 28 项全过
- [x] AV-004 在线服务实测（7422，新代码）：
  - GET providers 内置厂商带 `enabledModelIds: []` 与 `hasKey` ✔
  - PUT `/api/admin/llm/providers/deepseek/models` `{modelIds:["deepseek-chat"]}` → 200，GET 回读 enabledModelIds 生效 ✔
  - 复置空 → 200 ✔（验收环境已恢复默认空）

## 待 browser_use/用户逐项实操清单

### 默认空态（核心诉求）

- [ ] TC-001 模型配置首屏：可用模型卡片为空态提示「暂无可用模型，点击右上角「增加配置」添加」，无任何内置模型倒出
  - 实际：
  - 结果：
- [ ] TC-002 厂商管理首屏：「已配置厂商」为空态（未配置的内置厂商一律不展示）
  - 实际：
  - 结果：

### 增加配置弹窗流程（核心诉求）

- [ ] TC-003 弹窗 → 选内置厂商：模型区立即出现静态列表（自动匹配），均未勾选；hint 显示「内置静态模型 N 个，勾选启用」
  - 实际：
  - 结果：
- [ ] TC-004 填 API Key 自动拉取（自定义）：新建自定义厂商填齐 ID/名称/BaseURL 后输入 Key，停顿约 1s 自动打 /models 拉取（无需点检测）；失败只在 hint 提示不打断输入
  - 实际：
  - 结果：
- [ ] TC-005 勾选启用 + 全选/清空：勾选 2 个模型保存 → toast「已保存，启用 2 个模型」→ 可用列表只出现这 2 个标签；厂商管理面板出现该厂商卡片
  - 实际：
  - 结果：
- [ ] TC-006 再次打开同一厂商配置：已启用模型处于预勾状态，可增删勾选后保存
  - 实际：
  - 结果：

### 可用列表移除与 slot 配置

- [ ] TC-007 可用模型移除（第三轮改：模型配置页标签无 ×）：打开「配置厂商」弹窗取消勾选某模型 → 保存 → 可用列表标签消失、slot 下拉不再显示；已引用 slot 保留下拉占位
  - 实际：
  - 结果：
- [ ] TC-008 slot「模型」下拉按厂商分组只含启用模型；自定义 → 保存 → 徽章「slot 已配」；清除非默认 slot 恢复跟随默认
  - 实际：
  - 结果：

### 回归

- [ ] TC-009 厂商管理「测试连通」只提示成败与端点模型数，不改动已启用列表
  - 实际：
  - 结果：
- [ ] TC-010 密钥管理面板已移除（第五轮）：左侧导航无「密钥管理」项；密钥在「增加配置/配置厂商」弹窗中按厂商管理；模型配置表「密钥状态」列随弹窗内密钥保存变化
  - 实际：
  - 结果：
- [ ] TC-011 窄屏 <960px：slot 表 2 列堆叠无横向溢出；弹窗内勾选区可滚动
  - 实际：
  - 结果：
- [ ] TC-012 厂商软移除与配回（第四轮核心）：厂商管理点「移除」→ 确认 → 卡片消失、可用模型同步清空；再点「增加配置」→ 厂商下拉仍能选中该厂商（内置/软移除的自定义均在）→ 重填密钥勾选模型 → 保存后卡片回归
  - 实际：
  - 结果：

## 缺陷登记

| ID | 严重级 | 描述 | 状态 |
|----|--------|------|------|
| —  | —      | 自动化验证阶段未发现缺陷；浏览器实操待执行 | 待下轮 |

## 第三轮返工（2026-08-06 用户验收反馈）

- 变更点：
  1. **可用模型卡片纯展示**：移除标签上的 ×（移除口径统一为「增加配置」弹窗内取消勾选 → 保存）；删除 settingsRemoveAvailableModel/settingsConfirmRemoveAvailableModel 及 .set-avail-remove 样式
  2. **slot 下拉直接可选**：去掉「自定义」中间态——下拉常可编辑，每行直接「保存」（非默认且已配行附「清除」）；删除 settingsIsCustomizing/settingsCustomizeSlot/setCustomizing 状态
  3. **厂商表单弹窗布局优化**：弹窗加宽至 640px（.modal:has 作用域）；表单纵向间距统一 14px；内置厂商连接信息区改为提示条（.set-form-hint）；「检测模型/全选/清空」收进「启用模型」标题行；检测结果提示并入字段 hint
- 受影响文件：`frontend-demo/views/settings.js`、`frontend-demo/styles/views.css`、`frontend-demo/index.html`（缓存版本 20260806-b）
- 验证：`node --check` 通过；vm 冒烟新断言（标签无 ×/下拉无 disabled/无自定义按钮/默认行无清除/已配非默认行有清除/内置提示条/勾选预勾）全过；frontend-demo+api-client 单测 44 项全过；7422 在线确认新代码生效、旧函数 0 引用

## 第四轮返工（2026-08-06 用户验收反馈）

- 变更点：
  1. **厂商软移除（内置/自定义统一）**：厂商管理卡片的「删除」（仅自定义）改为「移除」（全部厂商）——清除启用模型（saveLlmProviderModels 置空）+ 清除密钥（deleteLlmKey，仅在有密钥时），厂商从列表消失
  2. **可再配置回来，不真删**：内置厂商为 pi-ai 静态表不可删；自定义厂商记录保留在 app-config，两者都仍在「增加配置」弹窗的厂商下拉中可选回。deleteLlmProvider 后端路由保留但 UI 不再调用
  3. **已配置过滤口径统一**：`enabledModelIds.length > 0 || hasKey`（内置/自定义一致；空壳自定义=已软移除态，不展示）
  4. **api-mock 对齐**：新增 mockBuiltinKeys 追踪内置密钥；setLlmKey/deleteLlmKey 同步内置与自定义 hasKey
- 受影响文件：`frontend-demo/views/settings.js`、`frontend-demo/api-mock.js`、`frontend-demo/index.html`（缓存版本 settings 20260806-c / api-mock 20260806-c）
- 验证：vm 冒烟新断言（过滤口径/内置行有移除无删除/软移除调用序列不含 deleteLlmProvider/无密钥时跳过 deleteLlmKey/已移除厂商仍在弹窗下拉可配回）全过；单测 44 项全过；7422 在线确认新代码生效

## 第五轮返工（2026-08-06 用户验收反馈）

- 变更点：**移除「密钥管理」面板**——密钥已统一在厂商配置弹窗中管理（每个厂商一条 API Key），独立面板冗余
  - 删除 SETTINGS_PANELS keys 项与 settingsPanelHtml 'keys' 分支（未知面板回退 models）
  - 删除死代码：settingsPanelKeys/settingsKeyItemHtml/settingsToggleKeyInput/settingsToggleKeyVisible/settingsSaveKey/settingsDeleteKey/settingsConfirmDeleteKey/settingsDeriveKeys/settingsMaskKey，及随之无引用的 settingsProviderOptions/settingsFirstProviderId/settingsSlotModelOptions
  - 删除死 CSS：.set-key-list/.set-key-item/.set-key-info/.set-key-name/.set-key-value（保留 .set-key-status*/.set-key-actions——slot 行与厂商卡片仍在用）
  - settingsLoad 移除 setKeys 派生初始化
- 受影响文件：`frontend-demo/views/settings.js`、`frontend-demo/styles/views.css`、`frontend-demo/index.html`（缓存版本 20260806-d）
- 验证：vm 冒烟新断言（导航无密钥管理/keys 面板回退 models/8 个死函数清除/6 个主流程函数健在）全过；单测 44 项全过；7422 在线确认

## 第六轮返工（2026-08-06 用户验收反馈）

- 变更点：**移除模型配置页的「增加配置」按钮**——入口统一收敛到「厂商管理」面板，模型配置页只读展示可用模型 + slot 下拉配置；删除死别名 settingsOpenAddModelModal；空态与下拉空值提示改为引导至「厂商管理」
- 受影响文件：`frontend-demo/views/settings.js`、`frontend-demo/index.html`（缓存版本 settings 20260806-e）
- 验证：vm 冒烟（模型页无按钮无页头/空态指向厂商管理/别名已删/厂商管理保留按钮）全过

## 第七轮：前后端联调（2026-08-06「看不到 LLM 回复」排查）

- 现象：配置好厂商/密钥/模型后发消息，气泡空白无任何提示
- 排查链路与根因（3 个独立 bug 叠加）：
  1. **DeepSeek 402 Insufficient Balance**：会话 jsonl 中 assistant 消息 `stopReason:"error", errorMessage:"402 Insufficient Balance"`，但 `getSessionMessages` 不映射 error 字段 → 历史回拉后空气泡（用户账号余额问题，非代码 bug，但错误必须可见）
  2. **模型静默兜底**：`LlmConfigStore.getApiKey` 内置厂商不查 AuthStorage（auth.json），只查配置/env → 用户在 UI 配的 opencode-go 密钥运行时取不到 → `resolveModelConfig` 静默返回 {} → 会话用 pi-agent 默认模型 deepseek/deepseek-v4-pro 发请求（界面显示已配置 opencode-go，实际不是）
  3. **createSession 500**：pi SDK `newSession` 懒落盘（首条消息才写 jsonl），`findSessionInfo` 扫盘找不到 → POST /sessions 报「新建会话未出现在列表中」
- 修复：
  - `src/app/chat-context.ts`：HistoricalChatMessage 增加 error 字段并映射 stopReason/errorMessage；listSessions 合并池中未落盘新会话；getSessionMessages 对未落盘会话返回空
  - `src/orchestrator/llm-config.ts`：getApiKey 内置厂商密钥链改为 配置 → AuthStorage(apiKeyResolver) → NE_LLM_API_KEY → 标准 env
  - `frontend-demo/views/studio.js`：stMessageHtml/stLiveMessageHtml 渲染 .st-msg-error 错误气泡（历史+实时同口径）；`frontend-demo/styles/views.css` 新增 .st-msg-error
  - 测试：tests/llm-config.test.ts 新增内置厂商 AuthStorage 密钥链用例（19 项全过）
- 联调验证（7422，--embed）：
  - POST /sessions 新建成功（修复前 500）✔
  - 新会话发消息 → assistant `provider=opencode-go model=deepseek-v4-flash text="收到"`（11380 in / 2 out tokens，真实回复）✔
  - 旧会话历史消息 API 返回 `"error":"402 Insufficient Balance"`（错误透出生效）✔

## 第八轮：主会话中断（abort，2026-08-06）

- 需求：主会话一生成就停不下来，需要中断能力
- 修复：
  - `src/app/chat-context.ts`：abortChat(sessionId?)——缺省中断活跃会话、可指定后台会话；非 streaming 幂等返回 aborted=false；状态收敛复用 prompt promise 链
  - `src/app/routes-chat.ts`：POST /api/chat/abort（body 可带 sessionId）
  - `frontend-demo/api-client.js`/`api-mock.js`：abortChat
  - `frontend-demo/views/studio.js`：busy 时发送按钮变红色停止按钮（stAbortChat），输入提示同步；busy 复位由 SSE agent_end 驱动
  - `frontend-demo/styles/views.css`：.st-stop-btn
- 测试：tests/chat-routes.test.ts 新增 3 例（路由 200/sessionId 透传/无项目 409/未知会话 404 + ChatContext.abortChat 行为：streaming 中断、非 streaming 幂等、未知会话抛错）34 项全过
- 实机验证（7422）：长文生成中 POST /abort → {aborted:true}，3s 内 streaming=false；消息截断于 477 字，历史错误字段显示「Request was aborted」（第七轮错误透出同时让中断原因可见）

## 汇总

- 自动化验证 4/4 通过（语法 / vm 冒烟 / 单测 158 项 / 在线新端点实测）
- 浏览器交互项 11 项待执行（本环境无 browser_use 工具）
- 设计说明：内置厂商模型全集为 pi-ai 静态表（只读），「启用子集」持久化于 app-config `llm.providerModels`；自定义厂商启用列表即其 `modelIds`；slot 保存校验不受影响（内置走 pi-ai 表、自定义走启用列表）
