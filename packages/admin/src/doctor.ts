// packages/admin/src/doctor.ts
/**
 * doctor.ts — 环境自检（从 scripts/doctor.mjs 抽取的可 import 函数）
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §5.3.5 / §6.4 / §2.3
 *
 * 与原 doctor.mjs 的差异（遵循"LLM 配置全部复用 PI"原则）：
 * - 不再检查 DEEPSEEK_API_KEY / PI_API_KEY（LLM Key 由 PI 管，admin/pi-status.ts 负责）
 * - 不再检查 PI_MODEL / PI_*_MODEL（模型由 ctx.model 管）
 * - 仅检查环境/依赖：Node 版本、原生绑定、dist 产物、模板目录、向量模型环境、
 *   PI 宿主版本、小说工程结构（可选）
 *
 * 库化设计：返回结构化 DoctorReport，不直接 console.log / process.exit，
 * 由调用方（CLI 脚本 / HTTP 路由）决定如何展示。
 */

import { existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { CheckStatus } from "./types.ts";

// ============================================================================
// 类型
// ============================================================================

/** 单项检查结果 */
export interface DoctorCheck {
  /** 检查项 ID（前端可能用作 i18n key） */
  id: string;
  /** 检查项名称（人类可读） */
  name: string;
  /** 状态 */
  status: CheckStatus;
  /** 主消息（如 "Node.js v20.0.0"） */
  message: string;
  /** 修复指引（fail/warn 时给出具体命令） */
  hint?: string;
}

/** 完整检查报告 */
export interface DoctorReport {
  /** 全部检查项（顺序固定） */
  checks: DoctorCheck[];
  /** 失败项数（阻断性） */
  failures: number;
  /** 警告项数（非阻断） */
  warnings: number;
  /** 通过项数 */
  passed: number;
  /** 总体是否可用（failures === 0） */
  ok: boolean;
}

/** runDoctor 选项 */
export interface DoctorOptions {
  /** 扩展仓库根目录（检查 dist/、templates/、原生绑定）
   *  对应开发时的 narrative-engine/ 或运行时的 .pi/extensions/narrative-engine/ */
  repoRoot: string;
  /** 可选：小说工程目录（检查工程结构 + 工程内扩展目录的原生绑定） */
  novelDir?: string;
  /** 可选：扩展目录（检查运行时原生绑定与模型缓存，默认 = repoRoot）
   *  当 novelDir 提供时，会额外检查 <novelDir>/.pi/extensions/narrative-engine/ */
  extensionDir?: string;
}

// ============================================================================
// 可 mock 的内部依赖
// ============================================================================

export const _internals: {
  spawn: typeof spawn;
} = { spawn };

// ============================================================================
// 内部检查函数
// ============================================================================

/** 检查 Node.js 版本（>= 20） */
export function _checkNodeVersion(): DoctorCheck {
  const major = parseInt(process.version.slice(1), 10);
  if (major >= 20) {
    return {
      id: "node",
      name: "Node.js 版本",
      status: "pass",
      message: `${process.version}（>= 20）`,
    };
  }
  return {
    id: "node",
    name: "Node.js 版本",
    status: "fail",
    message: `${process.version} 过旧，需要 Node.js >= 20`,
    hint: "https://nodejs.org/ 或 nvm 安装 LTS",
  };
}

/** 检查原生绑定（better-sqlite3 / sharp / onnxruntime-node） */
export function _checkNativeBindings(baseDir: string): DoctorCheck[] {
  const req = createRequire(resolve(baseDir, "package.json"));
  const checks: DoctorCheck[] = [];

  const items: Array<{ id: string; pkg: string; desc: string; hint: string }> = [
    {
      id: "native-better-sqlite3",
      pkg: "better-sqlite3",
      desc: "世界图存储",
      hint: "npm rebuild better-sqlite3（Windows 需 VS Build Tools）",
    },
    {
      id: "native-sharp",
      pkg: "sharp",
      desc: "transformers.js 静态 import 链",
      hint: "npm rebuild sharp 或 npm install --platform=win32 --arch=x64 sharp",
    },
    {
      id: "native-onnxruntime",
      pkg: "onnxruntime-node",
      desc: "向量推理后端",
      hint: "npm rebuild onnxruntime-node 或 npm install onnxruntime-node",
    },
  ];

  for (const { id, pkg, desc, hint } of items) {
    try {
      if (pkg === "better-sqlite3") {
        // better-sqlite3 需要实测打开内存库（ABI 不匹配时 require 不报错但 open 报错）
        const Database = req("better-sqlite3");
        const db = new Database(":memory:");
        db.exec("CREATE TABLE t(a)");
        db.close();
      } else {
        req(pkg);
      }
      checks.push({
        id,
        name: `原生绑定 ${pkg}`,
        status: "pass",
        message: `${pkg} 可加载（${desc}）`,
      });
    } catch {
      checks.push({
        id,
        name: `原生绑定 ${pkg}`,
        status: "fail",
        message: `${pkg} 缺失或 ABI 不匹配（影响：${desc}）`,
        hint,
      });
    }
  }
  return checks;
}

/** 检查 dist/ 构建产物 */
export function _checkDist(repoRoot: string): DoctorCheck {
  const distIndex = join(repoRoot, "dist", "index.js");
  if (existsSync(distIndex)) {
    return { id: "dist", name: "dist/ 构建产物", status: "pass", message: "dist/index.js 存在" };
  }
  return {
    id: "dist",
    name: "dist/ 构建产物",
    status: "fail",
    message: "dist/ 不存在",
    hint: "运行 npm run build",
  };
}

/** 检查 templates/novel/ 模板目录 */
export function _checkTemplates(repoRoot: string): DoctorCheck {
  const tplDir = join(repoRoot, "templates", "novel");
  if (existsSync(tplDir)) {
    try {
      const files = readdirSync(tplDir);
      return {
        id: "templates",
        name: "templates/novel/ 模板目录",
        status: "pass",
        message: `存在（${files.length} 个模板文件）`,
      };
    } catch {
      // fallthrough
    }
  }
  return {
    id: "templates",
    name: "templates/novel/ 模板目录",
    status: "fail",
    message: "templates/novel/ 不存在",
    hint: "git 仓库不完整？重新 clone 或 checkout",
  };
}

/** 检查向量模型环境（HF 缓存或镜像） */
export function _checkEmbedderEnv(baseDir: string): DoctorCheck {
  // transformers.js v2 缓存路径：模块所在 node_modules 下的 .cache/
  const cacheDir = join(baseDir, "node_modules", "@xenova", "transformers", ".cache", "Xenova");
  const hasLocalCache = existsSync(cacheDir) && readdirSync(cacheDir).length > 0;
  if (hasLocalCache) {
    return {
      id: "embedder-env",
      name: "向量模型环境",
      status: "pass",
      message: "模型已缓存（本目录 node_modules，离线可用）",
    };
  }
  // HF 全局缓存
  const hfCache = join(os.homedir(), ".cache", "huggingface", "hub");
  const hasHfCache =
    existsSync(hfCache) && readdirSync(hfCache).some((d) => d.startsWith("models--"));
  if (hasHfCache) {
    return {
      id: "embedder-env",
      name: "向量模型环境",
      status: "pass",
      message: "HF 模型缓存存在（~/.cache/huggingface）",
    };
  }
  if (process.env.HF_ENDPOINT) {
    return {
      id: "embedder-env",
      name: "向量模型环境",
      status: "pass",
      message: `未缓存但已配置镜像 HF_ENDPOINT=${process.env.HF_ENDPOINT}`,
    };
  }
  return {
    id: "embedder-env",
    name: "向量模型环境",
    status: "warn",
    message: "模型未缓存且未配置镜像：首次向量检索需从 huggingface.co 下载 ~50MB",
    hint: "网络受限时：设置 HF_ENDPOINT=https://hf-mirror.com（写入 .env 由 admin 模块管理）",
  };
}

/** 检查 PI 宿主版本 */
export async function _checkPiVersion(): Promise<DoctorCheck> {
  return new Promise((resolveCheck) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = _internals.spawn("pi", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      shell: process.platform === "win32",
    });
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolveCheck({
        id: "pi-version",
        name: "pi 宿主版本",
        status: "warn",
        message: "无法探测 pi 版本（pi 不在 PATH 或非交互环境）",
        hint: "运行时宿主为 pi CLI，要求 >= 0.77",
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const ver = (stdout || "").trim().split(/\s+/).pop() ?? "";
      if (code === 0 && ver) {
        const minor = parseInt(ver.split(".")[1] ?? "0", 10);
        if (minor >= 77) {
          resolveCheck({
            id: "pi-version",
            name: "pi 宿主版本",
            status: "pass",
            message: `pi ${ver}（>= 0.77，API 兼容）`,
          });
        } else {
          resolveCheck({
            id: "pi-version",
            name: "pi 宿主版本",
            status: "fail",
            message: `pi ${ver} 过旧（< 0.77）`,
            hint: "升级 pi 后重试",
          });
        }
      } else {
        resolveCheck({
          id: "pi-version",
          name: "pi 宿主版本",
          status: "warn",
          message: `pi --version 退出码 ${code}（stderr: ${stderr.trim().slice(0, 80) || "空"})`,
          hint: "运行时宿主为 pi CLI，要求 >= 0.77",
        });
      }
    });
  });
}

/** 检查小说工程结构（可选） */
export async function _checkNovelStructure(novelDir: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const items: Array<{ rel: string; desc: string; level: "fail" | "warn" }> = [
    { rel: "novel.json", desc: "项目清单", level: "warn" },
    { rel: "规则集.md", desc: "渲染规则集", level: "warn" },
    { rel: "planner 规则集.md", desc: "planner 规则集", level: "warn" },
    { rel: "角色规则集.md", desc: "角色规则集", level: "warn" },
    { rel: "正文", desc: "章节目录", level: "warn" },
    {
      rel: join(".pi", "extensions", "narrative-engine", "index.js"),
      desc: "引擎扩展（npm run sync 同步）",
      level: "fail",
    },
    {
      rel: join(".pi", "extensions", "narrative-engine", "node_modules"),
      desc: "扩展依赖（cd 扩展目录 && npm install）",
      level: "fail",
    },
    {
      rel: join(".pi", "world-graph-v3", "world.db"),
      desc: "世界图（首次运行自动创建）",
      level: "warn",
    },
  ];
  for (const { rel, desc, level } of items) {
    if (existsSync(join(novelDir, rel))) {
      checks.push({
        id: `novel-${rel}`,
        name: `工程结构 ${rel}`,
        status: "pass",
        message: desc,
      });
    } else if (level === "fail") {
      checks.push({
        id: `novel-${rel}`,
        name: `工程结构 ${rel}`,
        status: "fail",
        message: `缺 ${rel}：${desc}`,
        hint: "可运行 npm run init -- <目录> 重新生成骨架",
      });
    } else {
      checks.push({
        id: `novel-${rel}`,
        name: `工程结构 ${rel}`,
        status: "warn",
        message: `缺 ${rel}：${desc}`,
        hint: "可运行 npm run init -- <目录> 重新生成骨架",
      });
    }
  }
  // 工程内扩展目录的原生绑定
  const extDir = join(novelDir, ".pi", "extensions", "narrative-engine");
  if (existsSync(extDir) && existsSync(join(extDir, "node_modules"))) {
    const extChecks = _checkNativeBindings(extDir);
    for (const c of extChecks) {
      checks.push({
        ...c,
        id: `novel-ext-${c.id}`,
        name: `工程扩展 ${c.name}`,
      });
    }
    // 工程内扩展目录的模型缓存
    const embedderCheck = _checkEmbedderEnv(extDir);
    checks.push({
      ...embedderCheck,
      id: "novel-ext-embedder-env",
      name: "工程扩展 向量模型环境",
    });
  }
  return checks;
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 执行环境自检
 *
 * 检查顺序（与原 doctor.mjs 对齐）：
 * 1. Node.js 版本
 * 2. 原生绑定（better-sqlite3 / sharp / onnxruntime-node）
 * 3. dist/ 构建产物
 * 4. templates/novel/ 模板目录
 * 5. 向量模型环境
 * 6. pi 宿主版本
 * 7. 小说工程结构（novelDir 提供时）
 *
 * @param options 检查选项
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { repoRoot, novelDir, extensionDir } = options;
  const baseForNative = extensionDir ?? repoRoot;
  const checks: DoctorCheck[] = [];

  checks.push(_checkNodeVersion());
  checks.push(..._checkNativeBindings(baseForNative));
  checks.push(_checkDist(repoRoot));
  checks.push(_checkTemplates(repoRoot));
  checks.push(_checkEmbedderEnv(baseForNative));
  checks.push(await _checkPiVersion());

  if (novelDir) {
    checks.push(...(await _checkNovelStructure(novelDir)));
  }

  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;

  return {
    checks,
    failures,
    warnings,
    passed,
    ok: failures === 0,
  };
}

/**
 * 把 DoctorReport 格式化为人类可读文本（CLI 输出用）
 *
 * 库化设计：admin 子包不直接 console.log，由调用方决定输出形式。
 * 此函数提供 CLI 友好的文本，doctor.mjs 改造后调用它。
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    lines.push(`  ${icon} ${c.message}`);
    if (c.hint) lines.push(`     → ${c.hint}`);
  }
  lines.push("");
  lines.push("═".repeat(50));
  if (report.failures === 0 && report.warnings === 0) {
    lines.push("🎉 全部通过，环境可用");
  } else if (report.failures === 0) {
    lines.push(`✅ 可用（${report.warnings} 个警告，不阻断）`);
  } else {
    lines.push(
      `💥 ${report.failures} 个失败项，${report.warnings} 个警告——按上方指引修复后重跑`,
    );
  }
  return lines.join("\n");
}
