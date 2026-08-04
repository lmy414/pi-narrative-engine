# narrative-engine 全量代码审计报告（2026-08-03）

> **审计性质**：只读审计，未修改任何文件。所有发现均基于源码实证（行号引用），未臆测接口。
> **审计方法**：4 个子代理并行按模块分片查证（旧审计复核 · 后端逻辑 · 前端逻辑 · 前后端协同与安全），汇总后交付。
> **审计基线**：master 分支 `f7cfb3c`（2026-08-03）。
> **变更背景**：自 2026-07-30 上次审计以来，仓库经历架构级重构（PI 扩展删除→纯 SDK、commit 链路从过程式 for 循环→LLM 推理代理自主调用工具、frontend-demo 高保真重构多页、B3-B8 端点补齐、编排控制 HTTP 化 + DebugBus 接入）。
> **关联文档**：
> - 上次审计：[2026-07-30-code-audit.md](./2026-07-30-code-audit.md)
> - 同期前端 bug 清单：[2026-08-03-production-gap-bug-inventory.md](./2026-08-03-production-gap-bug-inventory.md)
> - 旧修复计划：[2026-07-27-fix-plan.md](./2026-07-27-fix-plan.md)
> - 旧数据流审计：[2026-07-29-data-flow-audit.md](./2026-07-29-data-flow-audit.md)

---

## 0. 总览

| 维度 | 评分 | 说明 |
|---|---|---|
| 旧审计问题闭环 | 9 / 10 | H1-H6 + M15/M16/M21/M23/M26/M30 全部已修复或合理重构 |
| 后端逻辑（orchestrator/agents/chat/ports/debug） | 6 / 10 | 架构清晰，但 commit 一致性缺口 + 子代理无超时 + EventQueue 无界威胁长期运行 |
| 前端逻辑（visualizer-ui + frontend-demo） | 6 / 10 | 视觉重构到位，但 frontend-demo 安全面薄弱、3D 资源泄漏严重 |
| 前后端协同 | 7 / 10 | B3-B8 端点补齐后契约基本一致，但 SSE 事件部分错位 |
| 代码安全 | 5 / 10 | CORS `*` + 无鉴权 + Tauri CSP 关闭 + 请求体无限制 + XSS 注入面广 |
| 代码质量 | 7 / 10 | 注释扎实，但部分过度工程与类型不安全残留 |

**全局结论**：架构级重构整体方向正确（纯 SDK、子代理编排器、Ports 抽象、调试总线），但**重构引入了新的高严重度问题**：

1. **数据正确性**：commit 流程在推理代理抛错时世界图已部分写入但返回 `appliedEventIds: []` 且 plan 被无条件删除，导致脏数据 + 不可重试。
2. **可用性**：子代理无超时 + EventQueue 无界 + 3D 资源泄漏 → 长时间运行必崩溃。
3. **安全**：CORS `*` + 无鉴权 = 任意网页可跨域操控本地服务（读写文件、改 API key、窃听对话）；frontend-demo 的 onclick 字符串拼接 + escapeHtml 不转义单引号 = 全站 XSS。

---

## 1. 旧审计闭环确认

逐一核查 [2026-07-30-code-audit.md](./2026-07-30-code-audit.md) 的高/中严重度项在当前源码下的状态：

| 旧编号 | 问题 | 状态 | 关键证据位置 |
|---|---|---|---|
| H1 | commit.ts try/catch 包整个 for | ✅ 已重构 | commit.ts 已删；新链路 `src/orchestrator.ts:353-447`，每阶段独立 try/catch |
| H2 | 部分成功时 memory.md 不更新 | ✅ 不再适用 | updateMemory 全删；`src/chat/scheduler-tools.ts:131-137` 无 memory 调用 |
| H3 | storyTime 格式分裂+字符串比较 | ✅ 已修复 | `src/chat/scheduler-tools.ts:24-33` 加 `validateStoryTime`；types.ts:88 / render-tools.ts:61 描述统一 |
| H4 / M4a | locationId 死字段 | ✅ 已修复 | `packages/scheduler/src/types.ts:109-111` 删除字段 |
| H5 | CI 测试覆盖缺失 | ✅ 已修复 | `.github/workflows/test.yml:57-67` 纳入 admin/novel-launcher/root tests；`package.json:18-20` 加 `test` 脚本 |
| H6 | esbuild 未声明 | ✅ 已修复 | `package.json:33` devDependencies 显式声明 |
| M15 | updater v 前缀未过滤 | ✅ 已修复 | `packages/admin/src/updater.ts:38-39,97` `.replace(/^v/, "")` |
| M16 | updater 版本字符串比较 | ✅ 已修复 | `packages/admin/src/updater.ts:37-46` `_compareSemver` 数值比较 |
| M21 | 设置页 .env 误删 | ✅ 已修复 | `visualizer-ui/components/settings-view.js:199` 追加 `loadConfig()` |
| M22 | 端口硬编码 | ✅ 前端已无硬编码 | 仅 Tauri 启动页 `tauri-app/public/index.html:34` 残留 |
| M23 | visualizer-ui 死代码 | ✅ 已删除 | detail-panel.js / events-view.js / graph-view.js 已移除 |
| M26 | app.js 重复请求 | ⚠️ 部分残留 | `visualizer-ui/app.js:251-254 onChanged` 仍并行 refreshEvents + loadGraph；`169-180 onActivated` 仍重复调 `api.projectActive()` |
| M30 | launch.ts shell 注入 | ✅ 已重构 | launch.ts 已删；`packages/novel-launcher/src/project.ts:123` 用 spawn 数组参数 |

**新发现（重构副产品）**：
- H1 架构变更引入新缺口：`src/orchestrator/service.ts:132-141` catch 块在推理代理抛错时返回 `appliedEventIds: []`，但推理代理可能已通过工具调用写入了部分世界图变更。详见 §2 🔴-2。
- H5 CI 与本地脚本差异：CI 显式排除 `pi-status.test.ts`（`.github/workflows/test.yml:59` 只列 8 个测试文件），但根 `package.json` 的 `test` 脚本用 glob 会包含它。本地 `npm test` 在某些环境可能卡住，与 CI 行为不一致。

---

## 2. 🔴 高严重度（必修，按优先级排序）

### 🔴-1. CORS `*` + 无鉴权 = 本地攻击面【安全·前后端协同】

**位置**：
- [src/app/routes-chat.ts:189](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-chat.ts#L189)
- [src/visualizer/routes.ts:36](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/routes.ts#L36)
- [src/debug/sse.ts:37](file:///d:/claude/pi-ex/narrative-engine/src/debug/sse.ts#L37)
- [src/app/unified-server.ts:233](file:///d:/claude/pi-ex/narrative-engine/src/app/unified-server.ts#L233)

unified-server 监听 127.0.0.1 only，但所有 JSON / SSE 响应都带 `access-control-allow-origin: *`，所有路由注释明示"不做鉴权"（routes-chat.ts:17、routes-ext.ts:13、routes-scheduler.ts:20）。

```ts
// routes-chat.ts:185-191
res.writeHead(200, {
  "Content-Type": "text/event-stream; charset=utf-8",
  ...
  "access-control-allow-origin": "*",
  ...
});
```

**攻击链**：用户在浏览器中打开任意恶意网页 → 该网页可跨域发起 POST/PUT/DELETE 到 `http://127.0.0.1:7421`：
- `PUT /api/files/write`、`POST /api/files/delete` → 写/删项目文件
- `POST /api/projects/activate` → 激活任意项目
- `PUT /api/admin/llm/key` → 改 LLM API key
- `GET /api/admin/config` → 读项目 `.env`
- `GET /api/chat/events` → 窃听用户对话 SSE 流
- `POST /api/debug/clear` → 清调试缓冲

"localhost-only"在此场景下不构成防线——浏览器中的恶意 JS 天然在 localhost 上。

**修复方向**：CORS 收紧（移除 `*` 或同源）+ 启动生成 token 写 app-config + 前端注入 `Authorization: Bearer <token>` 头，所有 `/api/*` 校验；至少对写操作加 `Origin`/`Referer` 校验。

---

### 🔴-2. commit 流程的 appliedEventIds 一致性缺口【后端·数据正确性】

**位置**：
- [src/orchestrator/service.ts:128-141](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/service.ts#L128)
- [src/orchestrator.ts:353-447](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L353)

reasoning-agent 通过 `world_event_apply` 等写工具已**实际写入世界图**（ports.worldGraph.processEvent 不可逆）。若 reasoning-agent 整体抛错（LLM 未提交 `diffusion_result`、API key 失效、网络中断），service.commit 的 catch 块：

```ts
catch (err) {
  this.plans.delete(planId);   // plan 已删除，不可重试
  return { ok: false, planId, appliedEventIds: [], ... };  // 客户端以为未写入
}
```

**影响**：世界图脏数据 + plan 不可重试也不可 discard + 后续 dispatch 基于错误状态推进。

**修复方向**：catch 中返回实际 `appliedEventIds`（从 `tool_execution_end` 事件聚合），且仅在错误发生在 reasoning 写入前才删除 plan。

---

### 🔴-3. 子代理循环无超时 + 无迭代上限【后端·可用性】

**位置**：
- [src/agents/collect.ts:27-58](file:///d:/claude/pi-ex/narrative-engine/src/agents/collect.ts#L27)
- [src/orchestrator.ts:204-206](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L204)

`collectSubmission` 返回的 promise 无超时；agents/ 工厂构造时未注入 maxIterations/maxSteps（grep `maxIterations|maxSteps` 在 agents/ 下无命中）。

```ts
const plannerCollected = collectSubmission<{ plan: RetrievalPlan }>(planner, "retrieval_plan");
await planner.prompt("");
plannerResult = await plannerCollected.promise;   // 可能永久 pending
```

**影响**：LLM 陷入循环（反复调只读工具而不提交产出）→ promise 永久 pending → EventQueue 单消费者被阻塞 → 整个编排器死锁。`scheduler_queue_status` 显示该事件永久 "running"。

**修复方向**：collectSubmission 加超时（如 120s）后 reject 并 dispose agent；EventQueue 加单事件执行超时。

---

### 🔴-4. EventQueue 无界 + 已完成事件永不清理【后端·内存泄漏+语义错误】

**位置**：
- [src/event-queue.ts:41](file:///d:/claude/pi-ex/narrative-engine/src/event-queue.ts#L41)
- [src/event-queue.ts:109-111](file:///d:/claude/pi-ex/narrative-engine/src/event-queue.ts#L109)

queue 数组无 maxLength，已完成（done/error）事件永不清理，`getAll()` 返回全部 slice。配合 🔴-3，pending 事件也会积压。

```ts
// event-queue.ts:41
private queue: QueuedEvent<TEvent, TResult>[] = [];

// event-queue.ts:109-111  getAll 返回全部，无清理
getAll(): QueuedEvent<TEvent, TResult>[] {
  return this.queue.slice();
}
```

**影响**：
- 内存无限增长，已完成事件对象（含完整 OrchestratorResult）永不释放
- `queueStatus()` 序列化开销随事件数线性增长，前端拉状态越来越慢
- **与前端 bug 清单 §1.3-1 交叉印证**：前端把 `queue.length` 当活跃数，但后端永不移除 → 跑过一次后前端永远显示"N 个任务执行中"

**修复方向**：加 maxLength（如 100）+ 已完成事件 TTL 清理；`queueStatus` 分页或只返回最近 N 条 / 只返回活跃条目。

---

### 🔴-5. 路径遍历漏洞【后端·安全】

**位置**：
- [src/chat/import-card.ts:121-133](file:///d:/claude/pi-ex/narrative-engine/src/chat/import-card.ts#L121)（parseCardFile 直接 `fs.readFile(cardPath)`）
- [src/chat/import-tools.ts:19](file:///d:/claude/pi-ex/narrative-engine/src/chat/import-tools.ts#L19)（epubPath）
- [src/agents/chapter-tools.ts:45-51](file:///d:/claude/pi-ex/narrative-engine/src/agents/chapter-tools.ts#L45)（chapterPath）
- [src/chat/world-tools.ts:78](file:///d:/claude/pi-ex/narrative-engine/src/chat/world-tools.ts#L78)
- [src/orchestrator.ts:520-522](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L520)（resolveChapterPath 只判 isAbsolute 不校验 `..`）

```ts
// orchestrator.ts:520-522
private resolveChapterPath(event: StructuredEvent): string {
  const p = event.chapterPath ?? `chapters/${event.storyTime}.md`;
  return isAbsolute(p) ? p : join(this.opts.cwd, p);   // 不校验 ../ 越界
}
```

主会话 LLM 可被诱导传入 `../../etc/passwd` 或 `C:\Windows\System32\config\SAM` 读取任意文件，或 `../../../malicious.md` 覆盖项目外文件。配合 🔴-1，任意网页可借此读任意文件。

**修复方向**：在 parseCardFile / import_novel / chapter_write 入口统一加路径校验：`path.relative(cwd, target)` 不以 `..` 开头才放行；`resolveChapterPath` 拒绝含 `..` 的相对路径。

---

### 🔴-6. Tauri 应用 CSP 完全关闭【安全·配置】

**位置**：[tauri-app/src-tauri/tauri.conf.json:22-24](file:///d:/claude/pi-ex/narrative-engine/tauri-app/src-tauri/tauri.conf.json#L22)

```json
"security": { "csp": null }
```

显式设为 `null` 完全关闭 Content Security Policy。Tauri 应用窗口加载的 frontend-demo / visualizer-ui 静态资源不受 CSP 保护。

**影响**：前端引入第三方脚本（如 CDN）或存在 XSS 时可执行任意 JS；`connect-src` 不受限，恶意 JS 可连接任意远程（外泄 API key、项目数据）。

**修复方向**：
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:7421; img-src 'self' data:"
```

---

### 🔴-7. 请求体无大小限制 + HTTP server 无超时 + SSE 无连接上限【安全·DoS】

**位置**：
- [src/visualizer/server.ts:56-74](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/server.ts#L56)（readBody 收集 chunks 无 size 检查）
- [src/app/unified-server.ts:233](file:///d:/claude/pi-ex/narrative-engine/src/app/unified-server.ts#L233)（无 server.timeout / headersTimeout / requestTimeout）
- [src/app/routes-chat.ts:180-224](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-chat.ts#L180)、[src/debug/sse.ts:27-83](file:///d:/claude/pi-ex/narrative-engine/src/debug/sse.ts#L27)（SSE 端点无连接数上限）

```ts
// server.ts:56-74  readBody 收集 chunks 无上限
export function readBody(req): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));  // 无 size 检查
    // ...
  });
}
```

**影响**：超大 JSON 耗尽内存 / 数千 SSE 连接耗尽 fd / slowloris 慢速攻击；配合 🔴-1，任意网页可发起此类攻击。

**修复方向**：readBody 加 maxBodySize（1MB，超返回 413）+ `server.headersTimeout = 60_000; server.requestTimeout = 30_000`（SSE 端点豁免）+ SSE 全局连接计数上限（如 10，超返回 503）。

---

### 🔴-8. frontend-demo 大量 onclick 字符串拼接 + escapeHtml 不转义单引号【前端·XSS】

**位置**：
- [frontend-demo/app.js:57-59](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/app.js#L57)（escapeHtml 实际只转 `& < > "`，**不转义单引号 `'`**）
- [frontend-demo/views/events.js:190,205,249,283,327](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/events.js#L190)
- [frontend-demo/views/graph.js:190,223,245,260,271,487](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L190)
- [frontend-demo/views/studio.js:224,351,374,375,437,533](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/studio.js#L224)
- [frontend-demo/views/entity-detail.js:177,269,310,345,371,403,446,466,486,528](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/entity-detail.js#L177)

代表例：
```js
<div class="entity-item${...}" onclick="graphSelectEntity('${e.entityId}')" ...>
```

若 `entityId` / `property` / `label` 含 `'`（如 `x');alert(1);//`），可闭合字符串注入任意 JS。`demo-utils.js:20` 的 `q()` 函数正确转义了单引号，但仅用于 `views/debug.js`，其他视图未使用。

**修复方向**：所有内联 `onclick` 字符串拼接改用 `q()`，或迁离 inline handler 用 `addEventListener` + `data-*`。

---

### 🔴-9. graph.js 重建 3D 场景未调用 `_destructor()`，WebGL 资源泄漏【前端·可用性】

**位置**：
- [frontend-demo/views/graph.js:299-354](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L299)
- [frontend-demo/views/graph.js:449-457](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L449)（graphSearchEntities 每次输入触发重建）
- [frontend-demo/app.js:164-167](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/app.js#L164)（cleanupRouteRuntime 不覆盖 graph）

- 行 324 仅 `pauseAnimation()` 后置 null，**未调用 `_graph3d._destructor()`**（对比 [visualizer-ui/components/graph-3d.js:121](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/graph-3d.js#L121) 正确调用）
- `graphSearchEntities` 每次输入触发 `graphInit3D()` 重建场景
- `cleanupRouteRuntime` 仅覆盖 studio/debug，graph 3D 资源切出视图时未清理

**影响**：长时间使用世界图页后 Chrome WebGL 上下文上限（16 个）耗尽，3D 渲染失败。

**修复方向**：重建前调 `_graph3d._destructor && _graph3d._destructor()`；新增 `cleanupGraphView` 在切出时销毁；`graphSearchEntities` 加 debounce 或只更新数据不重建场景。

---

### 🔴-10. proto-utils.js renderInline 的 `javascript:` 过滤可被绕过【前端·XSS】

**位置**：
- [visualizer-ui/proto-utils.js:62-73](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/proto-utils.js#L62)
- [visualizer-ui/components/editor-view.js:218](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/editor-view.js#L218)（`v-html="previewHtml"` 直接渲染输出）

```js
function renderInline(text) {
  var s = escapeHtml(text);              // 不转义 ' 和 :
  // ...
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
    var href = u.replace(/javascript:[^"']*/i, "");   // 仅匹配连续 javascript:
    return '<a href="' + href + '" target="_blank" rel="noopener">' + t + "</a>";
  });
}
```

正则只匹配字面量 `javascript:`，无法捕获 `jav\tascript:`、`jav&#x09;ascript:`、`data:text/html,<script>`、`vbscript:` 等。`escapeHtml` 不转义 `'` 和 `:`。测试 [tests/frontend-utils.test.ts:114-117](file:///d:/claude/pi-ex/narrative-engine/tests/frontend-utils.test.ts#L114) 仅测最直白场景。

**修复方向**：用 URL 解析白名单（仅允许 http/https/mailto），或用 DOMPurify；不要靠正则黑名单。

---

### 🔴-11. frontend-demo 第三方资源走 CDN 且无 SRI【前端·供应链】

**位置**：[frontend-demo/index.html:7-15](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/index.html#L7)

```html
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.1/dist/index.global.js"></script>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<script src="https://unpkg.com/3d-force-graph"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
```

无 `integrity` SRI 属性；`lucide@latest` 与 `3d-force-graph`（无版本锁定）随时可能拉到不兼容版本；CDN 不可达时整个应用挂掉。

**修复方向**：与 `visualizer-ui/vendor/` 一致下载到本地 `vendor/` 并加 SRI；锁定版本；移除 `@latest`。

---

## 3. 🟡 中严重度（按维度分组）

### 3.1 代码逻辑

- **M-Logic-1**：[src/orchestrator/llm-config.ts:141-153](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator/llm-config.ts#L141) `getApiKey` 回退链与 `resolveConfig` 不一致——slot=planner 显式配置 `{provider: "openai", name: "gpt-5.1"}` 无 apiKey，default 配置了 `{provider: "deepseek", apiKey: "ds-key"}` 时，会用 deepseek 的 key 给 openai，导致 401 鉴权失败。
- **M-Logic-2**：[src/agents/chapter-tools.ts:64-87](file:///d:/claude/pi-ex/narrative-engine/src/agents/chapter-tools.ts#L64) chapter_write 在 modify/insert 缺 targetEventId 时返回 `ok:false` 不抛错；[src/orchestrator.ts:431](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L431) 只看 render_result 的 ok 不看 chapter_write 的实际 ok → CommitSummary.ok 与实际写入状态不一致。
- **M-Logic-3**：[src/orchestrator.ts:428-440](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L428) CommitSummary.errors 重建空数组，**丢失 role 阶段错误**——客户端无法看到角色失败信息。
- **M-Logic-4**：[src/orchestrator.ts:286-332](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L286) yolo 模式下所有角色失败（outputs 为空）仍继续后半链路，可能用空 outputs 渲染并写入空章节文件。
- **M-Logic-5**：[src/chat/role-tools.ts:60](file:///d:/claude/pi-ex/narrative-engine/src/chat/role-tools.ts#L60) 缺少 `aborted` 状态处理（对比 [src/chat/render-tools.ts:42](file:///d:/claude/pi-ex/narrative-engine/src/chat/render-tools.ts#L42) 已处理），aborted 时无谓重试浪费 LLM 配额。
- **M-Logic-6**：[src/chat/world-tools.ts:81](file:///d:/claude/pi-ex/narrative-engine/src/chat/world-tools.ts#L81) 主会话版 `source` 字段用 `Type.String()` 无枚举校验（对比 [src/agents/world-tools.ts:21-25](file:///d:/claude/pi-ex/narrative-engine/src/agents/world-tools.ts#L21) 用了 `VISIBILITY_SOURCE` 枚举），LLM 传入非法字符串会在 zod 层抛错。
- **M-Logic-7**：[src/debug/sse.ts:62-82](file:///d:/claude/pi-ex/narrative-engine/src/debug/sse.ts#L62) 只监听 `req.on("close")`/`error"`，TCP 半开连接下 `res.write` 持续成功但无消费者，订阅者永不取消 → 内存泄漏。
- **M-Logic-8**：[frontend-demo/app.js:159-163](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/app.js#L159) `navigate(statePatch)` 用 `Object.assign(App, statePatch)` 直接替换 `App.viewState` 对象引用 → 跨页跳转后返回原页面状态丢失。**与前端 bug 清单 Bug 3 交叉印证**（项目切换状态污染）。
- **M-Logic-9**：[frontend-demo/views/studio.js:153-172](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/studio.js#L153) setInterval 2s 轮询无退避，同时订阅 SSE 双通道更新可能冲突。**与前端 bug 清单 §1.3-2 交叉印证**（status 轮询载荷爆炸）。
- **M-Logic-10**：[visualizer-ui/app.js:222-235](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/app.js#L222) loadGraph 无竞态保护——用户快速切换 storyTime 时后发先至会用旧 storyTime 的数据覆盖新数据。
- **M-Logic-11**：[frontend-demo/views/events.js:46-81](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/events.js#L46) 与 [frontend-demo/views/graph.js:55-60](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L55) 重复设置全局 storyTime，两处都调 `apiCall('getStatus')` 拉同一份数据，无竞态保护。**与前端 bug 清单 §1.4 交叉印证**（storyTime 初始化顺序错误导致真实模式必坏）。
- **M-Logic-12**：[frontend-demo/api-client.js:218-232](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/api-client.js#L218) EventSource 无指数退避重连，后端宕机时持续打挂；`onerror` 每次重连失败都回调 `onError`，调用方反复弹 toast。
- **M-Logic-13**：[visualizer-ui/components/debug-view.js:363-371](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/debug-view.js#L363) SSE 重连固定 3 秒，无指数退避，无最大重试次数。

### 3.2 前后端协同

- **M-Collab-1**：[visualizer-ui/api.js:202-204](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/api.js#L202) `adminUpdateStream` 调用 `/admin/update/stream`，但后端该端点已删除（[packages/admin/src/updater.ts:6-8](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/updater.ts#L6) 注释明确"一键更新执行链已删除"；[docs/api/unified-server.md:5](file:///d:/claude/pi-ex/narrative-engine/docs/api/unified-server.md#L5) 已声明移除）。前后端契约不一致。
- **M-Collab-2**：SSE 事件 `message_end` / `turn_start` / `turn_end` 后端已实现（[docs/api/chat.md:30-36](file:///d:/claude/pi-ex/narrative-engine/docs/api/chat.md#L30)），但前端 [frontend-demo/views/studio.js:756-779](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/studio.js#L756) 未处理 `message_end`（含"错误标红"语义）→ 错误消息无法在 UI 标红。**与前端 bug 清单 §1.2 交叉印证**（输入错误只 toast，气泡内无错误消息）。
- **M-Collab-3**：[src/app/routes-scheduler.ts:225-235](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-scheduler.ts#L225) `PUT /api/scheduler/mode` 不需活跃项目但修改模块级 `schedulerDefaultMode`，影响所有项目的 dispatch 默认模式——多项目场景下用户感知不一致。
- **M-Collab-4**：[src/app/routes-ext.ts:275-287](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-ext.ts#L275) `/api/projects/scan` 接受任意 root 路径（无白名单），可探测本地文件系统存在性。
- **M-Collab-5**：[packages/admin/src/updater.ts:73-107](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/updater.ts#L73) `compareVersions` 调用 `git ls-remote` 无超时，远程不可达时 HTTP 请求永久悬挂。
- **M-Collab-6**：[tauri-app/src-tauri/src/sidecar.rs:106-116](file:///d:/claude/pi-ex/narrative-engine/tauri-app/src-tauri/src/sidecar.rs#L106) 生产模式 `Stdio::inherit()` 同 dev 模式，Node 进程日志（可能含 API key 错误、项目路径）输出到 Tauri 进程 stdout/stderr。

### 3.3 代码安全

- **M-Sec-1**：HTTP 安全头全部缺失——grep 全仓库无 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Strict-Transport-Security` 设置（[src/visualizer/routes.ts:32-39](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/routes.ts#L32)、[src/visualizer/server.ts:77-93](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/server.ts#L77)）。
- **M-Sec-2**：[src/app/routes-chat.ts:91-93](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-chat.ts#L91) chat.message span 将用户输入前 200 字符持久化到 `<cwd>/.pi/logs/debug.jsonl`（默认开启，10MB 轮转 5 个文件），用户未被明示输入会被持久化。
- **M-Sec-3**：[src/app/routes-ext.ts:559-563](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-ext.ts#L559) `/api/admin/novel-json PUT` 用 `requireBody(body, [])` 不校验任何字段，整个 body 写入 → 可写入非法结构破坏 novel.json。
- **M-Sec-4**：[src/app/unified-server.ts:106](file:///d:/claude/pi-ex/narrative-engine/src/app/unified-server.ts#L106) AuthStorage 在 `%APPDATA%/narrative-engine/pi-agent/auth.json` **明文存储 API key**，文件权限未显式设置。

### 3.4 代码质量

- **M-Qual-1**：[src/agents/collect.ts:51](file:///d:/claude/pi-ex/narrative-engine/src/agents/collect.ts#L51) `resolve(event.result?.details as T)` 在 details 为 undefined 时静默 resolve undefined → 下游 `Cannot read properties of undefined` 难定位。
- **M-Qual-2**：[visualizer-ui/app.js:251-254](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/app.js#L251) `onChanged` 同时触发 `refreshEvents` + `loadGraph`（loadGraph 内部又触发 loadCharacterView），一次编辑触发 3 个请求，未用 Promise.all。**M26 部分残留**。
- **M-Qual-3**：[frontend-demo/views/debug.js:79](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/debug.js#L79) 无虚拟列表无上限，事件多时（1000+）渲染卡顿。每次 SSE 事件全量重渲。
- **M-Qual-4**：[visualizer-ui/components/graph-3d.js:148-162](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/graph-3d.js#L148) `focusSelected` setTimeout 重试无清理，组件卸载后 pending timer 仍会访问已销毁的 graph 实例。
- **M-Qual-5**：[src/orchestrator.ts:251-257](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L251) 串行角色注入连续多条 user message，可能被某些 LLM 误解为多轮对话。
- **M-Qual-6**：[frontend-demo/views/graph.js:338-339](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L338)、[visualizer-ui/components/graph-3d.js:95-103](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/graph-3d.js#L95) `nodeLabel`/`linkLabel` 返回未转义 HTML，实体名/标签被污染时悬停即 XSS。
- **M-Qual-7**：[scripts/package-sidecar.mjs:96-107](file:///d:/claude/pi-ex/narrative-engine/scripts/package-sidecar.mjs#L96) 打包产物 `server/main.js` 不混淆不剥离注释（`minify: false`），暴露内部实现细节。sourcemap: false 已是好实践。
- **M-Qual-8**：[src/chat/main-session.ts:134-136](file:///d:/claude/pi-ex/narrative-engine/src/chat/main-session.ts#L134) `dispose()` 不清理 `this.services`，下次 `start()` 覆盖前 `applyModelConfig` 会误操作。

---

## 4. 🟢 低严重度（择机清理）

### 4.1 后端

- **L-BE-1**：[src/agents/world-tools.ts:585-588](file:///d:/claude/pi-ex/narrative-engine/src/agents/world-tools.ts#L585) 空图时 `latestStoryTime` 返回 `""`，调用方用空字符串查询返回 null，LLM 困惑。
- **L-BE-2**：[src/debug/bus.ts:32-35](file:///d:/claude/pi-ex/narrative-engine/src/debug/bus.ts#L32) `nextEventId` 模块级全局，多实例共享。
- **L-BE-3**：[src/chat/world-tools.ts:14](file:///d:/claude/pi-ex/narrative-engine/src/chat/world-tools.ts#L14) 变量名 `storyTime` 与字段名冲突，可读性差。
- **L-BE-4**：[src/agents/world-tools.ts:332-365](file:///d:/claude/pi-ex/narrative-engine/src/agents/world-tools.ts#L332) `createLimitedQueryTool` 已知信息泄漏窗口，注释承认但无 issue 跟踪。
- **L-BE-5**：[src/agents/world-tools.ts:381-404](file:///d:/claude/pi-ex/narrative-engine/src/agents/world-tools.ts#L381) `eventId`/`declarationId` 由 LLM 生成无格式校验，可能重复或孤立。
- **L-BE-6**：[src/chat/import-tools.ts:19](file:///d:/claude/pi-ex/narrative-engine/src/chat/import-tools.ts#L19) `chapters` 参数无最小值校验，LLM 可能传入 0 或负数。
- **L-BE-7**：[src/chat/world-tools.ts:71](file:///d:/claude/pi-ex/narrative-engine/src/chat/world-tools.ts#L71) details 同时有 snapshot 和 error 字段，冗余设计。

### 4.2 前端

- **L-FE-1**：[frontend-demo/app.js:91-96](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/app.js#L91) `withLoading` 维护的 `App.loading` 标志无视觉反馈，注释承认是死代码。
- **L-FE-2**：[frontend-demo/views/events.js:94-102](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/events.js#L94) `eventEntityIds` 与 [frontend-demo/demo-utils.js:141-149](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/demo-utils.js#L141) 重复实现，未来易漂移。
- **L-FE-3**：[visualizer-ui/app.js:169-180,181-204](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/app.js#L169) `onActivated` 与 `init` 重复调用 `api.projectActive()`，一次激活触发 2 次同端点请求。**M26 部分残留**。
- **L-FE-4**：[visualizer-ui/components/debug-view.js:307-336](file:///d:/claude/pi-ex/narrative-engine/visualizer-ui/components/debug-view.js#L307) `connectStream` 中 fetch 探测无 AbortController，组件卸载后回调仍执行；硬编码 URL 绕过 api.js。
- **L-FE-5**：[frontend-demo/api-mock.js:51-66](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/api-mock.js#L51) `getChain` 递归无环检测，环数据会栈溢出。

### 4.3 测试覆盖缺口

- **L-Test-1**：无 commit 部分写入失败 / EventQueue 无界 / 子代理超时 / 路径校验的测试。
- **L-Test-2**：`renderMarkdown` 的 javascript: 绕过场景（[tests/frontend-utils.test.ts:114-117](file:///d:/claude/pi-ex/narrative-engine/tests/frontend-utils.test.ts#L114) 仅测直白案例）。
  - ⚠️ **随旧前端删除（2026-08-04）**：`tests/frontend-utils.test.ts` 测试对象为 `visualizer-ui/proto-utils.js`，已随旧版前端整目录删除。风险面消失：现行 `frontend-demo/views/files.js` 的 `flRenderMarkdown` 采用「整体 escapeHtml + 无 URL 渲染（flInline 仅粗体/斜体/代码）」设计，无链接协议注入面，等价安全由设计保证。
- **L-Test-3**：`frontend-demo/app.js`（路由/状态机）、`views/*.js`（除 mock 契约外）、`graph-3d.js` / `graph.js`、`studio.js` 完全无测试。
  - ⚠️ **存疑/跳过（2026-08-04）**：视图层全为 DOM 驱动，仓库无 jsdom 依赖，补单测需引入 DOM 环境，成本高收益低；行为验证由既有 browser_use 测试轮纪律承担。部分覆盖：api-mock getChain 环检测已补测试（`tests/frontend-api-client.test.ts`，回归 L-FE-5）。
- **L-Test-4**：`chat-routes.test.ts` 仅覆盖 `message_update`，其他 SSE 事件无回归测试。
- **L-Test-5**：无安全相关测试（监听地址 / CORS / 请求体大小 / 超时 / 路径遍历）。
- **L-Test-6**：CI 与本地脚本差异——CI 显式排除 `pi-status.test.ts`（[.github/workflows/test.yml:59](file:///d:/claude/pi-ex/narrative-engine/.github/workflows/test.yml#L59)），但根 `package.json` 的 `test` 脚本用 glob 会包含它，本地 `npm test` 在某些环境可能卡住。
- **L-Test-7**：未运行 `npm audit`，CI 未加 `npm audit --production`。

---

## 5. Top 必修项（按优先级）

### 第一梯队（安全/数据正确性，建议立即处理）

1. **🔴-1 CORS `*` + 无鉴权** → CORS 收紧 + token 鉴权
2. **🔴-2 commit 一致性缺口** → catch 返回实际 appliedEventIds + 条件删除 plan
3. **🔴-5 路径遍历** → parseCardFile/chapter_write/resolveChapterPath 统一加 cwd 范围校验
4. **🔴-6 Tauri CSP 关闭** → 设 CSP 头
5. **🔴-7 请求体无限制+无超时** → readBody 加 maxBodySize + server timeout + SSE 连接上限
6. **🔴-8 frontend-demo onclick XSS** → 改用 `q()` 函数
7. **🔴-9 graph.js WebGL 泄漏** → 加 `_destructor()` + `cleanupGraphView` + debounce

### 第二梯队（可用性/一致性，建议本迭代处理）

8. **🔴-3 子代理无超时** → collectSubmission 加超时
9. **🔴-4 EventQueue 无界** → 加 maxLength + TTL 清理
10. **🔴-10 renderInline javascript: 绕过** → 改白名单 URL 协议
11. **🔴-11 CDN 无 SRI** → 本地化 + 锁版本 + SRI
12. **M-Logic-3 CommitSummary.errors 丢失** → 聚合 role errors
13. **M-Logic-4 yolo 空输出继续渲染** → outputs 为空时跳过后半链路
14. **M-Sec-1 HTTP 安全头** → 统一加 nosniff/DENY/no-referrer

### 第三梯队（清理项，择机批量处理）

- M-Logic-1 ~ M-Logic-13（一致性收敛）
- M-Collab-1 ~ M-Collab-6（前后端协同对齐）
- M-Qual-1 ~ M-Qual-8（代码质量）
- L-* 全部低级项

---

## 6. 攻击链组合分析

某些单点问题组合后风险显著放大，需优先阻断：

1. **任意网页→读写本地文件链**：🔴-1（CORS `*` + 无鉴权）+ 🔴-5（路径遍历） → 任意网页可借 `PUT /api/files/write` 写入项目外任意路径，或读任意文件。
2. **任意网页→API key 窃取链**：🔴-1 + M-Sec-4（auth.json 明文） → 任意网页可 `GET /api/admin/config` 读 `.env` 或通过 LLM 端点间接探测 key。
3. **任意网页→XSS 持久化链**：🔴-1 + 🔴-8（onclick XSS）+ 🔴-6（Tauri CSP 关闭） → 任意网页可写脏实体数据到项目，用户加载该实体时触发 XSS，因 CSP 关闭可执行任意 JS 连接外网外泄。
4. **长时间运行崩溃链**：🔴-3（子代理无超时）+ 🔴-4（EventQueue 无界）+ 🔴-9（WebGL 泄漏） → 长时间使用后必死锁或资源耗尽。

**阻断建议**：先做 🔴-1（CORS + 鉴权），单点修复可同时阻断攻击链 1/2/3 的远程触发面；再做 🔴-9 与 🔴-3 解决长期运行可用性。

---

## 7. 与前端 bug 清单核对

本节与同期 [2026-08-03-production-gap-bug-inventory.md](./2026-08-03-production-gap-bug-inventory.md)（基于浏览器实测的"生产差距 bug 清单"）做交叉核对，避免重复发现、识别盲区、形成互补。

### 7.1 重叠项（两份报告都发现，交叉印证）

| 前端 bug 清单条目 | 本审计对应项 | 备注 |
|---|---|---|
| §1.3-1 队列长度语义错误（条目永不移除，前端当活跃数） | 🔴-4 EventQueue 无界 + 已完成事件永不清理 | 两边都发现。本审计侧重**内存泄漏**视角，前端 bug 清单侧重**语义错误**（活跃 vs 累计）。修复时合并：加 maxLength + 区分 active/all |
| §1.3-2 status 轮询载荷爆炸（每 2s 返回全部队列条目） | M-Logic-9 studio.js setInterval 轮询无退避 | 本审计提"无退避"，前端 bug 清单更深入指出**载荷爆炸**（含完整 OrchestratorResult，单次超 50KB）。合并修复：items 只给摘要 |
| §1.3-3 队列错误完全不可见 | M-Logic-3 CommitSummary.errors 丢失 role 错误 | 相关但不同：前端 bug 清单指**前端不展示队列错误**，本审计指**后端 CommitSummary.errors 数组重建为空**。两端都修才完整 |
| §1.3-5 轮询竞态（stLoadPlanDetails Promise.all 中 plan 被 commit → 404） | M-Logic-10 loadGraph 无竞态保护 | 都是竞态问题但位置不同。本审计未深究 stLoadPlanDetails 路径，属盲区 |
| §1.3-6 yolo 模式结果无处展示 | M-Logic-4 yolo 空输出继续渲染 | 相关但不同：前端 bug 清单指**有结果但无 UI 展示**，本审计指**空输出仍渲染可能写空章节**。两端都修才完整 |
| §1.3-7 dispatch 空 characterIds 必 400 | L1（前后端协同审查中提到） | 本审计已记录但归为低级。前端 bug 清单更明确指出**必 400** |
| §1.4 storyTime 初始化顺序错误（先 getGraph 后初始化 App.storyTime） | M-Logic-11 events.js 与 graph.js 重复设置全局 storyTime | 本审计提"重复设置"，前端 bug 清单更深入指出**顺序错误导致真实模式必坏**（mock 忽略参数所以不坏） |
| §1.2 输入错误只 toast，气泡内无错误消息 | M-Collab-2 SSE 事件 message_end 前端未处理 | 相关但不同：本审计指**前端未消费 message_end 事件**，前端 bug 清单指**UI 缺失错误展示**。修 message_end 处理即可同时解决 |
| Bug 3 项目切换状态污染 | M-Logic-8 navigate statePatch 替换 viewState | 相关但不同：本审计指**单次 navigate 替换 viewState 引用**，前端 bug 清单指**activateProject 不清理任何视图状态**。后者更严重（跨项目污染） |
| §5 collectSubmission 工具失败导致 Node 24 rejection 崩溃 → 已修复 | M-Qual-1 collect.ts details undefined 时静默 resolve | **已修复的是"rejection 崩溃"，本审计新发现的是"details undefined 静默通过"**——不同的子问题 |
| §5 SSE 头部延迟 30s 才冲刷 → 已修复 | （未单独列出，但审查中提及 SSE 头部设置） | 已修复 |

### 7.2 前端 bug 清单独有（本次审计盲区）

以下问题在前端 bug 清单中明确记录，但本次审计未发现或未深入。**列入本次审计的盲区**，下次审计需补强：

| 前端 bug 清单条目 | 描述 | 盲区原因 |
|---|---|---|
| §1.1 会话管理前后端能力严重错位 | 后端一个项目同时只有一个主会话；没有新建/切换/恢复/删除会话的 HTTP API；host 懒启动；前端「新建议程」创建假会话 session-<ts>，点击后 404；切换旧会话只是看历史，发送永远写入 live | 本审计聚焦 routes-chat.ts 端点存在性，未深究 session 切换/恢复逻辑与前后端语义错位 |
| §1.2 busy 标志只由 agent_end 复位 | LLM 异常时 SDK 是否必发 agent_end 未验证，若不发则发送按钮永久禁用 | 本审计仅在存疑项中提及，未作为正式发现 |
| §1.3-4 plan 出现前有 ~90s 真空期 | 前半链路跑完才入 plans，期间 stages 侧栏无数据 | 本审计未深究 stages 数据时序 |
| Bug 1 文件面板不显示文件名 - DTO 错位 | 后端 /api/files/tree 节点没有 name 字段，前端用 node.name → undefined → 空白 | 本审计审查前后端协同时聚焦端点存在性，**未逐一核对 DTO 字段**（重大盲区） |
| Bug 2 新建角色不出现在事件图 | 快速记事件 birth 表单太简陋（无 entityType 和 newFacts.name）；entityIndex 快照陈旧 | 本审计未深究表单字段完整性 |
| Bug 3 项目切换状态污染 | activateProject 不清理视图状态；文件 Tab 切换整视图重建，编辑器光标与撤销栈丢失 | 本审计只看 navigate 的 statePatch，未深究 activateProject 的清理范围 |
| Bug 4 世界图写入后需 F5 | 驻留视图无失效机制；storyTime 不前进；storyTimes 列表陈旧 | 本审计未深究视图失效机制 |

### 7.3 本次审计独有（前端 bug 清单未覆盖）

以下问题本次审计发现，前端 bug 清单（基于浏览器实测）未提及。**互补项**：

| 本审计编号 | 描述 | 前端 bug 清单未覆盖原因 |
|---|---|---|
| 🔴-1 | CORS `*` + 无鉴权 = 本地攻击面 | 前端 bug 清单关注"功能跑通"，未覆盖安全面 |
| 🔴-2 | commit 流程 appliedEventIds 一致性缺口 | 后端逻辑，浏览器实测难以发现 |
| 🔴-3 | 子代理循环无超时 | 后端逻辑，浏览器实测表现为"卡住"但难定位根因 |
| 🔴-5 | 路径遍历漏洞 | 安全专项，浏览器实测不会主动尝试 |
| 🔴-6 | Tauri CSP 完全关闭 | 配置安全，浏览器实测不触发 |
| 🔴-7 | 请求体无大小限制 + 无超时 + SSE 无上限 | DoS 攻击面，浏览器实测不触发 |
| 🔴-8 | frontend-demo onclick 字符串拼接 XSS | 需构造恶意实体数据才能触发，实测不易发现 |
| 🔴-9 | graph.js WebGL 资源泄漏 | 长时间使用才暴露，短期实测不触发 |
| 🔴-10 | renderInline javascript: 过滤绕过 | 需构造特殊 markdown 输入才触发 |
| 🔴-11 | frontend-demo 第三方资源走 CDN 无 SRI | 供应链安全，功能不受影响 |
| M-Logic-1 | llm-config getApiKey 回退链与 resolveConfig 不一致 | 后端逻辑，需多 provider 混合配置才触发 |
| M-Logic-2 | chapter_write ok=false 不抛错 | 后端逻辑，需 modify/insert 缺 targetEventId 才触发 |
| M-Logic-5 | role-tools.ts 缺 aborted 状态处理 | 后端逻辑，需 LLM 主动 abort 才触发 |
| M-Logic-6 | chat/world-tools.ts source 字段无枚举校验 | 后端逻辑，需 LLM 传非法字符串才触发 |
| M-Logic-7 | debug/sse.ts TCP 半开连接检测缺失 | 资源泄漏，长时间运行才暴露 |
| M-Collab-1 | visualizer-ui api.js adminUpdateStream 死代码 | 旧前端路径，frontend-demo 实测不触发 |
| M-Collab-3 | /api/scheduler/mode 全局影响 | 多项目场景，单项目实测不触发 |
| M-Collab-4 | /api/projects/scan 任意 root 路径 | 安全专项 |
| M-Collab-5 | compareVersions git ls-remote 无超时 | 需远程不可达才触发 |
| M-Collab-6 | Tauri sidecar 生产模式 inherit stdio | 需打包后从命令行启动才暴露 |
| M-Sec-* | HTTP 安全头缺失 / chat 持久化日志 / novel-json 无 schema / auth.json 明文 | 安全专项 |
| M-Qual-3 | frontend-demo debug.js 无虚拟列表 | 短期实测不易触发卡顿 |
| M-Qual-4 | graph-3d.js focusSelected setTimeout 无清理 | 需快速切换视图才触发 |
| M-Qual-6 | nodeLabel/linkLabel 未转义 HTML | 需实体名含 HTML 字符才触发 |
| M-Qual-7 | sidecar 不混淆不剥离注释 | 构建产物安全 |
| M-Qual-8 | main-session dispose 不清理 services | 后端逻辑 |

### 7.4 已修复并验证项（前端 bug 清单 §5）

前端 bug 清单 §5 已记录以下修复项，本审计复核确认状态：

| 已修复项 | 当前状态 | 备注 |
|---|---|---|
| SSE 头部延迟 30s 才冲刷（空缓冲时）→ 加 `flushHeaders()` + `:connected` 首条注释 | ✅ 仍在 | `src/debug/sse.ts`、`src/app/routes-chat.ts`，带回归测试 |
| 事件链点击跳顶 → `eventSelectEvent` 改定向 DOM 更新 | ✅ 仍在 | `frontend-demo/views/events.js:395` |
| 聊天 agent_end 后内容被旧会话覆盖 → sessions 加 live 标记、status 加 sessionId | ✅ 仍在 | `studio.js stResolveSessionId` 一律对齐 live 会话 |
| `collectSubmission` 工具失败导致 Node 24 未处理 rejection 崩溃 → rejection observer | ✅ 仍在 | `src/agents/collect.ts:39`。**但同文件 M-Qual-1 发现新子问题：details undefined 时静默 resolve** |

### 7.5 核对结论

- **重叠项 10 条**：两份报告交叉印证，主要在 EventQueue 语义、status 轮询、storyTime 初始化、竞态、错误展示等。合并修复可一次解决。
- **盲区 7 条**：前端 bug 清单基于浏览器实测，在**前后端语义错位、DTO 字段对齐、视图失效机制**上比本审计更深入。本审计盲区主要为"未逐一核对 DTO 字段"和"未深究视图失效机制"。
- **独有项 26+ 条**：本审计覆盖了前端 bug 清单未触及的**安全面、后端逻辑、资源泄漏、构建产物**等。互补价值明显。
- **建议**：两份报告合并作为修复排期输入。第一梯队优先做本审计 🔴-1/2/5/6/7/8/9 + 前端 bug 清单 P0（storyTime 初始化顺序 / queue.length 语义 / status 轮询瘦身 / 队列错误可见化）。

---

## 8. 审计方法与存疑项

### 8.1 审计方法

- **4 个子代理并行**，按模块分片：旧审计复核 · 后端逻辑 · 前端逻辑 · 前后端协同与安全
- 每个代理独立读源码核实，未臆测接口（遵循"以查档求证为荣"）
- 跨模块重复发现已去重并标注交叉印证（如 🔴-4 与前端 bug 清单 §1.3-1）
- 本报告所有行号均以当前源码为准
- 本次仅审计未修改任何文件

### 8.2 存疑项（需进一步查证）

- pi SDK `AuthStorage.create` 是否对 auth.json 设置文件权限（chmod 600）—— 需查 `@earendil-works/pi-coding-agent` 源码
- `SessionManager.subscribe` 是否保证 `agent_end` 必发——前端 bug 清单 §1.2 也标记为未验证
- `npm audit` 未运行（package-lock.json 内容未审查），建议 CI 加 `npm audit --production`
- pi-ai `streamSimple` 的并发上限与速率限制行为未审查

### 8.3 下次审计补强方向

基于本次盲区（§7.2），下次审计应：

1. **逐一核对前后端 DTO 字段**：不只看端点存在性，要对比每个字段的类型、可选性、命名一致性。
2. **深究视图失效机制**：驻留视图在数据变更后如何刷新（轮询/SSE/广播/手动）。
3. **会话管理全链路**：session 创建/切换/恢复/删除的前后端语义对齐。
4. **表单字段完整性**：每个写入路径的表单字段是否覆盖后端 schema 要求。

---

**报告结束。** 建议第一梯队 7 项立即处理，第二梯队 7 项本迭代处理。需要针对任何一项给出具体修复 patch，或对某模块做更深一轮审查，请告知。

---

## 附录：批次 1 修复状态（2026-08-04）

> 第二阶段批次 1（分支 `20260804-orch-skeleton-security`）针对本审计高/中严重度项的修复状态。详细执行记录见 `docs/plans/2026-08-04-phase2-plan.md` 附录 A。

### 🔴 高严重度

| 编号 | 状态 | 证据 |
|---|---|---|
| 🔴-1 CORS `*` + 无鉴权 | ✅ tier1 已修 | 2026-08-03-fix-audit-tier1 已修并测过 |
| 🔴-2 commit 一致性缺口 | ✅ fixed（master 已修，本批补文档） | `service.ts:132-150` catch 块从 err 取 appliedEventIds，部分写入时保留 plan；测试 `pipeline 部分写入失败：commit 回传实际 appliedEventIds（L-Test-1）` 覆盖 |
| 🔴-3 子代理无超时 | ✅ fixed（master 已修，本批补文档） | `collect.ts:25-54` `timeoutMs=180_000` 默认值 + 超时 reject |
| 🔴-4 EventQueue 无界 | ✅ fixed（master 已修，本批补文档） | `event-queue.ts:35-66` `maxLength=200` + `finishedTtlMs=1h` + `sweepFinished` 惰性清理；测试 `event-queue.test.ts` 5 项覆盖 |
| 🔴-5 路径遍历 | ✅ fixed（master 已修，本批补文档） | `path-guard.ts` `assertPathInside` + 5 处入口调用：`orchestrator.ts:567 resolveChapterPath` / `chapter-tools.ts:37,68 chapter_read/write` / `import-card.ts:126 parseCardFile` / `import-tools.ts:20`；测试 `path-guard.test.ts` 覆盖 |
| 🔴-6 Tauri CSP 关闭 | ✅ fixed（master 已修，本批补文档） | `tauri.conf.json:23` 完整 CSP（default-src 'self'; script-src 'self' 'unsafe-inline'; ...） |
| 🔴-7 请求体/SSE | ✅ tier1 已修 | 2026-08-03-fix-audit-tier1 |
| 🔴-8 onclick XSS | ✅ tier1 已修 | 2026-08-03-fix-audit-tier1 |
| 🔴-9 WebGL 泄漏 | ✅ tier1 已修 | 2026-08-03-fix-audit-tier1 |
| 🔴-10 renderInline javascript: | ✅ 已修 | visualizer-ui 删除 + vendor 本地化 |
| 🔴-11 CDN SRI | ✅ 已修 | visualizer-ui 删除 + vendor 本地化 + .gitattributes |

### M 中严重度（本批涉及）

| 编号 | 状态 | 证据 |
|---|---|---|
| M-Logic-2 chapter_write ok=false 不抛错 | ✅ fixed（master 已修，本批补文档） | `chapter-tools.ts:73-77` 缺 targetEventId 抛错 |
| M-Logic-9 2s 轮询无退避 | ✅ fixed（master 已修，本批补文档） | `studio.js:157-184` 动态间隔（busy 2s / idle 10s / 失败指数退避 2→30s） |
| M-Logic-12 EventSource 无退避重连 | ✅ fixed（master 已修，本批补文档） | `api-client.js:218-264` 指数退避 1→30s + onError 仅首次通知 |
| M-Collab-3 /api/scheduler/mode 全局影响 | ✅ fixed（master 已修，本批补文档） | `routes-scheduler.ts:225-228` 要求活跃项目上下文 |
| M-Qual-1 collect details undefined 静默 resolve | ✅ fixed（master 已修，本批补文档） | `collect.ts:67` details 缺失时显式 reject |
| M29 tauri prebuild 不触发 | ✅ fixed（master 已修，本批补文档） | `tauri.conf.json:9` `beforeBuildCommand: "node ../scripts/package-sidecar.mjs"` |

### M 中严重度（本批未涉及，留待后续批次）

| 编号 | 状态 | 后续批次 |
|---|---|---|
| M-Logic-1 llm-config getApiKey 回退链 | ✅ fixed（批次 2 文档同步） | `llm-config.ts:144` getApiKey 只从 resolveConfig(slot) 取 key，不再跨 provider 借 key |
| M-Logic-3 CommitSummary.errors 丢 role 错误 | ✅ fixed（批次 2 文档同步） | `orchestrator.ts:464-468` 聚合 trace.roleErrors 到 errors 数组 |
| M-Logic-4 yolo 空输出继续渲染 | ✅ fixed（批次 2 文档同步） | `orchestrator.ts:329-348` outputs 为空时跳过后半链路，返回含错误信息的 commit |
| M-Logic-5 role-tools 缺 aborted 状态 | ✅ fixed（批次 3 文档同步） | `role-tools.ts:60` + `render-tools.ts:42` 处理 `stopReason === "aborted"` |
| M-Logic-6 chat/world-tools source 无枚举校验 | ⏳ 复核 | 本批核对：`world_event_apply` 的 source 字段已用 `Type.Union([Type.Literal("engine"), Type.Literal("user")])`（world-tools.ts:88），审计可能针对其他字段，后续复核 |
| M-Logic-7 debug/sse TCP 半开连接泄漏 | ✅ fixed（批次 3 文档同步） | `debug/sse.ts` markDead + TCP 半开探测（writableLength 持续非零超 60s 判死连接清理） |
| M-Logic-8 navigate 替换 viewState 引用 | ✅ fixed（批次 2 文档同步） | `app.js:184-187` 浅合并 viewState，不替换整个 App.viewState 引用 |
| M-Logic-11 events.js storyTime 竞态 | ✅ fixed（批次 2 文档同步） | `events.js:51` + `graph.js:51` 代际守卫（seq 检查），过期请求写入丢弃 |
| M-Collab-2 message_end 未处理 | ✅ fixed（批次 2 新写） | `studio.js` stHandleChatEvent 处理 message_end，stopReason=error 时 live 消息标红 |
| M-Collab-5 compareVersions git ls-remote 无超时 | ✅ fixed（批次 3 复核确认） | `updater.ts:67` `timeoutMs ?? 5000` 默认 5s 超时 + kill 子进程（BUG-009 修复时已加，本批复核确认） |
| M-Sec-1 HTTP 安全头缺失 | ⏳ 待修 | 后续批次 |
| M-Sec-2 chat 持久化日志未明示 | ✅ fixed（批次 3 复核确认） | `routes-chat.ts:91-96` M-Sec-2 修复：不落盘用户输入原文，仅记录 chars 长度等元信息 |
| M-Sec-3 novel-json 无 schema | ⏳ 待修 | 批次 5 |
| M-Sec-4 auth.json 文件权限 | ✅ 已查证（§〇） | SDK 已设 0o600 |
| M-Qual-5 串行角色注入多条 user message | ⏳ 待修 | 批次 5 |
| M2/M6/M10/M13/M14 数据/工具层 | ⏳ 待修 | 批次 5 |
| M17/M18/M19 admin 死代码 | ⏳ 待修 | 批次 6 |
| M4b/M4c novel-importer | ⏳ 待修 | 批次 6 |
| M20/M22/M24/M25/M27/M28 Tauri/构建残留 | ⏳ 待修 | 批次 6 |
