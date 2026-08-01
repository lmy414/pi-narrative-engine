// src/orchestrator/llm-config.ts
/**
 * llm-config.ts — LLM 配置中心（直接面向 pi-ai 统一模型 API）
 *
 * 依据：docs/plans/2026-07-31-orchestrator-standalone-research.md §5.1
 *
 * 设计（2026-08-01 用户决策）：
 * - 不复用 MCP 客户端凭据，不做自造模型调用层；
 * - 直接复用 pi-ai 统一 API：getModel（provider+模型ID → Model，适配所有 provider）、
 *   streamSimple（统一流式调用）、getEnvApiKey（provider → 标准环境变量 key）；
 * - LlmConfigStore 是配置中心雏形：各子代理角色（slot）存 pi-ai 原生配置
 *   （provider / modelId / apiKey），供后期配置中心统一管理"每个子代理用什么模型"。
 *   解析链：slot 显式 → default → env 兜底（NE_LLM_PROVIDER/MODEL + getEnvApiKey）。
 *
 * 2026-07-31 复核修正：
 * - provider 用 KnownProvider 字面量类型（非裸 string），保留 getModel 第一参数类型安全
 * - getModel 第二参数断言 `as never`：该参数是字面量 keyof 联合（models.generated.ts），
 *   运行时 string 无法静态匹配；且 MODELS 类型不被 pi-ai exports 导出，无法引用窄化
 */

import { getModel, getEnvApiKey } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";

/** pi-ai 原生模型配置（配置中心统一存储形态） */
export interface LlmConfig {
  model: {
    /** 已查证：getModel 第一参数要求 KnownProvider 字面量联合（pi-ai types.d.ts:8） */
    provider: KnownProvider;
    /** 模型 ID（如 deepseek 分区 "deepseek-v4-flash"、openai 分区 "gpt-5.1"） */
    name: string;
  };
  /** 可省略：缺省时取 provider 标准环境变量（getEnvApiKey） */
  apiKey?: string;
  headers?: Record<string, string>;
}

/** 缺省模型（无显式配置时） */
const DEFAULT_MODEL: { provider: KnownProvider; name: string } = {
  provider: "deepseek",
  name: "deepseek-v4-flash",
};

/**
 * env 配置源：NE_LLM_PROVIDER / NE_LLM_MODEL / NE_LLM_API_KEY；
 * 缺省 provider/model 取 deepseek / deepseek-v4-flash；
 * key 从 NE_LLM_API_KEY → provider 标准 env 探测（复用 pi-ai getEnvApiKey）。
 */
export function loadLlmConfigFromEnv(): LlmConfig {
  const provider = (process.env.NE_LLM_PROVIDER ?? DEFAULT_MODEL.provider) as KnownProvider;
  const name = process.env.NE_LLM_MODEL ?? DEFAULT_MODEL.name;
  const apiKey = process.env.NE_LLM_API_KEY ?? getEnvApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `缺少 API Key：已尝试 NE_LLM_API_KEY${provider === "openai-codex" ? "" : ` / ${provider} 标准 env`}，均未找到。` +
        "请设置任一来源，或经 LlmConfigStore.setConfig 注入。",
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
 * LLM 配置中心（2026-08-01）——配置中心雏形，直接产出 pi-ai 原生 Model/apiKey
 *
 * - setConfig(slot, { provider, name, apiKey? })：注入 pi-ai 原生配置
 * - getModel(slot)：pi-ai Model（getModel 结果，未命中抛错）
 * - getApiKey(slot)：配置 apiKey → provider 标准 env（getEnvApiKey），均无抛错
 *
 * 子代理工厂直接消费 Model + apiKey + streamSimple（pi-ai），无自造调用层。
 */
export class LlmConfigStore {
  private readonly configs = new Map<LlmSlot, LlmConfig>();
  private readonly modelCache = new Map<LlmSlot, Model<any>>();
  private envFallback?: LlmConfig;

  /** 注入某 slot 的 pi-ai 配置（apiKey 可省略，缺省走 provider 标准 env） */
  setConfig(slot: LlmSlot, config: LlmConfig): void {
    this.configs.set(slot, config);
    this.modelCache.delete(slot);
  }

  /** 移除某 slot 的配置（恢复回退链） */
  clear(slot: LlmSlot): void {
    this.configs.delete(slot);
    this.modelCache.delete(slot);
  }

  /** 已注入的 slot 列表（诊断用） */
  configuredSlots(): LlmSlot[] {
    return Array.from(this.configs.keys());
  }

  /** 查看某 slot 的显式配置（不走回退链；未配置返回 undefined） */
  peekConfig(slot: LlmSlot): LlmConfig | undefined {
    return this.configs.get(slot);
  }

  /** 解析某 slot 配置：slot 显式 → default → env 兜底（env 解析一次并缓存） */
  private resolveConfig(slot: LlmSlot): LlmConfig {
    const hit = this.configs.get(slot) ?? this.configs.get("default");
    if (hit) return hit;
    if (!this.envFallback) {
      this.envFallback = loadLlmConfigFromEnv();
    }
    return this.envFallback;
  }

  getHeaders(slot: LlmSlot): Record<string, string> | undefined {
    return this.resolveConfig(slot).headers;
  }

  /** 取某 slot 的 pi-ai Model（getModel 未命中返回 undefined，此处显式抛错） */
  getModel(slot: LlmSlot): Model<any> {
    const cached = this.modelCache.get(slot);
    if (cached) return cached;
    const cfg = this.resolveConfig(slot);
    const model = getModel(cfg.model.provider, cfg.model.name as never);
    if (!model) {
      throw new Error(
        `模型不存在: provider=${cfg.model.provider} model=${cfg.model.name}` +
          "（模型 ID 需查 pi-ai MODELS 表，如 deepseek 分区用 deepseek-v4-flash、openai 分区用 gpt-5.1）",
      );
    }
    this.modelCache.set(slot, model);
    return model;
  }

  /** 取某 slot 的 apiKey：slot → default → NE_LLM_API_KEY → provider 标准 env */
  getApiKey(slot: LlmSlot): string {
    const cfg = this.resolveConfig(slot);
    const key = this.configs.get(slot)?.apiKey
      ?? this.configs.get("default")?.apiKey
      ?? process.env.NE_LLM_API_KEY
      ?? getEnvApiKey(cfg.model.provider);
    if (!key) {
      throw new Error(
        `slot=${slot} 缺 API Key：已尝试 slot/default 配置、NE_LLM_API_KEY 与 ${cfg.model.provider} 标准 env` +
          "（可 setConfig 注入 apiKey，或设置环境变量）",
      );
    }
    return key;
  }
}
