// src/agents/renderer-agent.ts
/**
 * renderer-agent.ts — RendererAgent 子代理类
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction-execution.md 任务 2.4
 *
 * 职责：渲染正文。先 chapter_read 读章节衔接上下文，生成正文后 chapter_write 写章节。
 * 迁移自原 createRendererAgent 工厂（pi-agent-core Agent + terminate 工具），
 * 改为继承 BaseAgent（唯一底层 AgentSession）+ 指令收尾产出。
 *
 * 产出契约：reply.text 应为 fenced JSON，顶层含 `render` 字段（RenderOutput）。
 */

import type { StructuredEvent } from "@pi/scheduler";
import type { RoleAgentOutput } from "@pi/role-pool";
import type { DiffusionOutput } from "../orchestrator.ts";
import type { RenderOutput } from "../orchestrator.ts";
import type { OrchestratorPorts } from "../orchestrator/assembly.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BaseAgent, OUTPUT_DISCIPLINE_SUFFIX } from "./base-agent.ts";
import type { AgentReply, AgentRuntime } from "./agent-runtime.ts";
import { extractFencedJson, AgentOutputParseError, toToolDefinition } from "./agent-runtime.ts";
import { createRendererTools } from "./chapter-tools.ts";
import { createRulesReadTool, formatRulesManifest } from "./rules-tools.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

/** renderer 输入 */
export interface RendererInput {
  event: StructuredEvent;
  /** 本次编排的渲染锚点 ID（evt_ 前缀） */
  eventId: string;
  outputs: RoleAgentOutput[];
  diffusion: DiffusionOutput;
  /** 目标章节路径（已解析为绝对路径） */
  chapterPath: string;
}

/** renderer 产出（顶层含 render 字段，与 orchestrator 消费一致） */
export interface RendererOutput {
  render: RenderOutput;
}

/** 渲染器子代理（一次性，forSubagent 轻量 prompt） */
export class RendererAgent extends BaseAgent<RendererInput, RendererOutput> {
  private readonly ports: OrchestratorPorts;

  constructor(runtime: AgentRuntime, opts: { cwd: string; agentDir: string }, ports: OrchestratorPorts) {
    super(runtime, opts);
    this.ports = ports;
  }

  protected getSlot(): LlmSlot {
    return "renderer";
  }

  protected async buildSystemPrompt(input: RendererInput): Promise<string> {
    // v3（2026-08-09，D11）：规则渐进披露——渲染规则集不再全文注入，
    // <available_rules> 清单（名称+位置+简介）入 system prompt，全文经 rules_read 按需读取
    const rulesManifest = await formatRulesManifest(this.cwd);
    return (
      "你是叙事引擎的渲染代理。消费角色产出与扩散结果，先用 chapter_read 读取章节衔接上下文，" +
      "生成正文后用 chapter_write 按事件意图（add/modify/insert）写入章节文件，" +
      "最后以 fenced JSON 提交正文。"
    )
      + `\n\n${rulesManifest}`
      + OUTPUT_DISCIPLINE_SUFFIX
      + `
注入格式说明：你的最终结论应为如下 fenced JSON（render 字段为渲染结果）：
\`\`\`json
{ "render": { "chapterPath": "${input.chapterPath}", "text": "你生成的正文全文", "ok": true } }
\`\`\`
`;
  }

  protected buildUserPrompt(input: RendererInput): string {
    return `事件：${input.event.instruction}\n故事时间：${input.event.storyTime}\n章节路径：${input.chapterPath}\n事件意图：${input.event.intent ?? "add"}${input.event.targetEventId ? `\n目标锚点：${input.event.targetEventId}` : ""}\n你的渲染锚点 ID：${input.eventId}\n角色产出：\n${JSON.stringify(input.outputs, null, 2)}\n扩散结果：\n${JSON.stringify(input.diffusion, null, 2)}`;
  }

  protected buildTools(): ToolDefinition[] {
    return [...createRendererTools(this.ports, this.cwd), createRulesReadTool(this.cwd)].map(toToolDefinition);
  }

  protected extractOutput(reply: AgentReply): RendererOutput {
    const raw = extractFencedJson(reply.text);
    const render = (raw as { render?: unknown })?.render;
    if (
      !render || typeof render !== "object" ||
      typeof (render as { chapterPath?: unknown })?.chapterPath !== "string" ||
      typeof (render as { text?: unknown })?.text !== "string"
    ) {
      throw new AgentOutputParseError(
        "renderer 产出缺少 render 字段或 chapterPath/text 非字符串",
        JSON.stringify(raw).slice(0, 500),
      );
    }
    return { render: render as RenderOutput };
  }
}