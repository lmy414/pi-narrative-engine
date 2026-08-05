# 会话管理（G2）执行文档

> 日期：2026-08-05
> 状态：📋 待用户核对（核对通过后按本计划分步执行）
> 依据：
> - `docs/plans/2026-08-04-phase2-plan.md` §G2（原计划）
> - `docs/audits/2026-08-03-production-gap-bug-inventory.md` §1.1 / §3（会话管理缺口与落地方案）
> - PI SDK 源码查证：`pi-ex/packages/coding-agent/src/core/agent-session-runtime.ts` / `session-manager.ts` / `main.ts`
> - 用户实测反馈 4 个坑点（刷新后历史不可见 / 工具调用消失 / 新建后旧消息残留 / 删除全部后历史残留）
> - 用户决策（2026-08-05）：先把最基础的单会话做完，多 host 池/桥层抽取/删除会话等推后

## 一、目标

把"假会话 404 + 每次启动碎片 + 切换只是看历史"现状改造为"真会话新建/切换 + 启动恢复最近"的最基础可用形态。

**只做单 host 单会话**，不做多 host 池/后台 streaming/删除会话/桥层抽取。

### 对齐的关键决策

| 项 | 决策 |
|---|---|
| 切换语义 | resume 写入旧会话（与 PI 本体 `--resume` / `--session` 一致） |
| 启动恢复 | host 启动时 `SessionManager.continueRecent`，有最近会话则复用，无则新建空会话 |
| 会话命名 | 新建时 `name = null`；首消息后由后端回填（SDK 已有 `firstMessage` 字段，桥层用此显示） |
| streaming 中切换 | 单 host 架构下 `runtime.switchSession` 内部 dispose 旧 session（SDK 既有行为，不可改）。**前端在 streaming 时禁用切换按钮**，提示"请等待生成完成"。最简方案 |
| 多 host 池 | **不做**，推 phase3 |
| 删除会话 | **不做**，推后续批次 |
| 桥层抽取 | **不做**，api-client.js 只新增两个方法，不重构 |
| 测试轮 | 包含 G2-4 专项测试轮 |

## 二、不做（明确范围）

- 多 host 池 / 多子进程隔离（推 phase3）
- 删除会话端点（推后续批次）
- 桥层抽取（api-client.js 只加方法不重构）
- fork 端点（`runtime.fork`）暴露
- 会话重命名端点
- 跨项目会话导入 / `parentSession` 展示
- `app-config.json` 启动恢复开关（默认恢复最近，不暴露设置项）
- streaming 中切换（禁用按钮，最简方案）

## 三、技术依据（已查证，非臆测）

### 3.1 SDK 原语签名

| 方法 | 文件 | 行号 | 签名要点 |
|---|---|---|---|
| `runtime.newSession({parentSession?, setup?, withSession?})` | `pi-ex/packages/coding-agent/src/core/agent-session-runtime.ts` | 212-244 | async → `{cancelled}`；取消走 `session_before_switch` 钩子；其他失败抛错 |
| `runtime.switchSession(sessionPath, {cwdOverride?, withSession?})` | 同上 | 187-210 | async → `{cancelled}`；`MissingSessionCwdError` 等抛错；内部走 `teardownCurrent("resume")` 销毁旧 session |
| `runtime.dispose()` | 同上 | 377-384 | 触发 `session_shutdown` reason="quit" |
| `runtime.setRebindSession(cb)` / `setBeforeSessionInvalidate(cb)` | 同上 | 111-125 | 钩子注册入口；`finishSessionReplacement` 会调 `rebindSession` |
| `SessionManager.create(cwd, sessionDir?, options?)` | `pi-ex/packages/coding-agent/src/core/session-manager.ts` | 1363-1366 | 同步；新建会话文件 |
| `SessionManager.continueRecent(cwd, sessionDir?)` | 同上 | 1390-1398 | 同步；有最近会话则 open 旧文件，无则 create 新建 |
| `SessionManager.open(path, sessionDir?, cwdOverride?)` | 同上 | 1374-1383 | 同步；复用旧文件，新消息 append |
| `SessionManager.list(cwd, sessionDir?, onProgress?)` | 同上 | 1471-1480 | async；按 modified 降序；sessionDir 与默认不同时按 cwd 过滤 |

### 3.2 PI 本体 resume 语义（已查证）

- `pi --resume` / `pi --session <id>`（命中本地）→ `SessionManager.open(path)` 复用旧文件，新消息 append 到旧 `.jsonl`（`pi-ex/packages/coding-agent/src/main.ts:318` / `:289`）
- 启动时**不走** `runtime.switchSession`（那是交互期 slash 命令路径），而是把 open 出来的 SessionManager 直接喂给 `createAgentSessionRuntime`
- `pi -c`（continue）：有最近会话则 open 旧文件，否则 create 新建——**这是 G2-3 启动恢复的参考模式**

### 3.3 narrative-engine 现状缺口（已查证）

| 缺口 | 位置 | 影响 |
|---|---|---|
| `setRebindSession` / `setBeforeSessionInvalidate` 未注入 | `src/chat/main-session.ts:92-97` | 切换后 rebind 空操作；`MainSessionHost.services` 失效 |
| `MainSessionHost.start()` 必新建会话 | `src/chat/main-session.ts:91` | 每次启动碎片，刷新后历史不可见（用户坑 1/2 根因） |
| `MainSessionHost.services` 字段切换后失效 | `src/chat/main-session.ts:58` | `applyModelConfig` 用到旧 services 实例 |
| `ChatContext` 无 `switchSession(id)` / `newSession()` 入口 | `src/app/chat-context.ts` | 路由层无法调用 |
| `routes-chat.ts` 无 POST 会话端点 | `src/app/routes-chat.ts:159-162` | 假会话 404 根因 |
| 前端 `stNewSession` 假实现 | `frontend-demo/views/studio.js:787-797` | 新建后旧消息残留（用户坑 3 根因） |
| 前端 `stSwitchSession` 只读历史 | `frontend-demo/views/studio.js:772-785` | 切换后发送仍写 live |
| `api-client.js` 缺会话管理方法 | `frontend-demo/api-client.js:171-175` | - |
| `api-mock.js` 缺会话管理 mock | `frontend-demo/api-mock.js:325-345` | - |
| `chat-routes.test.ts` stub host 无 `switchSession`/`newSession` | `tests/chat-routes.test.ts:42-44` | 测试需扩展 |

### 3.4 SessionInfo 字段（SDK 侧，11 字段）

`pi-ex/packages/coding-agent/src/core/session-manager.ts:168-182`：

```ts
interface SessionInfo {
  path: string;              // .jsonl 绝对路径
  id: string;                // uuidv7
  cwd: string;               // header.cwd（旧会话可能空串）
  name?: string;             // 用户自定义名
  parentSessionPath?: string; // fork 来源
  created: Date;
  modified: Date;            // 最后一条 user/assistant 消息时间
  messageCount: number;      // 所有 message entry（含 toolResult）
  firstMessage: string;      // 第一条 user 文本
  allMessagesText: string;   // 全文（搜索用）
}
```

当前 `GET /sessions` 只透出 6 字段（`routes-chat.ts:147-156`），G2 需扩展透出 `path`（切换需要）。

### 3.5 SessionManager.list 过滤行为

`session-manager.ts:1471-1480`：当 `sessionDir` 与默认不同时按 `cwd` 过滤。`ChatContext.listSessions` 传入项目内 `.pi/sessions`，与默认 APPDATA 路径必不同，过滤生效。

- 本项目正常 v3 会话不会被漏
- 跨项目复制过来的会话（header.cwd 指向源项目）会被过滤掉（G2 不处理，已知限制）

## 四、任务分解（3 步独立 commit）

### G2-1 后端原语接入 + 启动恢复（第一步）

**分支**：`20260805-session-backend`

**改动文件**：

| 文件 | 改动 |
|---|---|
| `src/chat/main-session.ts` | ① `start()` 内 `createAgentSessionRuntime` 后注入 `setRebindSession`（刷新 `this.services = runtime.services`）+ `setBeforeSessionInvalidate`（空实现，留 hook）<br>② `start()` 改造：把 `SessionManager.create(cwd, sessionDir)` 改为 `SessionManager.continueRecent(cwd, sessionDir)`（一行改动，与 PI 本体 `-c` 一致；有最近会话则 open 旧文件，无则 create 新建）<br>③ 新增 `switchSession(sessionPath)` / `newSession()` 公开方法（内部调 `runtime.switchSession` / `runtime.newSession`） |
| `src/app/chat-context.ts` | 新增 `createSession()` / `activateSession(id)` 方法，转发到 `host`；含 streaming 检查（`host.session.isStreaming` → 抛 `CHAT_BUSY`） |
| `src/app/routes-chat.ts` | ① `POST /api/chat/sessions`（创建）<br>② `POST /api/chat/sessions/:id/activate`（切换）<br>③ `GET /sessions` 扩展透出 `path` 字段<br>④ 错误码：`CHAT_BUSY` 409；`SESSION_INVALID_PATH` 默认 400 |
| `tests/chat-routes.test.ts` | ① stub host 扩展 `switchSession` / `newSession` 字段<br>② 新增测试：创建/切换端点 + streaming 时切换 409 + 启动恢复（list 空时走 create） |

**端点契约**：

```
POST /api/chat/sessions
  req body: {}（占位，无字段）
  res 200: { ok: true, data: { session: { id, name, created, modified, messageCount, firstMessage, live: true } } }
  res 409: CHAT_BUSY / NO_ACTIVE_PROJECT
  res 501: EMBEDDER_UNAVAILABLE

POST /api/chat/sessions/:id/activate
  res 200: { ok: true, data: { session: {..., live: true} } }
  res 404: SESSION_NOT_FOUND
  res 409: CHAT_BUSY
  res 400: SESSION_INVALID_PATH
```

**插入位置**：`routes-chat.ts:159`（`GET /sessions`）之后、`line 162`（`GET /sessions/:id/messages`）之前。`:id/activate` 与 `:id/messages` 都 `startsWith("/sessions/")`，必须用 `endsWith` 区分后缀，且 `activate` 分支在通用 `startsWith` 分支之前判断。

**验收标准**：
- `curl POST /api/chat/sessions` 创建新会话，返回 live=true
- `curl POST /api/chat/sessions/:id/activate` 切换 live 到旧会话
- `npm test` 全绿（基线 645 不降）
- 启动恢复：模拟 `.pi/sessions/` 有 1 个 jsonl，启动后 `GET /status` 的 sessionId 应指向恢复的会话

### G2-2 前端真调用（第二步）

**分支**：`20260805-session-frontend`

**改动文件**：

| 文件 | 改动 |
|---|---|
| `frontend-demo/api-client.js` | 新增 `createChatSession()` / `activateChatSession(id)` 方法（不重构，只加方法） |
| `frontend-demo/views/studio.js` | ① `stNewSession()` 改：调 `apiCall('createChatSession')`，返回后更新 `studioSessions` + `currentSessionId` + 清空 `studioMessages`<br>② `stSwitchSession(id)` 改：调 `apiCall('activateChatSession', id)`，返回后更新 live 标记 + 重新拉 messages<br>③ streaming 时禁用切换按钮 + "新建议程"按钮，提示"请等待生成完成"<br>④ `stSessionsHtml` 会话项展示：name 为空时显示 firstMessage 前 30 字符或 sessionId 前 8 位 |
| `frontend-demo/styles/views.css` | streaming 时按钮 disabled 样式 |
| `frontend-demo/api-mock.js` | ① `createChatSession` 实现：生成新 sessionId，push 到 chatSessions<br>② `activateChatSession` 实现：更新 live 标记 |
| `frontend-demo/mock-data.js` | 无改动（fixture 保持） |

**验收标准**：
- 点"新建议程"不再 404，真实创建空会话
- 切换旧会话后发送消息，写入切换后的会话（不再写 live）
- streaming 时切换/新建按钮灰掉
- 无艾莉亚/ch006 残留
- `npm test` 全绿

### G2-4 专项测试轮（第三步）

**分支**：`20260805-session-test-round`

**产物**：
- 测试轮文档：`docs/audits/frontend-test-runs/2026-08-05-sessions.md`
- 截图目录：`docs/audits/frontend-test-runs/shots/2026-08-05-sessions/`
- backlog 同步：`docs/audits/frontend-bug-backlog.md`

**测试清单覆盖点**：

| 分类 | 测试项 |
|---|---|
| 功能正确性 | 新建会话（live=true，空消息）/ 切换会话（live 转移，历史可见）/ 切换后发送写入切换后的会话 |
| 启动恢复 | 服务重启后 live 指向最近会话 / 无会话时新建空会话 |
| streaming 边界 | streaming 时切换按钮灰掉 / streaming 时新建按钮灰掉 / 生成完成后按钮恢复 |
| 工具调用持久化 | 刷新后工具调用记录可见（验证用户坑 2 已修） |
| 碎片治理 | 多次刷新不新增碎片会话 / 切走再切回不丢消息 |
| 控制台洁净 | 无 404 / 无未捕获 Promise / 无 JS 报错 |
| 响应式 | 1280/1440/1920 宽度下会话列表布局正常 |
| mock 模式 | mock 下新建/切换行为一致 |

**硬约束**（按 `docs/frontend-test-discipline.md`）：
- 测试轮进行中禁止改代码
- 发现问题必须登记，不得口头描述后忽略
- AI 声称完成前必须附本轮测试轮文档链接
- P0/P1 缺陷必须附截图

## 五、执行顺序与依赖

```
G2-1（后端原语 + 端点 + 启动恢复）
  │
  └─→ G2-2（前端真调用 + api-client 加方法 + mock 同步）
        │
        └─→ G2-4（专项测试轮）
```

- 每步独立 commit（narrative-engine 分支策略：`20260805-session-<step>` 分支 → ff-only 合并 master）
- 每步完成即跑 `npm test`（基线 645 不降）
- G2-2/G2-4 涉及 frontend-demo，按前端测试纪律自驱测试轮

## 六、验收总标准（G2 完成判据）

1. G2-1/G2-2 代码落地，`npm test` 全绿（645 基线不降）
2. G2-4 专项测试轮全绿（新建/切换/恢复/碎片治理/工具调用持久化）
3. 用户反馈的 3 个坑点全部修复并验证：
   - 坑 1（刷新后历史不可见）：G2-3 启动恢复解决
   - 坑 2（工具调用消失）：同上（getSessionMessages 聚合逻辑本身正确，根因是 live 指向新空会话）
   - 坑 3（新建后旧消息残留）：G2-2 真实 newSession 解决
4. 前端测试轮文档齐备
5. 坑 4（删除后历史残留）**不在 G2 范围**，文档明示推后续批次

## 七、风险与存疑（执行中保持跟踪）

| 风险/存疑 | 影响 | 缓解 |
|---|---|---|
| `switchSession` 内部 dispose 旧 session，streaming 被中断 | streaming 中切换会丢生成 | 前端 streaming 时禁用切换按钮 |
| `MainSessionHost.services` 在 rebind 回调中刷新的时机 | `applyModelConfig` 可能短暂访问 stale services | rebind 回调第一行刷新；单测覆盖"切换后立即 applyModelConfig" |
| `SessionManager.list` 的 cwd 过滤漏失跨项目会话 | 导入外部会话后不可见 | G2 不处理，文档明示已知限制 |
| 恢复失败时 `modelFallbackMessage` 提示文案 | 用户困惑 | 文案明确"会话恢复失败：{err.message}，已新建空会话" |
| `setBeforeSessionInvalidate` 空实现 | 未来需要 UI 拆卸时要回填 | 留 hook + 注释说明 |
| 坑 4（删除后历史残留）未解决 | 用户手动删 `.pi/sessions/` 后 host 仍持有 stale session | 文档明示 G2 不做删除，建议用户不要手动删文件 |

## 八、存疑点（坦诚标记，需执行中验证或用户决策）

1. **`MainSessionHost.services` 刷新方式**：rebind 回调里 `this.services = runtime.services` 是基于静态分析的推断，未实测。G2-1 单测必须覆盖"切换会话后立即 applyModelConfig"路径。
2. **启动恢复走 `continueRecent`**：与 PI 本体 `-c` 一致，不走 `runtime.switchSession`，不触发 teardown。`continueRecent` 在 `createAgentSessionRuntime` 之前就用 open 出来的 SessionManager，runtime 直接接管，无 teardown 语义混乱。`MainSessionHost.start()` 把 `SessionManager.create(cwd, sessionDir)` 改为 `SessionManager.continueRecent(cwd, sessionDir)`（找不到时 `continueRecent` 内部走 create），一行改动。
3. **streaming 中切换的 UX**：禁用按钮是最简方案。用户原期望"后台继续生成"需要多 host 池（phase3）。G2 内先按禁用实现，文档明示这是已知限制。
4. **删除会话能力缺失**：用户坑 4 未解决。G2 内不做，建议用户不要手动删 `.pi/sessions/` 文件。后续批次补 DELETE 端点。

---

**待用户核对**：以上目标定义、任务分解、不做范围、风险存疑是否有需要调整的？核对通过后从 G2-1 第一步开始执行。
