// src/app/provider-catalog.ts
/**
 * provider-catalog.ts — 厂商目录：内置厂商枚举 + 自定义厂商合并视图
 *
 * - 内置厂商：由 pi-ai getProviders()/getModels() 派生（只读，不可增删改）
 * - 自定义厂商：来自 app-config.json llm.providers（baseURL + apiKind + 模型来源）
 * - getProviderViews()：合并两类，返回统一形状供前端下拉与后端解析
 */
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { CustomProvider } from "@pi/admin";

/** 厂商统一视图（内置 + 自定义共享形状，供前端下拉展示） */
export interface ProviderView {
  /** 稳定标识：内置厂商 = provider 名；自定义 = 自定义 id */
  id: string;
  /** 展示名 */
  name: string;
  /** 厂商来源 */
  kind: "builtin" | "custom";
  /** apiKind（内置取自模型 api 字段；自定义取自配置） */
  apiKind: string;
  /** 可用模型 ID 列表 */
  modelIds: string[];
  /** 是否内置（内置只读，仅可配密钥） */
  builtin: boolean;
}

/** 内置厂商派生的模型视图（含 api 种类） */
interface BuiltinModelView {
  id: string;
  api: string;
}

/** 内置厂商缓存（getProviders/getModels 为静态表，可缓存） */
let _builtinCache: ProviderView[] | null = null;

function toBuiltinModelViews(providerId: string): BuiltinModelView[] {
  try {
    return getModels(providerId as never).map((m: Model<any>) => ({
      id: m.id,
      api: m.api,
    }));
  } catch {
    return [];
  }
}

/** 枚举内置厂商（pi-ai 派生，只读） */
export function listBuiltinProviders(): ProviderView[] {
  if (_builtinCache) return _builtinCache;
  const views = getProviders().map((p) => {
    const models = toBuiltinModelViews(p);
    // 取第一个模型的 api 作为该 provider 的 apiKind 代表（表内同 provider 通常一致）
    const apiKind = models[0]?.api ?? "";
    return {
      id: p,
      name: p,
      kind: "builtin" as const,
      apiKind,
      modelIds: models.map((m) => m.id),
      builtin: true,
    };
  });
  _builtinCache = views;
  return views;
}

/** 自定义厂商转视图 */
export function toCustomProviderView(p: CustomProvider): ProviderView {
  return {
    id: p.id,
    name: p.name,
    kind: "custom",
    apiKind: p.apiKind,
    modelIds: p.modelIds,
    builtin: false,
  };
}

/** 合并视图：内置（只读）+ 自定义（来自配置） */
export function getProviderViews(customProviders: CustomProvider[]): ProviderView[] {
  return [...listBuiltinProviders(), ...customProviders.map(toCustomProviderView)];
}

/** 按 id 查厂商视图（内置或自定义），未命中返回 undefined */
export function findProviderView(
  customProviders: CustomProvider[],
  id: string,
): ProviderView | undefined {
  return getProviderViews(customProviders).find((p) => p.id === id);
}