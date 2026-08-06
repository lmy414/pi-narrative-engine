// src/app/provider-models.ts
/**
 * provider-models.ts — 自定义厂商模型列表解析
 *
 * 模型列表双来源（对齐 LibreChat 模式）：
 * - fetchModels: true → GET {baseURL}/models 自动拉取（OpenAI 兼容 /models 端点），失败回退手动列表
 * - fetchModels: false → 直接返回配置的 modelIds
 *
 * 内置厂商的模型列表由 provider-catalog 的 getModels 派生，不走本模块。
 */
import type { CustomProvider } from "@pi/admin";

/** fetch 拉取 /models 结果的结构（OpenAI 兼容） */
interface ModelsListResponse {
  data?: Array<{ id: string }>;
  models?: Array<{ id: string }>;
}

/** 拉取状态（诊断/展示用） */
export interface FetchModelsResult {
  /** 拉取是否成功（仅 fetchModels=true 时相关） */
  fetched: boolean;
  /** 拉取失败时的错误信息（fetched=false 时可能为 null） */
  fetchError: string | null;
  /** 最终模型列表 */
  modelIds: string[];
}

/** 内存缓存：手动列表无需缓存；fetch 结果短时缓存避免重复请求 */
const fetchCache = new Map<string, { ts: number; ids: string[] }>();
const FETCH_TTL_MS = 60_000;

/** 从 {baseURL}/models 拉取模型 ID 列表（OpenAI 兼容；失败抛错） */
export async function fetchModelsFromEndpoint(
  baseURL: string,
  apiKey?: string,
): Promise<string[]> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`GET ${url} 失败: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ModelsListResponse;
  const ids = (body.data ?? body.models ?? []).map((m) => m.id);
  if (ids.length === 0) {
    throw new Error(`GET ${url} 返回空模型列表`);
  }
  return ids;
}

/**
 * 解析自定义厂商模型列表。
 *
 * - fetchModels=true：尝试拉取（带缓存），失败回退手动列表并把 fetchError 透出
 * - fetchModels=false：直接返回 modelIds
 */
export async function resolveProviderModels(
  provider: CustomProvider,
  apiKey?: string,
): Promise<FetchModelsResult> {
  // 手动来源
  if (!provider.fetchModels) {
    return { fetched: false, fetchError: null, modelIds: [...provider.modelIds] };
  }

  // fetch 来源：命中缓存直接返回
  const cached = fetchCache.get(provider.id);
  if (cached && Date.now() - cached.ts < FETCH_TTL_MS) {
    return { fetched: true, fetchError: null, modelIds: cached.ids };
  }

  try {
    const ids = await fetchModelsFromEndpoint(provider.baseURL, apiKey);
    fetchCache.set(provider.id, { ts: Date.now(), ids });
    return { fetched: true, fetchError: null, modelIds: ids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 失败回退手动列表
    return { fetched: false, fetchError: msg, modelIds: [...provider.modelIds] };
  }
}

/** 测试用：清空缓存（避免测试间污染） */
export function _clearFetchCache(): void {
  fetchCache.clear();
}