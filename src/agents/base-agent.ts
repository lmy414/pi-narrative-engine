// src/agents/base-agent.ts
/**
 * base-agent.ts — 统一代理抽象基类（仅子代理继承）
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction.md §4.2
 *       docs/plans/2026-08-12-unified-agent-abstraction-execution.md §2.3
 *
 * 职责：
 * - 唯一底层运行时 = AgentSession（pi-coding-agent），由 AgentRuntime 创建与驱动。
 * - 行为差异由子类实现：getSlot / buildSystemPrompt / buildUserPrompt / buildTools / extractOutput。
 * - run() 统一流程：buildSessionRequest → runtime.createSession → driveToReply → extractOutput，
 *   finally 中 dispose 会话（一次性，防资源泄漏）。
 *
 * 主会话不继承本类（持久多轮，非一次性语义），见执行文档 §2.6。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentReply, AgentRuntime, SessionRequest } from "./agent-runtime.ts";
import { SubagentResourceLoader } from "./agent-runtime.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

/** run() 可选参数 */
export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** BaseAgent 构造选项 */
export interface BaseAgentOptions {
  /** 项目目录（世界图/章节读写锚点） */
  cwd: string;
  /** 应用级配置目录（%APPDATA%/narrative-engine） */
  agentDir: string;
}

/**
 * 子代理指令收尾段（替代原 terminate 产出工具）。
 * 各子代理 buildSystemPrompt 末尾追加，并要求以 fenced JSON 收尾交付结构化产出。
 */
export const OUTPUT_DISCIPLINE_SUFFIX = `
---
⚠️ 产出纪律：
1. 完成所有推理后，你必须以一段 fenced JSON 提交最终结论。
2. 格式严格如下（仅输出一次，不得调用任何产出提交工具）：

\`\`\`json
{ ... }
\`\`\`

3. 不要在 JSON 前后添加解释性文字。
4. 如果无法完成任务，JSON 内 \`ok: false\` 并附 \`error\` 字段说明原因（仍须为合法 JSON）。
`;

/**
 * 统一代理抽象基类（唯一底层 AgentSession，一次性运行）
 *
 * @template TInput 子代理输入
 * @template TOutput 子代理结构化产出
 */
export abstract class BaseAgent<TInput, TOutput> {
  protected readonly runtime: AgentRuntime;
  protected readonly cwd: string;
  protected readonly agentDir: string;

  constructor(runtime: AgentRuntime, opts: BaseAgentOptions) {
    this.runtime = runtime;
    this.cwd = opts.cwd;
    this.agentDir = opts.agentDir;
  }

  /** 子代理的 LLM slot（planner/role/reasoning/renderer），用于解析 model/apiKey */
  protected abstract getSlot(): LlmSlot;
  /** 构造 systemPrompt（子代理用轻量 forSubagent prompt）；可异步（如渐进披露读取规则清单） */
  protected abstract buildSystemPrompt(input: TInput): string | Promise<string>;
  /** 构造用户 prompt */
  protected abstract buildUserPrompt(input: TInput): string;
  /** 工具集（ToolDefinition[]） */
  protected abstract buildTools(input: TInput): ToolDefinition[];
  /** 从最终 assistant 文本解析结构化产出 */
  protected abstract extractOutput(reply: AgentReply): TOutput;

  /** 子类可覆写 session 请求（默认 inMemory 一次性 + 禁用全部内建工具） */
  protected async buildSessionRequest(input: TInput): Promise<SessionRequest> {
    const model = this.runtime.resolveModel(this.getSlot());
    const systemPrompt = await this.buildSystemPrompt(input);
    return {
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      noTools: "all",
      customTools: this.buildTools(input),
      model,
      runtimeApiKey: {
        provider: model.provider,
        apiKey: this.runtime.resolveApiKey(this.getSlot()),
      },
      resourceLoader: new SubagentResourceLoader(systemPrompt),
    };
  }

  /** 统一执行入口 */
  async run(input: TInput, opts?: RunOptions): Promise<TOutput> {
    const req = await this.buildSessionRequest(input);
    const session = await this.runtime.createSession(req);
    try {
      const reply = await this.runtime.driveToReply(
        session,
        this.buildUserPrompt(input),
        opts,
      );
      return this.extractOutput(reply);
    } finally {
      session.dispose();
    }
  }
}