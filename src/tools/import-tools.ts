/**
 * import-tools.ts — 导入工具域注册
 *
 * 工具清单：
 *   import_novel         V3 EPUB 小说导入管道（8 阶段）
 *   import_character_card 酒馆角色卡导入（SillyTavern V1/V2）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runImportPipeline } from "@pi/novel-importer";
import {
  type SessionState,
  requireWg,
  requireEmbedder,
  resolveStoryTime,
} from "../session-state.ts";
import { parseCardFile, importCardToWorldGraph } from "../tools/import-card.ts";

export function registerImportTools(pi: ExtensionAPI, state: SessionState): void {
  // --------------------------------------------------------------------------
  // V3 小说导入管道
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "import_novel",
    label: "Import Novel",
    description:
      "从 EPUB 文件导入小说到世界图（V3）。执行 8 阶段管道：EPUB分章→实体预扫描→章节事件流→实体消解→关系抽取→可见性推断→写入world-graph→向量补齐+校验。内部并行 spawn 多个 LLM 子代理处理各章节。长时间运行任务（11章约10分钟）。",
    promptSnippet: "导入小说到世界图（V3，全自动 8 阶段管道）",
    parameters: Type.Object({
      epubPath: Type.String({ description: "EPUB 文件绝对路径" }),
      worldGraphDir: Type.Optional(Type.String({
        description: "world-graph 存储目录（缺省 <cwd>/.pi/world-graph-v3/）",
      })),
      chapters: Type.Optional(Type.Array(Type.Integer(), {
        description: "限定导入章节（1-based），缺省全部",
      })),
      model: Type.Optional(Type.String({
        description: "LLM 模型名（缺省用 pi 配置或环境变量 PI_MODEL）",
      })),
      apiKey: Type.Optional(Type.String({
        description: "LLM API key（缺省读环境变量 DEEPSEEK_API_KEY 或 PI_API_KEY）",
      })),
      concurrency: Type.Optional(Type.Integer({
        description: "章节并行限流（缺省 3）",
        minimum: 1,
        maximum: 10,
      })),
      resumeFromStage: Type.Optional(Type.Integer({
        description: "从指定阶段恢复（1-8，缺省从1开始）",
        minimum: 1,
        maximum: 8,
      })),
    }),
    async execute(_id, params) {
      // 复用已实例化的 Embedder（Xenova/bge-small-zh-v1.5, 512 维）
      // 注入到 runImportPipeline 供 reembedAll 使用
      const emb = requireEmbedder(state);

      const result = await runImportPipeline({
        epubPath: params.epubPath,
        worldGraphDir: params.worldGraphDir,
        chapters: params.chapters,
        model: params.model,
        apiKey: params.apiKey,
        concurrency: params.concurrency,
        resumeFromStage: params.resumeFromStage,
        cwd: state.sessionCwd ?? process.cwd(),
        embedder: emb, // 注入 TextEmbedder（Embedder.embed 满足接口）
      });

      const text = [
        `导入完成：`,
        `  实体数: ${result.entityCount}`,
        `  事件数: ${result.eventCount}`,
        `  关系数: ${result.relationCount}`,
        `  可见性数: ${result.visibilityCount}`,
        `  存储目录: ${result.worldGraphDir}`,
        `  dump 文件: ${result.dumpPath}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  // --------------------------------------------------------------------------
  // 酒馆角色卡导入（Pending Gap #5）
  // --------------------------------------------------------------------------

  pi.registerTool({
    name: "import_character_card",
    label: "Import Character Card",
    description:
      "导入酒馆角色卡（SillyTavern V1/V2，.json 或 .png）到世界图：birth 角色实体 + 卡字段写 Facts（description 写入 Entity.summary）+ 自产自知可见性。导入后调度器静态卡重组自动获得完整酒馆卡。",
    promptSnippet: "导入酒馆角色卡（.json/.png）到世界图",
    parameters: Type.Object({
      cardPath: Type.String({ description: "角色卡文件绝对路径（.json 或 .png）" }),
      entityId: Type.Optional(Type.String({ description: "指定 entityId（缺省自动生成 ent_char_xxxxxxxx）" })),
      storyTime: Type.Optional(Type.String({ description: "诞生时刻（不传用 currentStoryTime）" })),
    }),
    async execute(_id, params) {
      const g = requireWg(state);
      const storyTime = resolveStoryTime(state, params.storyTime);
      const card = await parseCardFile(params.cardPath);
      const result = await importCardToWorldGraph(g, card, storyTime, params.entityId);
      state.currentStoryTime = storyTime;
      const text = `角色卡已导入：${result.name}（${result.entityId}），${result.factCount} 个字段 Facts @ ${storyTime}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
