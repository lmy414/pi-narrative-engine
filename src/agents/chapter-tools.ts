// src/agents/chapter-tools.ts
/**
 * chapter-tools.ts — 渲染器子代理章节 AgentTool
 *
 * 依据：docs/plans/2026-08-01-data-layer-ports-execution-plan.md §四 A4
 *
 * 职责（子代理设计 §3.5）：渲染器代理消费角色产出 + 扩散结果，
 * 读章节上下文（chapter_read），生成正文后写章节文件（chapter_write）。
 * 渲染 LLM 调用由渲染器代理自己在 agent loop 中完成，工具只做文件 IO。
 *
 * chapter_write 按 intent 分支（对齐 @pi/renderer 锚点机制）：
 * - add：appendToChapter（章节末尾追加新锚点区块）
 * - modify：modifyChapterSection（重写 targetEventId 锚点区间正文）
 * - insert：insertChapterSection（在 targetEventId 区块后插入新锚点区块）
 */

import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { OrchestratorPorts } from "../orchestrator/assembly.ts";
import { assertPathInside } from "../path-guard.ts";

const SEQUENTIAL = { executionMode: "sequential" as const };

const chapterReadParams = Type.Object({
  chapterPath: Type.String({ description: "章节文件路径" }),
});

/** 读章节全文（衔接上下文）；cwd 非空时校验路径不越界 */
export function createChapterReadTool(ports: OrchestratorPorts, cwd?: string): AgentTool<typeof chapterReadParams> {
  return {
    name: "chapter_read",
    label: "Chapter Read",
    description: "读取章节文件全文，用于理解前文衔接（生成正文前先读上下文）。",
    parameters: chapterReadParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof chapterReadParams>) {
      const chapterPath = cwd ? assertPathInside(cwd, params.chapterPath, "章节文件路径") : params.chapterPath;
      const content = await ports.renderer.readChapter(chapterPath);
      return {
        content: [{ type: "text", text: content.length > 0 ? content : "(章节文件为空或不存在)" }],
        details: { content, length: content.length },
      };
    },
  };
}

const chapterWriteParams = Type.Object({
  chapterPath: Type.String({ description: "章节文件路径" }),
  mode: StringEnum(["add", "modify", "insert"], { description: "写入模式" }),
  eventId: Type.String({ description: "新事件锚点 ID（evt_ 前缀）" }),
  text: Type.String({ description: "要写入的正文" }),
  targetEventId: Type.Optional(Type.String({ description: "modify/insert 模式的目标锚点事件 ID" })),
});

/** 写章节文件（add/modify/insert 三分支）；cwd 非空时校验路径不越界 */
export function createChapterWriteTool(ports: OrchestratorPorts, cwd?: string): AgentTool<typeof chapterWriteParams> {
  return {
    name: "chapter_write",
    label: "Chapter Write",
    description:
      "把生成的正文写入章节文件。mode: add=章节末尾追加新事件区块（缺省）；" +
      "modify=重写 targetEventId 锚点区间的正文；insert=在 targetEventId 区块之后插入新事件区块。" +
      "eventId 是你本场事件的新锚点 ID（evt_ 前缀）。",
    parameters: chapterWriteParams,
    ...SEQUENTIAL,
    async execute(_id, params: Static<typeof chapterWriteParams>) {
      const r = ports.renderer;
      const chapterPath = cwd ? assertPathInside(cwd, params.chapterPath, "章节文件路径") : params.chapterPath;
      if (params.mode === "add") {
        await r.appendToChapter(chapterPath, params.eventId, params.text);
      } else {
        if (!params.targetEventId) {
          // M-Logic-2 修复：缺 targetEventId 是调用方（LLM）参数错误，必须抛错
          // 让 agent loop 感知失败并修正参数重试；旧实现返回 ok:false 不抛错，
          // orchestrator 只看 render_result.ok（LLM 自报）→ CommitSummary.ok 与实际写入不一致
          throw new Error(`${params.mode} 模式需要 targetEventId（目标锚点事件 ID），请修正参数后重试`);
        }
        if (params.mode === "modify") {
          await r.modifyChapterSection(chapterPath, params.targetEventId, params.text);
        } else {
          await r.insertChapterSection(chapterPath, params.targetEventId, params.eventId, params.text);
        }
      }
      const details = { ok: true, chapterPath, mode: params.mode, eventId: params.eventId };
      return {
        content: [{ type: "text", text: `章节已写入：${chapterPath}（${params.mode}，锚点 ${params.eventId}）` }],
        details,
      };
    },
  };
}

/** 渲染器子代理工具集；cwd 为项目根（路径越界防护基准） */
export function createRendererTools(ports: OrchestratorPorts, cwd?: string): AgentTool<any>[] {
  return [
    createChapterReadTool(ports, cwd),
    createChapterWriteTool(ports, cwd),
  ];
}
