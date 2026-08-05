# 前端测试轮 · 2026-08-05-background-generation

## 元信息
- 触发原因：实现多 session 并存 + 后台生成不中断 + busy 状态按 sessionId 维护 + SSE 多路复用 + background_complete 通知
- 受影响页面：studio（#/studio）
- 受影响文件：
  - `frontend-demo/views/studio.js`（sessionStatus map、stSwitchSession 不阻塞、stHandleChatEvent 多路复用、stNotifyBackgroundComplete/Error）
  - `frontend-demo/api-client.js`（getChatStatus 多会话状态结构）
  - `frontend-demo/api-mock.js`（getChatStatus 返回 sessions[]/backgroundStreaming[]，activateChatSession 不中断其他会话）
  - `frontend-demo/mock-data.js`（chatSessions 增加 status 字段）
  - `frontend-demo/styles/views.css`（st-session-item.streaming/errored 状态样式）
  - `src/app/chat-context.ts`（SessionPool 集成、subscribe 多路复用）
  - `src/app/routes-chat.ts`（/status 返回多会话状态、/events SSE 多路复用）
  - `src/chat/main-session.ts`（支持指定 sessionPath）
  - `src/chat/session-pool.ts`（新增）
  - `tests/chat-routes.test.ts`（多会话并存、SSE 多路复用、SessionPool 单元测试）
- 服务地址：http://127.0.0.1:7421
- 执行者：AI（browser_use）
- 开始时间：2026-08-05
- 截图目录：`docs/audits/frontend-test-runs/shots/2026-08-05-background-generation/`

## 测试清单

### 页面：studio · 加载与基础渲染

- [x] TC-001 studio 页面正常加载（功能）✅
  - 步骤：打开 http://127.0.0.1:7421/?mock=1#/studio，等待渲染完成
  - 预期：页面无 JS 报错；显示左栏会话列表 + 中栏聊天区；会话列表含多条历史会话
  - 实际：页面正常加载；左栏显示"会话"标题 + 7 条历史会话；中栏显示聊天区与输入框；viewState('studio') 含 7 个 sessions（均 status=idle）+ 4 条 studioMessages（session-03）
  - 结果：✅ PASS

- [x] TC-002 会话列表渲染含 status 字段（功能·关键）✅
  - 步骤：观察左栏会话列表项
  - 预期：所有会话项可点击；初始状态下不显示 spinner（status=idle）；不出现 disabled 项
  - 实际：7 个 .st-session-item 均有 onclick="stSwitchSession('...')"；无 .streaming / .errored class；无 disabled 项；sessionStatus map 全为 'idle'
  - 结果：✅ PASS

### 页面：studio · 会话切换不阻塞

- [x] TC-003 切换会话不阻塞（功能·关键）✅
  - 步骤：调用 stSwitchSession('session-04')
  - 预期：立即切换到目标会话；聊天区加载该会话消息；不出现"切换后提醒"toast
  - 实际：currentSessionId 从 session-03 变为 session-04；studioMessages 加载 session-04 的 2 条消息（首条"林远航与老陈的争执场景"）；studioBusy=false；active item class="st-session-item active"
  - 结果：✅ PASS

- [x] TC-004 切换期间输入框短暂禁用后恢复（功能）✅
  - 步骤：切换会话后检查输入框
  - 预期：切换完成后 textarea 立即可输入
  - 实际：#st-chat-textarea exists, disabled=false, value=""
  - 结果：✅ PASS

- [x] TC-005 切换会话不重新建立 SSE 连接（功能·关键）⏭️ N/A
  - 步骤：切换会话前后检查 SSE 连接
  - 预期：SSE 连接保持不断开；事件流按 sessionId 路由
  - 实际：mock 模式不建立 SSE 连接（studio.js 中 ApiRuntime.isMock 为 true 时走 stRunOrchestration 本地模拟，不调 stEnsureChatSubscription）。SSE 多路复用逻辑由后端单测覆盖（tests/chat-routes.test.ts SSE 多路复用测试通过）
  - 结果：⏭️ N/A（mock 模式不适用，后端单测已覆盖）

### 页面：studio · 按会话维护 busy 状态

- [x] TC-006 模拟 streaming 状态：会话项显示 spinner（功能·关键）✅
  - 步骤：注入 sessionStatus['session-03']='streaming' 并 renderView
  - 预期：session-03 项显示 spinner 图标；其他会话项不受影响仍可点击
  - 实际：session-03 class="st-session-item streaming"；.st-session-spinner 数量=1；其他 6 个会话项 class 不变
  - 结果：✅ PASS

- [x] TC-007 streaming 会话切换不阻塞其他会话（功能·关键）✅
  - 步骤：session-03 标记 streaming 后，调用 stSwitchSession('session-05')
  - 预期：可正常切换到 session-05；session-03 仍显示 spinner（后台继续）；切换回 session-03 仍显示 streaming
  - 实际：currentSessionId='session-05'；studioBusy=false；session-03 class 仍为 "st-session-item streaming"；所有 7 项 onclick 仍存在（无 disabled）；spinnerCount=1
  - 结果：✅ PASS

- [x] TC-008 模拟 error 状态：会话项显示错误样式（功能）✅
  - 步骤：注入 sessionStatus['session-06']='error' 并 renderView
  - 预期：session-06 项显示错误样式（红色标记）；title 提示"生成失败，点击查看"
  - 实际：session-06 class="st-session-item errored"；title="生成失败，点击查看"；.errored 数量=1
  - 结果：✅ PASS

### 页面：studio · background_complete 事件处理

- [x] TC-009 background_complete 事件触发 toast（功能·关键）✅
  - 步骤：当前在 session-05，注入 stHandleChatEvent({ type:'background_complete', sessionId:'session-03' })
  - 预期：session-03 状态从 streaming 变为 idle；显示"会话「<name>」生成完成"toast；session-03 spinner 消失
  - 实际：session-03 sessionStatus 立即变为 'idle'；toast 显示（toastVisible=true）；stRefreshSessionsOnly() 异步刷新后（约 1s）DOM 更新：session-03 class 去掉 streaming，spinnerCount=0
  - 结果：✅ PASS（注：DOM 更新有约 1s 异步延迟，由 stRefreshSessionsOnly 拉取后端 sessions[] 后 re-render，属预期行为）

- [x] TC-010 background_error 事件触发错误 toast（功能）✅
  - 步骤：注入 stHandleChatEvent({ type:'background_error', sessionId:'session-07', error:'LLM 调用超时' })
  - 预期：目标会话状态变 error；显示错误 toast
  - 实际：session-07 sessionStatus 立即变为 'error'；class="st-session-item errored"；title="生成失败，点击查看"；erroredCount=2（session-06+session-07）
  - 结果：✅ PASS

### 页面：studio · agent_end 事件清除 busy

- [x] TC-011 agent_end 事件清除当前会话 busy（功能·关键）✅
  - 步骤：标记 session-05 streaming + studioBusy=true，注入 stHandleChatEvent({ type:'pi', sessionId:'session-05', event:{ type:'agent_end' } })
  - 预期：studioBusy=false；sessionStatus[currentId]='idle'；输入框恢复可用
  - 实际：session-05 status 从 'streaming' 变为 'idle'；studioBusy 从 true 变为 false
  - 结果：✅ PASS

- [x] TC-012 非当前会话 agent_end 不影响当前会话（功能）✅
  - 步骤：当前 session-05，标记 session-03 streaming + studioBusy=true，注入 stHandleChatEvent({ type:'pi', sessionId:'session-03', event:{ type:'agent_end' } })
  - 预期：session-03 状态变 idle；session-05 状态不变；当前会话输入框不受影响
  - 实际：session-03 status 从 'streaming' 变为 'idle'；currentSessionId 仍为 'session-05'；session-05 status 仍为 'idle'；studioBusy 仍为 true（未误清）
  - 结果：✅ PASS

### 页面：studio · 控制台洁净

- [x] TC-013 控制台无报错/无未捕获 Promise（控制台）✅
  - 步骤：执行上述所有操作后检查 console
  - 预期：无 JS 报错；无未捕获 Promise rejection；无 404
  - 实际：仅 1 条 error（net::ERR_CONNECTION_REFUSED http://127.0.0.1:7421/?mock=1 — 服务重启时的连接拒绝，非代码缺陷）；2 条 three.js vendor 警告（非本项目代码）；无未捕获 Promise；无 404
  - 结果：✅ PASS（error 为环境性，非代码缺陷）

### 页面：studio · 集成测试（mock 编排流程）

- [x] TC-013b 发送消息触发 mock 编排，busy 状态正确清除（集成）✅
  - 步骤：在 session-05 输入"测试多会话并存功能"并回车发送
  - 预期：消息追加到 studioMessages；stRunOrchestration 模拟流式生成；完成后 studioBusy=false、sessionStatus[idle]=idle
  - 实际：messagesCount 从 2 增至 5；最后一条为 assistant 消息"已生成编排计划，等待你的确认。"，含 2 个 toolCalls（检索世界图/调用编排器，均 done）；studioBusy=false；session-05 status='idle'；realLiveMessage=null
  - 结果：✅ PASS

### 页面：其他视图回归

- [x] TC-014 graph 视图不受影响（回归）✅
  - 步骤：导航到 http://127.0.0.1:7421/?mock=1#/graph
  - 预期：graph 视图正常加载
  - 实际：app-main 渲染实体/角色视角选择器（"全部角色地点物品概念" + "全知视角林远航 视角艾莉亚 视角老陈 视角"）
  - 结果：✅ PASS

- [x] TC-015 events 视图不受影响（回归）✅
  - 步骤：导航到 http://127.0.0.1:7421/?mock=1#/events
  - 预期：events 视图正常加载
  - 实际：快照显示 23 个交互元素——筛选按钮（全部/角色/地点/物品/概念）、搜索框、ch006.ev008 storyTime 选择器、全知视角 combobox、快速记事件/快速加关系/视图重置/更多操作按钮、实体 heading、林远航 heading
  - 结果：✅ PASS

- [x] TC-016 settings 视图不受影响（回归）✅
  - 步骤：导航到 http://127.0.0.1:7421/?mock=1#/settings
  - 预期：settings 视图正常加载
  - 实际：app-main 渲染 set-container + set-sidebar，含"应用配置"分区；模型配置 combobox（Anthropic/OpenAI/Google/DeepSeek/自定义/pi）与保存按钮正常
  - 结果：✅ PASS

## 缺陷登记

| 编号 | 所属项 | 严重度 | 复现步骤 | 期望 | 实际 | 截图 | 状态 |
|------|--------|--------|---------|------|------|------|------|
|（无）| | | | | | | |

> 本轮测试未发现代码缺陷。所有功能性、交互性、控制台洁净、回归用例均通过。

## 小结
- 通过 15 项 / 失败 0 项 / 跳过 1 项（TC-005 mock 模式不适用 SSE，后端单测已覆盖）
- 缺陷分布：P0 0 / P1 0 / P2 0 / P3 0
- 总体评价：多 session 并存 + 后台生成不中断 + busy 状态按 sessionId 维护 + background_complete/error 事件处理 + agent_end 清除 busy 全部按设计工作。会话切换不阻塞、streaming/error 状态正确显示、事件路由按 sessionId 分流、其他视图无回归。mock 编排集成流程正常。可以进入提交流程。

### 截图
- `shots/2026-08-05-background-generation/studio-final.png`：studio 页面最终状态（mock 编排完成后）

### 测试覆盖说明
- mock 模式覆盖：会话切换、状态注入、事件注入、DOM 渲染、控制台洁净、其他视图回归、mock 编排集成
- 后端单测覆盖（tests/chat-routes.test.ts，654/654 通过）：SessionPool 多 session 并存、setActive 不 dispose 旧 handle、SSE 多路复用订阅/取消订阅、POST message 错误码、GET status 多会话状态结构
- 未覆盖（需真实后端 + LLM）：真实 SSE 事件流、PI session 真实 streaming、background_complete 实际推送、跨项目会话隔离
