# 第三方代码与依赖说明（THIRD-PARTY）

> 本项目以 GPL-3.0 发布。本文盘点全部第三方代码、依赖及其许可证。
> **结论先行：所有依赖均为宽松许可证（MIT / Apache-2.0 / ISC），与 GPL-3.0 兼容。**
> 最后更新：2026-07-29（pi-coding-agent 归类修正 + 补 @types/better-sqlite3）

## 1. 兼容性结论

| 许可证 | 涉及依赖 | 与 GPL-3.0 |
|--------|---------|-----------|
| MIT | 绝大多数 | ✅ 兼容（可合并，保留版权声明即可） |
| Apache-2.0 | @xenova/transformers, drizzle-orm, typescript | ✅ 兼容（GPLv3 §7 明确兼容；注意其专利授权条款） |
| ISC | epub2 | ✅ 兼容（与 MIT 等价） |
| MIT OR Apache-2.0（双许可） | sqlite-vec | ✅ 任选其一，均兼容 |

无 copyleft 冲突项，无许可证不明项。

## 2. npm 直接依赖（运行时）

| 包 | 版本约束 | 许可证 | 用途 |
|----|---------|--------|------|
| `@nicia-ai/typegraph` | ^0.40.0 | MIT | 世界图底层 SDK（节点/边存储、FTS5 全文检索、向量检索、QueryBuilder） |
| `better-sqlite3` | ^11.0.0 | MIT | SQLite 同步驱动（**含原生模块**，平台绑定问题见 SETUP.md §3.1） |
| `drizzle-orm` | ^0.36.0 | Apache-2.0 | typegraph 的 ORM 层（better-sqlite3 驱动） |
| `sqlite-vec` | ^0.1.9 | MIT OR Apache-2.0 | SQLite 向量扩展（cosine 相似度，vec0.dll 原生） |
| `zod` | ^4.0.0 | MIT | 事件记录/导入 schema 校验 |
| `typebox` | ^1.1.24 | MIT | pi 工具参数 schema（registerTool 参数定义） |
| `@xenova/transformers` | ^2.17.2 | Apache-2.0 | 本地文本嵌入（feature-extraction pipeline，ONNX 运行时） |
| `epub2` | ^3.0.2 | ISC | EPUB 分章解析（小说导入器阶段 1） |
| `@earendil-works/pi-ai` | ^0.77.0 | MIT | LLM 调用（complete/getModel/validateToolCall）+ TypeBox 重导出 |

## 3. npm 开发依赖（不进运行时）

| 包 | 许可证 | 用途 |
|----|--------|------|
| `typescript` | Apache-2.0 | 类型检查 |
| `tsx` | MIT | 测试运行器（tsx --test） |
| `@types/node` | MIT | Node 类型定义 |
| `@types/better-sqlite3` | MIT | better-sqlite3 的 TypeScript 类型定义 |
| `@earendil-works/pi-coding-agent` | MIT | pi 扩展 API 类型定义（ExtensionAPI，仅开发期类型检查；**运行时由宿主 pi CLI 提供**，见 SETUP.md §5） |

## 4. Vendored 前端库（`visualizer-ui/vendor/`，随仓库分发）

可视化无构建纯静态服务，以下库文件直接入库分发：

| 文件 | 项目（版本） | 许可证 | 用途 |
|------|------------|--------|------|
| `vue.global.prod.js` | Vue.js（3.5.x） | MIT | 可视化前端框架 |
| `element-plus.full.min.js` / `element-plus.index.css` / `element-plus.dark.css-vars.css` / `element-plus.locale.zh-cn.min.js` | Element Plus（2.14.x） | MIT | UI 组件库 + 中文语言包 |
| `three.min.js` | three.js（0.18x） | MIT | 3D 渲染引擎（3D 关系图） |
| `3d-force-graph.min.js` | 3d-force-graph（1.80.x，vasturiano） | MIT | 力导向 3D 图布局 |
| `three-spritetext.min.js` | three-spritetext（1.10.x） | MIT | 3D 图中的文字标签 |
| `docs/legacy/prototype-v3/v3/vendor/`（3 个 three 系文件） | 同上 | MIT | V3 原型的历史副本 |

## 5. AI 模型（运行时下载，不入库）

| 模型 | 来源 | 许可证 | 用途 |
|------|------|--------|------|
| `Xenova/bge-small-zh-v1.5`（量化 ONNX，~50MB） | HuggingFace（BAAI 旗智源，Xenova 转换） | MIT | 中文文本嵌入（512 维）：实体/事实向量检索 |

- 首次向量检索时下载到 `<扩展目录>/node_modules/@xenova/transformers/.cache/`；可用 `HF_ENDPOINT` 镜像加速（`https://hf-mirror.com` 或作者自维护备用镜像 `https://emaostudio.online/hf-mirror`）
- 模型权重不进 git 仓库

## 6. 宿主运行时

| 组件 | 许可证 | 关系 |
|------|--------|------|
| pi（coding agent CLI） | MIT | 本引擎是 pi 的项目级扩展；用户需自行安装 pi（>= 0.77，兼容性见 SETUP.md §5）。pi 不随本仓库分发 |

## 7. LLM 服务（非代码依赖）

运行期调用 DeepSeek API（用户自带 key，服务端处理）。DeepSeek 服务条款与本文档无关——产出文本的权属遵循用户与 DeepSeek 的服务协议，本项目不主张任何权利。

## 8. 署名履行方式

按各许可证要求，本文件即构成集中的第三方署名（attribution）。再分发时：
1. 保留本文件
2. 保留各 vendor 文件头部的原始版权注释（均已保留）
3. Apache-2.0 组件（@xenova/transformers / drizzle-orm / typescript）如有修改需标注——本项目**未修改**这些组件的源码
