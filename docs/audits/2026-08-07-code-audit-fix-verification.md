# 修复前核对排查报告（2026-08-07 审计文档）

> **关联文档**：[2026-08-07-code-audit.md](./2026-08-07-code-audit.md)（本轮核对的审计文档）
> **核对性质**：只读核对，未修改任何源码。所有判定基于源码实证（行号引用）。
> **核对基线**：`afb2b8c`（与审计基线一致，`git rev-parse HEAD` 实证，无行号漂移风险）。
> **核对日期**：2026-08-07（审计当日，工作树无后续改动）。

---

## 1. 核对方法

- 主审人精读 4 个 🔴 项的**全部相关源码**（render-tools / checker / orchestrator / collect / routes-scheduler / importer write+validate），并**追到外部依赖内核**——注意：narrative-engine 实际依赖 `underworld-graph@0.1.2`（node_modules 实证，`package.json:25` 声明 `^0.1.2`），而独立仓库 `underworld-graph/` 的 HEAD 已是 0.2.0（`b8bd4d6`），**两处源码不一致，审计文档部分行号引用落在了 0.2.0 上**（详见 §5 勘误 1）。
- 4 个只读子代理并行核证 27 个 🟠 项（服务层 / admin+launcher / importer+renderer / role-pool+scheduler+前端），每项给出 CONFIRMED / NOT_CONFIRMED / PARTIAL / LINE_DRIFT 判定与证据摘录。
- 行号核对规则：以 `afb2b8c` 工作树为准逐行比对。

## 2. 判定总览

| 项 | 判定 | 行号核对 | 关键修正 |
|---|---|---|---|
| 🔴-A | ✅ CONFIRMED | 精确 | dispatch 路径已有下游防护（orchestrator.ts:617-620），建议措辞需调整（见 §5-2） |
| 🔴-B | ✅ CONFIRMED | 精确 | 无 |
| 🔴-C | ✅ CONFIRMED（机制） | 精确 | **影响面描述不符**：0.1.2 内核静默截断、不抛错（见 §5-1） |
| 🔴-D | ✅ CONFIRMED | 精确 | 内核 `getAllEntities`（0.1.2:829-841）存活过滤已实证 |
| 🟠-1 | ✅ CONFIRMED | 精确 | 越界仅限「同名前缀」目录；win32 大小写变体被 startsWith 大小写敏感拦住 |
| 🟠-2 | ✅ CONFIRMED | 差 1 行（函数实起 247） | 建议补 `res.on("close")` 监听（现仅监听 req） |
| 🟠-3 | ✅ CONFIRMED | 精确 | 两类交错时序均成立（泄漏 / 互 dispose） |
| 🟠-4 | ✅ CONFIRMED | 精确 | `pool.set` 裸覆盖无 dispose（session-pool.ts:77-79） |
| 🟠-5 | ✅ CONFIRMED | 精确 | EventQueue 确无 stop/dispose（event-queue.ts 方法集实证）；队列归属 OrchestratorService |
| 🟠-6 | ✅ CONFIRMED | 精确 | pipeline 自动 mkdir + 写 5 类产物（db/jsonl/json） |
| 🟠-7 | ✅ CONFIRMED | 精确 | 读写删三路径全部跟链接；全仓 grep 无 realpath/lstat |
| 🟠-8 | ✅ CONFIRMED（5/5） | 精确 | 三类写策略：4 处读-改-写 + 1 处全量覆盖，均共享固定 .tmp |
| 🟠-9 | ✅ CONFIRMED | 精确 | 仅 `null` 字面量触发；无单项目失败隔离 |
| 🟠-10 | ✅ CONFIRMED | 行号精确，**路径修正** | 实际在 `src/app/routes-ext.ts`（非 packages/admin 下） |
| 🟠-11 | ✅ CONFIRMED | 精确 | 注释承诺未实现 |
| 🟠-12 | ✅ CONFIRMED（机制） | 精确 | **实际是「数据翻倍」非「崩溃」**：0.1.2 内核 decl 键无 unique 约束（见 §5-4） |
| 🟠-13 | ✅ CONFIRMED | 精确 | 无锚点存在性检查 |
| 🟠-14 | ✅ CONFIRMED（机制） | 精确 | **「静默丢弃」发生在阶段 7**（write.ts:230-236 去重）而非阶段 3（见 §5-5） |
| 🟠-15 | ✅ CONFIRMED | 精确 | **commit.ts 在仓库不存在**；运行时闭合语义需以内核与 visualizer 实际行为为准（见 §5-6） |
| 🟠-16 | ✅ CONFIRMED | 精确 | stages.ts:240-249 空章节恒返回条目，检查恒通过 |
| 🟠-17 | ✅ CONFIRMED | 精确 | chapterId = 过滤后数组序号（`chapters.length + 1`） |
| 🟠-18 | ✅ CONFIRMED | 精确 | 0 章继续走完 8 个阶段返回「成功」 |
| 🟠-19 | ✅ CONFIRMED | 精确 | 接口层（RoleLlmCaller）也无超时/重试承载点 |
| 🟠-20 | ✅ CONFIRMED | 精确 | addRelation 无 strict 参数、内核零校验（0.1.2:525-540） |
| 🟠-21 | ✅ CONFIRMED | 精确 | 整文件读改写、无锁/CAS |
| 🟠-22 | ✅ CONFIRMED | 精确 | resolver 接受 `ch-<N>`/`ch2` 超集；引擎侧 scheduler-tools.ts:24-33 显式拒绝 |
| 🟠-23 | ✅ CONFIRMED | 精确 | q()/flJs/settingsJs 均漏 `"` 转义（4 项）；escapeHtml 完整（5 项） |
| 🟠-24 | ✅ CONFIRMED | 精确 | 守卫在 await 之后；reloadDetail token 在 await 前（对照成立） |
| 🟠-25 | ✅ CONFIRMED（程度修正） | 精确 | 非「绝对永久」：再次输入 / 触发 renderView 可被动恢复（见 §5-7） |
| 🟠-26 | ✅ CONFIRMED | 精确 | L415 静默 return 与 L413-414 设计注释自相矛盾；`stIsStreamingBusy` 已有正确语义 |
| 🟠-27 | ✅ CONFIRMED | 精确 | 后端 400 已实证（visualizer/routes.ts:56-66）；events.js Promise.all 无 catch |

**汇总**：31 项全部 CONFIRMED（0 项 NOT_CONFIRMED）。4 个 🔴 的机制描述全部成立，但其中 2 个的影响面/措辞需要修正（🔴-A、🔴-C）；27 个 🟠 有 5 处细节修正，不影响「问题存在」的判定，但影响**修复方案的落地方式与优先级措辞**。

---

## 3. 🔴 逐项核证详情

### 🔴-A. 主会话渲染工具任意路径读写 — ✅ CONFIRMED（影响面需修正）

**证实**：`src/chat/render-tools.ts:61-64` 四个工具（render_append/render_modify/render_preview/render_check）把 LLM 参数 `p.chapterPath` 直接传给 `renderToFile`/`readChapter`/`checkNarrative`，无 `assertPathInside`；`src/checker.ts:132-168` `readCheckTarget` 四个分支（137/147/152/164）直接 `readChapter`/`readChapterSection`，无校验。对照子代理版 `src/agents/chapter-tools.ts:37,68` 均过 `assertPathInside`（cwd 非空时）。**主会话版是 🔴-5 修复漏掉的入口——成立。**

**影响面修正（§5-2）**：审计称「HTTP 侧 dispatch 的 chapterPath 同源无校验」。实测 `routes-scheduler.ts:122-125` 仅做类型检查，但下游 `orchestrator.ts:617-620` `resolveChapterPath` **已有 `assertPathInside(this.opts.cwd, p)`**（注释明确引用 08-03 审计 🔴-5），且渲染子代理工具经 `orchestrator.ts:583` 带 cwd 创建。即 **dispatch 入参到写路径已被双重防护**，该部分是纵深防御而非独立漏洞。真正的洞只在本文件两个入口：主会话 chat 工具 + checker（经 render_check 可达）。

**修复方案**（不变，但范围明确为两处）：
1. `render-tools.ts` 四个工具 execute 内对 `p.chapterPath`（含可选分支）统一 `assertPathInside(provider.cwd, chapterPath, "章节文件路径")`（render_preview 的可选 chapterPath 与 render_check 的可选 chapterPath 同样处理）；
2. `checker.ts` `readCheckTarget` 开头统一校验（该函数是唯一读入口，改动最小）；
3. `routes-scheduler.ts` 入参校验可作为纵深防御随带（低成本一行）。

### 🔴-B. 前半链路（planner/role）无整体超时 — ✅ CONFIRMED

**证实**：`orchestrator.ts:252-254`（planner）与 `318-321`（role）均为裸 `await agent.prompt("")`；`promptAndCollectWithTimeout`（55-86，Promise.race + abort + 300s）只在 commit 链路使用。`src/agents/collect.ts:44-106` 的 180s 超时（61-66）仅 `reject()` 产出 promise、**不取消 `agent.prompt`**（定时器无 `agent.abort()` 调用），且调用方在 `prompt` 返回前不会 await 产出 promise——LLM 无响应时编排器永久挂起成立，与 BUG-028 文档自述一致。

**修复方案**：planner 与 role 循环内改用 `promptAndCollectWithTimeout(agent, toolName, timeoutMs, label)`（签名完全兼容：内部即 collectSubmission + prompt + race + abort）。role 循环的 per-role 失败捕获（329-336）与超时抛错不冲突——超时抛错会被该 catch 捕获记入 errors，符合「单角色失败不阻断」语义。注意角色循环的 `collectSubmission` 需移入包装函数。

### 🔴-C. 导入 causedBy 链断裂 — ✅ CONFIRMED（机制）/ ⚠️ 影响面修正

**证实**：`buildCausedByChain`（write.ts:64-81）按章顺序串接全部事件；`writeToGraph` 三条跳过路径——entity_hint 无法解析（153-156）、重复 birth（173-177）、未 birth 发 death（269-273）——`continue`/`break` 跳过 `wg.processEvent`，**下一事件的 causedBy 仍指向从未写入的 eventId**。events.jsonl 出现悬空前驱：成立。

**影响面修正（§5-1，重要）**：审计称「内核 `traceCauses`（world-graph.ts:951）遇悬空前驱直接抛「因果链前驱丢失」，用户回溯因果链即报错」。实测**该行号属于 underworld-graph 0.2.0 仓库 HEAD**（0.2.0 world-graph.ts:952 确有 throw）。narrative-engine 实际依赖 0.1.2：其 `traceCauses`（world-graph.ts:667-669）只是 `eventLog.traceBack(eventId)`，而 `traceBack`（event-log.ts:39-50）对悬空前驱 `byId.get(causedBy)` 返回 undefined 后**静默终止链条**，不抛错。因此当前版本的实际表现是：**因果回溯静默截断（链上前半段事件缺失），不报错**——数据完整性危害仍在（用户/LLM 看到不完整因果链、日志空洞），但「用户回溯即报错」不成立。

**联动风险**：若后续升级 underworld-graph 到 0.2.x，同一数据将**从静默截断变为抛错**（0.2.0 加了显式校验）。修复前升级依赖会直接把隐性数据问题变成运行时故障——**修复 🔴-C 应优先于或与依赖升级同步**。

**修复方案**（审计建议不变，补充细节）：
1. 跳过事件时把其 causedBy 转链给后一个实际写入的事件（写循环内维护 `lastWrittenEventId`，跳过时更新当前 item 的 causedBy 映射后再写入）——注意 `buildCausedByChain` 在写循环前已生成固定 causedBy，需在 `writeToGraph` 内对「跳过」场景做链修补（写时用 `lastWrittenEventId ?? item.causedBy`）；
2. 阶段 8 增加日志级校验：读 events.jsonl（或 `wg.getAllEvents()`）验证每个事件的 causedBy 存在，发现悬空即 P1（警告）或 P0（阻断，视策略）——审计建议保留；
3. 补测试：覆盖重复 birth / 未 birth death / 无法解析 entity_hint 三种跳过路径 + 后续事件链完整。

### 🔴-D. 导入 P0 死亡实体假阳性 — ✅ CONFIRMED

**证实**：`validate.ts:261-301`：`allEntities = await wg.getAllEntities(lastStoryTime)`（274 行）→ 280 行建存活集合 → 284-301 对全部 change 事件 new_facts 的 entityId 做存在性检查。内核实证（0.1.2）：`getAllEntities`（world-graph.ts:829-841）过滤 `validTo === INFINITY || storyTime < validTo`（831-834），`killEntity`（466-469）把 Entity 的 validTo 置为死亡时刻——**死亡实体必不在终态集合**；其此前写入的 change Fact 的 entityId 全部报 P0 假阳性。含死亡/退场角色的小说导入必然失败：成立。

**修复方案**（审计建议成立，二选一）：
1. 首选：持久化「曾 birth 的 entityId 集合」——`writeToGraph` 已有 `birthedEntityIds`（write.ts:142），把该集合随 `WriteResult` 返回，validate.ts 用它做存在性判断（最小改动、语义即「曾 birth」）；
2. 备选：按各 fact 的 `validFrom` 时刻分别 `getEntityAt` 查询（成本高，不推荐）。
3. 补测试：含死亡角色的导入 smoke 用例（现有 importer 测试未覆盖死亡实体场景，审计 §5 已列）。

---

## 4. 🟠 核证结果（修正备注汇总）

### 服务层（🟠-1~6）—— 全部 CONFIRMED

- **🟠-1**：`server.ts:86-93`，`startsWith(normalize(uiDir))` 无分隔符。越界面限定：仅「uiDir 同级、以 uiDir 名前缀开头」的兄弟目录（`frontend-demo2` 等），任意深度逃逸仍被拦；win32 下大小写变体因 startsWith 大小写敏感反被拦。修复：`=== uiDir || startsWith(uiDir + sep)` 或复用 path-guard。
- **🟠-2**：`routes-chat.ts:263-291`，`send`/心跳仅 try/catch，无 `res.destroyed`/`writableLength` 探测，**仅监听 req 的 close/error、未监听 res**；对比 debug/sse.ts:44-118 有 markDead（49-53）+ send 内探测（56）+ writableLength 60s 判死（78-99）+ req/res 双监听（114-118）。死连接占 SSE 配额（unified-server.ts:236-247）成立。修复：移植 debug/sse.ts 模式 + 补 `res.on("close")`。
- **🟠-3**：`chat-context.ts:233-251`，无 in-flight 单飞。两类交错时序均实证：A 建 B 覆盖（泄漏）或 B disposeRuntime 清掉 A 刚建的 host（挂起）。修复：promise 缓存单飞。
- **🟠-4**：`chat-context.ts:472-505`，`pool.has` 仅精确匹配；前缀命中后 `createHostForSession` 重开同一会话文件、`pool.set`（session-pool.ts:77-79 裸 Map.set）覆盖旧 handle 无 dispose。修复：先做前缀解析命中池内会话时仅 `setActive`。
- **🟠-5**：`disposeRuntime`（592-604）只 dispose host + clear 映射 + drain debug bus；EventQueue 方法集（enqueue/getStatus/getAll/length/activeCount/pump/sweepFinished）**确无 stop/dispose**，OrchestratorService 同无。切项目后旧队列继续执行 + 同 cwd 双队列并发写成立。**修复前置**：需先给 EventQueue 增加可中止的 stop（含 in-flight worker 取消）再接入 disposeRuntime。
- **🟠-6**：`import-tools.ts:20` 仅 epubPath 过 `assertPathInside`；worldGraphDir 缺省值 `.pi/world-graph-v3` 在项目内不受影响，但显式传任意绝对路径时 pipeline（pipeline.ts:129-133 原样返回 → 184 mkdir → 写 db/jsonl/json）自动落盘。修复：execute 内对 worldGraphDir 补一行校验。

### admin / launcher（🟠-7~11）—— 全部 CONFIRMED

- **🟠-7**：`files.ts:70-87` `_resolveSafePath` 纯词法（绝对路径拒绝 + resolve + startsWith），全仓 grep 无 realpath/lstat；读（166-181）用 `fs.stat`（跟随链接）+ readFile，写/删/改名（198-216/253-263/280-299）同模式。`正文/notes.md → C:\Users\X\.ssh\id_rsa` 真实可绕过。修复：realpath 后二次包含性校验或 lstat 拒绝链接（审计建议一致）。
- **🟠-8**：五处（app-config.ts:186-249、files.ts:214-216、env-store.ts:272-276、rulesets.ts:145-147、novel-json.ts:165-167）均 `path + ".tmp"` 固定 tmp + writeFile + rename；前四处读-改-写。**修复方案细化**：读-改-写类（app-config/env-store/novel-json）仅换随机 tmp 名不够，需每文件 promise 队列；rulesets/files 至少唯一 tmp 名。
- **🟠-9**：`discover.ts:47-48`，`JSON.parse("null")` 返回 null 后 `data.name` 抛 TypeError；仅捕获语法错误（41-46）；`_discoverProjects` 循环（102-137）对 `_readNovelJson` 无 try/catch，一个坏项目全盘 500。修复：照抄 admin novel-json.ts:127-132 守卫 + per-entry try/catch 隔离。
- **🟠-10**：**文件实际在 `src/app/routes-ext.ts:322-325`**（审计路径 packages/admin 系笔误，行号正确）；`Number("abc")` → NaN 直达 `discover.ts:148`（`?? 3` 不替换 NaN）→ 93 行 `>= NaN` 恒 false 无界递归；负数静默空列表。修复：路由层 `Number.isFinite && 1..10` + discover 内部对非有限值防御。
- **🟠-11**：`files.ts:217-221`，注释承诺「baseMtime + 1ms 或 Date.now() 取更大者」，实现只 `new Date()`。修复：按注释实现（解析 baseMtime +1ms 与 now 取 max，或读当前 st.mtime 取 max）。

### importer / renderer（🟠-12~18）—— 全部 CONFIRMED

- **🟠-12**：阶段 7 无「已导入」守卫；内核 0.1.2 无 unique 约束 → 二次导入**插入重复行 + events.jsonl 翻倍**（非崩溃）。**修复注意**：若修复时顺手给 decl 键加 unique 索引，行为会从翻倍变崩溃——守卫与约束必须同时落地。
- **🟠-13**：`chapter-io.ts:61-77` append 无锚点存在性检查；modify/read 均 `indexOf` 命中首个锚点。
- **🟠-14**：阶段 3（stages.ts:155-204）仅格式校验（`^ch\d{3}\.ev\d{3}$`）；「重复 storyTime 的 new_facts 静默丢弃」实际发生在阶段 7 `write.ts:230-236`（seenFactKeys 去重），且按 (entityId, property, storyTime) 三元组。修复建议（阶段 3 加唯一性 + 章号一致性）不变。
- **🟠-15**：`findDeclarationId`（write.ts:420-432）返回最后一条；**仓库内无 commit.ts**（grep 实证），注释「与运行时 commit.ts 语义一致」双不成立——运行时（world-tools.ts world_event_apply）由 LLM 显式填 invalidated，visualizer（routes.ts:378）取第一条闭合，importer 取最后一条，三处语义本就不一致。修复：findDeclarationId 返回全部未闭合声明（或至少修正注释与语义对齐）。
- **🟠-16**：`validate.ts:143-148` 只查 chapterId 条目存在；stages.ts:240-249 空章节恒返回条目 → 检查恒通过。
- **🟠-17**：`epub.ts:94-97` catch 无日志无汇总；`chapterId = chapters.length + 1`（102 行）为过滤后序号。
- **🟠-18**：`pipeline.ts:206-232` 0 章无二次校验，空输入走完全部阶段返回 `{ entityCount: 0, eventCount: 0 }`「成功」。

### role-pool / scheduler（🟠-19~22）—— 全部 CONFIRMED

- **🟠-19**：`role-pool.ts:47` 唯一 LLM 调用点无超时无重试；types.ts:136-139 `RoleLlmCaller` 接口层无承载点；文件头注释即设计为「单角色失败跳过」。修复需先扩展接口（超时封装 + 错误分类重试），并确认调度侧事件不可重放（orchestrator 消费后无法重跑）。
- **🟠-20**：`transforms.ts:76-90` 零校验；内核 `addRelation`（0.1.2:525-540）**无 strict 参数、零校验**，空值写入 `rel-<src>--` 垃圾关系。
- **🟠-21**：`chapter-edit.ts:50-94` 整文件读改写、无锁；`ensureChapterFile`（49）只是创建文件。
- **🟠-22**：`chapter-resolver.ts:38-39` 接受 `ch-?(\d+)` 超集 + 解析失败静默兜底第 1 章；引擎侧 scheduler-tools.ts:24-33 `^ch\d{3}\.ev\d{3}$` 显式拒绝。注意：orchestrator 走自己的 resolveChapterPath（orchestrator.ts:618）不用本 resolver，暴露面为 resolver 自身 API。

### 前端（🟠-23~27）—— 全部 CONFIRMED

- **🟠-23**：`demo-utils.js:20-22` q() 只转义 `\ ' \n \r` **漏 `"`**；files.js:54-60 flJs、settings.js:86-92 settingsJs 同漏；escapeHtml（app.js:56-58）完整 5 项。裸插值点全部核实（graph.js:218/139、app.js:538-539/579-582、projects.js:153/185）；events.js:405/430/445 原始 id 拼 querySelector（非 XSS 但功能整体失效）。studio.js:22 头部约定「onclick 内联参数一律单引号 + escapeHtml」被违反。修复：属性一律 escapeHtml、q() 补 `"`、querySelector 用 CSS.escape()。
- **🟠-24**：`entity-detail.js:639-653` 守卫在 await 后（642）且 `detailReloadSeq++` 在 643；reloadDetail token 在 await 前（150）。快速点击后一次被丢成立。
- **🟠-25**：`files.js:570` try 前置 `btn.disabled = true`；非 MTIME_CONFLICT 失败（580-587）仅 handleApiError 弹 toast，不恢复按钮——但**非绝对永久**：再次输入触发 flOnEdit→flUpdateUiAfterEdit（539 恢复）或任何 renderView 可被动恢复。修复：catch 末尾恢复按钮。
- **🟠-26**：`studio.js:415` `if (stState('studioBusy')) return;` 静默返回，与 413-414 设计注释（studioBusy 仅用于输入框禁用）矛盾；`stIsStreamingBusy`（452-461）已有正确语义。
- **🟠-27**：graph.js:66-67 注释自认「真实后端在 storyTime 为空时直接 400」；后端 visualizer/routes.ts:56-66 `STORY_TIME_REQUIRED` 实证；events.js:61-64 Promise.all 无 catch → eventList 永不写入。

---

## 5. 审计文档勘误清单（影响修复决策，共 7 处）

| # | 位置 | 原文 | 修正 | 影响 |
|---|---|---|---|---|
| 1 | 🔴-C 影响段 | 「内核 `traceCauses`（world-graph.ts:951）遇悬空前驱直接抛『因果链前驱丢失』…用户回溯因果链即报错」 | 951 行属于 **0.2.0 仓库 HEAD**；实际依赖 0.1.2 的 `traceBack`（event-log.ts:39-50）**静默截断不抛错**。当前表现为链不完整、无报错 | 影响面从「报错」降为「静默数据缺失」；但 0.2.0 升级后变抛错——**修复优先级应不降反升**（见 §3-🔴-C 联动风险） |
| 2 | 🔴-A 建议尾句 | 「dispatch 入参同校验」 | `orchestrator.ts:617-620` resolveChapterPath 已校验（注释引用 08-03 🔴-5），渲染子代理工具亦带 cwd 防护——dispatch 路径**已有双重防护**，该建议属纵深防御 | 修复范围明确为 render-tools + checker 两处；dispatch 校验可选 |
| 3 | 🟠-10 位置 | `packages/admin/src/routes-ext.ts:322-325` | 实际在 **`src/app/routes-ext.ts:322-325`**（行号正确，路径笔误） | 无（仅文档修正） |
| 4 | 🟠-12 现象 | 「撞唯一键崩溃」 | 内核无 unique 约束，实际为**数据翻倍**（重复行 + events.jsonl 翻倍） | 修复时若加约束需与守卫同落，否则翻倍变崩溃 |
| 5 | 🟠-14 现象 | 「重复 storyTime 的 new_facts 被静默丢弃」 | 阶段 3 不丢弃（仅格式校验）；丢弃发生在**阶段 7** write.ts:230-236 三元组去重 | 修复点仍在阶段 3（加唯一性校验），措辞修正 |
| 6 | 🟠-15 现象 | 「与注释…及 commit.ts 语义不符」 | **仓库无 commit.ts**（grep 实证）；运行时闭合语义为 LLM 显式 invalidated；visualizer 取第一条、importer 取最后一条，三处本就不一致 | 修复需同时对齐 visualizer 语义或修注释 |
| 7 | 🟠-25 现象 | 「按钮永久禁用…无出口」 | 非绝对永久：再次输入 / renderView 可被动恢复 | 修复方案不变（catch 恢复按钮），措辞修正 |

另：审计 §8.2 存疑项中「traceCauses 对悬空前驱的抛错行为」已由本次核对定性（0.1.2 不抛错、0.2.0 抛错），可从存疑清单移除。

---

## 6. 修复建议报告（按梯队，含前置条件）

### 第一梯队（安全/数据正确性，建议立即处理）

**1. 🔴-A 主会话渲染工具路径防护** —— 范围明确为两处：
- `src/chat/render-tools.ts` 四工具 execute 内对 chapterPath（含可选参数）统一 `assertPathInside(provider.cwd, …)`；
- `src/checker.ts` `readCheckTarget` 入口统一校验；
- （可选纵深防御）`src/app/routes-scheduler.ts` 入参校验。
- 修复模式已有先例（agents/chapter-tools.ts:37,68），单点改动、风险低。

**2. 🔴-B planner/role 整体超时** —— 复用 `promptAndCollectWithTimeout`（orchestrator.ts:55-86）：
- planner（252-254）整体替换；role 循环（318-336）将 collectSubmission + prompt + collect 移入包装函数，超时抛错落入现有 per-role catch（329-336），语义兼容「单角色失败不阻断」。
- 前置：无（函数已存在且签名兼容）。

**3. 🔴-C causedBy 链修补 + 日志级校验** —— 优先级上调（见勘误 1 联动风险）：
- `writeToGraph` 内维护 `lastWrittenEventId`，跳过事件时用其修补后续写入事件的 causedBy；
- 阶段 8 增加日志完整性校验（读 events.jsonl 验证 causedBy 存在性）；
- 补 3 条跳过路径的测试。
- **联动**：若近期要升级 underworld-graph 0.2.x，本项必须先行或同步，否则静默截断变运行时抛错。

**4. 🔴-D P0 改「曾 birth」语义** —— `WriteResult` 增加 `birthedEntityIds`（write.ts:142 已有集合，随结果返回），validate.ts 用它替换终态快照判断；补含死亡角色导入测试。

### 第二梯队（一致性/健壮性，本迭代处理）

**5. 🟠-8 admin 五处并发写串行化** —— 一次修齐：
- 读-改-写类（app-config.ts / env-store.ts / novel-json.ts）每文件一个 promise 队列；
- 全量覆盖类（rulesets.ts / files.ts）至少 tmp 名带随机后缀；
- 补并发交错测试（审计 §5 已列缺口）。

**6. 🟠-3/4/5 chat-context 生命周期** —— 顺序依赖：**先做 🟠-5**（EventQueue 增加可中止 stop）→ 🟠-3（ensureHost 单飞）→ 🟠-4（前缀命中仅 setActive）。三者都涉及 host 生命周期，建议同一提交内完成。

**7. 🟠-2 chat SSE 半开检测** —— 移植 debug/sse.ts 模式（markDead + writableLength 判死 + req/res 双监听）。

**8. 🟠-7 符号链接 realpath 校验** —— 与 path-guard 同步加固（realpath 后二次包含性校验，或 lstat 拒绝链接）。

**9. 🟠-23 前端属性转义族** —— q()/flJs/settingsJs 补 `"` 转义 + 全部裸插值点 escapeHtml + querySelector 改 CSS.escape()。改后必须跑一轮前端测试轮（AGENTS.md 前端测试纪律），转义函数建议补单测（审计 §5 已列：escapeHtml 无任何测试）。

**10. 🟠-19 role-pool 超时重试** —— 需先扩展 `RoleLlmCaller` 接口（types.ts:136-139）承载超时；错误分类重试（限流可重试、永久错误不重试）。

### 第三梯队（择机批量）

🟠-1/6/9/10/11/12/13/14/15/16/17/18/20/21/22/24/25/26/27 + 🟡 全部 —— 修复方案见 §4 各条备注；其中 🟠-24/25/26/27 为前端项，改后同样需跑测试轮。

### 修复顺序依赖图（防踩坑）

```
🔴-A ──────────── 独立，可立即开工
🔴-B ──────────── 独立（复用现成函数）
🔴-D ──────────── 独立（WriteResult 扩展）
🔴-C ──────────── 独立，但必须早于 underworld-graph 0.2.x 升级
🟠-8  ─────────── 独立
🟠-5 (EventQueue stop) → 🟠-3 → 🟠-4   [同一提交]
🟠-2  ─────────── 独立（参照 debug/sse.ts）
🟠-7  ─────────── 与 path-guard 改动同步
🟠-23 ─────────── 独立，改后必跑前端测试轮
```

---

## 7. 核对局限性

- 全部为静态源码核对（含外部依赖 node_modules 实证），未运行时代验证；运行时行为（如 🟠-1 的 win32 越界读取）沿用审计文档的实证结论与代理对机制的分析，建议修复时以测试佐证。
- underworld-graph 0.1.2 与 0.2.0 的差异为本次核对的重点发现，**修复与升级依赖的先后顺序需在排期时显式决策**。
- 前端 🟠-23 的 XSS 可利用性（qe-entity 自由文本输入）依赖浏览器行为，修复后建议按前端测试纪律跑 browser_use 验证。

**报告结束。** 结论：审计文档 31 项发现全部成立、无虚假告警；7 处勘误均不影响「问题存在」判定，但其中 2 处（🔴-A 范围、🔴-C 影响面）影响修复方案的措辞与优先级，已在 §5/§6 给出修正与落地建议。
