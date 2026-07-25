/**
 * embedder.ts — 实体/状态声明向量化
 *
 * 设计参考：docs/legacy/world-graph-storage-design.md §向量构建方案
 *
 * 模型：Xenova/bge-small-zh-v1.5
 * - 512 维
 * - 量化 ONNX（~50MB）
 * - 本地运行，无外部依赖
 * - 通过 @xenova/transformers 加载
 *
 * 向量写入：由 @pi/world-graph 的 WorldGraph.reembedAll 调用
 * - Entity 节点：embedEntity(snapshot) 产出向量写入 Entity.embedding
 * - Fact 节点：embedFact(decl) 产出向量写入 Fact.embedding
 *
 * 向量更新：实时更新（语义字段变化时立即重新生成）
 */

import { pipeline, env } from "@xenova/transformers";
import type { EntitySnapshot, StateDeclaration } from "@pi/world-graph";

// ============================================================================
// 配置
// ============================================================================

// 禁用 transformers.js 的 sharp 依赖（仅图像模型需要，本项目只用文本 embedding）
// 必须在 import 时立即执行，避免 sharp 加载失败导致整个扩展加载失败
// （sharp 0.35 在 Windows 上原生二进制路径解析有问题）
(env as any).sharp = false;

/** 默认向量模型 */
const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";

/** 是否使用量化模型（更小更快，精度略降） */
const USE_QUANTIZED = true;

// ============================================================================
// 镜像配置（在导入时立即生效，便于国内用户通过环境变量切换镜像）
// ============================================================================

// transformers.js 不读 HF_ENDPOINT 环境变量，需要手动设置 env.remoteHost
// 支持 HF_ENDPOINT 环境变量（与 huggingface-cli 一致的命名约定）
const HF_ENDPOINT = process.env.HF_ENDPOINT;
if (HF_ENDPOINT) {
  env.remoteHost = HF_ENDPOINT.endsWith("/") ? HF_ENDPOINT : HF_ENDPOINT + "/";
}


// ============================================================================
// Embedder 类
// ============================================================================

export class Embedder {
  private extractor: Awaited<ReturnType<typeof pipeline>> | null = null;
  private initPromise: Promise<void> | null = null;
  private model: string;
  private dim: number;

  constructor(model: string = DEFAULT_MODEL, dim: number = 512) {
    this.model = model;
    this.dim = dim;
  }

  /**
   * 初始化模型（懒加载，仅首次调用时下载/加载）
   * 多次调用安全（initPromise 复用）
   */
  async init(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // transformers.js 的 PretrainedOptions 类型对 quantized 字段的类型定义有联合类型问题，
      // 用类型断言绕过（实际运行时只接受 boolean）
      const opts = { quantized: USE_QUANTIZED as unknown as undefined } as Record<string, unknown>;
      try {
        this.extractor = await pipeline("feature-extraction", this.model, opts);
      } catch (err) {
        // 远程不可达（HF 网络受限）时回退纯本地缓存：
        // transformers.js 默认每次都会先请求远端 config，缓存命中也会发请求，
        // 离线/被墙环境下会 fetch failed。localFilesOnly 强制只读本地缓存。
        console.warn(
          `[narrative-engine] embedder 远程加载失败（${(err as Error).message}），回退本地缓存重试…`,
        );
        (env as any).localFilesOnly = true;
        this.extractor = await pipeline("feature-extraction", this.model, opts);
      }
    })();

    return this.initPromise;
  }

  /** 获取向量维度 */
  getDimension(): number {
    return this.dim;
  }

  /**
   * 通用文本向量化
   * @returns 512 维归一化向量
   */
  async embed(text: string): Promise<number[]> {
    await this.init();
    if (!this.extractor) {
      throw new Error("Embedder not initialized");
    }

    // 空文本兜底（避免模型报错）
    const safeText = text?.trim() || "空";

    // transformers.js 的 PretrainedOptions 类型对 pooling/normalize 字段使用了
    // branded union type（& true / & false），TypeScript 严格模式下无法正确推断重载。
    // 用 any 绕过类型检查（运行时 transformers.js 只接受合法值）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = { pooling: "mean", normalize: true };
    const output = (await this.extractor(safeText, options)) as { data: Float32Array };

    // 转换为普通数组
    return Array.from(output.data);
  }

  /**
   * 实体向量化
   * 文本构建：entityId + type + 各 property: value
   */
  async embedEntity(snapshot: EntitySnapshot): Promise<number[]> {
    const parts: string[] = [snapshot.entityId, snapshot.type];
    for (const prop of snapshot.properties) {
      parts.push(`${prop.property}: ${String(prop.value)}`);
    }
    return this.embed(parts.join(" "));
  }

  /**
   * 状态声明向量化
   * 文本构建：property + value + modality
   */
  async embedFact(decl: StateDeclaration): Promise<number[]> {
    const text = `${decl.property} ${String(decl.value)} ${decl.modality}`;
    return this.embed(text);
  }

  /**
   * 批量向量化（提高吞吐）
   * @param texts 文本数组
   * @returns 向量数组（与输入同序）
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init();
    if (!this.extractor) {
      throw new Error("Embedder not initialized");
    }

    if (texts.length === 0) return [];

    const safeTexts = texts.map((t) => (t?.trim() ? t : "空"));

    // transformers.js 支持批量输入：传入字符串数组
    // 用 any 绕过 branded union type 问题（同 embed 方法）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = { pooling: "mean", normalize: true };
    const output = (await this.extractor(safeTexts as unknown as string, options)) as {
      data: Float32Array;
    };

    // output.data 是扁平的 Float32Array，需要按维度切片
    const data = output.data;
    const result: number[][] = [];
    for (let i = 0; i < safeTexts.length; i++) {
      const start = i * this.dim;
      const end = start + this.dim;
      result.push(Array.from(data.slice(start, end)));
    }
    return result;
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 计算两个向量的余弦相似度（向量已归一化，等价于点积）
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /**
   * 计算两个向量的欧氏距离（向量已归一化时与余弦等价）
   */
  static euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
}

// ============================================================================
// 单例（可选使用）
// ============================================================================

let defaultEmbedder: Embedder | null = null;

/** 获取默认 Embedder 单例 */
export function getDefaultEmbedder(): Embedder {
  if (!defaultEmbedder) {
    defaultEmbedder = new Embedder();
  }
  return defaultEmbedder;
}
