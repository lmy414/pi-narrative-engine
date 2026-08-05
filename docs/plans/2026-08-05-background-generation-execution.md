# 执行文档 · 2026-08-05 后台生成与 busy 状态修复

## 1. 背景

### 1.1 问题 1：streaming 中切换会话硬中断生成

**用户期望**：streaming 中切换会话不中断生成，后台继续，完成后弹窗通知，切回可看结果。

**当前实现**：
- 后端 `chat-context.ts:349-351` activateSession：streaming 时 throw CHAT_BUSY
- 前端 `studio.js:322-327` stSwitchSession：stIsStreamingBusy() 时 toast 提醒后 return
- 会话项 `studio.js:195-197`：busy 时 aria-disabled + 无 onclick

**技术约束**（已查档求证）：
- PI 本体 `agent-session-runtime.ts:187-209` switchSession 内部调 `teardownCurrent` → `session.dispose()`
- `agent-session.ts:714-728` dispose() 调 `this.agent.abort()` **硬中断生成**
- 无法避免——要让生成后台继续，**不能调 PI 的 switchSession**

### 1.2 问题 2：生成完成后会话项持续 disabled

**根因**（已查档求证）：

PI 本体 `agent.ts:462-494` isStreaming 清除时机：
```
agent.prompt() → run() → isStreaming=true → executor(agent循环)
  ↓ agent循环结束 → 发出 agent_end 事件 ← 前端收到，清除 studioBusy
  ↓ _runAgentPrompt 进入 while 循环调 _handlePostAgentRun (agent-session.ts:936)
  ↓   ├─ 检查重试（_prepareRetry）
  ↓   ├─ 检查 compaction（_checkCompaction）
  ↓   └─ 检查 queued messages
  ↓ _runAgentPrompt 结束 → finally → finishRun() → isStreaming=false
```

`agent_end` 事件发出时 `isStreaming` 仍为 true，直到后置循环结束才变 false。

前端 `studio.js:348-351` stIsStreamingBusy = studioBusy || chatStreaming：
- `agent_end` 清除 studioBusy（及时）
- chatStreaming 依赖轮询 `/api/chat/status` 的 isStreaming，2s 间隔
- **两者清除时机不同步** → 会话项在 agent_end 后仍 disabled（后置处理时间 + 最多 2s 轮询延迟）
- 若有 compaction 或重试，延迟可达数十秒

## 2. 调研结论（成熟项目实现方式）

### 2.1 主流模式

| 模式 | 代表 | 行为 | 适用性 |
|---|---|---|---|
| A 任务与 UI 解耦 | open-webui | 服务端任务注册表，SSE 断开不取消任务，结果落库 | **本项目最值得借鉴** |
| B 客户端断开即 abort | LibreChat | res.on('close') → abortController.abort() | 当前本项目同类（dispose=abort） |
| C Extension Host 托管 | Cline | 任务跑在 host 进程，面板隐藏不影响 | IDE 插件场景，不适用 |
| D 拒绝切换 | — | 未在主流产品中发现 | 不可取 |

### 2.2 借鉴 open-webui tasks.py

```python
tasks: Dict[str, asyncio.Task] = {}      # 全局任务池
chat_tasks = {}                          # 按 chat_id 分组
def create_task(coroutine, id=None):
    task_id = str(uuid4())
    task = asyncio.create_task(coroutine)
    task.add_done_callback(lambda t: cleanup_task(task_id, id))
    tasks[task_id] = task
    ...
```

关键设计：
- 生成是 asyncio.Task，注册在服务端全局 dict，**生命周期独立于 SSE 连接**
- stop_task 是显式取消接口（用户点"停止"才调），客户端断开不自动触发
- 结果写库与 SSE 推送解耦

### 2.3 open-webui 已知局限（issue #452）

- streaming 中切走丢失实时增量，切回只能看已完成快照
- PR #22146 用竞态守卫 `if (chatId !== targetChatId) return;` 防错写

## 3. PI SDK 多 runtime 可行性（已查档求证）

- `agent-session-runtime.ts:393-411` createAgentSessionRuntime：纯工厂，无单例限制
- `agent-session-services.ts:131-145` createAgentSessionServices：纯工厂，每次新建独立 services
- 每个 runtime 有独立 services/session/agent 状态/event listeners
- **结论：支持多 runtime 并存**，可同时持有多个 session

资源开销：
- 每个 services 实例 new DefaultResourceLoader + reload()（加载扩展/资源）
- LLM 调用是否串行化取决于 provider 实现，非 SDK 限制

## 4. 设计方案

### 4.1 核心思路

参考 open-webui 模式 A，把"生成任务"与"host/session 生命周期"解耦：
- MainSessionHost 改造为**多 session 并存**，不调 PI switchSession
- 切换会话 = 切换"当前活跃 handle"指针，不 dispose 旧 handle
- 旧 handle 的生成继续在后台跑（PI session 不 abort）

### 4.2 后端改造

#### 4.2.1 SessionPool（新增）

位置：`src/chat/session-pool.ts`

```typescript
interface SessionHandle {
  id: string;                    // sessionId
  runtime: AgentSessionRuntime;  // PI runtime（独立存活）
  services: AgentSessionServices;
  host: MainSessionHost;         // 单 session 宿主
  status: 'idle' | 'streaming' | 'error';
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

class SessionPool {
  private handles = new Map<string, SessionHandle>();
  private activeId: string | null = null;

  async acquire(opts): Promise<SessionHandle>;      // 创建或复用
  async switchActive(id: string): Promise<void>;    // 切换活跃指针（不 dispose 旧）
  getActive(): SessionHandle | null;
  get(id: string): SessionHandle | null;
  getAll(): SessionHandle[];
  async release(id: string): Promise<void>;         // 显式释放（用户删除会话）
  async releaseAll(): Promise<void>;
}
```

关键：switchActive **不调 PI switchSession**，只改 activeId 指针。旧 handle 保持存活，生成继续。

#### 4.2.2 MainSessionHost 改造

- 保留单 session 的 start/dispose/prompt/subscribe 能力
- 移除 switchSession/newSession（改由 SessionPool 管理多 session）
- ChatContext 改为持有 SessionPool 而非单一 host

#### 4.2.3 ChatContext 改造

```typescript
class ChatContext {
  private pool: SessionPool;

  async activateSession(id: string): Promise<SessionInfo> {
    // 不再 throw CHAT_BUSY——直接切换活跃指针
    await this.pool.switchActive(id);
    return this.findSessionInfo(id);
  }

  async sendChatMessage(text: string): Promise<void> {
    const handle = this.pool.getActive();
    // 发送到当前活跃 session，后台生成
  }

  getSessionStatus(): { 
    active: SessionHandle | null;
    backgroundStreaming: SessionHandle[];  // 后台生成中的会话
  };
}
```

#### 4.2.4 状态持久化

SessionHandle.status 在生成开始/结束时更新：
- prompt 前设 streaming
- agent_end 后置处理完成后设 idle（不是 agent_end 时立即设，避免问题 2 根因重现）
- 错误时设 error + lastError

#### 4.2.5 完成通知

两种机制（择一或并存）：
- **SSE 推送**：active session 的事件流照常；后台 session 完成时向所有 SSE 客户端广播 `background_complete` 事件
- **轮询**：前端轮询 `/api/chat/sessions` 返回每个会话的 status 字段，会话列表标记 spinner

### 4.3 前端改造

#### 4.3.1 busy 状态按 sessionId 维护

```javascript
// 替换单一 studioBusy/chatStreaming
stState('sessionStatus', {
  [sessionId]: 'idle' | 'streaming' | 'error',
  ...
});
```

- stIsStreamingBusy(sessionId) 检查指定会话状态
- 会话列表项按各自状态显示 spinner/disabled

#### 4.3.2 切换会话不阻塞

```javascript
async function stSwitchSession(id) {
  // 不再检查 stIsStreamingBusy——直接切换
  setStState('currentSessionId', id);
  // 订阅切换到新 session 的 SSE
  // 旧 session 若在生成，后台继续
}
```

#### 4.3.3 后台完成通知

- 监听 `background_complete` SSE 事件，toast 通知"会话 X 已完成生成"
- 会话列表项状态从 streaming 变 idle 时，更新 spinner

#### 4.3.4 问题 2 顺带解决

- busy 状态按 sessionId 维护，不再单一全局 flag
- agent_end 不再是清除 busy 的唯一时机——后端 status 字段更新后前端轮询/SSE 获取
- 避免清除时机不同步问题

## 5. 任务分解

### 阶段 1：后端 SessionPool + ChatContext 改造
- T1: 新增 SessionPool（session-pool.ts）
- T2: MainSessionHost 移除 switchSession/newSession，保留单 session 能力
- T3: ChatContext 改为持有 SessionPool，activateSession 不再 throw CHAT_BUSY
- T4: SessionHandle.status 在 prompt/agent_end 后置完成时更新
- T5: routes-chat.ts /status 返回所有 session 状态（非仅 active）
- T6: SSE 广播 background_complete 事件

### 阶段 2：前端 busy 状态按 sessionId 维护
- T7: studio.js 状态结构改为 sessionStatus map
- T8: stIsStreamingBusy(sessionId) 改为按会话检查
- T9: 会话列表项各自显示 spinner/disabled
- T10: stSwitchSession 不再阻塞，直接切换
- T11: 监听 background_complete，toast 通知

### 阶段 3：测试与验证
- T12: 后端单元测试（SessionPool 多 session 并存、切换不 dispose、后台完成状态更新）
- T13: 前端测试轮（会话切换不阻塞、后台完成通知、busy 状态正确清除）
- T14: 落地文档

## 6. 风险与存疑（已查证）

### 6.1 资源开销（已查证）
- `resource-loader.ts:321-400` DefaultResourceLoader.reload() = settingsManager.reload + packageManager.resolve + loadExtensions，文件 IO 为主
- `agent-session-services.ts:139-145` 创建 loader 时用 `resourceLoaderOptions ?? {}`，main-session.ts 未传，走默认（noExtensions=false）
- 每个 services 实例持有独立对象（authStorage/settingsManager/modelRegistry/resourceLoader/eventBus），KB-MB 级
- **结论**：多 session 并存开销可控，10 个 session MB 级
- **优化**：SessionPool 创建 services 时传 `resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }`（本项目用 customTools 注入，不依赖扩展系统），减少 reload 开销
- **池上限**：建议 LRU 策略，上限 10，超出时 dispose 最久未访问的 idle session（streaming 中的不回收）

### 6.2 LLM 调用并发（已查证）
- `ai/src/stream.ts:34-41` complete() 是纯函数，调 stream() 返回 result()
- **无内部锁/mutex/queue**，多 session 并发调用不串行化
- **结论**：多 session 同时 streaming 技术可行，并发上限由 provider 速率限制决定（非 SDK 限制）

### 6.3 SSE 架构设计（基于查证结果）

**选定方案：单一通道多路复用**

- 前端维持**一个 SSE 连接** `/api/chat/events`，不断开
- 后端 ChatContext 维护订阅者列表，所有 session 的事件都经此通道推送
- 事件 payload 增加 `sessionId` 字段路由：`{ type: 'message_update', sessionId: 'xxx', message: {...} }`
- 前端按 `currentSessionId` 过滤：当前会话事件实时渲染，其他会话事件只更新状态标记
- 后台 session 完成时广播 `background_complete` 事件：`{ type: 'background_complete', sessionId: 'xxx' }`

**实现要点**：
- 后端：ChatContext 持有 SessionPool，订阅所有 session 的事件，统一经 chatEvents 广播
- 前端：stHandleChatEvent 按 sessionId 分流——当前会话照常渲染，其他会话只更新 sessionStatus map
- 切换会话：不改 SSE 订阅，只改 `currentSessionId`，事件流自动路由到新会话

**优势**：
- 切换会话无 SSE 重连开销
- 后台 session 事件实时推送（不需要轮询）
- 单一连接简化资源管理

### 6.4 历史会话恢复（已查证）
- `session-manager.ts` 只持久化消息/compaction/branch summary 等 entry，**无 isStreaming 字段**
- 重启后 session 恢复 idle 状态，未完成生成不续传
- **结论**：后台生成仅限当前进程生命周期，重启后丢失（与 ChatGPT 行为一致，可接受）

### 6.5 与派发移除分支的合并顺序
- 当前 20260805-remove-dispatch 分支未合并
- 本方案改动范围（studio.js/chat-context.ts/main-session.ts）与派发移除有重叠
- **决策**：先合并派发移除分支，再基于 master 开新分支 `20260805-background-generation`

## 7. 验收标准

- [ ] streaming 中切换会话不中断生成（旧会话后台继续）
- [ ] 后台生成完成后 toast 通知"会话 X 已完成"
- [ ] 切回原会话能看到完整生成结果
- [ ] 生成完成后会话项立即恢复可点击（无 2s+ 延迟）
- [ ] 多 session 并存无资源泄漏（长期运行内存稳定）
- [ ] 单元测试全过
- [ ] 前端测试轮 PASS

## 8. 落地文档

完成后写到 `docs/plans/2026-08-05-background-generation-landing.md`，包含：
- 实际实现与设计差异
- 遇到的问题与解决
- 资源开销实测数据
- 后续优化方向
