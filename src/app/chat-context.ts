// src/app/chat-context.ts
/**
 * chat-context.ts — 主会话运行时上下文（unified-server 持有）
 *
 * 依据：docs/plans/2026-08-01-main-session-execution-plan.md §3.3
 *
 * 职责：
 * - ensureHost()：懒启动 MainSessionHost（绑定当前活跃项目）；项目切换 → dispose 重建
 * - ensureOrchestratorService(cwd)：按项目缓存 OrchestratorService（复用 orchestrator-mcp.ts 装配模式）
 * - dispose()：释放 host 与全部编排器服务
 *
 * 模型配置与子代理同源（LlmConfigStore，env 兜底）：env 无 key 时主会话仍可启动，
 * prompt 时由 PI SDK 报可读缺 key 错误。
 */
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SillyTavernCard } from "@pi/scheduler";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import { MainSessionHost, type MainSessionHostOptions } from "../chat/main-session.ts";
import { createSchedulerTools } from "../chat/scheduler-tools.ts";
import { createWorldTools } from "../chat/world-tools.ts";
import { createRenderTools } from "../chat/render-tools.ts";
import { createRoleTools } from "../chat/role-tools.ts";
import { createImportTools } from "../chat/import-tools.ts";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../orchestrator/llm-config.ts";
import { createDebugJsonlSink, createProjectDebugBus } from "../debug/bus.ts";
import type { DebugBus, DebugEventSink, DrainableDebugBus } from "../debug/types.ts";
import { Orchestrator } from "../orchestrator.ts";
import { OrchestratorService } from "../orchestrator/service.ts";
import { assemblePorts } from "../orchestrator/assembly.ts";
import { loadPlannerRuleSet } from "../planner-rule-loader.ts";
import type { Embedder } from "../embedder.ts";
import { ProjectRegistry, type ProjectHandle } from "./project-registry.ts";

/** ChatContext 统一错误（routes 层按 code 映射 HTTP 状态） */
export function assembleChatTools(deps: {
  service: OrchestratorService;
  wg: ProjectHandle["wg"];
  search: ProjectHandle["search"];
  cwd: string;
  embedder: Embedder;
  llmStore: LlmConfigStore;
  currentStoryTime: string | null;
  setCurrentStoryTime(storyTime: string): void;
}) {
  let currentStoryTime = deps.currentStoryTime;
  const projectDeps = {
    wg: deps.wg,
    search: deps.search,
    cwd: deps.cwd,
    embedder: deps.embedder,
    get currentStoryTime() { return currentStoryTime; },
    setCurrentStoryTime(storyTime: string) {
      currentStoryTime = storyTime;
      deps.setCurrentStoryTime(storyTime);
    },
  };
  return [
    ...createSchedulerTools(() => deps.service),
    ...createWorldTools(projectDeps),
    ...createRenderTools(deps),
    ...createRoleTools(deps),
    ...createImportTools(projectDeps),
  ];
}

export function createProjectStoryTimeStore() {
  const storyTimes = new Map<string, string>();
  return {
    get(cwd: string): string | null {
      return storyTimes.get(cwd) ?? null;
    },
    set(cwd: string, storyTime: string): void {
      storyTimes.set(cwd, storyTime);
    },
    clear(): void {
      storyTimes.clear();
    },
  };
}

export class ChatContextError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ChatContextError";
    this.code = code;
  }
}

/** 阶段 1 staticCardLoader 占位（阶段 2 接 defaultStaticCardLoader） */
const DEFAULT_STATIC_CARD_LOADER = async (characterId: string): Promise<SillyTavernCard> => ({
  name: characterId,
  description: characterId,
});

/** 提取 AgentMessage 的纯文本（content 为 string 或 Content[]，只取 text 段） */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text)
      .join("");
  }
  return "";
}

export interface HistoricalToolCall {
  id: string;
  name: string;
  status: "done" | "error";
  isError: boolean;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface HistoricalChatMessage {
  role: string;
  text: string;
  ts: string;
  toolCalls?: HistoricalToolCall[];
  provider?: string;
  model?: string;
  usage?: UsageSummary;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function summarizeUsage(usage: Partial<Usage>): UsageSummary {
  const inputTokens = nonNegativeFinite(usage.input);
  const outputTokens = nonNegativeFinite(usage.output);
  const cacheReadTokens = nonNegativeFinite(usage.cacheRead);
  const cacheWriteTokens = nonNegativeFinite(usage.cacheWrite);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.totalTokens === undefined
      ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
      : nonNegativeFinite(usage.totalTokens),
    estimatedCostUsd: nonNegativeFinite(usage.cost?.total),
  };
}

export interface ChatContextOptions {
  /** 多项目注册表（活跃项目来源） */
  registry: ProjectRegistry;
  /** 主会话/子代理共用模型配置中心 */
  llmStore: LlmConfigStore;
  /** 平台配置目录（agentDir = <configDir>/pi-agent） */
  configDir: string;
  /** 向量模型实例（null 时主会话不可用，检索降级由 Search 内部处理） */
  embedder?: Embedder | null;
  /** 调试总线（编排四阶段 span 埋点；null 时 no-op） */
  debugBus?: DebugBus | null;
  /** 项目日志 sink 工厂（测试可注入临时 sink）。 */
  createDebugSink?: (cwd: string) => DebugEventSink;
  createHost?: (options: MainSessionHostOptions) => MainSessionHost;
  createOrchestratorService?: (
    active: ProjectHandle,
    embedder: Embedder,
    debugBus: DebugBus | null,
  ) => Promise<OrchestratorService>;
}

export class ChatContext {
  private host: MainSessionHost | null = null;
  private readonly storyTimes = createProjectStoryTimeStore();
  /** 按项目目录缓存的编排器服务（项目切换后旧实例随 dispose 释放） */
  private readonly orchestratorServices = new Map<string, OrchestratorService>();
  /** 固定 cwd 的项目 bus；保留到上下文结束，以便旧任务切换后仍写原项目并可 drain。 */
  private readonly projectDebugBuses = new Map<string, DrainableDebugBus>();
  private readonly opts: ChatContextOptions;

  constructor(opts: ChatContextOptions) {
    this.opts = opts;
  }

  /** 当前活跃主会话（未启动为 null） */
  get activeHost(): MainSessionHost | null {
    return this.host;
  }

  /**
   * 确保主会话就绪：无活跃项目 → null；cwd 变化 → dispose 重建。
   * 懒启动：首个 chat 请求才创建。
   */
  async ensureHost(): Promise<MainSessionHost | null> {
    const active = this.opts.registry.getActive();
    if (!active) return null;
    if (this.host && this.host.cwd === active.dir) return this.host;

    if (!this.opts.embedder) {
      throw new ChatContextError("未加载向量模型（启动加 --embed），主会话不可用", "EMBEDDER_UNAVAILABLE");
    }

    await this.disposeRuntime();
    const cwd = active.dir;
    const modelConfig = this.resolveModelConfig();
    await this.ensureOrchestratorService(cwd);

    const host = (this.opts.createHost ?? ((options) => new MainSessionHost(options)))({
      agentDir: join(this.opts.configDir, "pi-agent"),
      cwd,
      sessionDir: join(cwd, ".pi", "sessions"),
      customTools: assembleChatTools({
        service: this.requireService(cwd),
        wg: active.wg,
        search: active.search,
        cwd,
        embedder: this.opts.embedder,
        llmStore: this.opts.llmStore,
        currentStoryTime: this.storyTimes.get(cwd),
        setCurrentStoryTime: (storyTime) => { this.storyTimes.set(cwd, storyTime); },
      }),
      ...modelConfig,
    });
    await host.start();
    this.host = host;
    return host;
  }

  /** 取指定项目的编排器服务（未缓存则装配；非活跃项目抛错） */
  async ensureOrchestratorService(cwd: string): Promise<OrchestratorService> {
    const cached = this.orchestratorServices.get(cwd);
    if (cached) return cached;

    const active = this.opts.registry.getActive();
    if (!active || active.dir !== cwd) {
      throw new ChatContextError(`项目未激活或已切换: ${cwd}`, "NO_ACTIVE_PROJECT");
    }
    const embedder = this.opts.embedder;
    if (!embedder) {
      throw new ChatContextError("未加载向量模型（启动加 --embed），编排器不可用", "EMBEDDER_UNAVAILABLE");
    }

    const projectDebugBus = this.ensureProjectDebugBus(cwd);
    if (this.opts.createOrchestratorService) {
      const service = await this.opts.createOrchestratorService(active, embedder, projectDebugBus);
      this.orchestratorServices.set(cwd, service);
      return service;
    }

    const [plannerRuleSet, roleRuleSet, renderRuleSet] = await Promise.all([
      loadPlannerRuleSet(cwd),
      loadRoleRuleSet(cwd),
      loadRuleSet(cwd),
    ]);
    const ports = assemblePorts({ wg: active.wg, search: active.search, embedder });
    const orchestrator = new Orchestrator({
      llmStore: this.opts.llmStore,
      cwd,
      plannerRuleSet,
      roleRuleSet,
      renderRuleSet,
      staticCardLoader: DEFAULT_STATIC_CARD_LOADER,
      ports,
      debugBus: projectDebugBus,
    });
    const service = new OrchestratorService(orchestrator);
    this.orchestratorServices.set(cwd, service);
    return service;
  }

  /** 释放主会话与全部编排器服务（服务关闭时调用） */
  async dispose(): Promise<void> {
    await this.disposeRuntime();
    this.storyTimes.clear();
  }

  /**
   * LLM 配置变更（default slot / key）后热应用到运行中的主会话。
   *
   * 尽力而为：host 未启动时无操作（下次 ensureHost 自然用新配置）；
   * 模型解析不出或 setModel 失败时抛给调用方（路由层兜底为"下次会话生效"）。
   * 子代理每次调用都经 LlmConfigStore 现取配置，无需额外处理。
   */
  async applyLlmChange(): Promise<void> {
    if (!this.host) return;
    const modelConfig = this.resolveModelConfig();
    if (!modelConfig.model) return;
    await this.host.applyModelConfig(modelConfig.model, modelConfig.runtimeApiKey);
  }

  // ============================================================================
  // 会话列表/历史（只读，B3；SDK SessionManager 持久化于 <项目>/.pi/sessions/）
  // ============================================================================

  /** 活跃项目的会话目录（与 MainSessionHost 一致） */
  private requireSessionDir(): string {
    const active = this.opts.registry.getActive();
    if (!active) {
      throw new ChatContextError("尚未激活项目", "NO_ACTIVE_PROJECT");
    }
    return join(active.dir, ".pi", "sessions");
  }

  /** 列出活跃项目的历史会话（只读元数据，不启动主会话） */
  async listSessions(): Promise<SessionInfo[]> {
    const sessionDir = this.requireSessionDir();
    const active = this.opts.registry.getActive()!;
    return SessionManager.list(active.dir, sessionDir);
  }

  /** 读取指定会话的历史消息，并聚合 assistant toolCall/toolResult。 */
  async getSessionMessages(sessionId: string): Promise<HistoricalChatMessage[]> {
    const sessions = await this.listSessions();
    const info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      throw new ChatContextError(`会话不存在: ${sessionId}`, "SESSION_NOT_FOUND");
    }
    const manager = SessionManager.open(info.path, this.requireSessionDir());
    const entries = manager.getEntries();
    const toolResults = new Map<string, boolean>();
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      toolResults.set(entry.message.toolCallId, entry.message.isError);
    }

    const messages: HistoricalChatMessage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "toolResult") continue;
      const historical: HistoricalChatMessage = {
        role: String(message.role),
        text: extractMessageText(message.content),
        ts: entry.timestamp,
      };
      if (message.role === "assistant") {
        const toolCalls = message.content
          .filter((content) => content.type === "toolCall")
          .map((toolCall): HistoricalToolCall => {
            const resultIsError = toolResults.get(toolCall.id);
            const isError = resultIsError ?? true;
            return {
              id: toolCall.id,
              name: toolCall.name,
              status: isError ? "error" : "done",
              isError,
            };
          });
        if (toolCalls.length > 0) historical.toolCalls = toolCalls;
        historical.provider = message.provider;
        historical.model = message.model;
        if (message.usage && typeof message.usage === "object") {
          historical.usage = summarizeUsage(message.usage);
        }
      }
      messages.push(historical);
    }
    return messages;
  }

  private async disposeRuntime(): Promise<void> {
    if (this.host) {
      await this.host.dispose();
      this.host = null;
    }
    this.orchestratorServices.clear();
    await Promise.all(Array.from(this.projectDebugBuses.values(), (bus) => bus.drain()));
  }

  private ensureProjectDebugBus(cwd: string): DrainableDebugBus | null {
    const globalBus = this.opts.debugBus;
    if (!globalBus) return null;
    const cached = this.projectDebugBuses.get(cwd);
    if (cached) return cached;
    const sink = (this.opts.createDebugSink ?? createDebugJsonlSink)(cwd);
    const bus = createProjectDebugBus(globalBus, sink);
    this.projectDebugBuses.set(cwd, bus);
    return bus;
  }

  private requireService(cwd: string): OrchestratorService {
    const service = this.orchestratorServices.get(cwd);
    if (!service) {
      throw new ChatContextError(`编排器服务未初始化: ${cwd}`, "NO_ACTIVE_PROJECT");
    }
    return service;
  }

  /** 从 LlmConfigStore 解析主会话模型（env 无 key 时返回空对象，走 SDK 缺省探测） */
  private resolveModelConfig(): {
    model?: Model<any>;
    runtimeApiKey?: { provider: string; apiKey: string };
  } {
    // 先检查是否有显式配置，有则优先使用，不走 env 兜底（避免 loadLlmConfigFromEnv 抛错）
    const configuredSlots = this.opts.llmStore.configuredSlots();
    if (configuredSlots.includes("default")) {
      try {
        const model = this.opts.llmStore.getModel("default");
        const apiKey = this.opts.llmStore.getApiKey("default");
        return { model, runtimeApiKey: { provider: model.provider, apiKey } };
      } catch {
        return {};
      }
    }
    // 无显式 "default" 配置，env 兜底
    try {
      const envConfig = loadLlmConfigFromEnv();
      const model = getModel(envConfig.model.provider, envConfig.model.name as never);
      return { model, runtimeApiKey: { provider: envConfig.model.provider, apiKey: envConfig.apiKey } };
    } catch {
      return {};
    }
  }
}
