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
import { existsSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SillyTavernCard } from "@pi/scheduler";
import { loadRoleRuleSet } from "@pi/role-pool";
import { readNovelJson } from "@pi/admin";
import { MainSessionHost, type MainSessionHostOptions } from "../chat/main-session.ts";
import { SessionPool, type SessionHandle } from "../chat/session-pool.ts";
import { createSchedulerTools } from "../chat/scheduler-tools.ts";
import { createMainSessionTools } from "../agents/world-tools.ts";
import { agentToolToToolDefinition } from "../chat/agent-tool-adapter.ts";
import { createRenderTools } from "../chat/render-tools.ts";
import { createRoleTools } from "../chat/role-tools.ts";
import { createImportTools } from "../chat/import-tools.ts";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../orchestrator/llm-config.ts";
import { LlmConfigStoreRuntime } from "../agents/agent-runtime.ts";
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
  dataAccess: ProjectHandle["dataAccess"];
  search: ProjectHandle["search"];
  cwd: string;
  embedder: Embedder;
  llmStore: LlmConfigStore;
  currentStoryTime: string | null;
  setCurrentStoryTime(storyTime: string): void;
}) {
  let currentStoryTime = deps.currentStoryTime;
  const projectDeps = {
    dataAccess: deps.dataAccess,
    search: deps.search,
    cwd: deps.cwd,
    embedder: deps.embedder,
    get currentStoryTime() { return currentStoryTime; },
    setCurrentStoryTime(storyTime: string) {
      currentStoryTime = storyTime;
      deps.setCurrentStoryTime(storyTime);
    },
  };
  // 主会话世界图工具：统一世界工具集经 agent-tool-adapter 转 ToolDefinition；
  // storyTime 缺省读会话态（未设置时抛 storyTime required，对齐现主会话语义；
  // world_status 内部 try/catch 会兜底实时取最新），写操作成功后回写会话态
  const worldToolDeps = {
    dataAccess: deps.dataAccess,
    search: deps.search,
    resolveStoryTime: async () => {
      if (projectDeps.currentStoryTime) return projectDeps.currentStoryTime;
      throw new Error("storyTime required (call world_event_apply first or pass storyTime explicitly)");
    },
    onStoryTime: (storyTime: string) => projectDeps.setCurrentStoryTime(storyTime),
  };
  return [
    ...createSchedulerTools(() => deps.service),
    ...createMainSessionTools(worldToolDeps).map(agentToolToToolDefinition),
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

/**
 * SSE 多路复用事件（所有 session 的 PI 事件经此通道推送，带 sessionId 路由）
 *
 * type 为 "pi" 时 event 为 PI session 原始事件；
 * type 为 "background_complete" 时为 ChatContext 合成事件（prompt() promise resolve 后触发）。
 */
export interface ChatEvent {
  type: "pi" | "background_complete" | "background_error";
  sessionId: string;
  /** PI 原始事件（type="pi" 时）或错误信息（type="background_error" 时） */
  event?: unknown;
  error?: string;
  timestamp: number;
}

/** SSE 订阅回调 */
export type ChatEventSubscriber = (event: ChatEvent) => void;

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
  /** LLM 错误（stopReason=error 时的 errorMessage，如 "402 Insufficient Balance"）；历史渲染错误气泡用 */
  error?: string;
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
  private readonly pool = new SessionPool();
  private readonly subscribers = new Set<ChatEventSubscriber>();
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
    return this.pool.getActive()?.host ?? null;
  }

  /** SessionPool（供 routes 层读取多 session 状态） */
  get sessionPool(): SessionPool {
    return this.pool;
  }

  /** 🟠-3（2026-08-08）：ensureHost 重建单飞——冷启动窗口内并发请求共享同一
   *  重建 promise，避免双 host 双 runtime 并发写同一会话文件 */
  private ensureHostPromise: Promise<MainSessionHost | null> | null = null;

  /**
   * 确保活跃主会话就绪：无活跃项目 → null；cwd 变化 → dispose 重建池。
   * 懒启动：首个 chat 请求才创建。
   */
  async ensureHost(): Promise<MainSessionHost | null> {
    const active = this.opts.registry.getActive();
    if (!active) return null;

    // 池中已有活跃 session 且项目匹配 → 直接返回
    const activeHandle = this.pool.getActive();
    if (activeHandle && activeHandle.host.cwd === active.dir) {
      return activeHandle.host;
    }

    if (!this.opts.embedder) {
      throw new ChatContextError("未加载向量模型（启动加 --embed），主会话不可用", "EMBEDDER_UNAVAILABLE");
    }

    // 🟠-3：单飞——并发进入的 ensureHost 共享同一个重建 promise
    if (!this.ensureHostPromise) {
      this.ensureHostPromise = this.buildHostForActive().finally(() => {
        this.ensureHostPromise = null;
      });
    }
    const host = await this.ensureHostPromise;

    // 单飞期间活跃项目可能再次切换：host 对应发起时的项目，二次校验不匹配则重建
    const current = this.opts.registry.getActive();
    if (current && host && host.cwd !== current.dir) {
      return this.ensureHost();
    }
    return host;
  }

  /** 为当前活跃项目重建整池（ensureHost 单飞的核心执行体） */
  private async buildHostForActive(): Promise<MainSessionHost | null> {
    const active = this.opts.registry.getActive();
    if (!active) return null;
    // 项目切换或首次启动 → dispose 整池重建
    await this.disposeRuntime();
    const host = await this.createHostForProject(active);
    return host;
  }

  /**
   * 为活跃项目创建 host（continueRecent 恢复最近会话），注入池并设为活跃。
   * 仅在 ensureHost 中调用（项目切换/首次启动）。
   */
  private async createHostForProject(active: ProjectHandle): Promise<MainSessionHost> {
    const cwd = active.dir;
    const modelConfig = this.resolveModelConfig();
    await this.ensureOrchestratorService(cwd);

    const host = await this.createHostInternal(active, cwd, modelConfig, undefined);
    const sessionId = host.session.sessionId;
    const handle: SessionHandle = {
      id: sessionId,
      host,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.pool.set(handle);
    this.pool.setActive(sessionId);
    this.subscribeSessionEvents(handle);
    return host;
  }

  /**
   * 为指定 sessionPath 创建 host（activateSession 切换到历史会话时调用）。
   */
  private async createHostForSession(active: ProjectHandle, sessionPath: string): Promise<MainSessionHost> {
    const cwd = active.dir;
    const modelConfig = this.resolveModelConfig();
    await this.ensureOrchestratorService(cwd);
    return this.createHostInternal(active, cwd, modelConfig, sessionPath);
  }

  /** host 创建内部实现（createHost 注入点供测试 mock） */
  private async createHostInternal(
    active: ProjectHandle,
    cwd: string,
    modelConfig: { model?: any; runtimeApiKey?: { provider: string; apiKey: string } },
    sessionPath: string | undefined,
  ): Promise<MainSessionHost> {
    const host = (this.opts.createHost ?? ((options) => new MainSessionHost(options)))({
      agentDir: join(this.opts.configDir, "pi-agent"),
      cwd,
      sessionDir: join(cwd, ".pi", "sessions"),
      customTools: assembleChatTools({
        service: this.requireService(cwd),
        dataAccess: active.dataAccess,
        search: active.search,
        cwd,
        embedder: this.opts.embedder!,
        llmStore: this.opts.llmStore,
        currentStoryTime: this.storyTimes.get(cwd),
        setCurrentStoryTime: (storyTime) => { this.storyTimes.set(cwd, storyTime); },
      }),
      ...modelConfig,
      sessionPath,
    });
    await host.start();
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

    const [plannerRuleSet, roleRuleSet, meta] = await Promise.all([
      loadPlannerRuleSet(cwd),
      loadRoleRuleSet(cwd),
      readNovelJson(cwd),
    ]);
    const ports = assemblePorts({ wg: active.wg, search: active.search, embedder });
    const agentRuntime = new LlmConfigStoreRuntime(this.opts.llmStore);
    const orchestrator = new Orchestrator({
      agentRuntime,
      agentDir: join(this.opts.configDir, "pi-agent"),
      cwd,
      dataAccess: active.dataAccess,
      // v3（2026-08-09）：chaptersDir 真实消费——resolveChapterPath 缺省路径按此解析
      chaptersDir: meta.data?.chaptersDir ?? "正文",
      plannerRuleSet,
      roleRuleSet,
      // v3（2026-08-09，D11）：渲染规则集改渐进披露（<available_rules> + rules_read），
      // 不再全文注入（renderRuleSet 字段废弃兼容）
      renderRuleSet: "",
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
   * LLM 配置变更（default slot / key）后热应用到池中所有主会话。
   *
   * 尽力而为：host 未启动时无操作；模型解析不出或 setModel 失败时抛给调用方。
   * 多 session 并存：遍历池中所有 host 应用。
   */
  async applyLlmChange(): Promise<void> {
    const modelConfig = this.resolveModelConfig();
    if (!modelConfig.model) return;
    for (const handle of this.pool.getAll()) {
      try {
        await handle.host.applyModelConfig(modelConfig.model, modelConfig.runtimeApiKey);
      } catch {
        // 单个 host 应用失败不影响其他 host
      }
    }
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
    const onDisk = await SessionManager.list(active.dir, sessionDir);
    // 合并池中尚未落盘的新会话：newSession 懒写盘（首条消息才写 jsonl），
    // 纯扫盘会漏掉刚创建的空会话，导致 createSession 的 findSessionInfo 误报
    // "新建会话未出现在列表中"，且前端列表在首发消息前看不到该会话
    const diskIds = new Set(onDisk.map((s) => s.id));
    for (const handle of this.pool.getAll()) {
      if (diskIds.has(handle.id)) continue;
      const sm = handle.host.session.sessionManager;
      onDisk.push({
        id: handle.id,
        // 🟡：getSessionFile 可能返回 undefined（会话未落盘），兜底空串
        path: sm.getSessionFile() ?? "",
        cwd: active.dir,
        created: new Date(handle.createdAt),
        modified: new Date(handle.updatedAt),
        messageCount: 0,
        firstMessage: "",
        allMessagesText: "",
      });
    }
    return onDisk;
  }

  /**
   * 新建空会话（多 session 并存版）。
   *
   * 创建新 MainSessionHost（独立 runtime），调 host.newSession() 生成新会话文件。
   * 不检查当前会话是否 streaming——旧会话在后台继续生成。
   * 新会话设为活跃，旧会话保持存活。
   */
  async createSession(): Promise<SessionInfo> {
    const active = this.opts.registry.getActive();
    if (!active) throw new ChatContextError("尚未激活项目", "NO_ACTIVE_PROJECT");
    if (!this.opts.embedder) {
      throw new ChatContextError("未加载向量模型（启动加 --embed），主会话不可用", "EMBEDDER_UNAVAILABLE");
    }

    // 确保 orchestrator service 就绪（首次或项目切换后）
    await this.ensureOrchestratorService(active.dir);
    const cwd = active.dir;
    const modelConfig = this.resolveModelConfig();

    // 创建新 host（无 sessionPath → continueRecent），再 newSession 生成新会话文件
    const host = await this.createHostInternal(active, cwd, modelConfig, undefined);
    await host.newSession(); // dispose host 内 continueRecent 会话，创建新会话文件（不影响池中其他 host）

    const sessionId = host.session.sessionId;
    const handle: SessionHandle = {
      id: sessionId,
      host,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.pool.set(handle);
    this.pool.setActive(sessionId); // 旧活跃会话保持存活，后台继续生成
    this.subscribeSessionEvents(handle);
    return this.findSessionInfo(sessionId);
  }

  /**
   * 切换到指定会话（多 session 并存版）。
   *
   * 池中已有 → 仅切 activeId 指针（不 dispose 旧 host，生成继续后台）。
   * 池中没有 → 创建新 host（sessionPath 指定），注入池并设为活跃。
   * 不检查 streaming——活跃会话切换不中断后台生成。
   * id 可为 sessionId 或 sessionId 前缀（与 PI 本体 resolveSessionPath 一致）。
   */
  async activateSession(id: string): Promise<SessionInfo> {
    const active = this.opts.registry.getActive();
    if (!active) throw new ChatContextError("尚未激活项目", "NO_ACTIVE_PROJECT");
    if (!this.opts.embedder) {
      throw new ChatContextError("未加载向量模型（启动加 --embed），主会话不可用", "EMBEDDER_UNAVAILABLE");
    }

    // 🟠-4（2026-08-08）：池中已有（精确或唯一前缀）→ 仅切指针。
    // 此前前缀命中会走 createHostForSession 重开同一会话文件再 pool.set
    // 裸覆盖旧 handle——旧 host 永不 dispose（双写 + 泄漏）
    const inPool = this.pool.match(id);
    if (inPool) {
      this.pool.setActive(inPool.id);
      return this.findSessionInfo(inPool.id);
    }

    // 池中没有 → 创建新 host
    const sessions = await this.listSessions();
    const target = this.resolveSessionPath(id, sessions);
    if (!target) throw new ChatContextError(`会话不存在: ${id}`, "SESSION_NOT_FOUND");

    // 确保池已初始化（首次切换时可能 ensureHost 未被调用过）
    if (this.pool.size === 0) {
      await this.ensureHost();
      // ensureHost 后再次检查池中是否已有该 session（精确或前缀）
      const again = this.pool.match(id);
      if (again) {
        this.pool.setActive(again.id);
        return this.findSessionInfo(again.id);
      }
    }

    const host = await this.createHostForSession(active, target.path);
    const sessionId = host.session.sessionId;
    const handle: SessionHandle = {
      id: sessionId,
      host,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.pool.set(handle);
    this.pool.setActive(sessionId);
    this.subscribeSessionEvents(handle);
    return this.findSessionInfo(sessionId);
  }

  /** 按 id 或 id 前缀匹配会话（与 PI 本体 resolveSessionPath 语义一致） */
  private resolveSessionPath(id: string, sessions: SessionInfo[]): SessionInfo | null {
    // 精确匹配优先
    const exact = sessions.find((s) => s.id === id);
    if (exact) return exact;
    // 前缀匹配（PI 本体 main.ts:167 同逻辑）
    const prefixed = sessions.filter((s) => s.id.startsWith(id));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) {
      throw new ChatContextError(`会话 ID 前缀不唯一: ${id}（匹配 ${prefixed.length} 个）`, "SESSION_INVALID_PATH");
    }
    return null;
  }

  /** 按 sessionId 从 listSessions 查找 SessionInfo（含 path 字段） */
  private async findSessionInfo(sessionId: string): Promise<SessionInfo> {
    const sessions = await this.listSessions();
    const info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      // 新建会话可能在 list 时还未被读取（极端竞态），返回最小信息
      throw new ChatContextError(`新建会话未出现在列表中: ${sessionId}`, "INTERNAL_ERROR");
    }
    return info;
  }

  /** 读取指定会话的历史消息，并聚合 assistant toolCall/toolResult。 */
  async getSessionMessages(sessionId: string): Promise<HistoricalChatMessage[]> {
    const sessions = await this.listSessions();
    const info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      throw new ChatContextError(`会话不存在: ${sessionId}`, "SESSION_NOT_FOUND");
    }
    // 池中新建会话首条消息前未落盘（newSession 懒写），此时无历史可读
    if (!existsSync(info.path)) return [];
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
        // 🟡：联合类型成员（BashExecutionMessage 等）无 content 字段，显式收窄
        text: extractMessageText((message as { content?: unknown }).content),
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
        // 错误透出：stopReason=error 的 assistant 消息带 errorMessage（如余额不足 402），
        // 不映射则历史回拉后错误气泡消失（用户只见空回复）
        const stopReason = (message as { stopReason?: string }).stopReason;
        const errorMessage = (message as { errorMessage?: string }).errorMessage;
        if (stopReason === "error" || errorMessage) {
          historical.error = errorMessage || "生成失败";
        }
      }
      messages.push(historical);
    }
    return messages;
  }

  private async disposeRuntime(): Promise<void> {
    // dispose 池中所有 host（后台生成中的也会被中断——项目切换场景）
    for (const handle of this.pool.getAll()) {
      try {
        await handle.host.dispose();
      } catch {
        // 单个 host dispose 失败不影响其他
      }
    }
    this.pool.clear();
    // 🟠-5（2026-08-08）：停止各项目队列后再清映射——此前只 clear map，
    // 旧队列继续后台执行、plan 状态丢失、切回时同项目双队列并发写同一 wg
    for (const service of this.orchestratorServices.values()) {
      try {
        service.dispose();
      } catch {
        // 单个服务停止失败不影响其他
      }
    }
    this.orchestratorServices.clear();
    await Promise.all(Array.from(this.projectDebugBuses.values(), (bus) => bus.drain()));
  }

  // ============================================================================
  // SSE 多路复用（所有 session 的 PI 事件经统一通道推送，带 sessionId 路由）
  // ============================================================================

  /**
   * 订阅所有 session 的事件（SSE 端点调用）。
   *
   * 池中所有 session 的 PI 事件都经此通道推送，事件 payload 含 sessionId 路由：
   * { type: "pi", sessionId, event, timestamp }
   * 后台 session 完成时推送合成事件：
   * { type: "background_complete", sessionId, timestamp }
   *
   * 返回取消订阅函数。
   */
  subscribe(cb: ChatEventSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * 订阅单个 session 的 PI 事件，转发给所有订阅者（带 sessionId 包装）。
   * 新 session 创建/激活时调用。
   */
  private subscribeSessionEvents(handle: SessionHandle): void {
    handle.host.session.subscribe((event) => {
      const wrapped: ChatEvent = {
        type: "pi",
        sessionId: handle.id,
        event,
        timestamp: Date.now(),
      };
      for (const cb of this.subscribers) {
        try {
          cb(wrapped);
        } catch {
          // 单个订阅者异常不影响其他
        }
      }
    });
  }

  /**
   * 发送消息到活跃会话，并跟踪生成状态。
   *
   * - prompt 调用前设 status=streaming
   * - prompt() promise resolve 后设 status=idle（含后置处理完成，解决问题 2 根因）
   * - prompt() promise reject 后设 status=error
   * - 后台完成时推送 background_complete 事件
   *
   * 返回 preflight 结果（true=模型就绪，false=模型不可用）。
   * prompt() 只调用一次——preflightResult 回调通知 preflight 结果，
   * prompt promise 的 then/catch 在生成+后置处理完成后触发。
   */
  async sendChatMessage(text: string): Promise<{ preflightSucceeded: boolean; sessionId: string }> {
    const host = await this.ensureHost();
    if (!host) throw new ChatContextError("尚未激活项目", "NO_ACTIVE_PROJECT");
    if (host.session.isStreaming) {
      throw new ChatContextError("当前活跃会话正在生成，请等待完成后再发送", "CHAT_BUSY");
    }

    const sessionId = host.session.sessionId;
    this.pool.updateStatus(sessionId, "streaming");

    const preflightSucceeded = await new Promise<boolean>((resolve) => {
      // 🟡（2026-08-08）：prompt 同步抛错（如 session 状态异常）时复位 status——
      // 此前 status=streaming 永不复位（前端 spinner 卡死）
      let promptPromise: Promise<unknown>;
      try {
        promptPromise = host.session.prompt(text, { preflightResult: resolve });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.pool.updateStatus(sessionId, "error", msg);
        this.notifyBackgroundError(sessionId, msg);
        resolve(false);
        return;
      }
      // prompt promise 在生成+后置处理完成后 resolve/reject
      promptPromise
        .then(() => {
          this.pool.updateStatus(sessionId, "idle");
          this.notifyBackgroundComplete(sessionId);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.pool.updateStatus(sessionId, "error", msg);
          this.notifyBackgroundError(sessionId, msg);
          // preflight 阶段失败时 resolve(false)，让调用方知道模型不可用
          resolve(false);
        });
    });

    if (!preflightSucceeded) {
      throw new ChatContextError("主会话模型不可用（未配置模型或 API Key）", "MODEL_NOT_READY");
    }

    return { preflightSucceeded: true, sessionId };
  }

  /**
   * 中断会话生成（abort）。sessionId 缺省中断当前活跃会话；指定时可中断后台生成中的会话。
   * 幂等：目标不在 streaming 返回 aborted=false（不抛错），前端停止按钮可放心连点。
   * 状态收敛由 sendChatMessage 的 prompt promise 链负责（abort 后 promise 落定 → idle/error）。
   */
  async abortChat(sessionId?: string): Promise<{ aborted: boolean; sessionId: string }> {
    const handle = sessionId ? this.pool.get(sessionId) : this.pool.getActive();
    if (!handle) {
      throw new ChatContextError(
        sessionId ? `会话不存在: ${sessionId}` : "没有活跃会话",
        "SESSION_NOT_FOUND",
      );
    }
    if (!handle.host.session.isStreaming) {
      return { aborted: false, sessionId: handle.id };
    }
    await handle.host.session.abort();
    return { aborted: true, sessionId: handle.id };
  }

  /** 推送 background_complete 合成事件（后台生成完成） */
  private notifyBackgroundComplete(sessionId: string): void {
    const event: ChatEvent = {
      type: "background_complete",
      sessionId,
      timestamp: Date.now(),
    };
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // 忽略
      }
    }
  }

  /** 推送 background_error 合成事件（后台生成失败） */
  private notifyBackgroundError(sessionId: string, error: string): void {
    const event: ChatEvent = {
      type: "background_error",
      sessionId,
      error,
      timestamp: Date.now(),
    };
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // 忽略
      }
    }
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
      // 🟡：类型对齐（provider 字符串 → KnownProvider、apiKey 可能缺省）——
      // 与上分支 `as never` 约定一致（pi-ai 模型表第二参为字面量联合）
      const model = getModel(envConfig.model.provider as never, envConfig.model.name as never);
      return {
        model,
        runtimeApiKey: {
          provider: envConfig.model.provider as never,
          apiKey: envConfig.apiKey ?? "",
        },
      };
    } catch {
      return {};
    }
  }
}
