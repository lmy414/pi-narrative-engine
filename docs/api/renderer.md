# `@pi/renderer` 包 API

> 属于 [API 文档索引](README.md)。渲染器子包（workspace 子包，`private: true`），将叙事指令 + 角色池结构化数据渲染为符合规则集.md 文风格的文本。源码 `packages/renderer/src/`。

## 概述

**架构定位**：
- 通过 narrative-engine 扩展暴露 5 个 pi 工具（`render_*`，见 [pi-tools-render.md](pi-tools-render.md)）
- 不独立成为 pi 扩展，随 narrative-engine 一起 build + sync

**核心理念**：
- 渲染器无状态：LLM 调用器和规则集由调用方传入
- 规则集.md 是渲染器的 `AGENTS.md`：纯自由文本，原样注入用户消息末尾（注意力最强），每次渲染重读不缓存

## 公共导出面（软隔离后）

```typescript
// 核心渲染函数
export { renderText, renderToFile } from "./renderer.ts";

// 规则集加载
export { loadRuleSet } from "./rule-loader.ts";

// 章节文件读写（供 scheduler/检验工具复用）
export {
  readChapter,
  readChapterSection,
  ensureChapterFile,
  CHAPTER_VERSION_MARKER,
  EVENT_ANCHOR_PREFIX,
} from "./chapter-io.ts";

// 类型
export type {
  RoleOutput,
  RenderTextCommand,
  RenderFileCommand,
  RenderResult,
  RenderLlmCaller,
} from "./types.ts";
```

> 软隔离：`_appendToChapter` / `_modifyChapterSection` / `_RENDERER_SYSTEM_PROMPT` / `_buildUserMessage` / `_RenderCtx` 为内部导出（`_` 前缀），仅本包内部使用。

## `loadRuleSet(novelCwd: string): Promise<string>`

读取 `<novelCwd>/规则集.md` 全文。文件不存在时返回空字符串（不报错）。不缓存，每次重读。

## `renderText(cmd: RenderTextCommand, ctx: RenderCtx): Promise<string>`

仅生成文本，不写文件。调用方需自行传入 context（已有章节文本或上下文摘要）。适合预览。

## `renderToFile(cmd: RenderFileCommand, ctx: RenderCtx): Promise<RenderResult>`

生成文本并写入章节文件。

- **append 模式**：读全文做上下文 → LLM 生成 → 追加到文件末尾
- **modify 模式**：读全文做上下文 → LLM 生成 → 重写锚点区间（`modifyAnchorEventId` 定位，保留锚点本身）

## `readChapter(chapterPath): Promise<string>`

读取章节文件全文。

## `readChapterSection(chapterPath, startEventId?, endEventId?): Promise<string>`

读取章节文件中指定锚点区间的文本。`[start, end)` 语义（包含 start，不包含 end）。

## `ensureChapterFile(chapterPath): Promise<void>`

确保章节文件存在（不存在时创建，首行写入 `CHAPTER_VERSION_MARKER`）。

## `RenderLlmCaller`

注入式 LLM 调用器接口：`(systemPrompt: string, userMessage: string) => Promise<string>`。便于单测时注入 mock，生产环境用 pi-ai 的 complete 实现（见 `src/renderer-llm.ts` 的 `makeRendererLlmCaller(piCtx)`，从 PI 本体获取模型与 API Key）。

## 规则集.md 格式说明

规则集.md 是渲染器的 `AGENTS.md`，纯自由文本 Markdown，无固定模块名要求。

**示例**：
```markdown
# 规则集

## 文风
白描为主，少用形容词。
对话简洁，不铺垫情绪。

## 禁止词
- 手机、电脑、电话等现代词汇
- "突然"、"忽然"等副词

## 格式
- 段落间空一行
- 对话用「」包裹
```

**注入位置**：用户消息末尾（注意力最强），由 `buildUserMessage` 拼接：

```
[已有上下文]
...

[叙事指令]
（故事时间：ch009.ev006）
（续写模式：在已有上下文之后续写新段落）
...

[角色池结构化数据]
...

─── 规则集（严格遵守以下规则）───
<规则集全文>
─── 以上为本次渲染规则 ───
```

## 章节文件格式约定

```
<!-- engine v0.01 -->

<!-- event: evt_001 -->

林墨推开酒馆的门，雨丝落在肩上。

<!-- event: evt_002 -->

「师弟，许久不见。」
```

- 首行固定 `<!-- engine v0.01 -->`（版本标记，`CHAPTER_VERSION_MARKER`）
- 每个事件渲染产物前插入 `<!-- event: <eventId> -->` 锚点（`EVENT_ANCHOR_PREFIX`）
- 锚点后空一行，接正文
- modify 模式按锚点定位重写区间；insert 模式由调度器内嵌 `chapter-edit.insertChapterSection` 实现（renderer 无 insert 模式）
