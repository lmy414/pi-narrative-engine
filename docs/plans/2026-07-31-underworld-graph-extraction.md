# 架构转型第一阶段：underworld-graph 子包独立化

> 日期：2026-07-31
> 状态：任务文档（待执行）
> 性质：架构转型第一阶段执行计划，按本文档分阶段落地
> 关联：
> - `docs/plans/2026-07-31-sdk-integration-architecture.md`（SDK 集成架构决策）
> - `docs/plans/2026-07-31-tool-allocation-design.md`（工具分配方案）
> - `docs/plans/2026-07-31-sdk-tool-implementation.md`（SDK 工具实现方案）

## 一、任务背景

当前 narrative-engine 采用 PI 扩展模式运行，子包以 workspace symlink + jiti 现场解析 TS 源码的方式被消费。这套架构在前期验证阶段是合适的——快速迭代、零构建开销。但作为应用形态的长期底座，它有几个根本性问题：

1. **扩展模式不适合后续更迭**：PI 扩展加载器、ExtensionRunner、jiti 解析链路构成了一层黑盒，调试困难，时序不可控（见 SDK 工具实现方案 §八 存疑点）。
2. **临时性验证设计不利于应用化**：子包源码即入口（无 dist/）、聚合测试、sync 复制 packages/ 整个目录——这些都是为了快速验证，不是生产级架构。
3. **核心资产与世界图耦合在同一仓库**：world-graph 是项目的核心数据资产，承载所有叙事状态，但它和叙事引擎的业务逻辑混在同一个 monorepo 里，版本共振、变更耦合，不利于长期演进。

需要**架构设计转型**，把核心资产从扩展模式中剥离，建立独立、可版本化、可复用的底层包。

## 二、任务目标

**将 world-graph 子包彻底独立出去，作为独立 git 仓库 + 独立 npm 包发布，narrative-engine 改为通过 npm 依赖引用。**

理由：
- **核心资产**：world-graph 承载所有叙事状态（实体、关系、事件、可见性），是项目的数据底座
- **无耦合**：源码查证确认 world-graph 是叶子包，零依赖 PI 本体（`@earendil-works/pi-*`）和其他 @pi/* 子包（见 §三.1）
- **可复用**：独立后可被其他叙事工具、可视化前端、导入器等独立复用，不绑定 narrative-engine

**独立后包名**：`underworld-graph`（刀剑神域 Alicization 篇虚拟世界名，npm 可用）

## 三、现状查证（基于源码，非脑补）

### 3.1 world-graph 是叶子包，零外部耦合

**查证结论**（grep `packages/world-graph/` 全目录）：

| 依赖类别 | 是否依赖 | 证据 |
|---|---|---|
| PI 本体（`@earendil-works/pi-*`） | **否** | grep `@earendil-works/pi-` 零匹配 |
| PI 类型（`ExtensionContext` / `AgentTool`） | **否** | grep 零匹配 |
| narrative-engine 其他子包（`@pi/*`） | **否** | grep `@pi/(renderer\|scheduler\|role-pool\|...)` 零匹配 |
| 外部图存储 SDK | 是 | `@nicia-ai/typegraph ^0.40.0` |
| 外部存储 | 是 | `better-sqlite3`、`drizzle-orm`、`sqlite-vec` |
| 校验 | 是 | `zod ^4.0.0` |

**world-graph 在依赖图最底层**，是独立化的最佳候选。

### 3.2 当前包结构

[packages/world-graph/package.json](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/package.json) 关键字段：

```json
{
  "name": "@pi/world-graph",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "tsx --test tests/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

特点：
- **无 build 脚本**：源码即入口，`exports` 直接指向 `./src/index.ts`
- **无 dist/ 产物**：`tsconfig` 设 `emitDeclarationOnly: true`，tsc 不产 .js
- **private: true**：不可发布
- **无 README / CHANGELOG / LICENSE**：文档缺失

### 3.3 当前引用方式

**narrative-engine 仓库内引用**（共约 24 个 .ts 源文件 + 8 个 test 文件）：

| 引用位置 | 文件数 | 典型例子 |
|---|---|---|
| 主包 `src/` | 14 | `src/index.ts:31`、`src/search.ts:7`、`src/session-state.ts:13` |
| 子包 `packages/scheduler/src/` | 4 | `commit.ts:54`、`retrieve.ts:27-28` |
| 子包 `packages/novel-importer/src/` | 4 | `pipeline.ts:25`、`write.ts:18-19` |
| 测试文件 | 8 | `tests/e2e.test.ts` 等 |

**引用机制**：
- 子包间用裸版本号 `"@pi/world-graph": "*"`（不是 `workspace:*`）
- 配合根 `package.json` 的 `workspaces: ["packages/*"]`，npm install 时在 `node_modules/@pi/world-graph` 建立 symlink → `packages/world-graph`
- 运行时由 PI 扩展加载器的 jiti 解析 TS 源码

### 3.4 两种消费模式

narrative-engine 有两条并存的消费路径，独立化时都要处理：

| 维度 | PI 扩展模式（开发/novel 工程） | Tauri sidecar 模式（桌面应用打包） |
|---|---|---|
| 主包构建 | esbuild transform-only，逐文件 | esbuild bundle，单文件 |
| 子包消费 | 独立 npm 包，jiti 现场解析 TS 源码 | 全部内联进 `server/main.js` |
| 同步/打包 | [sync.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/sync.mjs) 复制 `packages/` 整个目录 | [package-sidecar.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/package-sidecar.mjs) 复制 `extension-snapshot/` |
| 入口 | `dist/index.js`（PI 加载） | `server/main.js`（Node 直接执行） |

**关键文件**：
- [scripts/sync.mjs:33,125-129](file:///d:/claude/pi-ex/narrative-engine/scripts/sync.mjs) — 复制 `packages/` 到扩展目录
- [scripts/package-sidecar.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/package-sidecar.mjs) — esbuild bundle + extension-snapshot 复刻

### 3.5 运行时路径注入

world-graph 本身不决定存储路径（源码 grep `process.cwd|process.env|__dirname` 零匹配）。路径由调用方通过 `WorldGraphOptions` 注入：

```typescript
export interface WorldGraphOptions {
  dbPath: string;
  eventLogPath: string;
}
```

三处调用入口：
1. [src/index.ts:105-110](file:///d:/claude/pi-ex/narrative-engine/src/index.ts) — 扩展入口，`resolveWorldGraphDir(ctx.cwd)` → `<cwd>/.pi/world-graph-v3/`
2. [src/app/project-registry.ts:88-107](file:///d:/claude/pi-ex/narrative-engine/src/app/project-registry.ts) — 多项目注册表，从 `novel.json` 读 `meta.worldGraphDir`
3. [packages/novel-importer/src/pipeline.ts:127-130](file:///d:/claude/pi-ex/narrative-engine/packages/novel-importer/src/pipeline.ts) — 小说导入器

**独立化后这三处调用逻辑不变**，只是 `WorldGraph` 的 import 来源从 `@pi/world-graph` 改为 `underworld-graph`。

## 四、目标形态

### 4.1 独立 git 仓库

新建仓库 `underworld-graph`（独立 git 历史，与 narrative-engine 完全解耦）：

```
underworld-graph/                # 新独立仓库
├── src/                         # 从 narrative-engine/packages/world-graph/src/ 迁移
├── tests/                       # 从 narrative-engine/packages/world-graph/tests/ 迁移
├── scripts/
│   └── smoke.mjs                # 冒烟脚本
├── package.json                 # name: "underworld-graph", private: false
├── tsconfig.json                # 独立配置，产出 dist/
├── README.md                    # 新增
├── CHANGELOG.md                 # 新增
├── LICENSE                      # 新增
└── .github/workflows/           # CI: test + build + publish
```

### 4.2 npm 包：underworld-graph

**package.json 关键字段**（独立后）：

```json
{
  "name": "underworld-graph",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "tsx --test tests/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "files": ["dist/", "src/", "README.md", "CHANGELOG.md", "LICENSE"]
}
```

**关键变化**：
- `private: false`（可发布）
- `exports` 指向 `./dist/index.js`（编译产物，不再是源码）
- 新增 `build` 脚本（tsc 产出 .js + .d.ts）
- `files` 声明发布内容

### 4.3 narrative-engine 消费方式变更

| 维度 | 现状 | 独立后 |
|---|---|---|
| 依赖声明 | `"@pi/world-graph": "*"`（workspace） | `"underworld-graph": "^0.1.0"`（npm） |
| 同步逻辑 | sync.mjs 复制 `packages/world-graph/` | sync.mjs 不再复制，靠 `npm install` 拉取 |
| sidecar 打包 | esbuild bundle 内联源码 | esbuild bundle 内联 dist/（或 external） |
| import 路径 | `from "@pi/world-graph"` | `from "underworld-graph"` |
| 版本管理 | 随仓库提交共振 | 独立版本，narrative-engine 锁定 |

## 五、任务分解（分阶段迭代）

按 AGENTS.md "分步迭代"原则，分 4 个阶段，每阶段独立可验证。

### 阶段 1：包结构独立化（在 narrative-engine 仓库内预备）

**目标**：让 world-graph 具备独立发布的能力，但仍留在原仓库，降低一次性改动风险。

| 任务 | 详情 | 验证 |
|---|---|---|
| 1.1 加 build 脚本 | `packages/world-graph/package.json` 新增 `"build": "tsc"`，tsconfig 改 `emitDeclarationOnly: false` + `declaration: true`，产出 `dist/*.js` + `dist/*.d.ts` | `npm run build` 产出 dist/ 且类型正确 |
| 1.2 exports 切换到 dist/ | `exports["."].import` 改为 `./dist/index.js`，`types` 改为 `./dist/index.d.ts` | 主包 `src/` import 仍可用 |
| 1.3 补齐文档 | 新增 `packages/world-graph/README.md`、`CHANGELOG.md`、`LICENSE` | 文档完整 |
| 1.4 改包名 | `name` 从 `@pi/world-graph` 改为 `underworld-graph`（仍 `private: true`） | 全仓库 import 路径批量改 `@pi/world-graph` → `underworld-graph` |
| 1.5 清理聚合测试 | 根 `package.json` 的 `test` 脚本移除 `packages/world-graph/tests/*.test.ts`，子包独立跑测试 | `npm test` 不再跑子包测试 |
| 1.6 验证两种消费模式 | PI 扩展模式（sync + 加载）+ Tauri sidecar 模式（package-sidecar）全链路冒烟 | 两条路径均通过 |

**阶段 1 验收**：world-graph 在 narrative-engine 仓库内具备独立包结构（build/dist/exports/文档），仅 `private` 标记未开放，随时可拆。

### 阶段 2：迁移到独立仓库 + 首次发布

**目标**：建立独立 git 仓库，发布首个 npm 版本。

| 任务 | 详情 | 验证 |
|---|---|---|
| 2.1 新建 git 仓库 | 在 `d:\claude\pi-ex\underworld-graph/` 新建仓库（与 narrative-engine、novel 平级） | `git init` + 首次 commit |
| 2.2 迁移源码 | 把 `narrative-engine/packages/world-graph/{src,tests,scripts}` 复制到新仓库；保留 git 历史（可选：`git filter-repo` 提取子目录历史） | 新仓库结构完整 |
| 2.3 配置 package.json | `private: false`，补齐 `main/types/exports/files/scripts`，version 设 `0.1.0` | `npm publish --dry-run` 产物列表正确 |
| 2.4 配置 CI | `.github/workflows/ci.yml`：push/PR 跑 test + typecheck + build；tag 触发 publish | CI 绿 |
| 2.5 首次发布 | `npm publish`（或 `npm publish --access public`），打 git tag `v0.1.0` | `npm view underworld-graph` 可查 |
| 2.6 写 README | 描述设计目标、核心 API（WorldGraph.create/getEntityAt/processEvent 等）、使用示例 | README 完整 |

**阶段 2 验收**：`underworld-graph@0.1.0` 在 npm 公开可装，CI 流程跑通。

### 阶段 3：narrative-engine 切换为外部依赖

**目标**：narrative-engine 移除本地子包，改为 npm 依赖。

| 任务 | 详情 | 验证 |
|---|---|---|
| 3.1 移除本地子包 | 删除 `narrative-engine/packages/world-graph/`；从根 `package.json` 的 `workspaces` 隐式移除（仍为 `["packages/*"]`，world-graph 不再存在） | `npm install` 不再建链 @pi/world-graph |
| 3.2 改依赖声明 | narrative-engine 根 `package.json` 新增 `"underworld-graph": "^0.1.0"`；子包 `packages/scheduler/package.json`、`packages/novel-importer/package.json` 同步改 | `package-lock.json` 锁定外部包 |
| 3.3 批量改 import | 全仓库 `from "@pi/world-graph"` → `from "underworld-graph"`（约 24 个源文件 + 8 个测试） | `npm run typecheck` 通过 |
| 3.4 调整 sync.mjs | [scripts/sync.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/sync.mjs) 复制 `packages/` 时不再包含 world-graph（已删）；确认 `extension-snapshot` 的 world-graph 来源改为 `node_modules/underworld-graph/dist/` | sync 后扩展目录可正常加载 |
| 3.5 调整 package-sidecar.mjs | [scripts/package-sidecar.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/package-sidecar.mjs) 的 `extension-snapshot` 部分：world-graph 从 `packages/world-graph/` 改为 `node_modules/underworld-graph/{dist,package.json}`；`EXTERNALS` 列表评估是否需加 `underworld-graph`（取决于 bundle 策略） | sidecar 打包产物正确 |
| 3.6 调整根 test 聚合 | 根 `package.json` 的 `test` 脚本移除 world-graph 测试 glob（阶段 1.5 已部分做，此处确认） | `npm test` 不再找 world-graph 测试 |
| 3.7 全量回归 | 跑全部测试 + PI 扩展加载冒烟 + Tauri sidecar 打包冒烟 | 全绿 |

**阶段 3 验收**：narrative-engine 不再包含 world-graph 源码，完全通过 npm 依赖消费 `underworld-graph`。

### 阶段 4：验证与收尾

| 任务 | 详情 | 验证 |
|---|---|---|
| 4.1 PI 扩展模式端到端 | `npm run sync` → novel 工程加载扩展 → 跑一次完整创作链路（import → dispatch → render） | 创作链路正常 |
| 4.2 Tauri sidecar 端到端 | `npm run package-sidecar` → Tauri 打包 → 安装运行 → 创作链路 | 桌面应用正常 |
| 4.3 本地联调流程 | 文档化：修改 underworld-graph 后如何与 narrative-engine 联调（`npm link` 或 `file:` 协议） | 流程可执行 |
| 4.4 版本升级流程 | 文档化：underworld-graph 发新版后 narrative-engine 如何升级（`npm install underworld-graph@latest` → 测试 → 提交 lockfile） | 流程清晰 |
| 4.5 更新设计文档 | 相关设计文档（SDK 集成架构等）更新依赖面描述 | 文档一致 |

**阶段 4 验收**：两种消费模式全链路验证通过，联调/升级流程文档化。

## 六、风险与存疑

### 6.1 PI 扩展加载器对编译产物的 jiti 解析

**问题**：当前子包 `exports` 指向 `./src/index.ts`，PI 扩展加载器的 jiti 现场解析 TS。独立后 `exports` 指向 `./dist/index.js`（编译产物），jiti 是否仍需介入？是否会有 .d.ts 解析问题？

**影响**：若 jiti 对 .js 产物处理有差异，可能导致扩展加载失败。

**验证方式**：阶段 1.6 + 阶段 4.1 端到端冒烟验证。预期：.js 产物由 Node 原生 ESM loader 解析，jiti 不需介入，应更稳定。

### 6.2 sync.mjs 的 packages/ 复制逻辑调整

**问题**：[sync.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/sync.mjs) 当前 `freshCopyDir(packages/, target/packages/)` 复制所有子包。独立后 world-graph 不在 packages/，但其他子包（scheduler、novel-importer 等）仍在。需确认：
- 其他子包是否也走 jiti 解析 TS 源码？是（见调研报告）
- sync.mjs 逻辑是否需分支化？不需要，删掉 world-graph 后 `freshCopyDir` 自动只复制剩余子包

**结论**：此风险低，sync.mjs 逻辑不需大改，world-graph 自然从复制列表消失。但 `node_modules/underworld-graph/` 是否需要同步到扩展目录需验证——PI 扩展目录的 `npm install` 应能拉取，但需确认。

### 6.3 Tauri sidecar 的 extension-snapshot 产物

**问题**：[package-sidecar.mjs](file:///d:/claude/pi-ex/narrative-engine/scripts/package-sidecar.mjs) 的 `extension-snapshot` 复刻 sync 布局，当前包含 `packages/world-graph/`。独立后需改为从 `node_modules/underworld-graph/` 取 `dist/` + `package.json`。

**影响**：sidecar 模式的扩展 reinstall 端点安装源需调整。

**验证方式**：阶段 3.5 + 阶段 4.2 打包冒烟。

### 6.4 版本锁定策略

**问题**：narrative-engine 锁定 underworld-graph 版本用 `^0.1.0`（允许 0.x 升级）还是精确版本？

**建议**：0.x 阶段用 `~0.1.0`（只允许 patch 升级），1.0 后改 `^1.0.0`。0.x 语义不稳定性高，不应自动跨 minor 升级。

### 6.5 本地联调流程

**问题**：独立后，修改 underworld-graph 源码时如何与 narrative-engine 联调？

**候选方案**：
- A. `npm link underworld-graph`（全局 symlink，narrative-engine 用本地开发版）
- B. `file:../underworld-graph` 协议（package.json 临时改依赖路径）
- C. underworld-graph 发预发布版（`0.1.0-dev.1`），narrative-engine 装 dev 版

**建议**：A 用于本地开发，B 用于临时联调，C 用于 CI 验证。阶段 4.3 文档化。

### 6.6 git 历史保留

**问题**：迁移到独立仓库时，是否保留 world-graph 在 narrative-engine 仓库的 git 历史？

**候选**：
- A. 不保留（新仓库从空开始，复制当前快照）——简单，但丢失历史
- B. 用 `git filter-repo --subdirectory-filter packages/world-graph` 提取子目录历史——保留历史，但操作复杂

**建议**：A（不保留）。world-graph 在 narrative-engine 仓库的历史价值有限，新仓库从 v0.1.0 开始建立独立历史更清晰。narrative-engine 仓库的 git 历史仍可追溯旧 world-graph 的演进。

## 七、验收标准

阶段全部完成后，以下条件必须满足：

1. **独立仓库**：`d:\claude\pi-ex\underworld-graph\` 存在，独立 git 历史，CI 跑通
2. **npm 包**：`npm view underworld-graph` 可查，最新版可 `npm install`
3. **narrative-engine 解耦**：
   - `narrative-engine/packages/world-graph/` 不存在
   - 全仓库 grep `@pi/world-graph` 零匹配
   - 根 `package.json` 依赖 `"underworld-graph": "^0.1.0"` 或类似
4. **两种消费模式正常**：
   - PI 扩展模式：`npm run sync` → novel 工程加载扩展 → 创作链路通过
   - Tauri sidecar 模式：`npm run package-sidecar` → 打包 → 运行 → 创作链路通过
5. **测试全绿**：narrative-engine 全量测试 + underworld-graph 独立测试均通过
6. **文档完整**：underworld-graph 的 README/CHANGELOG/LICENSE 齐全；narrative-engine 的联调/升级流程文档化

## 八、与既有设计文档的关系

| 维度 | 本文档 | SDK 集成架构文档 | SDK 工具实现方案 |
|---|---|---|---|
| 关注点 | world-graph 子包如何独立化 | narrative-engine 如何与 PI SDK 集成 | 31 个工具在 SDK 模式下怎么实现 |
| 关系 | 架构转型第一阶段 | SDK 集成的整体架构 | 工具层迁移实现 |
| 时序 | **先行**：world-graph 独立是后续 SDK 化的基础 | world-graph 独立后，SDK 集成架构的依赖面更小 | 工具实现依赖 world-graph 稳定接口 |
| 依赖面影响 | 减少 narrative-engine 对内子包依赖 | SDK 集成时 world-graph 已是外部包 | 子代理工具闭包注入 wg 时，wg 已是外部包 |

**本文档是架构转型的第一阶段**，为后续 SDK 集成、工具迁移奠定基础。world-graph 独立后，narrative-engine 的依赖面收敛，SDK 化改造的作用域更聚焦。

## 九、决策溯源

本文档的结论基于以下查证与决策过程：

1. **查证 world-graph 现状**：用 search agent 调研 [packages/world-graph/](file:///d:/claude/pi-ex/narrative-engine/packages/world-graph/) 的包结构、依赖、被引用情况、消费模式——确认是叶子包，零外部耦合
2. **查证 narrative-engine 包管理配置**：用 search agent 调研根 package.json、tsconfig、build.mjs、sync.mjs、package-sidecar.mjs——确认两种消费模式的具体机制
3. **对齐独立形态**：用户决策"独立 git 仓库 + npm publish"（最彻底形态）
4. **对齐包名**：用户选择 `underworld-graph`，查证 npm registry 确认可用
5. **分阶段设计**：按 AGENTS.md "分步迭代"原则，拆为 4 个阶段，每阶段独立可验收
6. **识别存疑点**：列出 6 项需原型验证的风险，避免脑补

## 十、范围边界（用户澄清）

独立化过程中以下两类资产**不随 underworld-graph 包迁移/发布**：

### 10.1 可视化资产不打包

- **visualizer-ui/ 属于 narrative-engine 仓库**，是世界图的前端可视化层，不属于 underworld-graph 内核包
- 阶段 2 迁移到独立仓库时，**只迁移 `src/` + `tests/` + `scripts/smoke.mjs` + 配置文件**，不迁移任何可视化资产
- visualizer-ui 的演进仍由 narrative-engine 仓库主导，后续若需独立化，作为单独的架构转型任务处理
- sync.mjs 中 `freshCopyDir(srcUiDir, ...)` 逻辑保留在 narrative-engine，与 underworld-graph 无关

### 10.2 测试不发布到 npm

- 测试源码（`tests/*.test.ts`）保留在 git 仓库（github 可见），但**不发布到 npm 包产物**
- 通过 `package.json` 的 `files` 字段控制：`["dist/", "src/", "README.md", "CHANGELOG.md", "LICENSE"]` —— 不含 `tests/`、`scripts/`
- 这与主流 npm 包做法一致：测试在仓库内可运行，发布产物不含测试集
- 阶段 1.5 "清理聚合测试" 仍需执行（让 narrative-engine 根 `npm test` 不再跑 world-graph 子包测试），但 underworld-graph 自身的 `npm test` 在仓库内仍可运行
