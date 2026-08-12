// src/agents/agent-runtime.ts
/**
 * agent-runtime.ts — 统一代理运行时抽象（PI 解耦边界）
 *
 * 依据：docs/plans/2026-08-12-unified-agent-abstraction.md §4.1
 *       docs/plans/2026-08-12-unified-agent-abstraction-execution.md §2.1/§2.2/§2.4
 *
 * 职责：
 * - 拆分两个接口：`ModelResolver`（模型/Key 解析，主会话与子代理共享）与
 *   `AgentRuntime`（+ 一次性会话创建与驱动，仅子代理用）。
 * - 提供默认实现 `LlmConfigStoreRuntime`（包装 LlmConfigStore）。
 * - 提供 `SubagentResourceLoader`：子代理专用极简资源加载器，只返回 systemPrompt，
 *   不加载任何项目级资源（.pi/SYSTEM.md / AGENTS.md 等）。
 * - 提供 `AgentOutputParseError` + `extractFencedJson`：指令收尾文本的结构化解析（三级容错）。
 * - 提供 `toToolDefinition`：AgentTool（pi-agent-core）→ ToolDefinition（pi-coding-agent）机械适配。
 *
 * 未来 PI 独立：仅本文件与 pi-coding-agent/pi-agent-core/pi-ai 耦合，替换即脱离。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  AuthStorage,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { LlmConfigStore, LlmSlot } from "../orchestrator/llm-config.ts";

// ============================================================================
// 接口：ModelResolver / AgentRuntime（拆分）
// ============================================================================

/** 模型/Key 解析来源：主会话（MainSessionHost）与子代理（LlmConfigStoreRuntime）共享 */
export interface ModelResolver {
  /** 按 slot 解析模型 */
  resolveModel(slot: LlmSlot): Model<any>;
  /** 按 slot 解析 API Key */
  resolveApiKey(slot: LlmSlot): string;
}

/** 一次性会话创建请求（BaseAgent.buildSessionRequest 产出） */
export interface SessionRequest {
  /** 项目目录（子代理工具的世界图/章节读写锚定此目录） */
  cwd: string;
  /** 应用级配置目录（与 MainSessionHost 同一 agentDir，禁止缺省落到 ~/.pi/agent） */
  agentDir: string;
  /** 会话持久化目录（子代理传 inMemory，不持久化） */
  sessionManager: SessionManager;
  /** 内建工具白名单 */
  tools?: string[];
  /** 内建工具黑名单 */
  excludeTools?: string[];
  /** 禁用全部内建工具（子代理恒传 "all"） */
  noTools?: "all" | "builtin";
  /** 自定义工具（世界图工具等，ToolDefinition[]） */
  customTools?: ToolDefinition[];
  /** 系统提示词装配（子代理用 SubagentResourceLoader） */
  resourceLoader?: ResourceLoader;
  /** 显式模型（由 BaseAgent 经 runtime.resolveModel(slot) 解析后填入） */
  model?: Model<any>;
  /** 运行时 API Key（经 AuthStorage.setRuntimeApiKey 注入） */
  runtimeApiKey?: { provider: string; apiKey: string };
}

/** 一次 prompt 的收尾结果（从 message_end 事件提取） */
export interface AgentReply {
  /** 最终 assistant 消息文本 */
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

/** 一次性会话运行时：仅子代理用（主会话是持久多轮，不适用） */
export interface AgentRuntime extends ModelResolver {
  /** 创建一次 AgentSession（统一运行时） */
  createSession(req: SessionRequest): Promise<AgentSession>;
  /** 驱动一次 prompt，返回最终文本（含超时/中断兜底） */
  driveToReply(
    session: AgentSession,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentReply>;
}

// ============================================================================
// 子代理专用极简 ResourceLoader
// ============================================================================

/**
 * 子代理专用：只返回 systemPrompt，不加载任何项目资源。
 *
 * 避免子代理加载 cwd 下的 .pi/SYSTEM.md / AGENTS.md 等无关项目配置。
 */
export class SubagentResourceLoader implements ResourceLoader {
  private readonly systemPrompt: string;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  getExtensions() {
    // 子代理无扩展；runtime 字段无实际消费方（createAgentSession 仅透传返回给调用方），
    // 用空断言占位，避免构造庞大的 ExtensionRuntime。
    return { extensions: [], errors: [], runtime: undefined as unknown as never };
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  extendResources(): void {
    /* 子代理无扩展资源可注入 */
  }

  async reload(): Promise<void> {
    /* 子代理资源已固定，无需重载 */
  }
}

// ============================================================================
// AgentTool（pi-agent-core）→ ToolDefinition（pi-coding-agent）机械适配
// ============================================================================

/**
 * AgentTool → ToolDefinition 机械适配。
 *
 * 已查证（pi-coding-agent extensions/types.ts:426 vs pi-agent-core types.ts:361）：
 * - 两者 `parameters` 同为 TypeBox schema，可直接复用，无需转换。
 * - 差异仅在 `execute` 签名：AgentTool.execute(toolCallId, params, signal?, onUpdate?)
 *   vs ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)（多第 5 参 ctx）。
 *   现有 execute 闭包不消费 ctx，包一层忽略即可。
 */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    execute: (toolCallId, params, signal, onUpdate, _ctx) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}

// ============================================================================
// 产出解析：AgentOutputParseError + extractFencedJson（三级容错）
// ============================================================================

/** 代理输出解析失败错误（含原始文本前 500 字，绝不静默返回 undefined） */
export class AgentOutputParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = "AgentOutputParseError";
  }
}

/**
 * 通用 JSON 提取器：三级容错。
 *
 * - L1: 提取 ```json ... ``` 内的文本 → JSON.parse
 * - L2: 去除 fence 后，提取第一个顶层 { ... } 或 [ ... ] → JSON.parse
 * - L3: 仍失败则抛 AgentOutputParseError（含原始文本前 500 字）
 */
export function extractFencedJson(text: string): unknown {
  // L1: fenced ` ```json ... ``` `
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fallthrough 到 L2 */
    }
  }
  // L2: 第一个顶层 { ... } 或 [ ... ]
  const bare = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (bare) {
    try {
      return JSON.parse(bare[1]);
    } catch {
      /* fallthrough 到 L3 */
    }
  }
  // L3: 失败
  throw new AgentOutputParseError(
    "无法从代理输出中提取有效 JSON（尝试 fenced 和 bare 提取均失败）",
    text.slice(0, 500),
  );
}

// ============================================================================
// 默认实现：LlmConfigStoreRuntime
// ============================================================================

/**
 * 默认 AgentRuntime 实现：包装 LlmConfigStore。
 *
 * - resolveModel / resolveApiKey：透传 LlmConfigStore。
 * - createSession：经 createAgentSession 创建一次 AgentSession（model/apiKey 已在
 *   BaseAgent.buildSessionRequest 中经 resolveModel/resolveApiKey 填入）。
 * - driveToReply：await session.prompt() 后从 message_end 事件取最终 assistant 文本。
 */
export class LlmConfigStoreRuntime implements AgentRuntime {
  private readonly store: LlmConfigStore;

  constructor(store: LlmConfigStore) {
    this.store = store;
  }

  resolveModel(slot: LlmSlot): Model<any> {
    return this.store.getModel(slot);
  }

  resolveApiKey(slot: LlmSlot): string {
    return this.store.getApiKey(slot);
  }

  async createSession(req: SessionRequest): Promise<AgentSession> {
    // 构造 AuthStorage 并在创建会话前注入运行时 Key（与 MainSessionHost.start 同模式）。
    // createAgentSession 用传入的 authStorage 构造 ModelRegistry，streamFn 经
    // modelRegistry.getApiKeyAndHeaders 取 key，因此 setRuntimeApiKey 后能正确鉴权。
    let authStorage: AuthStorage | undefined;
    if (req.runtimeApiKey) {
      authStorage = AuthStorage.create(joinAgentDirAuth(req.agentDir));
      authStorage.setRuntimeApiKey(req.runtimeApiKey.provider, req.runtimeApiKey.apiKey);
    }

    const result = await createAgentSession({
      cwd: req.cwd,
      agentDir: req.agentDir,
      sessionManager: req.sessionManager,
      model: req.model,
      customTools: req.customTools,
      noTools: req.noTools,
      tools: req.tools,
      excludeTools: req.excludeTools,
      resourceLoader: req.resourceLoader,
      ...(authStorage ? { authStorage } : {}),
    });
    return result.session;
  }

  async driveToReply(
    session: AgentSession,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AgentReply> {
    const timeoutMs = opts?.timeoutMs ?? 300_000;
    let finalText = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text) {
          finalText += text;
        }
        stopReason = event.message.stopReason;
        errorMessage = event.message.errorMessage;
      }
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const promptPromise = session.prompt(prompt, { expandPromptTemplates: false });
      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // 中断子代理执行循环，释放底层 LLM 连接
            void session.abort().catch(() => {});
            reject(new Error(`Agent prompt 超时（${timeoutMs}ms，已中断子代理）`));
          }, timeoutMs);
        });
        await Promise.race([promptPromise, timeoutPromise]);
      } else {
        await promptPromise;
      }
    } catch (err) {
      // prompt 抛错（超时/LLM 错误）时，保留原始错误信息
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }

    return { text: finalText, stopReason, errorMessage };
  }
}

/** agentDir/auth.json 路径拼接（避免在类内重复 path.join 逻辑） */
function joinAgentDirAuth(agentDir: string): string {
  return `${agentDir.replace(/[\\/]+$/, "")}/auth.json`;
}