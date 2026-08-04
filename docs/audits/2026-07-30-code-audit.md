# narrative-engine 代码审计报告（2026-07-30）

> **审计性质**：只读审计，未修改任何文件。所有发现均基于源码实证（行号引用），未臆测接口。
> **审计方法**：5 个审计代理并行按模块分片查证（src/ 核心层 · world-graph+scheduler · role-pool+renderer · importer+launcher+admin · scripts+tauri+visualizer），汇总后交付。
> **审计重点**：除常规 bug/一致性/测试覆盖外，本次专项检查**过度工程（over-engineering）**——遵循用户规则"以新增冗余为耻，以复用存量为荣"。
> **审计基线**：master 分支当前工作区状态（2026-07-30，行号基于当时源码，**已与后续重构脱节**；08-03 审计已按新基线复核 H1-H6/M 级闭环状态，见 [2026-08-03-code-audit.md](2026-08-03-code-audit.md)）。注意：既往审计文档（2026-07-25 / 07-27 / 07-29）行号引用已与重构后的源码脱节（详见 M8），本报告所有行号均以当前源码为准。
> **修订记录**：初稿经 3 个独立代理交叉复核（事实准确性 9/10 · 过度工程判断 7/10 · 分级合理性 8/10），已据复核意见修订：H4/H7/H8 据项目上下文降级为 M；H3 行号修正；M21 重新定性；L2/L3/L4 软化；补漏 embedBatch/launch shell 注入/busy_timeout/失效脚本；修正 L21 误判。

---

## 0. 总览

| 维度 | 评分 | 说明 |
|---|---|---|
| src/ 核心入口层 | 7 / 10 | 模块拆分清晰，注释扎实；拖欠 2 个已知 bug + 1 处过度工程 |
| world-graph + scheduler | 7.5 / 10 | P0 修复全部落地，测试扎实；1 个静默数据丢失隐患 + 类型松散 |
| role-pool + renderer | 7.5 / 10 | 数据流契约清晰；文档滞后 + 公共 API 测试盲区 |
| novel-importer / launcher / admin | 7.5 / 10 | updater 版本比较两处 bug；novel-importer 为测试实现（bug 降级处理）|
| scripts / tauri / visualizer / CI | 6 / 10 | CI 覆盖严重不足 + esbuild 隐式依赖 + 设置页状态污染 |

**全局结论**：核心数据流（dispatch → retrieve → role-pool → commit → render）质量扎实，P0 修复历史可追溯。主要风险集中在：(1) 几个已知 bug 未跟进修复；(2) 应用化新增模块的 CI 回归真空；(3) 若干过度工程点（embedderAdapter 冗余包装、buildSystemPrompt 多余参数等）；(4) 进程启动路径的 shell 注入面（M30）。

---

## 1. 🔴 高严重度（bug / 数据正确性 / 构建破坏）

### H1. commit.ts 4.2.5 步 try/catch 包裹整个 for 循环，单条 embedding 失败导致同实体其余 property 全部丢向量
[file:///workspace/packages/scheduler/src/commit.ts#L189-L211](file:///workspace/packages/scheduler/src/commit.ts#L189)

```typescript
try {
  for (const change of changes) {
    const declarationId = `decl-${entityId}-${change.property}-${event.storyTime}`;
    ...
    const vec = await ctx.embedder.embedFact(decl);
    await ctx.wg.updateFactEmbedding(declarationId, vec);
  }
} catch (embedErr) {
  console.warn(`[commit] entityId ${entityId} embedding 生成失败: ...（不阻断 commit）`);
}
```

**问题**：try/catch 在循环**外部**。若 `changes[0]` 的 `embedFact` 抛错，catch 立即触发，`changes[1..n]` 的 embedding 永不尝试 → 这些 Fact 的 `embedding` 字段保持空 → `search_vector` / `search_hybrid` 对这些事实**永久不命中**（静默数据丢失）。

**对比**：同文件 4.3 步 setVisibility 把 try/catch 放在循环**内部**（[commit.ts:221-L231](file:///workspace/packages/scheduler/src/commit.ts#L221)），逐 knower 独立容错。4.2.5 与 4.3 设计意图相同（失败不阻断），但实现不一致。

**测试缺口**：现有用例 `commit: embedFact 抛错时不阻断 commit`（[commit.test.ts:575-L598](file:///workspace/packages/scheduler/tests/commit.test.ts#L575)）只注入 1 条 state_change，无法暴露多 property 部分失败场景。

**修复方向**：把 try/catch 移入 for 循环体内（与 4.3 对齐），每条 change 独立容错；并补「多 state_change，第 1 条 embedFact 抛错时其余仍写入」的测试。

---

### H2. scheduler_commit 部分成功时 memory.md 不更新（已知未修）
[file:///workspace/src/tools/scheduler-tools.ts#L139-L145](file:///workspace/src/tools/scheduler-tools.ts#L139)

```ts
if (result.ok) {
  try { await updateMemory(g, cwd); } catch (err) { ... }
}
```

**问题**：`commit.ts` 的 `ok = failedEntityIds.length === 0 && failedRelations.length === 0 && renderResult.ok`。部分 entityId 写扩散失败时 `ok=false`，但 `appliedEventIds` 已非空（成功的实体已落库）。当前条件 `if (result.ok)` 跳过 memory.md 更新，导致下一轮检索的"最近事件"展示滞后。

**佐证**：data-flow-audit.md §7 #2 已记录并建议改为 `if (result.appliedEventIds.length > 0)`，但代码未修复。审计文档自承的修复项未落地。

**修复方向**：将条件改为 `if (result.appliedEventIds.length > 0)`。

---

### H3. storyTime 格式描述分裂 + 字符串比较脆弱，`ch-10` 会被判定早于 `ch-2`
- SKILL.md 权威约定：[file:///workspace/src/skills/narrative-engine/SKILL.md#L61-L72](file:///workspace/src/skills/narrative-engine/SKILL.md#L61) 要求 `ch{NNN}.ev{NNN}` 3 位零填充（保证字典序 == 故事时序）。
- types.ts 注释写 `如 ch-2`（带 dash、无填充）：[types.ts:89](file:///workspace/packages/scheduler/src/types.ts#L89)
- render-tools.ts description 写 `如 ch-2`：[render-tools.ts:48](file:///workspace/src/tools/render-tools.ts#L48)、[render-tools.ts:134](file:///workspace/src/tools/render-tools.ts#L134)（注：L92 仅为"故事时间"无格式示例，初稿误列）
- scheduler-tools.ts 用裸字符串比较推进 currentStoryTime：[scheduler-tools.ts:94-L96](file:///workspace/src/tools/scheduler-tools.ts#L94)
- retrieve.ts / world-graph.ts 的双时态过滤同样用字符串字典序比较：[retrieve.ts:278](file:///workspace/packages/scheduler/src/retrieve.ts#L278)、[world-graph.ts:312-L317](file:///workspace/packages/world-graph/src/world-graph.ts#L312)

**问题**：`chapter-resolver.ts` 同时支持两种格式（`ch-2` 与 `ch009.ev003`）。一旦主会话混用：`"ch-10" < "ch-2"`（因 `'1' < '2'`），即"第 10 章会被认为早于第 2 章"——getEntityAt 与 retrieve P0-1 时态过滤双双失效，未来事实泄漏。retrieve.test.ts 注释（[retrieve.test.ts:695](file:///workspace/packages/scheduler/tests/retrieve.test.ts#L695)）已意识到此问题，用 `ch-99` 规避单测，但无生产侧防护。`StructuredEvent.storyTime`（[types.ts:90](file:///workspace/packages/scheduler/src/types.ts#L90)）是 `string`，无格式校验。

**修复方向**：在系统边界对 `storyTime` 做格式校验（强制 `ch<NNN>.ev<NNN>` 零填充，拒绝 `ch-<N>` 多位数），或统一规整化；render-tools / types.ts 描述改为 `如 ch009.ev006` 与 SKILL.md 一致。这是双时态检索正确性的隐性前提，目前仅靠约定无防护。

---

### H4. StructuredEvent.locationId 字段声明但完全未消费（已知未修，降级为 M——见 M4a）
> 经复核降级：此为过度工程/死字段问题，不写坏数据、不崩溃、不让现有功能失效，影响仅是"主会话传了 locationId 以为会触发可见性推断，实际被丢弃"。详见中严重度 M4a。

---

### H5. CI 测试覆盖严重缺失——应用化核心包零 CI 覆盖
[file:///workspace/.github/workflows/test.yml#L35](file:///workspace/.github/workflows/test.yml#L35)

`test.yml` 只跑 5 个子包套件（world-graph / role-pool / scheduler / renderer / novel-importer）+ 1 个根测试（`tests/import-card.test.ts`）。但本版本主打的"应用化"核心包完全没有进 CI：
- `packages/admin/tests/`（9 个测试文件）未运行
- `packages/novel-launcher/tests/`（4 个测试文件）未运行
- 根 `tests/` 下 unified-server / project-registry / visualizer-server / tools / search / memory / checker / prompts / role-pool-llm / story-time / frontend-utils / e2e / e2e-renderer / debug/* 均未运行

CHANGELOG 第 13 行声称"已通过 326+ 单元测试 + 2 个端到端测试"，但 CI 实际只验证其中一小部分。本次新增的应用内置模式、扩展重装、项目迁移、配置管理等关键链路在 CI 上完全无回归保护。根 `package.json` 也无 `test` 脚本，CI 靠手工罗列套件，新增包极易被遗漏。

**修复方向**：把 admin / novel-launcher / 根 tests/ 纳入 test.yml，并在根 package.json 加 `test` 脚本统一编排。

---

### H6. esbuild 被构建脚本直接 import，但任何 package.json 都未声明
[file:///workspace/scripts/build.mjs#L19](file:///workspace/scripts/build.mjs#L19)
[file:///workspace/scripts/package-sidecar.mjs#L32](file:///workspace/scripts/package-sidecar.mjs#L32)
[file:///workspace/package.json#L18](file:///workspace/package.json#L18)

`build.mjs`（`import { transform } from "esbuild"`）和 `package-sidecar.mjs`（`import * as esbuild from "esbuild"`）直接依赖 esbuild，但根 `package.json` devDependencies 无 esbuild，全仓 `package.json` 中 `grep esbuild` 零命中。当前能跑仅因 `tsx`（各子包 devDependency）传递依赖 esbuild 并被 hoist。一旦 tsx 升级/换底层依赖，`npm run build` 与 `npm run sidecar` 会直接报 `Cannot find package 'esbuild'`。

**修复方向**：将 `esbuild` 显式写入根 devDependencies。

---

### H7. import-novel-v3.ts 默认 `--world-graph` 硬编码开发者本机 Windows 路径（降级为 M——见 M4b）
> 经复核降级：这是一次性开发者 CLI 脚本（scripts/ 下，非生产代码），不影响扩展运行时、不影响最终用户。详见中严重度 M4b。

---

### H8. novel-importer pipeline.ts resume 从阶段 ≥2 起章节全文丢失（降级为 M——见 M4c）
> 经复核降级：README L46-L49 明示 novel-importer 是"测试实现，不保证数据质量，后续将重写"。按项目上下文，其 bug 严重度应降级。bug 本身属实（详见中严重度 M4c），但归为 M 更符合项目实际。

---

## 2. 🟡 中严重度（一致性 / 过度工程 / 可维护性）

### M4a. StructuredEvent.locationId 字段声明但完全未消费（原 H4 降级）
[file:///workspace/packages/scheduler/src/types.ts#L110-L111](file:///workspace/packages/scheduler/src/types.ts#L110)

注释写"地点 ID（可选，用于可见性推断；缺省时不触发额外推断）"，scheduler-tools.ts L83 也将其透传到 `StructuredEvent`，但 `packages/scheduler/src/plan.ts` 与 `commit.ts` 全文未读取该字段（grep 确认 scheduler/src 下仅 types.ts 出现 locationId）。`world_visibility_infer` 工具存在（[world-tools.ts:442-L459](file:///workspace/src/tools/world-tools.ts#L442)），但调度器内部不调用它。data-flow-audit.md §7 #1 已记录未修。

**为什么是 M 而非 H**：不写坏数据、不崩溃、不让现有功能失效。影响仅是"主会话传了 locationId 以为会触发可见性推断，实际被静默丢弃"。属过度工程/死字段。

**修复方向**：二选一——要么在 commit 4.x 步按 `event.locationId` 调 `wg.inferVisibility(event.storyTime)`（接线），要么从 schema 删除该字段（避免误导调用方）。

---

### M4b. import-novel-v3.ts 默认 `--world-graph` 硬编码开发者本机 Windows 路径（原 H7 降级）
[file:///workspace/scripts/import-novel-v3.ts#L104](file:///workspace/scripts/import-novel-v3.ts#L104)

```ts
opts.worldGraph = path.resolve("d:\\claude\\pi-ex\\novel\\.pi\\world-graph-v3");
```

注释自称"缺省指向 novel/.pi/world-graph-v3"，但实际是绝对路径。任何其他人在其他机器跑（不显式传 `--world-graph`）都会写入这个不存在的目录。

**为什么是 M 而非 H**：一次性开发者 CLI 脚本（scripts/ 下，非生产代码），不影响扩展运行时、不影响最终用户。

**修复方向**：改为 `path.resolve("novel", ".pi", "world-graph-v3")` 或 `process.cwd()` 相对路径。

---

### M4c. novel-importer pipeline.ts resume 从阶段 ≥2 起章节全文丢失（原 H8 降级）
[file:///workspace/packages/novel-importer/src/pipeline.ts#L206-L223](file:///workspace/packages/novel-importer/src/pipeline.ts#L206)

resume 时 chapters 从 dump 加载，但 dump 中刻意不保留全文（`content: ""`）。然而重读条件是 `if (resumeFromStage <= 1 || chapters.length === 0)`——当 `resumeFromStage >= 2` 且 dump 有章节元数据时，`chapters.length > 0`，**EPUB 不会被重读**，chapters 全部带着空 content 进入后续阶段。阶段 3 `generateAllChapterEvents` 的空章节检查会对所有章节命中，全部返回空事件 → 0 事件。`tests/smoke.test.ts` 无 resume 路径测试，故此 bug 未被覆盖。

**为什么是 M 而非 H**：README L46-L49 明示 novel-importer 是"测试实现，不保证数据质量，后续将重写"。按项目上下文降级。bug 本身属实。

**修复方向**：resume 时无条件重读 EPUB 填充 content，或 dump 保留全文。

---

### M30. launch.ts _spawnDarwin / xterm 存在 shell 命令注入（cwd 未转义）【复核补漏】
[file:///workspace/packages/novel-launcher/src/launch.ts#L103](file:///workspace/packages/novel-launcher/src/launch.ts#L103)
[file:///workspace/packages/novel-launcher/src/launch.ts#L140](file:///workspace/packages/novel-launcher/src/launch.ts#L140)

```ts
// L103 _spawnDarwin
const shellCmd = `cd '${cwd}' && ${piCmd}`;
// L140 xterm
["-e", `cd '${cwd}' && ${piCmd}`]
```

`cwd` 仅用单引号包裹但**未对 cwd 内的单引号做转义**。若项目路径含单引号（如 `x'; rm -rf ~; echo '`），可构造命令注入。`launchPi` 是公共 API，projectDir 可来自外部注册数据。

**对比**：本报告 L21 指出的"_spawnLinux 未引号化 --working-directory"实际是弱发现——该处用 `spawn` 数组传参（无 shell），实际安全；反而真正的 shell 注入（_spawnDarwin/xterm 用字符串拼接 + shell:true）被初稿漏掉。L21 已据此修正。

**修复方向**：对 cwd 内的单引号做转义（`cwd.replace(/'/g, "'\\''")`），或改用 `spawn` 数组传参避免 shell 拼接。

---

### M1. setVisibility opts.source 类型为 string 而非 VisibilitySource 枚举，schema 与函数签名不一致
[file:///workspace/packages/world-graph/src/world-graph.ts#L485-L508](file:///workspace/packages/world-graph/src/world-graph.ts#L485)

```typescript
async setVisibility(characterId, declarationId, opts: {
  state: "known";
  confidence: number;
  source: string;          // ← 应为 VisibilitySource
  ...
}): Promise<void>
```

节点 schema（[world-graph.ts:74](file:///workspace/packages/world-graph/src/world-graph.ts#L74)）和 `VisibilityDeclaration`（[types.ts:115](file:///workspace/packages/world-graph/src/types.ts#L115)）都已用 `VisibilitySource = z.enum(["experienced","informed","witnessed"])` 枚举，但 `setVisibility` 入参 `source: string` 放宽了约束。TS 无法在编译期拦截拼写错误；运行时 schema 校验抛错会被 commit 4.3/4.4 的 catch 静默吞掉 → 可见性写入静默失败。

**修复方向**：把 `source: string` 改为 `source: VisibilitySource`，并 import 该类型。零运行时影响，纯类型收窄。

---

### M2. getAllDeclarationsAt 映射时丢弃 valueText，knowledgeMapper 候选信息不完整
[file:///workspace/packages/world-graph/src/world-graph.ts#L571-L585](file:///workspace/packages/world-graph/src/world-graph.ts#L571)

```typescript
async getAllDeclarationsAt(storyTime, opts?) {
  const facts = await this.findNodes("Fact", opts?.recordedAsOf);
  return facts.filter(...).map((f: any) => ({
    declarationId, entityId, property, value, modality, validFrom, validTo,
    // ← 缺 valueText: f.valueText
  })) as StateDeclaration[];
}
```

`StateDeclaration.valueText` 是 optional，类型合法，但 commit.ts 4.4 的 knowledgeMapper 候选列表只取了 declarationId/entityId/property/value 四字段。LLM 做语义匹配时，`value` 是 `unknown`（可能是对象/数字），缺少人类可读的 `valueText` 会降低映射精度。`reembedAll` 和 `getEntityAt` 都映射了 valueText，唯独此方法漏了。

**修复方向**：map 中补 `valueText: f.valueText`；commit.ts 候选 brief 也补 valueText 字段。

---

### M3.【过度工程】scheduler-llm.ts 的 embedderAdapter 是冗余包装
[file:///workspace/src/scheduler-llm.ts#L70-L78](file:///workspace/src/scheduler-llm.ts#L70)

```ts
const embedderAdapter: {
  embed(text: string): Promise<number[]>;
  embedEntity(snap: EntitySnapshot): Promise<number[]>;
  embedFact(decl: StateDeclaration): Promise<number[]>;
} = {
  embed: (text: string) => embedder.embed(text),
  embedEntity: (snap) => embedder.embedEntity(snap),
  embedFact: (decl) => embedder.embedFact(decl),
};
```

**为什么过度**：`Embedder` 类（[embedder.ts:63](file:///workspace/src/embedder.ts#L63)）已实现 `embed`/`embedEntity`/`embedFact` 三方法，签名完全一致。`SchedulerCtx.embedder` 是结构化类型（[types.ts:373](file:///workspace/packages/scheduler/src/types.ts#L373)），TypeScript structural typing 自动让 `Embedder` 实例满足该接口。注释自承"显式包装保持与现有代码风格一致，便于单测 mock"——但 mock 应在测试侧注入（构造 mock 对象传 `makeSchedulerCtx`），不应在装配层加运行时包装。

**更简单替代**：`embedder: embedder`（删整个 adapter），约 10 行代码消失。若担心未来 Embedder 接口漂移，可在类型层用 `satisfies` 约束而非运行时包装。

---

### M4.【过度工程 / 死代码】embedder.ts 的 getDefaultEmbedder 单例 + 静态方法 + embedBatch 均无生产调用
[file:///workspace/src/embedder.ts#L194-L218](file:///workspace/src/embedder.ts#L194)（`cosineSimilarity`/`euclideanDistance`）
[file:///workspace/src/embedder.ts#L225-L232](file:///workspace/src/embedder.ts#L225)（`defaultEmbedder` + `getDefaultEmbedder`）
[file:///workspace/src/embedder.ts#L158-L185](file:///workspace/src/embedder.ts#L158)（`embedBatch`，【复核补漏】）

- `getDefaultEmbedder` 在 src/ 全量 Grep 仅命中定义处（无任何调用方）；项目统一用 `new Embedder()`（index.ts L111、main.ts L57、standalone.ts L74）
- `cosineSimilarity`/`euclideanDistance` 仅在 `tests/embedder.test.ts` L33-36 被调用，生产代码不引用（向量相似度计算已下沉到 sqlite-vec）
- `embedBatch`（28 行，含维度切片逻辑）全文 grep 仅命中定义处与 docs/api.md，**零生产调用、零测试调用**

**例外**：`docs/api.md` L1411/L1420-1421 把这些列为公共 API。若要保留作为对外 API 承诺，应加 `@public` 注释；否则建议删除以减少维护面。

**更简单替代**：删除 `defaultEmbedder`/`getDefaultEmbedder`/`embedBatch`；静态方法若不再对外暴露则一并删除。

---

### M5. memory.ts updateMemory 双重调用 wg.getAllEvents()
[file:///workspace/src/memory.ts#L91-L92](file:///workspace/src/memory.ts#L91)

```ts
const events = await wg.getAllEvents();        // L91
const latest = await latestStoryTime(wg);      // L92，内部又调 wg.getAllEvents()
```

两次全表扫描（world-graph 无业务字段索引）。事件量大时浪费 IO。

**更简单替代**：把 `latestStoryTime` 改为 `latestStoryTimeFromEvents(events)` 内联计算，或直接 `events.reduce(...)`。

---

### M6. Search 类 embedder 强制非空 + `as Embedder` 反模式（类型不安全）
[file:///workspace/src/search.ts#L18-L22](file:///workspace/src/search.ts#L18)（构造器要求 `embedder: Embedder` 非空）
[file:///workspace/src/app/project-registry.ts#L122](file:///workspace/src/app/project-registry.ts#L122)（`new Search(wg, this.embedder as Embedder)`）
[file:///workspace/src/visualizer/standalone.ts#L79](file:///workspace/src/visualizer/standalone.ts#L79)（`new Search(wg, null as unknown as Embedder)`）

`Search.vector`/`Search.hybrid` 会调 `this.embedder.embed(query)`。当 embedder 实际为 null 时运行时抛 `Cannot read property 'embed' of null`，但 TypeScript 编译期检查被 `as Embedder` 绕过。`forceFulltext` 标志只是约定，没有运行时强制约束。

**为什么是过度工程**：用 cast 撒谎给类型系统看，换取"构造器签名简洁"。一旦有人在 forceFulltext=true 的场景误调 `search.vector`，运行时崩、编译期无警告。

**更简单替代**：`Search` 构造器改为 `embedder: Embedder | null`；`vector`/`hybrid` 内首行 `if (!this.embedder) throw new Error("vector/hybrid 检索需要 embedder")`。

---

### M7. commit.ts 用 `String(change.value)` 给 valueText，对象值会变 `[object Object]`
[file:///workspace/packages/scheduler/src/commit.ts#L198](file:///workspace/packages/scheduler/src/commit.ts#L198)

```ts
valueText: String(change.value),
```

`state_changes.value` 的 schema 是 `Type.Unknown`（[role-pool-llm.ts:54](file:///workspace/src/role-pool-llm.ts#L54)），允许任意类型。当 LLM 输出对象/数组时，`String(obj)` 得 `"[object Object]"`——FTS 检索命中无效、embedding 文本无意义。world-graph 自身也用 `String(val)`（world-graph.ts L279、L465），是项目级一致的反模式。但 commit 路径是新写入的主要来源，影响更大。

**修复方向**：`valueText: typeof change.value === "object" ? JSON.stringify(change.value) : String(change.value)`，或在 schema 层限定 `value` 为标量联合。

---

### M8. 审计文档（docs/audits/*）行号引用全部过期，与现状脱节
[file:///workspace/docs/audits/2026-07-29-data-flow-audit.md#L60](file:///workspace/docs/audits/2026-07-29-data-flow-audit.md#L60) 引用 `src/index.ts:1216-1246`
[file:///workspace/docs/audits/2026-07-29-data-flow-audit.md#L499](file:///workspace/docs/audits/2026-07-29-data-flow-audit.md#L499) 引用 `src/index.ts:200-204`

当前 `src/index.ts` 仅 227 行。重构后工具注册拆到 `src/tools/*.ts`，但审计文档全部沿用拆分前的旧行号。`2026-07-25-requirements-audit.md` L32 引用 `src/index.ts:236`（旧 `before_agent_start` 行号，现已挪到 L167）。新开发者照行号查源码会找不到对应代码，违反"以查档求证为荣"原则。

**修复方向**：审计文档统一加"基线 commit"标注 + 重新核对行号；或改为引用函数名/工具名而非行号。

---

### M9. plan.ts 动态事实不去重，同一 declarationId 跨检索项重复注入（已标注但未修）
[file:///workspace/packages/scheduler/src/plan.ts#L154-L155](file:///workspace/packages/scheduler/src/plan.ts#L154)

```typescript
// 注意：当前不去重（Pending Gap #11），同一 declarationId 可能被多次命中
facts.push(...result.map((f) => ({ ...f, label: item.label })));
```

planner LLM 可能输出多条 RetrievalItem 命中同一 declarationId（如 character_view + search_text 都返回同一 Fact），全部累加到 `dynamicFactsByCharacter`，注入角色提示词时重复占 token。data-flow-audit #3 已记录为 P2。注释承认了但未修。

**修复方向**：在 push 前按 declarationId 去重（保留首次命中的 label，或合并 label）。

---

### M10.【过度工程】debug.ts 用模块级可变计数器生成 span eventId
[file:///workspace/packages/scheduler/src/debug.ts#L62-L65](file:///workspace/packages/scheduler/src/debug.ts#L62)

```typescript
let nextSpanId = 1;
function genEventId(): string {
  return `dbg_${Date.now().toString(36)}_${nextSpanId++}`;
}
```

`nextSpanId` 是进程全局可变状态。`tsx --test` 并行跑用例时，span ID 跨用例共享计数器，断言无法依赖稳定 ID。属"为简单需求用了进程级单例"的轻微过度工程。

**替代方案**：用 `crypto.randomUUID()` 或 `${Date.now()}_${Math.random().toString(36).slice(2,8)}`（与 `newTraceId` 同风格，[debug.ts:133](file:///workspace/packages/scheduler/src/debug.ts#L133)），去掉模块级状态。

---

### M11. api.md §6.5 / §6.6 导出清单与实际 `_` 前缀软隔离约定不一致
[file:///workspace/docs/api.md#L1098](file:///workspace/docs/api.md#L1098)（renderer 类型导出）
[file:///workspace/docs/api.md#L1204-L1206](file:///workspace/docs/api.md#L1204)（role-pool 类型与 prompts 导出）
实际导出：[renderer/src/index.ts:50-L62](file:///workspace/packages/renderer/src/index.ts#L50)、[role-pool/src/index.ts:47-L62](file:///workspace/packages/role-pool/src/index.ts#L47)

api.md 仍按旧版无前缀导出描述，但两个 `index.ts` 在 2026-07-29 引入了 `_` 前缀软隔离约定（`_` 前缀 = 包内部实现，不保证稳定）。具体偏差：
- renderer：api.md 写 `export { appendToChapter, modifyChapterSection }`，实际为 `_appendToChapter, _modifyChapterSection`；`RENDERER_SYSTEM_PROMPT / buildUserMessage` 实际为 `_RENDERER_SYSTEM_PROMPT / _buildUserMessage`；`RenderCtx` 实际为 `_RenderCtx`
- role-pool：api.md 写 `RoleRelationUpdate`（实际无此类型，类型名是 `RelationUpdate` 且导出为 `_RelationUpdate`）；`RoleCtx` 实际为 `_RoleCtx`；`SillyTavernCard / FactSnapshot / PriorAction` 实际均为 `_` 前缀；api.md 漏列 `InteractHooks`（实际为公共导出）

**修复方向**：更新 api.md §6.5/§6.6 导出清单为 `_` 前缀版本，并补 `InteractHooks`，删除不存在的 `RoleRelationUpdate`。

---

### M12. mock-scheduler.ts 演示数据违反 prompt 自身规则
[file:///workspace/packages/role-pool/demo/mock-scheduler.ts#L125](file:///workspace/packages/role-pool/demo/mock-scheduler.ts#L125)、[mock-scheduler.ts:139](file:///workspace/packages/role-pool/demo/mock-scheduler.ts#L139)

演示的 `scriptedOutputs` 中 `relation_update.target` 填的是名字（`"陆谦"`、`"林冲"`），而 `prompts.ts:154` 明确要求 "relation_update.target 填对方角色的 characterId（不是名字，如 e_lin_chong）"。cast 中已定义 `characterId: "linchong"` / `"luxian"`，但 mock LLM 输出用名字。运行 demo 后 `extractRelations` 产出 `{ source: "linchong", target: "陆谦", label: "仇敌" }` —— target 是名字而非 entityId，真实场景下 `wg.addRelation` 会拿到不存在的 targetId。

**修复方向**：把 `target: "陆谦"` 改为 `target: "luxian"`，`target: "林冲"` 改为 `target: "linchong"`。

---

### M13. InteractHooks 公共 API 在 role-pool 包内零测试覆盖
接口定义 [file:///workspace/packages/role-pool/src/types.ts#L157-L175](file:///workspace/packages/role-pool/src/types.ts#L157)
调用点 [role-pool.ts:42](file:///workspace/packages/role-pool/src/role-pool.ts#L42)、[role-pool.ts:56](file:///workspace/packages/role-pool/src/role-pool.ts#L56)、[role-pool.ts:60](file:///workspace/packages/role-pool/src/role-pool.ts#L60)
测试目录 [role-pool.test.ts](file:///workspace/packages/role-pool/tests/role-pool.test.ts)（全文无 hooks 用例）

`InteractHooks` 是公共导出（`index.ts:38` 无 `_` 前缀），`onTurnStart` 返回 token、`onTurnEnd` 接收 token 的传递契约，以及"成功走 `{ output }` 分支、失败走 `{ error }` 分支"的语义，在 role-pool 包内无任何测试。仅靠 scheduler 侧间接覆盖。

**修复方向**：补 3 个用例——注入 onTurnStart/onTurnEnd 验证调用次数与 token 透传；成功路径 result.output；失败路径 result.error。

---

### M14. relation_update.target 在渲染器 payload 中是 characterId 而非名字（设计张力）
role-pool 侧 [types.ts:96-L97](file:///workspace/packages/role-pool/src/types.ts#L96)（注释要求 target 填 characterId）+ [transforms.ts:41-L45](file:///workspace/packages/role-pool/src/transforms.ts#L41)（`toRoleOutputs` 直接 `...rest` 透传，不翻译）
renderer 侧 [prompts.ts:115-L120](file:///workspace/packages/renderer/src/prompts.ts#L115)（`formatPayload` 把 `ru.target` 原样输出为 `    - ${ru.target}: ${ru.label}`）

role-pool 为方便 scheduler 的 `wg.addRelation`，强制 LLM 在 `relation_update.target` 填对方 characterId（如 `luxian`）。但 `toRoleOutputs` 投影给 renderer 时**不翻译**为名字，renderer 的 `formatPayload` 把 characterId 原样塞进 prompt。渲染 LLM 看到的是 `actor: 林冲`（名字）+ `relation_update: - luxian: 仇敌`（characterId），同一对象两种标识并存。

**缓解**：renderer system prompt 要求"relation_update 不要描述关系建立或改变，融入动作即可"，所以 LLM 倾向于忽略 target 字面值。实际影响有限，但仍是设计张力。

**修复方向**：`toRoleOutputs` 接受 cast 映射，把 `relation_update.target` 从 characterId 翻译为名字后再给 renderer；或在 renderer prompt 里附加 characterId→name 名单。

---

### M15. admin updater.ts compareVersions 不支持 v 前缀 tag
[file:///workspace/packages/admin/src/updater.ts#L325-L326](file:///workspace/packages/admin/src/updater.ts#L325)

```typescript
.filter((t) => /^\d+\.\d+\.\d+/.test(t))
```

正则要求 tag 以数字开头，`v0.1.2`（常见 git tag 约定）会被过滤掉 → remote=null。而 `data-flow-audit.md:325` 示例正是 `refs/tags/v0.1.2` 形式。`tests/updater.test.ts:319` 只用无 v 前缀的 `refs/tags/0.1.0`，掩盖了此 bug。

**修复方向**：正则前先 `.replace(/^v/, "")`。

---

### M16. admin updater.ts 版本比较用字典序，多版本号场景选错 latest
[file:///workspace/packages/admin/src/updater.ts#L331-L333](file:///workspace/packages/admin/src/updater.ts#L331)

```typescript
// 简单字典序比较（语义版本格式一致时等价于版本比较）
tags.sort();
resolveVer(tags[tags.length - 1]);
```

对 `0.1.10` vs `0.1.2`，字符串序 `"0.1.10" < "0.1.2"`（因 '1' < '2'），会错误地把 `0.1.2` 选为最新。注释承认限制。

**修复方向**：实现简易 semver 比较（split 后数值比较）。

---

### M17. admin updater.ts _runCommand 中 stderrTail 为死变量
[file:///workspace/packages/admin/src/updater.ts#L125](file:///workspace/packages/admin/src/updater.ts#L125)、[updater.ts:137](file:///workspace/packages/admin/src/updater.ts#L137)

`let stderrTail = "";` 在 L137 `if (isStderr) stderrTail = line;` 被赋值，但函数返回前从未读取。dead code。

**修复方向**：删除，或将其接入错误报告（当前 `_runCommand` 失败仅返回退出码，不含 stderr 摘要）。

---

### M18. admin env-store.ts 删除 key 的 filter 恒真（dead code）
[file:///workspace/packages/admin/src/env-store.ts#L228](file:///workspace/packages/admin/src/env-store.ts#L228)

```typescript
lines = lines.filter((l) => l.type !== "blank" || l.raw !== "" || true);
// 上行 filter 恒真，等价于不过滤
```

`|| true` 使条件恒真。删除 key 时该行被改为空行而非真正移除，文件残留空行。功能上 `readEnvFile` 仍正确，但 L228 是纯死代码。

**修复方向**：删除 L228 与解释注释；如需真正移除，改用显式索引收集法。

---

### M19. admin novel-json.ts _normalizeNovelJson 重复赋值（死代码）
[file:///workspace/packages/admin/src/novel-json.ts#L80-L98](file:///workspace/packages/admin/src/novel-json.ts#L80)

```typescript
return {
  name,                                          // L81
  engine: pick("engine", "string"),              // L82
  ...
  ...raw,                                        // L89 覆盖上面所有
  name,                                          // L91 重新赋值
  engine: pick("engine", "string"),              // L92 重新赋值（pick 第二次调用）
  ...
};
```

L81-87 的赋值被 L89 的 `...raw` 全部覆盖，又在 L91-97 重新赋值。L81-87 是死代码，且 `pick(...)` 对每字段调用了两次。

**修复方向**：简化为 `{ ...raw, name, engine: pick("engine","string"), ... }` 单次赋值。

---

### M20. novel-launcher project.ts launchVisualizer 在打包 sidecar 中可能失效
[file:///workspace/packages/novel-launcher/src/project.ts#L36-L38](file:///workspace/packages/novel-launcher/src/project.ts#L36)、[project.ts:126-L127](file:///workspace/packages/novel-launcher/src/project.ts#L126)

```typescript
const REPO_ROOT = resolve(__dirname, "..", "..", "..");  // 假设源码在 packages/novel-launcher/src/
...
const scriptPath = _resolveScript("visualizer.mjs");      // join(REPO_ROOT, "scripts", name)
```

文件头注释说明 createProject 已为打包 sidecar 内联化（"原 spawn scripts/init-novel.mjs 在打包 sidecar 中无脚本文件可用"），但 `launchVisualizer` 仍依赖 `_resolveScript("visualizer.mjs")` 定位 `REPO_ROOT/scripts/visualizer.mjs`。在打包 sidecar 模式下 `__dirname` 不再是 `packages/novel-launcher/src/`，向上 3 层不是仓库根，`scripts/visualizer.mjs` 大概率不存在。

**修复方向**：与 createProject 同策略，把 visualizer 也内联或由调用方显式传入 scriptPath。

---

### M21. 设置页"向量模型"保存会误删用户的 HF_ENDPOINT / PI_DEBUG（加载遗漏 bug）
[file:///workspace/visualizer-ui/components/settings-view.js#L489](file:///workspace/visualizer-ui/components/settings-view.js#L489)、[settings-view.js:183](file:///workspace/visualizer-ui/components/settings-view.js#L183)

"向量模型"子页的"保存到 .env"按钮调用 `saveConfig()`，而 `saveConfig()` 一次性写全部三个 key（`HF_ENDPOINT` / `PI_DEBUG` / `PI_EMBEDDER_MODEL`）。`configForm` 初始值是三个空字符串，只有在进入"扩展配置"子页时 `loadConfig()` 才会填充。复现路径：用户已在 `.env` 配好 `HF_ENDPOINT` → 打开设置 → 直接切到"向量模型" → 改 `PI_EMBEDDER_MODEL` → 点保存 → `configForm.HF_ENDPOINT=""` 被当 null 写入 → 用户原 `HF_ENDPOINT` / `PI_DEBUG` 被静默删除。

**定性修正（复核）**：初稿将此归为"过度工程"（三字段共享 configForm + 全量写函数）。经复核，共享表单 + 单一保存其实是比拆分更简单的设计；真正的问题是**加载遗漏**——切到"向量模型"子页时 `loadEmbedder()` 未调 `loadConfig()` 填充 HF_ENDPOINT/PI_DEBUG，导致保存时用空串覆盖。

**更简单替代**（比拆单字段保存更简单）：在 `loadEmbedder()` 末尾追加 `this.loadConfig()`，或在 `saveConfig` 入口先 `await loadConfig()` 合并当前值再写。无需拆分表单。

---

### M22. 启动页硬编码 PORT=7421，与 sidecar 的 `NE_PORT` 覆盖机制不一致
[file:///workspace/tauri-app/public/index.html#L34](file:///workspace/tauri-app/public/index.html#L34)
[file:///workspace/tauri-app/src-tauri/src/sidecar.rs#L39](file:///workspace/tauri-app/src-tauri/src/sidecar.rs#L39)

`sidecar.rs::sidecar_port()` 支持 `NE_PORT` 环境变量覆盖端口，`app-mode.md` §9.1 也把"改 NE_PORT"列为端口占用时的排查手段。但启动页 `index.html` 把 `var PORT = 7421` 写死。一旦用户设了 `NE_PORT=8321`，sidecar 监听 8321，启动页仍轮询 7421，60s 后必然超时报错，而服务其实已起来。

**修复方向**：在文档/错误提示里说明"改 NE_PORT 需同步改启动页"，或由 Rust 侧把端口注入 HTML。

---

### M23. visualizer-ui 三个遗留 JS 文件是死代码，仍随 build/sync 分发
[file:///workspace/visualizer-ui/detail-panel.js#L1](file:///workspace/visualizer-ui/detail-panel.js#L1)
[file:///workspace/visualizer-ui/events-view.js#L1](file:///workspace/visualizer-ui/events-view.js#L1)
[file:///workspace/visualizer-ui/graph-view.js#L1](file:///workspace/visualizer-ui/graph-view.js#L1)

`index.html`（[index.html:23](file:///workspace/visualizer-ui/index.html#L23)）只加载 `api.js` / `proto-utils.js` / `components/*.js` / `app.js`，根本不引用这三个根级文件。它们使用的是一套已被废弃的架构（`Viz.app` / `Viz.detail` / `Viz.graph` / `Viz.events`，引用 `detail-drawer` / `dtab` / `dpane` 等当前 DOM 中不存在的元素），而现行 `app.js` 走 Vue + `window.V3`。`grep` 确认这三文件只互相引用，无任何现行文件引用它们。`sync.mjs` 会把整个 `visualizer-ui/` 原样复制到目标项目（[sync.mjs:133](file:///workspace/scripts/sync.mjs#L133)），相当于把约 900+ 行死代码分发出去。

**修复方向**：删除这三个文件。

---

### M24. 版本号三处不一致，新建项目拿到过期 engineVersion
[file:///workspace/templates/novel/novel.json#L4](file:///workspace/templates/novel/novel.json#L4)（`"engineVersion": "0.1.0"`）
[file:///workspace/package.json#L3](file:///workspace/package.json#L3)（`0.1.0-alpha.1`）
[file:///workspace/tauri-app/src-tauri/Cargo.toml#L3](file:///workspace/tauri-app/src-tauri/Cargo.toml#L3)（`0.1.0`）
[file:///workspace/tauri-app/src-tauri/tauri.conf.json#L4](file:///workspace/tauri-app/src-tauri/tauri.conf.json#L4)（`0.1.0-alpha.1`）

`init-novel.mjs` 用此模板创建新项目，新项目的 `novel.json.engineVersion` 落盘就是 `"0.1.0"`，与实际引擎 `0.1.0-alpha.1` 不符。后续 `@pi/admin` 的版本比对（`compareVersions`）若依赖此字段会得到错误结论。

**修复方向**：模板应与 `package.json` 同源（构建时注入或手动对齐）。

---

### M25. lib.rs 文件头注释写错文件名
[file:///workspace/tauri-app/src-tauri/src/lib.rs#L1](file:///workspace/tauri-app/src-tauri/src/lib.rs#L1)

```rust
// main.rs — narrative-engine Tauri 应用入口（阶段 4）
```

该文件是 `lib.rs`，注释却写 `main.rs`（从 main.rs 复制过来未改）。`main.rs` 自身注释是对的。注释与代码不符，排错时易误导。

---

### M26. app.js::onActivated 重复请求 /api/projects/active
[file:///workspace/visualizer-ui/app.js#L169](file:///workspace/visualizer-ui/app.js#L169)

```js
onActivated: function (dir) {
  api.projectActive().then(function (data) {
    self.activeProject = data.active;
    self.init();          // init() 内部又调一次 api.projectActive()
    self.mainTab = "workbench";
  })
}
```

`init()`（line 185）自身就会 `api.projectActive()`。激活成功后这里先拉一次、`init` 再拉一次，同一端点连发两次。`onActivated` 已拿到 `data.active`，直接调 `loadWorld()` 即可，无需再走 `init()` 的探测分支。属于过度编排：把"探测多项目能力"和"加载世界图"两个职责揉进 `init`，导致激活路径上重复探测。

---

### M27. .cargo/config.toml 强制中国镜像，影响非中国贡献者构建 Tauri
[file:///workspace/tauri-app/src-tauri/.cargo/config.toml#L2](file:///workspace/tauri-app/src-tauri/.cargo/config.toml#L2)

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
```

该文件对所有构建本 Tauri 工程的人生效，无条件把 crates.io 换成 `rsproxy.cn`。非中国网络环境下该镜像可能更慢或不可达，且无注释说明可关闭。CI 不构建 Tauri 所以未暴露此问题。

**修复方向**：改为环境变量条件切换，或至少在文件头注明"仅本机加速用，可删除"。

---

### M28. extract-fields.ps1 是开发者一次性脚本，硬编码本机路径
[file:///workspace/scripts/extract-fields.ps1#L1](file:///workspace/scripts/extract-fields.ps1#L1)

```powershell
$lines = Get-Content "d:\claude\pi-ex\novel\.pi\world-graph-v3\events.jsonl"
```

硬编码 `d:\claude\pi-ex\novel\...`，无参数化、无 `param()`。作为 `scripts/` 下被审计的产物，它既不能被他人直接运行，也无文档说明用途。属于应清理的调试残留。

---

### M29. tauri build 直调时 prebuild 不触发（构建鲁棒性缺口）
[file:///workspace/tauri-app/package.json#L10](file:///workspace/tauri-app/package.json#L10)
[file:///workspace/tauri-app/src-tauri/tauri.conf.json#L8](file:///workspace/tauri-app/src-tauri/tauri.conf.json#L8)

`tauri.conf.json` 的 `beforeBuildCommand` 为空字符串，靠 npm `prebuild` 钩子跑 `package-sidecar.mjs`。若开发者直接 `npx tauri build`（不经 `npm run build`），prebuild 不触发，`resources/` 为空（被 .gitignore 排除），release 构建出的安装包无 sidecar 资源，运行时 sidecar 启动失败。

**修复方向**：`beforeBuildCommand` 应直接写 `"node ../scripts/package-sidecar.mjs"` 以保证无论从哪入口调 `tauri build` 都先生成资源。

---

## 3. 🟢 低严重度（代码质量 / 轻度过度工程 / 测试缺口）

> 以下为可改可不改项，择机清理即可。每条均经源码核实。

### 过度工程 / 死代码

- **L1**【过度工程】`buildSystemPrompt` 的 `member` 参数完全未使用，靠 `void member` 抑制 TS 警告，注释自承"未来可能用于按角色定制 prompt"。[role-pool/src/prompts.ts:33](file:///workspace/packages/role-pool/src/prompts.ts#L33)、[prompts.ts:61](file:///workspace/packages/role-pool/src/prompts.ts#L61)。替代：删除 `member` 参数。
- **L2**【过度工程 / 死代码】`updateEntityEmbedding` 为预留 API，无生产调用方，注释明确写"备用 API，预留给未来 updateEntitySummary 路径使用"。[world-graph.ts:817-L836](file:///workspace/packages/world-graph/src/world-graph.ts#L817)。替代：删除，待真要联动 embedding 时再补。
- **L3**【过度工程】`package-sidecar.mjs::depVersion` 的二级回退（向上 6 层 + 名字宽松匹配）为未经验证的假设性需求，且 `name.split("/").pop()` 对 scoped 包会误匹配。[scripts/package-sidecar.mjs:63](file:///workspace/scripts/package-sidecar.mjs#L63)。替代：一级解析失败就返回 null 跳过。
- **L4**【过度工程 / 边界】`proto-utils.js::renderMarkdown` 约 80 行手写 markdown 解析器。[proto-utils.js:76](file:///workspace/visualizer-ui/proto-utils.js#L76)。考虑引 marked.js 或纯文本预览。列为"边界过度工程"，非必须改。
- **L5】bus.ts 的 `count` 变量冗余，始终等于 `min(buffer.length, capacity)`。[debug/bus.ts:40](file:///workspace/src/debug/bus.ts#L40)、[bus.ts:50](file:///workspace/src/debug/bus.ts#L50)。替代：删 `count`，`snapshot` 用 `buffer.length`。
- **L6】validate.ts P0 causedBy 校验含死代码，`causedBy !== item.causedBy` 恒为 false。[novel-importer/src/validate.ts:170-L178](file:///workspace/packages/novel-importer/src/validate.ts#L170)。
- **L7】pipeline.ts 阶段 7 的空 finally 误导。[novel-importer/src/pipeline.ts:435-L453](file:///workspace/packages/novel-importer/src/pipeline.ts#L435)。
- **L8】novel-importer pipeline.ts dump 构造代码重复 6 次。[pipeline.ts:238](file:///workspace/packages/novel-importer/src/pipeline.ts#L238) 等多处。替代：抽取 `buildDump(partial)`。
- **L9】doctor.ts 与 pi-status.ts 版本兼容判断不一致：doctor.ts 对 `1.0.0` 会得 minor=0 < 77 → fail（即使 major=1 应通过）；pi-status.ts 有 `if (major > 0) return true` 兜底。[doctor.ts:266-L269](file:///workspace/packages/admin/src/doctor.ts#L266) vs [pi-status.ts:130-L138](file:///workspace/packages/admin/src/pi-status.ts#L130)。
- **L10】app-config.ts writeAppConfig 仅校验 mode，不校验其他字段类型。[app-config.ts:142-L148](file:///workspace/packages/admin/src/app-config.ts#L142)。

### 代码质量 / 注释不符

- **L11】`as unknown as undefined` 双重断言无意义。[embedder.ts:85](file:///workspace/src/embedder.ts#L85)。
- **L12】三处 `unreachable` throw 不可达（planner/role-pool/knowledge-mapper）。[planner-llm.ts:116](file:///workspace/src/planner-llm.ts#L116)、[role-pool-llm.ts:124](file:///workspace/src/role-pool-llm.ts#L124)、[knowledge-mapper-llm.ts:127](file:///workspace/src/knowledge-mapper-llm.ts#L127)。TS 需要它满足返回类型，模式重复但合理。
- **L13】checker.ts L167 不可达 throw（4 字面量联合已全覆盖）。[checker.ts:167](file:///workspace/src/checker.ts#L167)。
- **L14】story-time.test.ts 文件名与内容不符（只测 default export + getState，不测 storyTime 格式）。[tests/story-time.test.ts](file:///workspace/tests/story-time.test.ts)。
- **L15】import-card.ts PNG 签名校验只校验前 4 字节（真正 PNG 是 8 字节）。[import-card.ts:81](file:///workspace/src/tools/import-card.ts#L81)。
- **L16】import-card.ts iTXt 解析未处理 indexOf 返回 -1。[import-card.ts:103-L104](file:///workspace/src/tools/import-card.ts#L103)。
- **L17】注释与代码不符：types.ts debugBus 文档列出不存在的 step 5.5/6。[scheduler/src/types.ts:411](file:///workspace/packages/scheduler/src/types.ts#L411)。
- **L18】注释与代码不符：index.ts 称 executeRetrievalItem / resolveChapterPath "commit.ts 内部使用"，实际是 plan.ts 使用。[scheduler/src/index.ts:65](file:///workspace/packages/scheduler/src/index.ts#L65)、[index.ts:68](file:///workspace/packages/scheduler/src/index.ts#L68)。
- **L19】epub.ts toc vs flow 注释不严谨。[epub.ts:77](file:///workspace/packages/novel-importer/src/epub.ts#L77)。
- **L20】launch.ts _spawnLinux 忽略 title 形参。[launch.ts:114-L148](file:///workspace/packages/novel-launcher/src/launch.ts#L114)。
- **L21】launch.ts _spawnLinux 未引号化 --working-directory。[launch.ts:122-L128](file:///workspace/packages/novel-launcher/src/launch.ts#L122)。**【复核修正】此为弱发现**：`spawn` 数组传参无 shell，实际安全。真正的 shell 注入在 _spawnDarwin/xterm 路径，见 M30。
- **L22】project.ts openInFileManager 静默吞错。[project.ts:155-L157](file:///workspace/packages/novel-launcher/src/project.ts#L155)。
- **L23】embedder-status.ts clearEmbedderCache 与 _findCacheDir 路径不对称。[embedder-status.ts:165-L171](file:///workspace/packages/admin/src/embedder-status.ts#L165) vs [:90-L102](file:///workspace/packages/admin/src/embedder-status.ts#L90)。
- **L24】validate.ts P0 "birth 不重复"被降级为 P1，偏离 spec 注释。[validate.ts:16](file:///workspace/packages/novel-importer/src/validate.ts#L16) 与 [:221-L223](file:///workspace/packages/novel-importer/src/validate.ts#L221)。
- **L25】resolve.ts makeLlmCaller 全阶段共用硬编码参数 maxTokens:8000/temperature:0.1。[resolve.ts:375-L377](file:///workspace/packages/novel-importer/src/resolve.ts#L375)。
- **L26】debug-view.js 绕过 api.js 直接用 fetch。[debug-view.js:312](file:///workspace/visualizer-ui/components/debug-view.js#L312)、[debug-view.js:449](file:///workspace/visualizer-ui/components/debug-view.js#L449)。
- **L27】editor-view.js 刷新按钮用错图标（funnel=漏斗）。[editor-view.js:181](file:///workspace/visualizer-ui/components/editor-view.js#L181)。
- **L28】api.js 命名歧义：adminConfig vs adminAppConfig。[api.js:158](file:///workspace/visualizer-ui/api.js#L158)、[api.js:198](file:///workspace/visualizer-ui/api.js#L198)。
- **L29】build.mjs rewriteTsSpecifiers 正则只覆盖静态 from 形式，不处理动态 import。[build.mjs:49](file:///workspace/scripts/build.mjs#L49)。当前不构成 bug。
- **L30】settings-view.js 概览页按钮触发双重加载。[settings-view.js:406](file:///workspace/visualizer-ui/components/settings-view.js#L406)。
- **L31】sync.mjs replaceDistAtRoot 不清理源端已删除的产物文件。[sync.mjs:87](file:///workspace/scripts/sync.mjs#L87)。

### 边界处理 / 测试缺口

- **L32】modifyChapterSection 重写后丢失下一锚点前的空行。[chapter-io.ts:116-L122](file:///workspace/packages/renderer/src/chapter-io.ts#L116)。测试 [chapter-io.test.ts:95-L115](file:///workspace/packages/renderer/tests/chapter-io.test.ts#L95) 仅检查包含性，未校验空行格式。
- **L33】readChapterSection endEventId 缺失时静默回退到 EOF，与 startEventId 缺失抛错不对称。[chapter-io.ts:153-L160](file:///workspace/packages/renderer/src/chapter-io.ts#L153)。
- **L34】renderToFile 的 `modifyAnchorEventId ?? cmd.eventId` 回退路径未测试。[renderer.ts:74](file:///workspace/packages/renderer/src/renderer.ts#L74)。
- **L35】interact + executionHints 集成路径未在 role-pool.test.ts 覆盖。[role-pool.ts:45](file:///workspace/packages/role-pool/src/role-pool.ts#L45)。
- **L36】extractStateChanges 用 `if (out.state_changes)` 而非 `?.length`，`[]` 边界未测试。[transforms.ts:58](file:///workspace/packages/role-pool/src/transforms.ts#L58)。
- **L37】interact 中 onTurnStart 在 try/catch 之外，onTurnEnd 在内，hooks 错误处理不对称。[role-pool.ts:42](file:///workspace/packages/role-pool/src/role-pool.ts#L42)、[role-pool.ts:56](file:///workspace/packages/role-pool/src/role-pool.ts#L56)、[role-pool.ts:60](file:///workspace/packages/role-pool/src/role-pool.ts#L60)。
- **L38】retrieve.ts hitsToFactSnapshots 的 Relation / Visibility 分支无测试覆盖。[retrieve.ts:304-L332](file:///workspace/packages/scheduler/src/retrieve.ts#L304)。
- **L39】planner-llm.ts parseRetrievalItem 不校验 type 字段合法性。[planner-llm.ts:133-L150](file:///workspace/src/planner-llm.ts#L133)。
- **L40】cache.ts setPlan 持久化为 fire-and-forget，yolo 模式紧接 commit 时存在竞态窗口（由 ENOENT 容错兜底，非 bug）。[cache.ts:162-L166](file:///workspace/packages/scheduler/src/cache.ts#L162)。
- **L41】role-pool-llm.test.ts 仅测 schema 常量，不覆盖重试与解析逻辑。[tests/role-pool-llm.test.ts](file:///workspace/tests/role-pool-llm.test.ts)。
- **L42】novel-importer 无 validate.test.ts / pipeline.test.ts / write.test.ts，resume 路径与 P0/P1 校验无测试。
- **L43】rule-loader.ts 两个包近乎完全重复，但属合理重复（保持子包零外部依赖）。[role-pool/src/rule-loader.ts:1-L31](file:///workspace/packages/role-pool/src/rule-loader.ts#L1) vs [renderer/src/rule-loader.ts:1-L33](file:///workspace/packages/renderer/src/rule-loader.ts#L1)。仅记录。

---

## 4. 过度工程专项总结

本次审计重点检查过度工程，共识别 **7 处明确过度工程** + **1 处边界过度工程**（M21 经复核重新定性为加载遗漏 bug，已从此表移除）：

| # | 位置 | 类型 | 建议 |
|---|---|---|---|
| M3 | scheduler-llm.ts embedderAdapter | 冗余包装层 | 删除 adapter，直接 `embedder: embedder` |
| M4 | embedder.ts getDefaultEmbedder + 静态方法 | 死代码（hypothetical 未来需求） | 删除 |
| L1 | role-pool buildSystemPrompt 的 member 参数 | 为 hypothetical 未来需求保留参数 | 删除参数 |
| L2 | world-graph updateEntityEmbedding | 预留 API 无调用方 | 删除，待真要联动时再补 |
| L3 | package-sidecar depVersion 二级回退 | 未经验证的假设性需求 | 一级失败就返回 null |
| L4 | proto-utils renderMarkdown | 边界过度工程（自研 markdown 解析） | 评估引 marked.js |
| M10 | debug.ts 模块级可变计数器 | 为简单需求用进程级单例 | 用 randomUUID |
| M4a | StructuredEvent.locationId（原 H4 降级） | 收了字段却不接线（hypothetical 需求） | 接线或删除 |

> **M21 不再列入此表**：经复核重新定性为"加载遗漏 bug"，非过度工程（共享表单 + 单一保存其实是更简单的设计）。详见中严重度章节 M21。

**共性模式**：过度工程主要表现为「为 hypothetical 未来需求提前实现」（预留 API、保留参数）和「无实际增值的包装层」（adapter/wrapper）。符合用户规则"以新增冗余为耻，以复用存量为荣"的关切方向。

**误判边界**：以下看似过度但实为合理设计，已核实不报：
- `RenderFileCommand` 与 `RenderTextCommand` 双类型（输入语义不同，分离合理）
- `renderToFile` 整体 try/catch 转 `RenderResult{ok:false}`（系统边界把异常转结构化结果，合理）
- `_` 前缀软隔离约定（合理的版本演进策略）
- `rule-loader.ts` 两包重复（保持子包零外部依赖，合理）
- `InteractHooks.onTurnStart` 返回 `unknown` token（span 句柄透传，类型安全选择）

---

## 5. 测试覆盖总评

| 模块 | 覆盖评估 |
|---|---|
| world-graph + scheduler | 优。P0 修复均有对应用例。缺口：H1 多 property 部分失败、L2 Relation/Visibility 检索分支 |
| role-pool + renderer | 良。prompts/transforms/chapter-io 质量高。缺口：M13 InteractHooks、L34-L37 若干集成路径 |
| novel-importer | 一般（测试实现背景下可接受）。缺口：L42 无 validate/pipeline/write 测试，resume 路径无覆盖（致 H8 未被发现）|
| novel-launcher | 优。覆盖全面 |
| admin | 良。缺口：updater v 前缀 bug 被测试掩盖（M15）、env-store 删除 key 残留空行未校验（M18）|
| src/ 核心 | 良。memory/checker/bus/unified-server 有集成测试。缺口：L41 planner/role-pool/knowledge-mapper LLM 的 retry 循环与 parse 兜底无单测 |
| **CI 编排** | **差**。H5——应用化核心包零 CI 覆盖，326+ 测试只跑一小部分 |

---

## 6. Top 必修项（按优先级）

### 第一梯队（数据正确性 / 构建破坏，建议立即处理）

1. **H1 — commit.ts 4.2.5 步 try/catch 位置**：把 try/catch 从 for 循环外移入循环内（与 4.3 步 setVisibility 对齐），避免单条 `embedFact` 失败导致同实体其余 property 的 embedding 全部丢失。并补多 state_change 部分失败测试。
2. **H2 — scheduler_commit 部分成功时 memory.md 不更新**：改 `if (result.ok)` 为 `if (result.appliedEventIds.length > 0)`（[scheduler-tools.ts:139](file:///workspace/src/tools/scheduler-tools.ts#L139)）。一行改动，修一个数据正确性 bug。
3. **H3 — storyTime 格式边界校验**：在 `StructuredEvent` 入口对 storyTime 做格式校验（强制 `ch<NNN>.ev<NNN>` 零填充），消除 `ch-10 < ch-2` 字典序导致的时态过滤系统性失效。统一 render-tools.ts 三处 description 为 `如 ch009.ev006`。
4. **H5 — 补齐 CI 测试矩阵**：把 admin / novel-launcher / 根 tests/ 纳入 test.yml，并在根 package.json 加 `test` 脚本。
5. **H6 — 显式声明 esbuild 依赖**：在根 package.json devDependencies 加 `esbuild`。

### 第二梯队（一致性 / 过度工程清理，建议本迭代处理）

6. **M4a — locationId 字段决策**（原 H4 降级）：接线或删除，避免主会话误以为传了就有用。
7. **M4b — 修掉 import-novel-v3.ts 硬编码路径**（原 H7 降级）。
8. **M4c — novel-importer resume 章节全文丢失**（原 H8 降级）：resume 时无条件重读 EPUB 填充 content，或 dump 保留全文。
9. **M30 — launch.ts shell 命令注入修复**（_spawnDarwin / xterm 路径 cwd 未转义，需 cwd 单引号转义或改用 spawn 数组传参）。
10. **M1 — setVisibility source 类型收窄为 VisibilitySource 枚举**。
11. **M3 — 删除 scheduler-llm.ts 的 embedderAdapter 冗余包装**。
12. **M15 + M16 — admin updater 版本比较修复**（v 前缀 + semver 数值比较）。
13. **M21 — 修复设置页向量模型保存误删 .env 配置**（在 `loadEmbedder()` 末尾追加 `loadConfig()` 调用）。
14. **M23 — 删除 visualizer-ui 三个死代码 JS 文件**。
15. **M29 — tauri.conf.json beforeBuildCommand 补齐**。

### 第三梯队（清理项，择机批量处理）

- 过度工程/死代码清理：M4 / L1 / L2 / L3 / L6 / L7 / L8 / M17 / M18 / M19
- 注释/文档对齐：M8 / M11 / M25 / L17 / L18 / L24
- 测试补齐：M13 / L32-L37 / L41 / L42
- 其余 🟢 低级项

---

## 7. 审计方法说明

- **5 个审计代理并行**，按模块分片：src/ 核心层 · world-graph+scheduler · role-pool+renderer · importer+launcher+admin · scripts+tauri+visualizer+CI
- 每个代理独立读源码核实，未臆测接口（遵循"以查档求证为荣"）
- 跨模块重复发现已去重并标注交叉印证（如 H2/H3/H4/M3 同时被 src/ 层和 scheduler 层代理发现）
- 本报告所有行号均以当前源码为准，既往审计文档的过期行号引用见 M8
- 本次仅审计未修改任何文件

**报告结束。**
