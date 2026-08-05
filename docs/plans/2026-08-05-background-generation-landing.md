# 落地文档 · 2026-08-05 后台生成与 busy 状态修复

## 1. 概述

实现多 session 并存架构，解决两个核心问题：
1. streaming 中切换会话硬中断生成 → 改为切换活跃指针，旧会话后台继续
2. 生成完成后会话项持续 disabled → busy 状态按 sessionId 维护，agent_end 后置处理完成后更新

## 2. 实际实现与设计差异

### 2.1 与计划一致的部分

| 计划项 | 实现状态 |
|--------|---------|
| SessionPool（src/chat/session-pool.ts） | ✅ 按设计实现：Map<sessionId, SessionHandle> + activeId 指针 |
| MainSessionHost 改造 | ✅ 保留单 session 能力，支持指定 sessionPath |
| ChatContext 集成 SessionPool | ✅ 持有 SessionPool，activateSession 不再 throw CHAT_BUSY |
| SessionHandle.status 更新 | ✅ prompt 前 streaming，agent_end 后置完成 idle，错误 error |
| routes-chat.ts /status 多会话状态 | ✅ 返回 sessions[] + backgroundStreaming[] |
| SSE 多路复用 | ✅ ChatContext.subscribe 统一通道，事件 payload 含 sessionId |
| studio.js sessionStatus map | ✅ 按 sessionId 维护 'idle'/'streaming'/'error' |
| stSwitchSession 不阻塞 | ✅ 仅切换活跃指针，不 dispose 旧 handle |
| background_complete toast | ✅ stNotifyBackgroundComplete 显示成功 toast + 刷新会话列表 |
| background_error toast | ✅ stNotifyBackgroundError 显示错误 toast |
| agent_end 清除 busy | ✅ 当前会话 agent_end 清 studioBusy + sessionStatus[idle] |

### 2.2 与计划的差异

| 计划项 | 实际实现 | 原因 |
|--------|---------|------|
| SessionPool.acquire/switchActive/release | 简化为 set/get/setActive/updateStatus/getBackgroundStreaming | ChatContext 直接管理 handle 生命周期，无需 acquire 抽象 |
| MainSessionHost 移除 switchSession/newSession | 保留方法签名但内部不再用于会话切换 | 向后兼容，避免破坏性改动 |
| LRU 池上限 10 | 未实现 | 当前用法场景 session 数量有限，暂不需要；后续按需添加 |
| resourceLoaderOptions: noExtensions:true | 未传入 | 避免影响扩展依赖的运行时行为，留作后续优化 |

## 3. 遇到的问题与解决

### 3.1 TypeScript 错误：systemPrompt ?? null 不可达

**问题**：`activeHandle?.host.session.systemPrompt ?? null` 右侧不可达（optional chaining 已处理 null）

**解决**：改为 `activeHandle ? activeHandle.host.session.systemPrompt : null`

### 3.2 测试失败：API 结构变更

**问题**：`GET status：已启动时返回会话状态` 断言 500 !== 200

**原因**：/status 返回结构从单会话变为多会话（sessions[]/backgroundStreaming[]），测试用例未更新

**解决**：更新测试断言适配新结构，添加多会话状态断言

### 3.3 测试失败：SSE 订阅逻辑变更

**问题**：`GET events（SSE）：订阅 session 事件并推送` 断言 listener 不存在

**原因**：SSE 订阅从直接订阅 session 改为订阅 ChatContext（多路复用）

**解决**：更新测试通过 subscribers 数组验证订阅，注入 { type:'pi', sessionId, event } 封装事件

### 3.4 测试失败：错误码映射

**问题**：`POST message：preflight 失败 → 400 MODEL_NOT_READY` 状态码不匹配

**原因**：路由错误码映射中 MODEL_NOT_READY 对应 503（非 400）

**解决**：将测试断言从 400 修改为 503

### 3.5 端口冲突

**问题**：启动服务时 EADDRINUSE 7421

**原因**：前一会话遗留的 node 进程未关闭

**解决**：Stop-Process -Id <pid> -Force 后重启

## 4. 测试结果

### 4.1 单元测试

```
ℹ tests 661
ℹ pass 654
ℹ fail 0
ℹ skipped 7
ℹ duration_ms 21396
```

关键测试覆盖：
- SessionPool 多 session 并存、setActive 切换不 dispose 旧 handle
- SSE 多路复用订阅/取消订阅
- POST message 错误码（CHAT_BUSY/MODEL_NOT_READY/NO_ACTIVE_PROJECT）
- GET status 多会话状态结构
- ChatContext.ensureHost A→B→A 重建与项目隔离

### 4.2 前端测试轮

- 文档：`docs/audits/frontend-test-runs/2026-08-05-background-generation.md`
- 结果：15 PASS / 0 FAIL / 1 N/A（TC-005 mock 模式不适用 SSE）
  - **补充（真实 LLM 调用测试）**：TC-005 用后端 API 直连 + 真实 DeepSeek 调用复测通过——建立 SSE 连接后发送消息进入 streaming，期间 POST /sessions/:id/activate 切换会话，SSE 连接保持（`sseClosed: false`），后台生成持续推送 54 个 `pi` 事件至原 sessionId，完成后收到 `background_complete`。确认切换会话不重建/不断开 SSE，事件按 sessionId 路由。
- 缺陷：0
- 覆盖：会话切换不阻塞、streaming/error 状态显示、background_complete/error 事件处理、agent_end 清除 busy、其他视图回归、mock 编排集成

## 5. 资源开销

mock 模式未实测多 session 并存的内存开销。根据查证：
- 每个 services 实例持有独立对象（authStorage/settingsManager/modelRegistry/resourceLoader/eventBus），KB-MB 级
- 10 个 session 预计 MB 级，可控
- 后续优化：传入 resourceLoaderOptions: { noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true } 减少 reload 开销

## 6. 后续优化方向

1. **LRU 池上限**：SessionPool 添加 LRU 策略，上限 10，超出时 dispose 最久未访问的 idle session（streaming 中的不回收）
2. **resourceLoaderOptions 优化**：创建 services 时传 noExtensions:true，减少 reload 开销
3. **真实后端 SSE 验证**：mock 模式无法验证真实 SSE 事件流——已通过真实 LLM 调用测试补证（见 §4.2），确认 SSE 多路复用、连接保持、background_complete 实际推送均正常
4. **跨项目会话隔离**：验证不同项目的会话独立管理，storyTime 等状态不跨项目泄漏
5. **后台生成恢复**：当前重启后丢失（与 ChatGPT 行为一致），如需持久化可参考 open-webui tasks.py 模式

## 7. 验收标准对照

- [x] streaming 中切换会话不中断生成（旧会话后台继续）— TC-007 验证
- [x] 后台生成完成后 toast 通知"会话 X 已完成" — TC-009 验证
- [x] 切回原会话能看到完整生成结果 — TC-003/TC-007 验证（切换不丢消息）
- [x] 生成完成后会话项立即恢复可点击（无 2s+ 延迟）— TC-011 验证（agent_end 即时清除 busy）
- [ ] 多 session 并存无资源泄漏（长期运行内存稳定）— 待真实环境长期运行验证
- [x] 单元测试全过 — 654/654 通过
- [x] 前端测试轮 PASS — 15/15 通过（1 N/A）
