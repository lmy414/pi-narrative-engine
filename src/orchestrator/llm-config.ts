// src/orchestrator/llm-config.ts
/**
 * llm-config.ts — LlmConfig / AgentRuntime 抽象 + 独立 LLM 配置中心（SDK 模式解耦点）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.1
 *
 * 分层：
 * - AgentRuntime：子代理设计 §3.1 的解耦接口（model / streamFn / getApiKey），零 PI 依赖
 * - LlmConfig：独立配置源——provider/model/apiKey，经 API 注入，替代 PI 适配器
 * - LlmConfigStore：LLM 配置中心（2026-08-01 新增）——
 *   外部模块 / pi 适配器经代码 API 注入各子代理角色（slot）的配置，
 *   支持"角色扮演用什么模型、调度器（planner）用什么模型"独立设置，每 slot 独立 key。
 *   设计决策（用户澄清 2026-08-01）：不复用 MCP 客户端凭据（移除客户端名映射
 *   / Codex auth.json 探测），改为独立配置 + env 兜底。
 * - loadLlmConfigFromEnv：env 配置源（无显式注入时的兜底）
 *
 * 2026-07-31 复核修正：
 * - provider 用 KnownProvider 字面量类型（非裸 string），保留 getModel 第一参数类型安全
 * - getModel 第二参数断言 `as never`：该参数是字面量 keyof 联合（models.generated.ts），
 *   运行时 string 无法静态匹配；且 MODELS 类型不被 pi-ai exports 导出，无法引用窄化
 */

import { getModel, getEnvApiKey, streamSimple } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** 解耦接口（子代理设计 §3.1）：编排器与子代理只依赖它，不依赖 PI */
export interface AgentRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

/** 独立配置源（替代 PI 适配器） */
export interface LlmConfig {
  model: {
    /** 已查证：getModel 第一参数要求 KnownProvider 字面量联合（pi-ai types.d.ts:8） */
    provider: KnownProvider;
    /** 模型 ID（如 "deepseek-v4-flash"） */
    name: string;
  };
  apiKey: string;
  headers?: Record<string, string>;
}

/** 从 LlmConfig 构造 AgentRuntime（纯 SDK，无 PI） */
export function createRuntimeFromConfig(config: LlmConfig): AgentRuntime {
  // 已查证：getModel 未命中返回 undefined（models.js:11-14），不抛错——这里显式校验，
  // 避免配置了不存在的模型名后到运行期才静默失败
  const model = getModel(config.model.provider, config.model.name as never);
  if (!model) {
    throw new Error(
      `模型不存在: provider=${config.model.provider} model=${config.model.name}` +
        "（模型 ID 需查 pi-ai MODELS 表，如 deepseek 分区用 deepseek-v4-flash、openai 分区用 gpt-5.1）",
    );
  }
  return {
    model,
    streamFn: streamSimple,
    getApiKey: async () => config.apiKey,
  };
}

/** 缺省模型（无显式配置时） */
const DEFAULT_MODEL: { provider: KnownProvider; name: string } = {
  provider: "deepseek",
  name: "deepseek-v4-flash",
};

/**
 * env 配置源：NE_LLM_PROVIDER / NE_LLM_MODEL / NE_LLM_API_KEY；
 * 缺省 provider/model 取 deepseek / deepseek-v4-flash；
 * key 从 NE_LLM_API_KEY → provider 标准 env 探测。
 * 标准 env 探测复用 pi-ai 的 getEnvApiKey（env-api-keys.ts 内置完整
 * provider→环境变量映射，含 OAuth 等特殊处理），不自维护映射。
 */
export function loadLlmConfigFromEnv(): LlmConfig {
  const provider = (process.env.NE_LLM_PROVIDER ?? DEFAULT_MODEL.provider) as KnownProvider;
  const name = process.env.NE_LLM_MODEL ?? DEFAULT_MODEL.name;
  const apiKey = process.env.NE_LLM_API_KEY ?? getEnvApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `缺少 API Key：已尝试 NE_LLM_API_KEY${provider === "openai-codex" ? "" : ` / ${provider} 标准 env`}，均未找到。` +
        "请设置任一来源，或经 LlmConfigStore API 注入各 slot 配置。",
    );
  }
  return { model: { provider, name }, apiKey };
}

/**
 * 子代理角色（slot）标识：
 * - planner：调度器（检索计划推导）
 * - role：角色扮演
 * - reasoning：可见性推理
 * - renderer：渲染
 * - default：兜底（未显式配置的 slot 回退到这里）
 */
export type LlmSlot = "planner" | "role" | "reasoning" | "renderer" | "default";

/** 全部业务 slot（不含 default） */
export const LLM_BUSINESS_SLOTS: LlmSlot[] = ["planner", "role", "reasoning", "renderer"];

/**
 * 独立 LLM 配置中心（2026-08-01）
 *
 * 经代码 API 注入各 slot 的配置/runtime，供编排器与后续模块使用：
 * - setConfig(slot, { provider, model, apiKey })：配置注入（每 slot 独立 key）
 * - setRuntime(slot, rt)：runtime 直注入（pi 适配器路径：createLlmConfigFromCtx → setConfig）
 * - getRuntime(slot)：取 runtime，解析顺序 slot 显式 → default → env 兜底
 *
 * 不依赖 ExtensionContext / MCP 客户端信息，纯独立配置。
 */
export class LlmConfigStore {
  private readonly slots = new Map<LlmSlot, AgentRuntime>();
  private envFallback?: AgentRuntime;

  /** 注入某 slot 的 LLM 配置（provider/model/apiKey 独立） */
  setConfig(slot: LlmSlot, config: LlmConfig): void {
    this.slots.set(slot, createRuntimeFromConfig(config));
  }

  /** 直接注入某 slot 的 AgentRuntime（pi 适配器等已有 runtime 的路径） */
  setRuntime(slot: LlmSlot, runtime: AgentRuntime): void {
    this.slots.set(slot, runtime);
  }

  /** 移除某 slot 的配置（恢复回退链） */
  clear(slot: LlmSlot): void {
    this.slots.delete(slot);
  }

  /** 已注入的 slot 列表（诊断用） */
  configuredSlots(): LlmSlot[] {
    return Array.from(this.slots.keys());
  }

  /**
   * 取某 slot 的 runtime：slot 显式 → default → env 兜底。
   * env 兜底解析一次并缓存（env 变化需重启进程）。
   */
  async getRuntime(slot: LlmSlot): Promise<AgentRuntime> {
    const hit = this.slots.get(slot) ?? this.slots.get("default");
    if (hit) return hit;
    if (!this.envFallback) {
      this.envFallback = createRuntimeFromConfig(loadLlmConfigFromEnv());
    }
    return this.envFallback;
  }
}
