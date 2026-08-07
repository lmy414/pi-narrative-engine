# narrative-engine 代码审查报告（2026-08-07）

> **审查性质**：只读审查，未修改任何文件。所有发现均基于源码实证（行号引用），未臆测接口。
> **审查方法**：主干精读（main/unified-server/orchestrator/event-queue/path-guard/llm-config/ports/collect）+ 6 个子代理并行分模块查证（服务层与子代理 · admin+novel-launcher · novel-importer+renderer · role-pool+scheduler · 前端 frontend-demo · 前端重审），主审人对关键发现二次核实。
> **审查基线**：master 分支 `afb2b8c`（2026-08-06 设置页重构）。
> **变更背景**：自 2026-08-03 上次审计以来：08-03 审计 11 个 🔴 的批次 1-4 修复完成（本报告 §1 逐项核闭环）、BUG-019 编排结果面板、BUG-028~036 批量修复（含 commit 链路超时兜底）、M 系列清理、模型配置/厂商管理重构（启用模型制）。
> **关联文档**：
> - 上次审计：[2026-08-03-code-audit.md](./2026-08-03-code-audit.md)
> - BUG-028 排查：[2026-08-06-orchestrator-commit-stuck.md](./2026-08-06-orchestrator-commit-stuck.md)

---

## 0. 总览

| 维度 | 评分（0-10） | 说明 |
|---|---|---|
| 旧审计闭环（11 🔴 + M 系列） | 9 / 10 | 全部闭环或部分闭环，**残留 2 处**：🔴-3 超时兜底只覆盖后半链路；🔴-5 路径防护漏掉主会话渲染工具 |
| 服务层（app/routes/chat-context） | 7 / 10 | 分层清晰、契约成熟；短板在生命周期管理（释放路径不完整） |
| packages（admin/launcher/importer/renderer/role-pool/scheduler） | 7.5 / 10 | 工程质量高；admin 并发写无串行化、importer 两条路径假设不一致 |
| 前端 frontend-demo | 7.5 / 10 | 转义纪律主路径到位；残留属性裸插值族 + 若干竞态 |
| 安全面 | 6 / 10 | 主攻击面（CORS/路径遍历）已收口；**残留 1 个任意文件读写洞 + 1 个符号链接绕过** |
| 测试覆盖 | 7 / 10 | 60 个测试文件，后端关键路径覆盖好；前端视图层与 SSE 链路缺测 |

**全局结论**：08-03 审计的修复质量高、闭环率超过 9 成，批次修复均有测试与文档留痕。本轮发现的 4 个 🔴 高严重度问题全部是**修复的遗漏面**（同一问题的另一半入口），而非全新架构问题：

1. **🔴-A 主会话渲染工具任意路径读写**（08-03 🔴-5 的遗漏面）：`chat/render-tools.ts` 四个工具 + `checker.ts` 直接透传 LLM 提供的 `chapterPath`，无 `assertPathInside`——同一仓库子代理版 `agents/chapter-tools.ts` 已防护，主会话版漏网。
2. **🔴-B 前半链路无整体超时**（08-03 🔴-3 的遗漏面）：BUG-028 的 `promptAndCollectWithTimeout` 只包了 reasoning/renderer；planner/role 仍是裸 `await agent.prompt("")`，LLM 无响应时编排器死锁（BUG-028 文档自述该模式"超时兜底形同虚设"）。
3. **🔴-C 导入 causedBy 链断裂**（novel-importer）：被跳过的事件仍被后续事件引用为前驱，运行时 `world_event_chain` 回溯即抛错。
4. **🔴-D 导入 P0 死亡实体假阳性**（novel-importer）：终态存活集合校验历史 Fact，含死亡角色的导入必然误判失败。

---

## 1. 旧审计（2026-08-03）闭环核对

### 1.1 🔴 高严重度（11 项）

| 编号 | 问题 | 状态 | 证据 |
|---|---|---|---|
| 🔴-1 | CORS `*` + 无鉴权 | ✅ 已修复 | `unified-server.ts:43-58` Origin 白名单（tauri + 本机同端口）+ 403 拒绝 + 回显精确 Origin |
| 🔴-2 | commit appliedEventIds 一致性 | ✅ 已修复 | `orchestrator.ts:446-447` appliedSink 写工具真实记录；错误路径 `err.appliedEventIds` 回填（476-478、509-513） |
| 🔴-3 | 子代理无超时 | ⚠️ **部分修复（残留）** | 后半链路 `promptAndCollectWithTimeout`（orchestrator.ts:55-86，abort + 300s）；**planner/role 仍裸 `await prompt("")`**（252-254、318-321），见 🔴-B |
| 🔴-4 | EventQueue 无界 | ✅ 已修复 | `event-queue.ts:71-73` maxLength=200 + finishedTtlMs=1h + sweepFinished 惰性清理 |
| 🔴-5 | 路径遍历 | ⚠️ **部分修复（残留）** | `path-guard.ts` + 子代理 chapter-tools / parseCardFile / import epubPath / resolveChapterPath 已防护；**主会话 chat/render-tools + checker 漏网**，见 🔴-A |
| 🔴-6 | Tauri CSP 关闭 | ✅ 已修复 | `tauri.conf.json:23` 完整 CSP（default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 本机） |
| 🔴-7 | 请求体/超时/SSE | ✅ 已修复 | readBody MAX_BODY_SIZE（413）；`unified-server.ts:330-331` headersTimeout/requestTimeout；SSE 全局配额 10（128-139） |
| 🔴-8 | onclick 字符串拼接 XSS | ✅ 已修复 | 前端代理核实：q()/data-* 迁移完成，`escapeHtml` 完整转义 `& < > " '` 五种（demo-utils.js:56-58） |
| 🔴-9 | graph.js WebGL 泄漏 | ✅ 已修复 | 前端代理核实：`_destructor()` + `cleanupGraphView` 已存在 |
| 🔴-10 | renderInline javascript: 绕过 | ✅ 已修复 | visualizer-ui 整目录删除，风险面消失 |
| 🔴-11 | CDN 无 SRI | ✅ 已修复 | vendor 本地化 + integrity（index.html:11-18）；**残留**：Google Fonts 仍走外部 CDN（低影响，Tauri CSP 会拦截导致字体降级） |

### 1.2 M 中严重度（抽查关键项）

| 编号 | 问题 | 状态 | 证据 |
|---|---|---|---|
| M-Logic-1 | getApiKey 跨 provider 借 key | ✅ 已修复 | `llm-config.ts:204-235` key 只来自解析到的这份配置，注释留痕 |
| M-Logic-3 | CommitSummary.errors 丢 role 错误 | ✅ 已修复 | `orchestrator.ts:519-521` 聚合 trace.roleErrors |
| M-Logic-4 | yolo 空输出继续渲染 | ✅ 已修复 | `orchestrator.ts:376-391` outputs 为空时跳过后半链路 |
| M-Logic-7 | debug/sse 半开连接泄漏 | ✅ 已修复 | `debug/sse.ts` markDead + writableLength 探测（**但 chat SSE 未同步**，见 🟠-2） |
| M-Collab-3 | /api/scheduler/mode 全局影响 | ⚠️ 部分修复 | 已要求活跃项目上下文；但仍是**模块级全局单例**，切项目不重置（见 🟡-3） |
| M-Collab-4 | /api/projects/scan 任意 root | ✅ 部分 | scan 有 defaultScanRoots 白名单；**meta/activate 未套白名单**（见 🟡-4） |
| M-Sec-1 | HTTP 安全头缺失 | ✅ 已修复 | `unified-server.ts:187-189` nosniff/DENY/no-referrer 统一下发 |
| M-Sec-2 | chat 输入持久化 | ✅ 已修复 | 仅记录 chars 长度等元信息，不落盘原文 |
| M-Sec-3 | novel-json 无 schema | ✅ 已修复 | `novel-json.ts:127-132` null/非对象/数组守卫 |
| M-Sec-4 | auth.json 权限 | ✅ 已修复 | `unified-server.ts:148-154` 显式 chmod 0o600（Windows no-op，注释存疑备案） |
| M-Qual-1 | collect details undefined 静默 resolve | ✅ 已修复 | `collect.ts:82-86` 显式 reject |
| M-Qual-5 | 串行角色多条 user message | ✅ 已修复 | `orchestrator.ts:298-308` 合并为单条 |

**闭环结论**：08-03 审计的修复承诺基本兑现（附录批次 1-4 与源码一致）。残留集中在两处「同一问题修复了一半」：超时兜底（🔴-3）与路径防护（🔴-5）。

---

## 2. 🔴 高严重度（本轮新发现，按优先级）

### 🔴-A. 主会话渲染工具任意路径读写（08-03 🔴-5 的遗漏面）【安全】

**位置**：
- [src/chat/render-tools.ts:61-64](file:///d:/claude/pi-ex/narrative-engine/src/chat/render-tools.ts#L61)（render_append / render_modify / render_preview / render_check）
- [src/checker.ts:137,147,152,164](file:///d:/claude/pi-ex/narrative-engine/src/checker.ts#L137)（readCheckTarget 直接 readChapter）
- [src/app/routes-scheduler.ts:122-125](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-scheduler.ts#L122)（dispatch 的 chapterPath 自由透传）

**现象**：主会话四工具把 LLM 参数 `p.chapterPath` 直接传给 `renderToFile`/`readChapter`。写路径经 `ensureChapterFile`（`packages/renderer/src/chapter-io.ts:61-125`）**自动 mkdir + writeFile**；读路径内容进入 LLM 上下文。对比同仓库子代理版 `agents/chapter-tools.ts:37,68` 已用 `assertPathInside`，主会话版是 🔴-5 修复时漏掉的入口。

**影响**：主会话 LLM 一旦被 prompt 注入（小说正文、世界图内容、导入的卡描述皆可携带指令），即可读写项目外任意文件（自动建目录 + 任意写 / 任意读进入上下文）。HTTP 侧 dispatch 的 chapterPath 同源无校验。

**建议**：四个工具 + checker.ts 读写前统一 `assertPathInside(provider.cwd, chapterPath, "章节文件路径")`；dispatch 入参同校验。

---

### 🔴-B. 前半链路（planner/role）无整体超时（08-03 🔴-3 的遗漏面）【可用性】

**位置**：
- [src/orchestrator.ts:252-254](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L252)（planner）
- [src/orchestrator.ts:318-321](file:///d:/claude/pi-ex/narrative-engine/src/orchestrator.ts#L318)（role）

**现象**：BUG-028 修复的 `promptAndCollectWithTimeout`（`orchestrator.ts:55-86`）只应用于 `runReasoning`/`runRenderer`。planner/role 仍是：
```ts
const plannerCollected = collectSubmission<...>(planner, "retrieval_plan");
await planner.prompt("");                    // LLM 无响应则此处永久挂起
plannerResult = await plannerCollected.promise;  // 走不到
```
`collect.ts` 的 180s 超时只 reject 产出 promise，**不取消 agent.prompt**——BUG-028 排查文档（`docs/audits/2026-08-06-orchestrator-commit-stuck.md` §三问题2）明确断言该模式"超时兜底形同虚设"。

**影响**：LLM 偶发无响应（deepseek 不稳定已知，BUG-025/026 同类）时，planner/role 永久挂起 → EventQueue 单消费者被阻塞 → 整个编排器死锁，`scheduler_queue_status` 永久 running。与 BUG-028 修复前行为完全一致。

**建议**：planner/role 复用 `promptAndCollectWithTimeout`（或 `Promise.race` 整体超时 + `agent.abort()`）。

---

### 🔴-C. 导入 causedBy 链断裂（悬空前驱）【数据完整性】

**位置**：packages/novel-importer/src/write.ts:153-156、173-177、269-273

**现象**：`buildCausedByChain`（write.ts:64-81）把每个事件的 causedBy 设为上一事件 eventId；`writeToGraph` 中 entity_hint 无法解析 / 重复 birth / 对未 birth 实体发 death 三条路径 `continue` 跳过 `wg.processEvent`，但**下一事件的 causedBy 仍指向这个从未写入日志的 eventId**。

**影响**：重复 birth 是 LLM 明确预期的常见场景（代码注释自述），一旦发生 events.jsonl 即出现悬空 causedBy。内核 `traceCauses`（world-graph.ts:951）遇悬空前驱直接抛「因果链前驱丢失」，而 `world_event_chain` 工具（src/chat/world-tools.ts:89）公开暴露该路径——用户回溯因果链即报错。P0 校验只查内存 chain，日志空洞查不出。

**建议**：跳过事件时把其 causedBy 转链给后一个实际写入的事件（或写占位行），阶段 8 增加"日志 causedBy 完整性"校验（读 events.jsonl 验证）。

---

### 🔴-D. 导入 P0 校验死亡实体假阳性【数据正确性】

**位置**：packages/novel-importer/src/validate.ts:284-301（配合 268-274）

**现象**：`allEntities = await wg.getAllEntities(lastStoryTime)` 只返回存活实体（内核按 validTo > storyTime 过滤）；随后对每个 change 事件 new_facts 检查 entityId 是否在该集合中。凡实体在本书中死亡/退场（含最后事件即 death），其此前写入的全部 change Fact 的 entityId 都不在集合中。

**影响**：任何含死亡/退场角色的小说导入必然在阶段 8 以 `P0: 事件 xxx 的 new_facts[].entityId 在 Entity 表中不存在` **假阳性失败**，数据实际是好的，错误信息误导排查。

**建议**：改为"该 entityId 是否曾 birth"语义（持久化 birthedEntityIds 集合，或按各 fact 的 validFrom 时刻分别查询），不要用终态快照做存在性判断。

---

## 3. 🟠 中严重度（按模块分组）

### 3.1 服务层（src/app、src/chat、src/visualizer）

- **🟠-1**：[src/visualizer/server.ts:89](file:///d:/claude/pi-ex/narrative-engine/src/visualizer/server.ts#L89) 静态服务路径校验 `startsWith(normalize(uiDir))` **缺路径分隔符**：`/%2e%2e/frontend-demo2/x` 解码后 normalize 到 uiDir 同级、名字以 `frontend-demo` 开头的兄弟目录即可放行读取（已实证 win32 路径行为）。利用条件：需 uiDir 同级存在该前缀目录。建议改为 `=== uiDir || startsWith(uiDir + sep)` 或复用 path-guard。
- **🟠-2**：[src/app/routes-chat.ts:248-292](file:///d:/claude/pi-ex/narrative-engine/src/app/routes-chat.ts#L248) chat SSE 无半开连接检测（对比 debug/sse.ts 有 markDead + writableLength 探测）：死连接永不清理，可占满全局 SSE 配额（10），之后所有 /api/chat/events 新连接 503 直到重启。建议移植 debug/sse.ts 模式。
- **🟠-3**：[src/app/chat-context.ts:233-251](file:///d:/claude/pi-ex/narrative-engine/src/app/chat-context.ts#L233) `ensureHost` TOCTOU 竞态：冷启动窗口内两个并发 POST /api/chat/message 双双通过检查，各建一个 host（双 runtime 并发写同一会话文件）。建议 in-flight 单飞（promise 缓存）。
- **🟠-4**：[src/app/chat-context.ts:465-506](file:///d:/claude/pi-ex/narrative-engine/src/app/chat-context.ts#L465) `activateSession` 前缀 id 匹配失效：池中会话用前缀命中时走 createHostForSession 打开**同一会话文件**再 `pool.set` 覆盖——旧 host 永不 dispose（双写 + 泄漏）。建议先做前缀匹配，命中则仅 setActive。
- **🟠-5**：[src/app/chat-context.ts:592-604](file:///d:/claude/pi-ex/narrative-engine/src/app/chat-context.ts#L592) `disposeRuntime` 只清映射不停 EventQueue（EventQueue 无 stop/dispose）：切换项目后旧队列继续后台执行、plan 状态丢失、切回时同项目双队列并发写同一 wg。建议 EventQueue 增加 dispose（等待/中止在跑任务）。
- **🟠-6**：[src/chat/render-tools.ts:61](file:///d:/claude/pi-ex/narrative-engine/src/chat/render-tools.ts#L61) + [src/chat/import-tools.ts:20](file:///d:/claude/pi-ex/narrative-engine/src/chat/import-tools.ts#L20)（与 Agent C 交叉印证）`import_novel` 的 `worldGraphDir` 参数无 `assertPathInside`（仅 epubPath 有）：LLM 可把世界图数据写到项目外任意目录（pipeline 自动 mkdir + 写 5 个文件）。建议 worldGraphDir 同样校验。
- **🟠-7**：[packages/admin/src/files.ts:70-87](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/files.ts#L70) 路径防护纯词法校验，**符号链接可绕过读边界**（`正文/notes.md → C:\Users\X\.ssh\id_rsa` 即任意读）。建议读写前 realpath 后二次包含性校验，或 lstat 拒绝符号链接。

### 3.2 admin / novel-launcher

- **🟠-8**：[packages/admin/src/app-config.ts:186-248](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/app-config.ts#L186)（同模式 files.ts:214 / env-store.ts:272 / rulesets.ts:145 / novel-json.ts:165）**五处并发写无串行化**：固定 `path + ".tmp"` 共享 tmp 路径 + 读-改-写竞态——两请求交错时一个必然 500（raw ENOENT）或配置更新静默丢失。建议每文件一个 promise 队列 + tmp 名带随机后缀。
- **🟠-9**：[packages/novel-launcher/src/discover.ts:47-48](file:///d:/claude/pi-ex/narrative-engine/packages/novel-launcher/src/discover.ts#L47) novel.json 内容为 `null` 时 TypeError 崩溃且拖垮整个扫描（对比 admin/novel-json.ts:127-132 有守卫）。建议照抄守卫 + 单项目失败隔离。
- **🟠-10**：[packages/admin/src/routes-ext.ts:322-325](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/routes-ext.ts#L322)（配合 discover.ts:93）`maxDepth` 传 NaN 时 `currentDepth >= NaN` 恒 false → **无界递归扫描**；负数静默空列表。建议路由层 `Number.isFinite && 1..10` 校验。
- **🟠-11**：[packages/admin/src/files.ts:217-221](file:///d:/claude/pi-ex/narrative-engine/packages/admin/src/files.ts#L217) utimes「取更大者」注释与实现不符（只 `new Date()` 未取 max）：粗粒度 mtime FS（FAT/SMB）上乐观锁失效。建议按注释实现 `max(baseMtime+1ms, now)`。

### 3.3 novel-importer / renderer

- **🟠-12**：[packages/novel-importer/src/pipeline.ts:432-491](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/pipeline.ts#L432) 导入不幂等：同目录二次导入撞 `decl-{entityId}-{property}-{storyTime}` 唯一键崩溃或数据翻倍，无"已导入"守卫。建议阶段 7 前检查 world.db 是否已有数据。
- **🟠-13**：[packages/renderer/src/chapter-io.ts:61-77](file:///d:/claude/pi-ex/narrative-engine/packages/renderer/src/chapter-io.ts#L61) append 不防重：同 eventId 重复追加产生双锚点，modify/read 永远命中首个，第二个区块成孤儿（LLM 复用 evt_ id 或失败重试时触发）。建议 append 前检查锚点已存在。
- **🟠-14**：[packages/novel-importer/src/stages.ts:155-204](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/stages.ts#L155) storyTime 只校验格式不校验同章唯一性与章号一致性：重复 storyTime 的 new_facts 被静默丢弃、跨章错序破坏 bi-temporal 单调性。建议阶段 3 增加唯一性 + 章号匹配校验。
- **🟠-15**：[packages/novel-importer/src/write.ts:248-253](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/write.ts#L248) 自动闭合只闭合每 property 最新一条未闭合声明，与注释"旧 Fact 全部闭合"及 commit.ts 语义不符。建议 findDeclarationId 返回全部未闭合。
- **🟠-16**：[packages/novel-importer/src/validate.ts:143-147](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/validate.ts#L143) P0"章节完整性"检查形同虚设（空章节也返回空 events 条目，检查恒通过）。建议改校验 `events.length > 0`。
- **🟠-17**：[packages/novel-importer/src/epub.ts:94-96](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/epub.ts#L94) 单章读取失败静默吞掉（epub2 getChapter 对 manifest 不匹配条目必失败，已实证）+ chapterId 为过滤后序号导致用户按原书目录选章选错。建议失败 warn 汇总 + chapterId 按原始序号。
- **🟠-18**：[packages/novel-importer/src/pipeline.ts:206-232](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/pipeline.ts#L206) 空导入静默"成功"（全书章节均过短/读取失败时返回 0 实体 0 事件导入完成）。建议阶段 1 后校验 chapters.length > 0。

### 3.4 role-pool / scheduler

- **🟠-19**：[packages/role-pool/src/role-pool.ts:47,57-62](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/role-pool.ts#L47) 角色交互循环对 LLM 失败无重试无超时：瞬时失败（限流/网络抖动）角色整场缺席且事件已消耗无法重跑；LLM 挂起则整条串行链无限阻塞。建议错误分类重试 + 退避 + 单次调用超时。
- **🟠-20**：[packages/role-pool/src/transforms.ts:76-90](file:///d:/claude/pi-ex/narrative-engine/packages/role-pool/src/transforms.ts#L76) extractRelations 对 source/target/label 零校验：LLM 漏填时经非 strict `addRelation` 静默写入 `rel--label-...` 垃圾关系（当前 commit 重接后立即暴露）。建议过滤空值/校验 ID 格式。
- **🟠-21**：[packages/scheduler/src/chapter-edit.ts:43-95](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/chapter-edit.ts#L43) insertChapterSection 读-改-写整文件无并发保护：与事件队列 append/modify 另一路径并发时后写者基于旧内容整体覆盖，先写者区块整块丢失（静默）。建议进程内写锁或 CAS。
- **🟠-22**：[packages/scheduler/src/chapter-resolver.ts:38-39](file:///d:/claude/pi-ex/narrative-engine/packages/scheduler/src/chapter-resolver.ts#L38) 无法解析的 storyTime 静默兜底第 1 章（污染 `第1章-未命名.md`）；且接受 `ch-<N>` 而引擎侧 validateStoryTime 显式拒绝——两套格式集并存。建议解析失败抛错 + 统一格式约定。

### 3.5 前端 frontend-demo

- **🟠-23**：[frontend-demo/views/graph.js:218](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L218)（及 graph.js:139、app.js:538-539/579-582、projects.js:153,185）**属性上下文转义漏点**：`data-entity-id="${e.entityId}"`、`<option value="${o.id}">`、弹窗 `value="${...}"` 裸插值；且 q()/flJs/settingsJs **不转义双引号**——值含 `"` 时可闭合属性注入新事件处理器（qe-entity 是自由文本输入，条件性 XSS）。同族：events.js:405/430/445 用原始 id 拼 querySelector（含 `"`/`\` 时 SyntaxError 使点击处理整体失效）。建议属性一律 escapeHtml、onclick 参数 q() 后整体 escapeHtml、querySelector 用 CSS.escape()。
- **🟠-24**：[frontend-demo/views/entity-detail.js:639-653](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/entity-detail.js#L639) openEntityDetail 快速点击不同实体时**后一次点击被丢弃**（守卫在 await 之后比对，先返回者胜出，与 reloadDetail 的 token 守卫语义相反）。建议开头同步设 id + 复用 detailReloadSeq。
- **🟠-25**：[frontend-demo/views/files.js:566-588](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/files.js#L566) 保存失败（非 mtime 冲突）后「保存」按钮永久禁用 + dirty 残留，无出口。建议 catch 恢复按钮。
- **🟠-26**：[frontend-demo/views/studio.js:412-445](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/studio.js#L412) 流式生成期间点击其他会话被静默忽略（studioBusy guard），与"多会话并存不阻塞切换"设计意图矛盾。建议 busy 只禁输入或给提示。
- **🟠-27**：[frontend-demo/views/graph.js:67-73](file:///d:/claude/pi-ex/narrative-engine/frontend-demo/views/graph.js#L67)（配合 events.js:56-64）全新空项目（storyTimes 为空）进入世界图/事件链必现 `STORY_TIME_REQUIRED` 400 错误 toast（后端已实测 400，mock 兜底不暴露）；事件链页 Promise.all 中 getGraph 失败导致 eventList 永不写入。建议 storyTimes 为空时跳过带 storyTime 请求直接渲染空态。

---

## 4. 🟡 低严重度（择机清理，按模块速览）

**服务层**：
- 🟡 LLM slot 配置"先持久化后应用"（routes-ext.ts:506-520）：落盘后 setConfig 抛错则分叉，下次启动重放失败。建议先 store 后落盘。
- 🟡 provider-models.ts:30-31 fetch 缓存仅按 provider.id 键控：更新 baseURL/Key 后 60s 内返回旧模型列表。
- 🟡 scheduler-tools.ts:47-55 标称"会话级默认模式"实为模块级全局单例，切项目不重置。
- 🟡 routes-ext.ts:331-339 `GET /api/projects/meta?dir=` 无 scan 白名单（口径不一致，纵深防御缺口）。
- 🟡 routes.ts:102-106 / routes-ext.ts:201-205 畸形 % 编码 decodeURIComponent 在 try 外抛 URIError → 500 而非 400。
- 🟡 chat-context.ts:669-686 sendChatMessage 同步抛错时 status=streaming 永不复位。
- 🟡 routes-ext.ts:606-613 自定义厂商 apiKind 无枚举校验（非法值落盘后到调用时才炸）。
- 🟡 session-pool.ts:15 池无上限无删除端点，每次 createSession 一个完整 runtime，只增不减。
- 🟡 project-registry.ts:73-127 openProject 幂等检查与 WorldGraph.create 之间无并发保护（db 句柄泄漏）。
- 🟡 world-tools.ts:94 world_query 无 embedder 缺失 → fulltext 兜底（当前不可达，防御性）。

**admin / launcher**：
- 🟡 app-config.ts:153-158 损坏配置被静默当默认值，下次写入即覆盖（丢失槽位配置）。
- 🟡 defaultScanRoots 无 Array.isArray 校验，写入字符串后 scan 永久 500。
- 🟡 原始 fs 错误消息直出响应（含绝对路径泄漏）；doctor 泄漏 HF_ENDPOINT 值；pi-status warnings 带底层错误原文。
- 🟡 env-store.ts:69-93 quoteValue/unquoteValue 不对等（引号值往返损坏）。
- 🟡 embedder-status.ts:65-79 _dirSize 串行 stat，大缓存耗时数秒。
- 🟡 project.ts:62-64 模板替换 `$&`/`$'` 特殊序列干扰（项目名含 $ 时错误）。
- 🟡 files.ts:200-213 文件不存在时 baseMtime 被静默忽略（乐观锁语义不完整）。

**importer / renderer**：
- 🟡 renderer.ts:53-64 modify 模式把全文当上下文（与 types.ts 文档"锚点区间+前后段落"矛盾）。
- 🟡 chapter-io.ts:121 modify 重写后锚点间隔缺空行（格式约定漂移）。
- 🟡 chapter-io.ts:76,124 读全文+整文件覆写非原子（O(n²) 累计；崩溃留截断文件）。
- 🟡 resolve.ts:518-520 LLM 裁决的 canonical_name 被完全忽略（规范名取组内首个变体）。
- 🟡 prompts.ts:23-28 阶段 2 预扫描 prompt 无章节数上限（数百章书籍数十万 token 超上下文）。
- 🟡 import-card.ts:64,129-130 畸形输入（spec 非字符串 / JSON null）产生不可诊断 TypeError。
- 🟡 stages.ts:243,252 onProgress done 恒为 0（进度条不动）；write.ts:474-491 chapter-index eventCount 含被跳过事件。

**role-pool / scheduler**：
- 🟡 role-pool.ts:42 onTurnStart 钩子在 try 外，钩子抛错中断整个 interact。
- 🟡 prompts.ts 角色卡/规则集无定界转义（内容即提示词，标记字面量可破坏结构）。
- 🟡 chapter-edit.ts:53 锚点重复时 indexOf 取首处静默错位；utils.ts randomId 用 Math.random() 碰撞空间小。
- 🟡 scheduler dist/ 残留已删模块（plan/commit/retrieve/cache）陈旧编译产物；注释仍引用已删文件。

**前端**：
- 🟡 files.js:419-425 快速双击同文件可重复 tab；debug.js 状态数组无限增长 + 每次全量 O(n) 过滤；api-client.js:38 非 JSON 响应抛 TypeError 噪音；projects.js menuId 未转义 + `$('#id')` 遇 CSS 特殊字符失效；studio.js:91-112 stLoadData 无代际守卫；studio.js:1056-1057 plan 字段裸访问。

---

## 5. 测试覆盖缺口

- **escapeHtml / q() 转义本身无任何测试**（无 XSS 回归用例；🔴-8 曾靠浏览器实测而非单测）。
- **app.js / views/* 视图层无测试**：路由解析、navigate 双清路径、项目切换 resetProjectScopedState、syncStoryTime、代际守卫、storyTimeWatcher 启停（仓库无 jsdom，补测需引入 DOM 环境——08-03 审计已评估成本高，由 browser_use 测试轮纪律承担，但转义函数属纯函数应可补）。
- **SSE 链路整段缺测**：frontend-api-client.test.ts 仅断言 URL 与 close；unified-server.test.ts 无 EventSource 流式测试（chat/debug SSE 推送、半开清理、重连退避均未覆盖）。
- **空项目路径缺测**：后端 400 已测（unified-server.test.ts:1074），前端"storyTimes 为空渲染空态"分支无测试。
- **导入校验假阳性（🔴-D）与 causedBy 完整性（🔴-C）无测试**：现有 importer 测试（epub/stage2/stage3/smoke）未覆盖跳过路径与死亡实体场景。
- **并发写（🟠-8）无测试**：admin 各写模块的并发交错场景无覆盖。

---

## 6. 模块总体评价

- **服务层**：分层清晰（薄路由 → ChatContext/ProjectRegistry → 工具/子代理），错误 code→HTTP 映射、envelope 契约、SSE 配额等基建成熟，修复留痕（M-*/BUG-*）可追溯性好。短板集中在**生命周期管理**：host/池/队列/SSE 的创建都有防护，但释放路径不完整（队列无 stop、旧 host 无回收、chat SSE 无半开检测、session 池无上限）。
- **admin / launcher**：工程质量最高模块——统一 AdminError 错误码、五处原子写、乐观锁、扩展名双向白名单、路径防护与 path-guard 同思路。缺口：并发写零串行化（唯一真实一致性隐患）、符号链接未纳入防护、discover 容错是全仓最弱一环。
- **importer / renderer**：阶段管道职责清晰、LLM 输出校验完备、写入侧对 LLM 噪声做系统性去重。核心缺陷是**写入与校验两条路径对同一数据的不一致假设**（causedBy 断裂、终态快照校验过程数据），错误表现极具迷惑性。
- **role-pool / scheduler**：role-pool 干净利落（无状态串行编排、纯函数 transforms、类型严格）；最大缺口是失败语义（无超时无重试无输出校验）。scheduler 是"壳"形态（plan/commit 已迁至引擎层），残留已删模块引用与 dist 陈旧产物。
- **前端**：状态命名空间双写、三段式调度、代际守卫已成体系，SSE/轮询路由切换对称清理无泄漏，LLM 文本主路径转义执行到位。残余问题集中在转义纪律零散漏点（同一 ID 家族）与错误路径边界缺陷。

---

## 7. Top 修复建议（按优先级）

**第一梯队（安全/数据正确性，建议立即处理）**：
1. 🔴-A 主会话渲染工具 + checker 路径防护（复用 assertPathInside）
2. 🔴-B planner/role 整体超时（复用 promptAndCollectWithTimeout）
3. 🔴-C causedBy 链修补 + 日志级校验
4. 🔴-D P0 改为"曾 birth"语义

**第二梯队（一致性/健壮性，建议本迭代处理）**：
5. 🟠-8 admin 五处并发写串行化（单修复模式，一次修齐）
6. 🟠-3/4/5 chat-context 生命周期（ensureHost 单飞、activateSession 前缀、EventQueue dispose）
7. 🟠-2 chat SSE 半开检测（移植 debug/sse.ts）
8. 🟠-7 符号链接 realpath 校验（与 path-guard 同步加固）
9. 🟠-23 前端属性转义族（含 q() 双引号洞）
10. 🟠-19 role-pool 超时重试

**第三梯队（清理项，择机批量处理）**：
- 🟠-9~22 各包容错/幂等/校验补齐；🟡 全部；测试缺口按 §5 逐项补。

---

## 8. 审计方法与存疑项

### 8.1 方法
- 主干 12 个文件精读（主审人）+ 6 个子代理并行分片（每片通读全部文件、交叉验证外部依赖源码），关键发现由主审人二次核实（render-tools 路径面、collect 超时语义、CSP/SRI 状态、server.ts startsWith 绕过条件）。
- 旧审计闭环逐项对照当前源码验证，行号以 `afb2b8c` 为准。

### 8.2 存疑项（需进一步查证）
- main.ts shutdown 时 `server.close()` 会等待活跃 SSE 连接关闭——客户端不断开时关闭流程是否挂起（Node 行为，未实测）。
- `traceCauses` 对悬空前驱的抛错行为基于 underworld-graph 源码阅读（world-graph.ts:951），未在运行时复现。
- Tauri CSP 下 Google Fonts 外部样式是否被拦截导致字体降级（未在 Tauri 壳内实测）。

---

**报告结束。** 建议第一梯队 4 项立即处理（均为既有修复的遗漏面，修复模式已有先例）。需要针对任何一项给出修复 patch 或深入某模块，请告知。

---

## 9. 批次 1 修复闭环（2026-08-08）

> 修复前置：2026-08-07 修复前核对排查（[2026-08-07-code-audit-fix-verification.md](./2026-08-07-code-audit-fix-verification.md)）对 4 个 🔴 逐一实证，其中 🔴-A 影响面（dispatch 已有下游 resolveChapterPath 双重防护）与 🔴-D 首选方案（WriteResult 透传 birthedEntityIds）按核对结论落地。
> 分支：`20260808-audit-fix-batch1` → master（ff-only）。全量测试 722/722 通过。

| 编号 | 修复内容 | 证据 |
|---|---|---|
| 🔴-A | ✅ 主会话渲染工具 + checker 路径防护 | `render-tools.ts` 四工具 execute 内 `assertPathInside(provider.cwd, chapterPath)`（preview 可选参数有值即校验）；`checker.ts` CheckCtx 增加必填 `cwd`，`checkNarrative` 入口校验（防御纵深，独立导出亦自保）；`routes-scheduler.ts` dispatch 入队前校验 + `PATH_ESCAPE: 403`（纵深防御，下游 resolveChapterPath 兜底保留） |
| 🔴-B | ✅ planner/role 接入整体超时 | `orchestrator.ts` `promptAndCollectWithTimeout` 加 export，planner（300s）/role 循环（300s/角色）替换裸 `await prompt("")`；顺带修复原成功/失败路径 `collectSubmission.dispose()` 泄漏（finally 保证）；超时抛错语义与既有 catch 兼容（planner 转 error、role 记 errors 不阻断） |
| 🔴-C | ✅ causedBy 链修补 + 阶段 8 日志级校验 | `write.ts` `writeToGraph` 维护 `lastWrittenEventId`，三条跳过路径（entity_hint 未解析/重复 birth/未 birth death）不更新，成功写入才更新，后续事件 causedBy 重链；`validate.ts` 新增日志完整性校验（`wg.getAllEvents()` 查悬空前驱，P0 阻断）——内核 0.2.x 升级后遇悬空即抛错，已前置拦截 |
| 🔴-D | ✅ P0 改「曾 birth」语义 | `WriteResult` 增加 `birthedEntityIds`（write.ts 运行时集合随结果返回，核对报告首选方案）；`validate.ts` factEntityId 解析复用 `resolveEntityId`（export，含别名兜底，消漏报）；报错条件改「现存 ∪ 曾 birth 皆不含」；pipeline resume fallback 同步补字段 |

**新增/更新测试（18 个新用例，722 全绿）**：
- `tests/render-tools.test.ts`（新建，6 用例）：四工具越界 chapterPath → PATH_ESCAPE；界内相对路径真实写入成功
- `tests/checker.test.ts`（+1 用例 + 全量补 cwd）：越界 chapterPath → PATH_ESCAPE
- `tests/e2e-renderer.test.ts`：checkNarrative 调用补 cwd
- `tests/orchestrator-timeout.test.ts`（新建，3 用例）：LLM 无响应 → 整体超时 + abort；正常提交路径；工具失败不 abort
- `packages/novel-importer/tests/write.test.ts`（新建，5 用例）：正常链逐级衔接；重复 birth / 未 birth death / entity_hint 未解析 / 已 dead 重复 death 四场景日志无悬空 causedBy
- `packages/novel-importer/tests/validate.test.ts`（新建，3 用例）：死亡实体导入 P0 通过（修复前假阳性）；从未 birth 引用仍报；日志悬空 causedBy 报 P0

**遗留（下一批）**：🟠-1~27 与 🟡 全部（按核对报告第二/三梯队排期）。

---

## 10. 批次 2a 修复闭环（2026-08-08，第二梯队后端项）

> 分支：`20260808-audit-fix-batch2a` → master（ff-only）。全量测试 737 项：735 pass / 0 fail / 2 skip（符号链接用例在本机 Windows 无创建权限自动跳过，逻辑在有权限环境执行）。

| 编号 | 修复内容 | 证据 |
|---|---|---|
| 🟠-8 | ✅ admin 五处并发写串行化 | 新建 `packages/admin/src/serialize.ts`（`createWriteQueue`：每模块一队列，tail 吞 rejection 防链断）；读-改-写类三处（app-config / env-store / novel-json）整体入队；全量覆盖类两处（rulesets / files）+ `_atomicWrite` 的 tmp 名改随机后缀。并发写不同字段不再静默丢更新 |
| 🟠-5 | ✅ EventQueue 增加可中止 stop | `event-queue.ts` 新增 `stop()`（幂等；pending 置 error、in-flight 允许完成、泵循环停止后不再取新任务、enqueue 抛错）；`OrchestratorService.dispose()` 接线；`ChatContext.disposeRuntime` 清映射前逐个 `service.dispose()`——切项目后旧队列不再消费新任务，消除同项目双队列并发写 wg |
| 🟠-3 | ✅ ensureHost 单飞 | `chat-context.ts` `ensureHostPromise` promise 缓存 + 完成后二次校验（单飞期间项目再切换则重建）——冷启动窗口并发请求共享同一 host，消除双 runtime 并发写同一会话文件 |
| 🟠-4 | ✅ activateSession 前缀命中回收 | `SessionPool.match(id)`（精确优先、前缀唯一）；`activateSession` 池内前缀命中仅 `setActive`——不再重开同一会话文件 + `pool.set` 裸覆盖（旧 host 泄漏 + 双写） |
| 🟠-2 | ✅ chat SSE 半开检测 | `routes-chat.ts` handleChatEvents 移植 debug/sse.ts 模式：markDead + send 探测 + writableLength 60s 判死 + req/res 双监听 + cleanup 前置声明；守卫用严格布尔比较（`=== true/false`），避免 mock/降级对象缺字段误判 |
| 🟠-7 | ✅ 符号链接 realpath 二次校验 | `admin/files.ts` 新增 `assertNoSymlinkEscape`（realpath 后包含性校验，目标不存在时上溯最近存在祖先）；read/write/create/delete/rename 五入口接入——`正文/notes.md → ~/.ssh/id_rsa` 类绕过被 PATH_ESCAPE 拒绝 |
| 🟠-19 | ✅ role-pool 单次调用超时 + 错误分类重试 | `role-pool.ts` `callLlmWithRetry`：单次 60s 超时（Promise.race + clearTimeout）+ 瞬时错误（限流/网络/超时）指数退避重试最多 3 次；永久错误不重试。超时后底层调用无法取消（接口无 abort 承载点），但串行链不再被无限阻塞 |

**新增/更新测试（15 个新用例，737 全绿）**：
- `packages/admin/tests/serialize.test.ts`（新建 2）：队列串行、失败不中断后续
- `app-config.test.ts`（+2）：并发写不同字段不丢更新、无 .tmp 残留
- `env-store.test.ts`（+1）：并发写不同 key 不丢更新
- `files.test.ts`（+3）：符号链接越界拒绝（读/写，环境不支持时 skip）、并发写不同文件 + 无 .tmp 残留
- `tests/event-queue.test.ts`（+3）：stop 后入队抛错、pending 置 error + in-flight 完成、幂等
- `tests/orchestrator-service.test.ts`（+1）：dispose 后 dispatch/commit 拒绝入队
- `packages/role-pool/tests/role-pool.test.ts`（+3）：限流重试成功（调用 2 次）、永久失败不重试（调用 1 次）、网络错误重试 3 次后仍失败
- `tests/chat-routes.test.ts`（+2）：ensureHost 并发单飞只建 1 host；activateSession 前缀命中不重复创建 host

**遗留（下一批）**：🟠-1/6/9/10/11/12/13/14/15/16/17/18/20/21/22/24/25/26/27 + 🟡 全部；其中 🟠-23 等前端项按前端测试纪律在批次 2b 处理。
