// src/chat/main-session.ts
/**
 * main-session.ts — 主会话宿主（PI 本体同构：services → 工厂 → runtime）
 *
 * 依据：docs/plans/2026-08-01-main-session-execution-plan.md §3.1
 *       docs/plans/2026-07-31-sdk-integration-architecture.md §3.2（主会话用 createAgentSessionRuntime）
 *
 * 结构照搬 PI 本体（pi-ex/packages/coding-agent/src/main.ts）：
 * - services（cwd 绑定）：创建一次，跨项目切换复用
 * - 工厂闭包：重建会话时复用（项目切换 = dispose + 重建本 host）
 * - 最简提示词：.pi/SYSTEM.md 自动发现（DefaultResourceLoader），代码不硬编码
 *
 * 模型来源（关键修正：不依赖 agentDir/auth.json 预置）：
 * - 经 options.model + options.runtimeApiKey 注入（调用方从 LlmConfigStore 解析，
 *   与子代理同一配置源）；authStorage.setRuntimeApiKey 为运行时覆盖，不落盘。
 * - 两者都不传时走 modelRegistry 探测（agentDir/auth.json 或 provider 标准 env），
 *   prompt 时缺 key 会报可读错误。
 *
 * 未来 PI 独立：仅本文件与 @earendil-works/pi-coding-agent 耦合，替换即脱离。
 */
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelResolver } from "../agents/agent-runtime.ts";
import type { LlmSlot } from "../orchestrator/llm-config.ts";

export interface MainSessionHostOptions {
  /** 应用自有配置目录（含 auth.json / SYSTEM.md 兜底；不污染 ~/.pi/agent） */
  agentDir: string;
  /** 初始项目目录 */
  cwd: string;
  /** 会话持久化目录（如 <cwd>/.pi/sessions；硬约束：运行时数据放项目目录） */
  sessionDir: string;
  /** 主会话工具（编排器 4 工具等） */
  customTools: ToolDefinition[];
  /** 显式模型（从 LlmConfigStore 解析，可选；缺省走 modelRegistry 探测） */
  model?: Model<any>;
  /** 运行时 API Key 覆盖（setRuntimeApiKey，不持久化；可选） */
  runtimeApiKey?: { provider: string; apiKey: string };
  /**
   * 指定会话路径启动（多 session 并存场景：SessionPool 为每个会话创建独立 host）。
   * 缺省时走 SessionManager.continueRecent（恢复最近会话，与 PI 本体 `pi -c` 一致）。
   */
  sessionPath?: string;
}

/**
 * 主会话宿主（services + 工厂闭包 + runtime）
 *
 * - start()：创建服务 + runtime（首个会话）
 * - session：当前会话（prompt / subscribe / systemPrompt / isStreaming）
 * - dispose()：释放 runtime（项目切换时调用方 dispose 后以新 cwd 重建）
 */
export class MainSessionHost implements ModelResolver {
  private runtime!: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  private readonly opts: MainSessionHostOptions;
  /** 最近一次创建的 services（热应用模型配置用；与 runtime 同生命周期） */
  private services: Awaited<ReturnType<typeof createAgentSessionServices>> | null = null;

  constructor(opts: MainSessionHostOptions) {
    this.opts = opts;
  }

  /** 按 slot 解析模型（主会话恒用 default 语义：返回当前会话模型或构造注入的 opts.model） */
  resolveModel(_slot: LlmSlot): Model<any> {
    const model = this.runtime?.session.model ?? this.opts.model;
    if (!model) {
      throw new Error("主会话模型未解析（start() 未完成或未注入 opts.model）");
    }
    return model;
  }

  /** 按 slot 解析 API Key（主会话 Key 已在 start() 时经 setRuntimeApiKey 注入 authStorage） */
  resolveApiKey(_slot: LlmSlot): string {
    return this.opts.runtimeApiKey?.apiKey ?? "";
  }

  /** 创建服务 + 工厂 + runtime（PI 本体 main.ts 三层结构） */
  async start(): Promise<void> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir });
      this.services = services;
      // 运行时注入 API Key（不写 auth.json；provider 标准 env 兜底仍生效）
      if (this.opts.runtimeApiKey) {
        services.authStorage.setRuntimeApiKey(
          this.opts.runtimeApiKey.provider,
          this.opts.runtimeApiKey.apiKey,
        );
      }
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: this.opts.model,
        customTools: this.opts.customTools,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };

    // G2-3：启动恢复最近会话（与 PI 本体 `pi -c` 一致）。
    // continueRecent 同步：有最近 .jsonl 则 open 旧文件（新消息 append），无则 create 新建。
    // 不走 runtime.switchSession（那是交互期 slash 命令路径），避免首次启动触发 teardown。
    //
    // 多 session 并存场景（sessionPath 指定）：直接 open 目标会话文件，
    // 不走 continueRecent（避免每个 host 都打开最近会话造成冲突）。
    const sessionManager = this.opts.sessionPath
      ? SessionManager.open(this.opts.sessionPath, this.opts.sessionDir)
      : SessionManager.continueRecent(this.opts.cwd, this.opts.sessionDir);
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.opts.cwd,
      agentDir: this.opts.agentDir,
      sessionManager,
    });

    // G2-1：注入 rebind 钩子，切换会话后刷新 services 引用（修复 applyModelConfig
    // 在 switchSession 后访问 stale services 的隐患；PI 本体 modes/print-mode.ts:67 同模式）。
    this.runtime.setRebindSession(async () => {
      this.services = this.runtime.services;
    });
    // G2-1：beforeSessionInvalidate 留空 hook（当前无 UI 拆卸需求，未来扩展时回填）。
    this.runtime.setBeforeSessionInvalidate(() => {});
  }

  /**
   * 切换到指定会话路径（G2-2 切换端点入口）。
   *
   * 内部调 runtime.switchSession，会 dispose 当前 session 并接管目标 session。
   * streaming 中调用会中断当前生成——上层（ChatContext）应先检查 isStreaming 抛 CHAT_BUSY。
   */
  async switchSession(sessionPath: string): Promise<void> {
    await this.runtime.switchSession(sessionPath);
  }

  /**
   * 新建空会话（G2-2 新建端点入口）。
   *
   * 内部调 runtime.newSession，会 dispose 当前 session 并创建新会话文件。
   * streaming 中调用会中断当前生成——上层（ChatContext）应先检查 isStreaming 抛 CHAT_BUSY。
   */
  async newSession(): Promise<void> {
    await this.runtime.newSession();
  }

  /**
   * 热应用模型配置（LLM 设置变更后由 ChatContext 调用）
   *
   * - authStorage.reload()：让运行中会话读到经 /api/admin/llm/key 落盘的 key
   * - setModel：SDK 直接换模型（模型无可用 auth 时抛错，调用方兜底为"下次会话生效"）
   */
  async applyModelConfig(
    model: Model<any>,
    runtimeApiKey?: { provider: string; apiKey: string },
  ): Promise<void> {
    const services = this.services;
    if (!services) return;
    if (runtimeApiKey) {
      services.authStorage.setRuntimeApiKey(runtimeApiKey.provider, runtimeApiKey.apiKey);
    }
    services.authStorage.reload();
    await this.session.setModel(model);
  }

  /** 当前会话 */
  get session(): AgentSession {
    return this.runtime.session;
  }

  /** 当前绑定项目目录 */
  get cwd(): string {
    return this.runtime.cwd;
  }

  /** 模型回退提示（恢复会话时模型与保存不一致等） */
  get modelFallbackMessage(): string | undefined {
    return this.runtime.modelFallbackMessage;
  }

  /** 释放 runtime（会话持久化文件保留，可恢复） */
  async dispose(): Promise<void> {
    await this.runtime.dispose();
    // M-Qual-8：清空 services，防止释放后 applyModelConfig 对已释放实例误操作
    this.services = null;
  }
}
