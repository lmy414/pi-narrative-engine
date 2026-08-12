# 第三方代码与依赖说明（THIRD-PARTY）

> 本项目以 GPL-3.0-only 发布。本文盘点全部第三方代码、依赖及其许可证。
> **结论先行：所有外部依赖均为宽松许可证（MIT / Apache-2.0 / ISC），与 GPL-3.0 兼容。**
> 最后更新：2026-08-12（核对 package.json / frontend-demo/vendor/ 后更新：underworld-graph 0.3.1、新增 marked/dompurify、vendor 6 文件）

## 1. 概述

- 本仓库 `narrative-engine` 是直接依赖 pi SDK（`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent`）的独立 Node.js 应用，**不再是 pi 扩展**（扩展机制与 `.pi/extensions/` 同步已废弃）。
- 运行方式：`node scripts/app-server.mjs [--project <dir>] [--port 7421]` 启动本地 unified-server，浏览器访问 `http://127.0.0.1:7421`。
- 可视化前端位于 `frontend-demo/`，无构建步骤，由 unified-server 直接伺服静态文件；第三方库以 vendor 形式入库。
- 仓库无 Tauri / Rust 桌面壳（早期应用化方案已废弃，`tauri-app/` 目录不存在）；无 Vue / Element Plus（早期可视化方案已废弃，`frontend-demo/vendor/` 不再含 vue / element-plus 文件）。
- Workspace 子包位于 `packages/`，均为 private，不对外发布。

## 2. npm 直接依赖（运行时，root `package.json` → `dependencies`）

仅 3 项：

| 包 | 版本约束 | 许可证 | 用途 |
|----|---------|--------|------|
| `@xenova/transformers` | ^2.17.2 | Apache-2.0 | 本地文本嵌入（feature-extraction pipeline，ONNX 运行时，用于实体/事实向量检索） |
| `epub2` | ^3.0.2 | ISC | EPUB 分章解析（novel-importer 阶段 1） |
| `underworld-graph` | 0.3.1 | GPL-3.0-only | 世界图底层 SDK（节点/边存储、FTS5 全文检索、向量检索、QueryBuilder）。**第一方外部包**：本项目作者同人维护的独立 npm 包（许可证与本仓库一致），2026-07-31 从 monorepo 解耦独立发布，2026-08-08 升级至 0.3.x |

> `@nicia-ai/typegraph` / `better-sqlite3` / `drizzle-orm` / `sqlite-vec` / `zod` 等自解耦起经 `underworld-graph` 传递依赖引入，根 `package.json` 不再直接声明（详见 §6）。

## 3. npm 开发依赖（不进运行时，root `package.json` → `devDependencies`）

共 11 项：

| 包 | 版本约束 | 许可证 | 用途 |
|----|---------|--------|------|
| `@earendil-works/pi-agent-core` | ^0.77.0 | MIT | pi SDK 核心（agent 运行时类型与工具） |
| `@earendil-works/pi-ai` | ^0.77.0 | MIT | LLM 调用（complete/getModel/validateToolCall）+ TypeBox 重导出 |
| `@earendil-works/pi-coding-agent` | ^0.77.0 | MIT | pi 编码 agent API 类型定义（AgentSession / createAgentSession / ToolDefinition 等） |
| `@modelcontextprotocol/sdk` | ^1.30.0 | MIT | MCP 协议 SDK（unified-server 对外暴露 MCP 工具） |
| `@types/node` | ^20.14.0 | MIT | Node.js 类型定义 |
| `dompurify` | ^3.4.13 | Apache-2.0 OR MPL-2.0 | 前端 markdown 渲染净化（vendor 同版本） |
| `esbuild` | ^0.23.0 | MIT | TS→JS 逐文件转译（`scripts/build.mjs`）与 sidecar 打包 |
| `marked` | ^18.0.9 | MIT | 前端 markdown 渲染（vendor 同版本） |
| `typebox` | ^1.1.24 | MIT | pi 工具参数 schema（registerTool 参数定义） |
| `typescript` | ^5.4.0 | Apache-2.0 | 类型检查（`tsc --noEmit`） |
| `zod` | ^4.4.3 | MIT | 事件记录/导入 schema 校验（novel-importer 使用） |

> `overrides` 字段强制 `sharp` ^0.35.0 与 `onnxruntime-web` ^1.20.0（`@xenova/transformers` 传递依赖），用于规避旧版本兼容性问题，不引入新增许可证项（sharp MIT、onnxruntime-web MIT）。

## 4. Workspace 子包（`packages/*`，private）

6 个内部子包，均 `private: true`，不对外发布。各自 `package.json` 声明的运行时依赖均已在 root 或同行子包中复用，无新增第三方许可证项：

| 子包 | 路径 | 运行时 dependencies |
|------|------|---------------------|
| `@pi/admin` | `packages/admin/` | —（仅 devDeps：`@earendil-works/pi-coding-agent` / `tsx` / `typescript` / `@types/node`） |
| `@pi/scheduler` | `packages/scheduler/` | `underworld-graph` / `@pi/role-pool` / `@pi/renderer` |
| `@pi/renderer` | `packages/renderer/` | `@earendil-works/pi-ai` |
| `@pi/role-pool` | `packages/role-pool/` | `@earendil-works/pi-ai` |
| `@pi/novel-importer` | `packages/novel-importer/` | `underworld-graph` / `@earendil-works/pi-ai` / `epub2` / `typebox` / `zod` |
| `@pi/novel-launcher` | `packages/novel-launcher/` | `underworld-graph` |

各子包 devDependencies 统一为 `@types/node` / `tsx` / `typescript`（`@pi/admin` 另引 `@earendil-works/pi-coding-agent`），均已在 root devDependencies 中声明，无新增许可证项。

## 5. Vendored 前端库（`frontend-demo/vendor/`，随仓库分发）

可视化无构建纯静态服务，以下 6 个库文件直接入库分发（与 `frontend-demo/index.html` 引用一一对应，含 SRI integrity 属性）：

| 文件 | 项目（版本） | 许可证 | 用途 |
|------|------------|--------|------|
| `tailwind-browser-4.3.1.js` | Tailwind CSS（4.3.1，browser CDN UMD） | MIT | 原子化 CSS 框架（浏览器即时编译，无构建步骤） |
| `lucide-1.28.0.js` | Lucide Icons（1.28.0） | ISC | UI 图标库（`lucide.createIcons()` 注入 `<i data-lucide="...">`） |
| `marked-18.0.9.js` | marked（18.0.9） | MIT | Markdown → HTML 渲染（与 root `marked` 同版本） |
| `dompurify-3.4.13.js` | DOMPurify（3.4.13） | Apache-2.0 OR MPL-2.0 | 渲染后的 HTML 净化（XSS 防护，与 root `dompurify` 同版本） |
| `3d-force-graph-1.80.0.js` | 3d-force-graph（1.80.0，vasturiano） | MIT | 三维力导图布局（世界图主视图，`ForceGraph3D()(container)` 实例化） |
| `three-0.160.0.js` | three.js（0.160.0） | MIT | 3D 渲染引擎（自定义节点几何体 `graph3dNodeObject`，由 3d-force-graph 内部依赖；UMD 必须在 3d-force-graph 之后加载） |

> **加载顺序**（见 `index.html` 注释）：tailwind → marked → dompurify → lucide → 3d-force-graph → three。three UMD 必须在 3d-force-graph 之后加载；先加载会导致 3d-force-graph UMD 初始化失败（全局不挂载）。
>
> **文字标签**：3D 图节点文字标签走 DOM 投影层（`graph3dLabelLayer`），**不使用** three-spritetext（与 3d-force-graph 内置 three 版本不兼容）。
>
> **项目自有文件（非第三方）**：`frontend-demo/styles/`（tokens.css / shell.css / components.css / views.css）、`frontend-demo/app.js` / `api-client.js` / `api-mock.js` / `mock-data.js` / `demo-utils.js` / `views/*.js` 均为本项目自有代码，无第三方许可证问题。

## 6. 传递依赖说明（经 `underworld-graph` 引入）

`underworld-graph` 作为世界图底层 SDK，其自身 `dependencies` 引入了以下组件（不直接声明于 root `package.json`，但随 `npm install` 装入 `node_modules`）：

| 传递依赖 | 许可证 | 用途 |
|---------|--------|------|
| `@nicia-ai/typegraph` | MIT | 世界图节点/边存储、QueryBuilder、FTS5 全文检索 |
| `better-sqlite3` | MIT | SQLite 同步驱动（**含原生模块**，平台绑定问题见 SETUP.md） |
| `drizzle-orm` | Apache-2.0 | typegraph 的 ORM 层（better-sqlite3 驱动） |
| `sqlite-vec` | MIT OR Apache-2.0 | SQLite 向量扩展（cosine 相似度，vec0 原生模块） |

> 这些组件的许可证均与 GPL-3.0 兼容（MIT / Apache-2.0 / 双许可）。如 `underworld-graph` 后续调整其依赖清单，以该包当时发布的 `package.json` 为准。

## 7. 运行时：pi SDK 独立应用（非 pi 扩展）

| 组件 | 许可证 | 关系 |
|------|--------|------|
| pi SDK（`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent`） | MIT | 本引擎直接以 npm 依赖方式引入 pi SDK，作为独立 Node.js 应用运行（`node scripts/app-server.mjs`）。**不再是 pi 扩展**，无需用户单独安装 pi CLI，扩展机制与 `.pi/extensions/` 同步已废弃 |

## 8. AI 模型（运行时下载，不入库）

| 模型 | 来源 | 许可证 | 用途 |
|------|------|--------|------|
| `Xenova/bge-small-zh-v1.5`（量化 ONNX，~50MB） | HuggingFace（BAAI 旗智源，Xenova 转换） | MIT | 中文文本嵌入（512 维）：实体/事实向量检索 |

- 首次向量检索时下载到应用数据目录的 `@xenova/transformers/.cache/`；可用 `HF_ENDPOINT` 镜像加速（`https://hf-mirror.com` 或作者自维护备用镜像 `https://emaostudio.online/hf-mirror`）
- 模型权重不进 git 仓库

## 9. LLM 服务（非代码依赖）

运行期调用 DeepSeek API（用户自带 key，服务端处理）。DeepSeek 服务条款与本文档无关——产出文本的权属遵循用户与 DeepSeek 的服务协议，本项目不主张任何权利。

## 10. 署名履行方式

按各许可证要求，本文件即构成集中的第三方署名（attribution）。再分发时：

1. 保留本文件
2. 保留各 vendor 文件头部的原始版权注释（均已保留）
3. Apache-2.0 组件（npm：`@xenova/transformers` / `drizzle-orm` / `typescript`；vendor：`dompurify`）如有修改需标注——本项目**未修改**这些组件的源码
4. ISC 组件（`epub2` / `lucide`）与 MIT 组件（`tailwind` / `3d-force-graph` / `three` / `marked` / 各 pi SDK 包 / `zod` / `typebox` / `esbuild` / `@modelcontextprotocol/sdk` / `@types/node`）保留版权声明即可

## 11. 兼容性结论

| 许可证 | 涉及依赖 | 与 GPL-3.0 |
|--------|---------|-----------|
| MIT | 绝大多数（pi SDK / zod / typebox / esbuild / @types/node / @modelcontextprotocol/sdk / tailwind / 3d-force-graph / three / marked / @nicia-ai/typegraph / better-sqlite3） | ✅ 兼容（可合并，保留版权声明即可） |
| Apache-2.0 | @xenova/transformers, drizzle-orm, typescript | ✅ 兼容（GPLv3 §7 明确兼容；注意其专利授权条款） |
| ISC | epub2, lucide | ✅ 兼容（与 MIT 等价） |
| MIT OR Apache-2.0（双许可） | sqlite-vec | ✅ 任选其一，均兼容 |
| Apache-2.0 OR MPL-2.0（双许可） | dompurify | ✅ 选 Apache-2.0 即兼容（与 GPL-3.0 同向兼容） |
| GPL-3.0-only | underworld-graph（第一方同人维护） | ✅ 与本仓库许可证完全一致 |

无 copyleft 冲突项，无许可证不明项。
