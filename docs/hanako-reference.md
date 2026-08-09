# Hanako 设计参考手册（docs/hanako-reference.md）

> **定位**：本仓库的设计参考手册（现行文档，持续维护）。
> 本工程遇到设计/实现需求时，优先参考 [HanaAgent（openhanako）](https://github.com/liliMozi/openhanako)
> 的既有做法：**借鉴方法，或直接移植其中的实现**。
> 本文件是"按图索骥"的地图：每个模式标注了 openhanako 中的精确出处，
> 打开对应文件即可看到完整实现，无需重新发明。
>
> 适用者：本仓库的 AI / 开发者。
> 上游源码位置：`D:\claude\openhanako`（本地克隆，可随时翻阅）。
> 研读日期：2026-08-09（openhanako v0.442.0）。

## 0. 快速指南

- **遇到"怎么设计 X"** → 先查下表"模式库"是否有对应条目；有 → 打开【出处】文件，借鉴或移植
- **遇到"怎么写"的取舍**（命名/注释/错误/防御） → 查 §2 美学惯例
- **拿不准要不要借鉴** → 查 §3 不借鉴清单（规模差异与明确排除项）
- **移植代码后** → 必须在 `docs/THIRD-PARTY.md` 登记（Apache-2.0 归因义务，见 §4）

## 1. 上游背景

| 项 | 说明 |
|---|---|
| 项目 | HanaAgent（仓库名 openhanako），"有记忆、有灵魂的私人 AI 助理" |
| 许可证 | Apache-2.0（可借鉴、可移植，需保留版权声明与归因） |
| 技术栈 | 与 pi-ex 同源：`@earendil-works/pi-agent-core`（hanako 0.80.3，本工程 0.77.x）、TypeBox、better-sqlite3 |
| 规模 | core+lib+server+hub ≈ 数百文件，单文件可达 3000+ 行（大而全，参考其方法而非其规模） |
| 分层 | `shared/`（跨层无依赖）→ `lib/`（核心库）→ `core/`（编排 + Manager）→ `hub/`（后台调度）→ `server/`（Hono + WS）→ `desktop/`（React） |

## 2. 模式库（设计时查阅，按主题分组）

### 2.1 错误处理

**模式 A：错误注册表 + AppError** ⭐ 最优先借鉴
- 出处：`openhanako/shared/errors.ts`（80 行）
- 做法：`ERROR_DEFS` 把每个错误码映射为 `{severity, category, i18nKey, retryable, httpStatus}` 六元组；`AppError` 携带 code/traceId/context，`AppError.wrap()` 统一包装未知错误，`toJSON/fromJSON` 支持跨进程传输
- 何时用：本工程所有路由（routes-chat/ext/scheduler）与 agent 错误统一化
- 移植要点：整个文件可原样移植（仅去掉 i18n 依赖或换成本工程文案）；错误码按本工程域重命名（如 `ORCH_*`、`WORLD_*`）

**模式 B：全局 ErrorBus**
- 出处：`openhanako/shared/error-bus.ts`（92 行）
- 做法：进程级单例；`report()` 带 5 秒去重窗口（dedupeKey）、50 条面包屑、按 severity 自动路由（critical→boundary / 其余→toast）；监听器互相隔离（一个 listener 抛错不影响其他）
- 何时用：前端与后端的事件总线报告路径；现有 `docs/api/debug-bus.md` 可对照演进

**模式 C：错误分层哲学**
- 出处：`openhanako/lib/tools/tool-result.ts`（toolOk/toolError）、`server/http/route-errors.ts`（HttpRouteError 白名单状态码）、`server/index.ts` 全局 `app.onError`（AppError.wrap + traceId 响应）
- 做法：工具层返回结构化结果不抛异常（模型可读）；基础设施抛带 code 的错；HTTP 层统一映射状态码；安全 fail-closed、日志/持久化 fail-soft
- 何时用：新工具 / 新路由 / 新持久化代码一律遵守

### 2.2 日志与脱敏

**模式 D：模块日志器**
- 出处：`openhanako/lib/debug-log.ts`（createModuleLogger，237-254 行）+ 全局 DebugLog（5MB 截断、连续重复去重、7 天清理、写失败不阻塞业务）
- 做法：每文件 `const log = createModuleLogger("模块名")`，同写 console + 持久文件
- 移植要点：`debug-log.ts` 可整体移植；日志目录换成本工程 `novel/` 下的运行数据目录

**模式 E：日志脱敏管线**
- 出处：`openhanako/shared/log-redactor.ts`
- 做法：`redactLogText`（正则管线：API key、Bearer、data URI、密钥 query 参数、长随机 token、路径映射 `~`）、`redactLogValue`（深走对象按敏感键名脱敏）
- 何时用：任何落盘/透传给 LLM 的日志与工具参数

### 2.3 工具与 Agent

**模式 F：工具工厂 + 结构化结果**
- 出处：`openhanako/lib/tools/notify-tool.ts`（73-92 行工具范本）、`lib/tools/file-tool.ts`（71-202 行 FileRef 规范化 + 边界检查 + errorResult）、`lib/tools/browser-tool.ts`（108-480 行：单工具动作分派 + 授权撤销短路返回 "stop" 而非报错）
- 做法：`createXTool(deps)` 返回 `{name, description, parameters(JSON Schema/TypeBox), sessionPermission?, execute}`；execute 不抛异常，返回 `{content, details}`；`details` 携带结构化副作用供前端渲染
- 何时用：本工程 agents/tools.ts、world-tools.ts 的重构方向；新工具一律此形态

**模式 G：会话权限描述符**
- 出处：`openhanako/lib/tools/session-permission-wrapper.ts`（Proxy 绑定 SessionManager + 漂移重校验）、`core/session-permission-mode.ts`（SESSION_APPROVAL_POLICIES）
- 做法：每个工具 `sessionPermission.resolveInvocation(params)` 把调用分类为 `{action, kind: read|routine|review, capability, target}`，目标规范化+限长后进描述符
- 何时用：当工具需要人审/分级授权时（本工程当前无此需求，先记录）

**模式 H：Pi SDK 适配层纪律**
- 出处：`openhanako/lib/pi-sdk/index.ts`（头部 1-12 行契约：不接 engine/不组装 session options/无状态）
- 做法：稳定 API 原样 re-export（含 TypeBox `Type`，工具不直接 import 第三方包）；不稳定 API 手写适配器，每条带"SDK 哪个版本破坏了形状"的 why 注释；OAuth 等边界用类型推导让 **SDK 升级在 typecheck 期失败而非运行时**
- 何时用：本工程升级 pi SDK 0.77→0.80+ 时，先建此层再升级（对照 `src/ports/adapters.ts` 现有适配）

### 2.4 事件与实时性

**模式 I：索引化 EventBus**
- 出处：`openhanako/hub/event-bus.ts`（226 行）
- 做法：订阅按 `sessionPath` 建索引（广播集 + 会话集），emit 只遍历相关订阅者；`request/handle` 请求响应模式（SKIP 回退链、超时、能力目录）；subscribe 返回 unsubscribe
- 何时用：**D1=SSE 编排可见性方案**（`docs/plans/2026-08-08-live-stage-visibility.md`）落地时，订阅过滤与事件模型直接参照；也可演进现有 `src/event-queue.ts`

**模式 J：WS 协议设计**
- 出处：`openhanako/server/ws-protocol.ts`（头部 1-41 行协议全文注释 + 手写 assert* 校验）、`server/ws-scope.ts`（订阅/权限门）
- 做法：扁平 `{type}` 判别对象（无 {event,data} 包裹）；`streamId + seq` 断线续传；每客户端订阅去重；一次序列化多端广播；权限 fail-closed
- 何时用：SSE/WS 推送可见性实现时对照

### 2.5 配置与正源

**模式 K：配置单一事实来源**
- 出处：`openhanako/shared/config-schema.ts`（50 行）、`shared/config-scope.ts`
- 做法：一张声明表：字段 → `{scope: global|agent, setter, getter, prefsPath, defaultValue}`；读写两端（后端/前端）都走这张表
- 何时用：应用级配置（`%APPDATA%/narrative-engine/app-config.json`）出现双端漂移时

**模式 L：模型引用纪律**
- 出处：`openhanako/shared/model-ref.ts`（头部 8-15 行契约）
- 做法：复合身份 `(provider, id)`；只有 `parseModelRef`（仅 UI/反序列化入口）宽容；运行时**绝不按 id 回退**，推断只发生在迁移期
- 何时用：本工程 `src/app/llm-resolver.ts` 的 provider/model 解析扩展时

### 2.6 持久化与安全

**模式 M：原子写 + 分层存储**
- 出处：`openhanako/shared/safe-fs.ts`（atomicWriteSync：tmp+rename+权限）、`lib/checkpoint-store.ts`（单 JSON 文件存储范本）、`lib/memory/fact-store.ts`（SQLite 仅给查询：WAL + `user_version` 迁移阶梯 + 预编译缓存）
- 做法：内存 Map + 整文件原子 JSON 优先；查询需求才上 SQLite；写入全部原子化
- 何时用：world-graph 落盘、正文文件写入等（已有写锁，补原子性即完整）

**模式 N：密钥文件独立模块**
- 出处：`openhanako/shared/secret-fs.ts`（头部 1-35 行威胁模型散文 + `SECRET_FILE_MODE 0o600` 模块强制）
- 做法：权限不是参数而是模块常量——调用方不可能忘；Windows 跳过 chmod（NTFS 语义）；healer 确认模式而非假报
- 何时用：LLM provider API key / 应用凭据落盘时

**模式 O：路径守卫**
- 出处：`openhanako/lib/sandbox/path-guard.ts`（4 级访问 + 操作矩阵 + 对不存在路径向上找最近祖先再判定）、`lib/sandbox/policy.ts`（ACL 单一事实来源）、`server/utils/path-security.ts`（fail-closed：拒绝相对路径与点目录）
- 移植要点：本工程已有 `src/path-guard.ts`，对照补"mkdir -p 链判定"与"操作×级别矩阵"即可，无需重写

### 2.7 编排与增量

**模式 P：增量编译（省 token）**
- 出处：`openhanako/lib/memory/compile.ts`（compileToday watermark 增量 311-379 行 / compileDaily 指纹 sidecar 409-443 行）、`lib/memory/memory-ticker.ts`（分步检查点续跑 DAILY_STEP_KEYS + 每步健康账本）
- 做法：watermark（只重扫更新时间戳之后的输入）+ 指纹 sidecar（输入键 hash，未变则跳过）+ 步骤级持久化检查点（重启不重复计费）
- 何时用：**编排器每轮/每日的总结、记忆、世界图提炼**——本工程最值得借鉴的省钱机制

**模式 Q：Thin Facade + Manager 注入**
- 出处：`openhanako/core/engine.ts`（3600 行纯委托 + 构造器闭包注入）、`core/agent-manager.ts`（_d 依赖袋 + 并发队列限流 + 幂等迁移）
- 做法：Manager 构造器收 `{getX: () => this._x}` 闭包，不持有 engine 引用；重服务延迟初始化；hub 经 setter 单向注入避免循环引用
- 何时用：`src/app/main.ts` 与 `src/orchestrator/service.ts` 若继续膨胀，按此拆 Manager（当前规模未必需要）

**模式 R：声明式路由表**
- 出处：`openhanako/hub/index.ts`（258-308 行）
- 做法：消息统一入口按"匹配谓词 → handler"路由表组织，优先级由位置显式保证；新增路由显式插入表内，不散落 if
- 何时用：`src/app/routes-chat.ts` 的消息分发路径演进时

### 2.8 前端（frontend-demo 为原生 JS，仅借鉴思路）

**模式 S：Zustand slice 组织**（若未来前端引入 React）
- 出处：`openhanako/desktop/src/react/stores/index.ts`（单 store 由 ~24 个 `createXSlice(set, get?)` 拼装）、`stores/create-keyed-slice.ts`（session 级 keyed 状态 + 版本计数器防旧数据覆盖）
- 做法：slice 工厂收 set/get；`get` 用 Pick 部分类型避免循环 import；WS 直写跨 slice 状态；`bumpLiveVersion` 让 in-flight 加载检测竞态

**模式 T：WS 消息处理与缓冲**
- 出处：`openhanako/desktop/src/react/stores/ws-message-handler.ts`（大 switch 分发 + 非聚焦会话照常缓冲）、`hooks/use-stream-buffer.ts`（30fps 节流刷 store）
- 何时用：SSE 推送流式刷新时参照节流合并思路

### 2.9 工程机制

**模式 U：棘轮式边界 lint**
- 出处：`openhanako/scripts/lint-open-boundary.mjs`（头部注释即设计文档）、`export-manifest.json`（白名单）、`build/open-boundary-baseline.json`（已知债务基线）
- 做法：白名单 + 基线文件：基线内旧违规警告放行，**新违规 CI 失败**；债可见且不增长，清零后切绝对模式
- 何时用：为 `src/ports/` 守"ports 不 import 具体实现"（本项目六边形防腐化的低成本机制）

**模式 V：宽松 TS 双轨**
- 出处：`openhanako/tsconfig.json`（前端严格）vs `tsconfig.node.json`（核心层 `strict:false` + `declare _f: any` + JSDoc）
- 做法：核心快速迭代层关严格性、保留类型语法；边界/前端开严格
- 何时用：与项目现状对齐即可，不必照搬（本工程已是纯 TS，保持现状）

## 3. 美学惯例（写作风格速查）

1. **中文写"为什么"，英文写契约**：文件头注释是设计动机散文——威胁模型、演进史（v1→v2→v4）、取舍理由；代码内 why 注释引用 issue/决策来源
2. **命名动词化**：`create*` 工厂 / `wrap*` 装饰器 / `normalize*` 每个不可信边界 / `resolve*` 解析器；私有字段 `_` 前缀；常量 UPPER_SNAKE
3. **长文件分节横幅**：`// ── 分节名 ──` / `═══`；启动步骤 ①②③
4. **纯逻辑提取到模块级导出函数**（可单测），大闭包只留编排
5. **防御性惯例**：注入依赖 `typeof f === "function"` 检查；`Object.freeze` 冻结上下文/配置；`eslint-disable` 必带行内理由；兼容层标 `@deprecated` + 可移除版本（如 `COMPAT(x, remove no earlier than v0.133)`）
6. **启动断言不变量**：如"拒绝带未分类工具启动"（`assertAllToolsCategorized`）
7. **失败语义三态**：返回结果（工具）/ 抛带 code 的错（基础设施）/ fail-soft 吞掉（日志与账本——"计费永不阻塞模型请求"）

## 4. 移植纪律

1. **归因**：openhanako 为 Apache-2.0。直接移植代码（含大段改写）须在 `docs/THIRD-PARTY.md` 登记：来源文件、许可证、移植日期与用途
2. **版本差异**：hanako 用 pi SDK 0.80.3，本工程 0.77.x；移植涉及 SDK API 的部分（模式 H）先核对本工程版本签名
3. **规模克制**：hanako 是大而全的单体，本工程仅 ~5800 行；**借鉴方法，不复制规模**——Manager 体系、插件系统、多 Agent、桌面壳均明确不移植
4. **不引入**：不因 hanako 引入 Hono / Electron / Zustand / better-sqlite3 到本工程核心；本工程保持 node:http + 原生前端 + underworld-graph 现状
5. **文档同步**：本文件属"现行文档"（docs/README.md 现行区），按维护约定随代码演进更新；新借鉴的模式在此登记条目

## 5. 已借鉴/移植登记（按时间倒序）

| 日期 | 模式 | 用途 | 出处 | 状态 |
|------|------|------|------|------|
| （暂无） | | | | |
