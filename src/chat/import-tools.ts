import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runImportPipeline } from "@pi/novel-importer";
import type { WorldGraphDataAccess } from "../data/world-graph-data-access.ts";
import type { Embedder } from "../embedder.ts";
import { parseCardFile, importCardToWorldGraph } from "./import-card.ts";
import { assertPathInside } from "../path-guard.ts";

export interface ImportToolsProvider {
  cwd: string;
  dataAccess: WorldGraphDataAccess;
  embedder: Embedder;
  currentStoryTime: string | null;
  setCurrentStoryTime(storyTime: string): void;
  runImportPipeline?: typeof runImportPipeline;
}

export function createImportTools(provider: ImportToolsProvider): ToolDefinition[] {
  return [
    // 🟠-6（2026-08-08）：import_novel 的 worldGraphDir 与 epubPath 同源校验——
    // 此前只有 epubPath 过 assertPathInside，LLM 可把世界图数据写到项目外
    // 任意目录（pipeline 自动 mkdir + 写 5 类产物）。注：本文件 defineTool 为
    // 单行语句，注释必须放独立行，行内 // 会吞掉整行其余代码。
    defineTool({ name: "import_novel", label: "Import Novel", description: "从 EPUB 文件导入小说到世界图（V3）。执行 8 阶段管道：EPUB分章→实体预扫描→章节事件流→实体消解→关系抽取→可见性推断→写入world-graph→向量补齐+校验。内部并行 spawn 多个 LLM 子代理处理各章节。长时间运行任务（11章约10分钟）。", promptSnippet: "导入小说到世界图（V3，全自动 8 阶段管道）", parameters: Type.Object({ epubPath: Type.String({ description: "EPUB 文件绝对路径" }), worldGraphDir: Type.Optional(Type.String({ description: "world-graph 存储目录（缺省 <cwd>/.pi/world-graph-v3/）" })), chapters: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "限定导入章节（1-based，最小 1），缺省全部" })), model: Type.Optional(Type.String({ description: "LLM 模型名（缺省用 pi 配置或环境变量 PI_MODEL）" })), apiKey: Type.Optional(Type.String({ description: "LLM API key（缺省读环境变量 DEEPSEEK_API_KEY 或 PI_API_KEY）" })), concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "章节并行限流（缺省 3）" })), resumeFromStage: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "从指定阶段恢复（1-8，缺省从1开始）" })), minContentLength: Type.Optional(Type.Integer({ minimum: 1, description: "章节最小内容长度（字符，缺省 200；短篇可调小）" })) }), async execute(_id: string, params: any) { assertPathInside(provider.cwd, (params as any).epubPath, "EPUB 文件路径"); if ((params as any).worldGraphDir) { assertPathInside(provider.cwd, (params as any).worldGraphDir, "世界图存储目录"); } const result = await (provider.runImportPipeline ?? runImportPipeline)({ ...(params as any), cwd: provider.cwd, embedder: provider.embedder }); const storyTimes = await provider.dataAccess.listStoryTimes(); const latestStoryTime = storyTimes.at(-1); if (latestStoryTime) provider.setCurrentStoryTime(latestStoryTime); return { content: [{ type: "text", text: [`导入完成：`, `实体数: ${result.entityCount}`, `事件数: ${result.eventCount}`, `关系数: ${result.relationCount}`, `可见性数: ${result.visibilityCount}`, `存储目录: ${result.worldGraphDir}`, `dump 文件: ${result.dumpPath}`].join("\n") }], details: result }; } } as any),
    defineTool({ name: "import_character_card", label: "Import Character Card", description: "导入酒馆角色卡（SillyTavern V1/V2，.json 或 .png）到世界图：birth 角色实体 + 卡字段写 Facts（description 写入 Entity.summary）+ 自产自知可见性。导入后调度器静态卡重组自动获得完整酒馆卡。", promptSnippet: "导入酒馆角色卡（.json/.png）到世界图", parameters: Type.Object({ cardPath: Type.String({ description: "角色卡文件绝对路径（.json 或 .png）" }), entityId: Type.Optional(Type.String({ description: "指定 entityId（缺省自动生成 ent_char_xxxxxxxx）" })), storyTime: Type.Optional(Type.String({ description: "诞生时刻（不传用 currentStoryTime）" })) }), async execute(_id: string, params: any) { const p = params as any; const storyTime = p.storyTime ?? provider.currentStoryTime; if (!storyTime) throw new Error("storyTime required (call world_event_apply first or pass storyTime explicitly)"); const card = await parseCardFile(p.cardPath, provider.cwd); const result = await importCardToWorldGraph(provider.dataAccess, card, storyTime, p.entityId); provider.setCurrentStoryTime(storyTime); return { content: [{ type: "text", text: `角色卡已导入：${result.name}（${result.entityId}），${result.factCount} 个字段 Facts @ ${storyTime}` }], details: result }; } } as any),
  ];
}
