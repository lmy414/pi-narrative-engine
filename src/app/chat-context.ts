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
import type { Model } from "@earendil-works/pi-ai";
import type { SillyTavernCard } from "@pi/scheduler";
import { loadRoleRuleSet } from "@pi/role-pool";
import { loadRuleSet } from "@pi/renderer";
import { MainSessionHost } from "../chat/main-session.ts";
import { createSchedulerTools } from "../chat/scheduler-tools.ts";
import { LlmConfigStore, loadLlmConfigFromEnv } from "../orchestrator/llm-config.ts";
import { Orchestrator } from "../orchestrator.ts";
import { OrchestratorService } from "../orchestrator/service.ts";
import { assemblePorts } from "../orchestrator/assembly.ts";
import { loadPlannerRuleSet } from "../planner-rule-loader.ts";
import type { Embedder } from "../embedder.ts";
import { ProjectRegistry } from "./project-registry.ts";

/** ChatContext 统一错误（routes 层按 code 映射 HTTP 状态） */
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

export interface ChatContextOptions {
  /** 多项目注册表（活跃项目来源） */
  registry: ProjectRegistry;
  /** 主会话/子代理共用模型配置中心 */
  llmStore: LlmConfigStore;
  /** 平台配置目录（agentDir = <configDir>/pi-agent） */
  configDir: string;
  /** 向量模型实例（null 时主会话不可用，检索降级由 Search 内部处理） */
  embedder?: Embedder | null;
}

export class ChatContext {
  private host: MainSessionHost | null = null;
  /** 按项目目录缓存的编排器服务（项目切换后旧实例随 dispose 释放） */
  private readonly orchestratorServices = new Map<string, OrchestratorService>();
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

    await this.dispose();
    const cwd = active.dir;
    await this.ensureOrchestratorService(cwd);

    const host = new MainSessionHost({
      agentDir: join(this.opts.configDir, "pi-agent"),
      cwd,
      sessionDir: join(cwd, ".pi", "sessions"),
      customTools: createSchedulerTools(() => this.requireService(cwd)),
      ...this.resolveModelConfig(),
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
    });
    const service = new OrchestratorService(orchestrator);
    this.orchestratorServices.set(cwd, service);
    return service;
  }

  /** 释放主会话与全部编排器服务（服务关闭时调用） */
  async dispose(): Promise<void> {
    if (this.host) {
      await this.host.dispose();
      this.host = null;
    }
    this.orchestratorServices.clear();
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
    try {
      loadLlmConfigFromEnv();
      const model = this.opts.llmStore.getModel("default");
      const apiKey = this.opts.llmStore.getApiKey("default");
      return { model, runtimeApiKey: { provider: model.provider, apiKey } };
    } catch {
      return {};
    }
  }
}
