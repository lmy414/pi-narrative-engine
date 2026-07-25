#!/usr/bin/env node
/**
 * doctor.mjs — narrative-engine 环境自检
 *
 * 用法：npm run doctor [--novel <小说工程目录>]
 *
 * 检查项（每项 ✅/❌/⚠️ + 修复指引）：
 *   1. Node.js 版本（>= 20）
 *   2. 原生绑定（better-sqlite3 / sharp / onnxruntime-node——缺失分别导致世界图无法初始化、扩展 import 崩溃、向量模型无法推理）
 *   3. dist/ 构建产物（是否跑过 npm run build）
 *   4. templates/novel/ 模板目录
 *   5. LLM API key（DEEPSEEK_API_KEY / PI_API_KEY）
 *   6. 向量模型环境（HF 缓存 或 HF_ENDPOINT 镜像 或离线回退说明）
 *   7. --novel 指定时：小说工程结构（novel.json / 规则集 / .pi/extensions / world-graph）
 *
 * 退出码：全部通过 0；有 ❌ 则 1（⚠️ 不阻断）
 */

import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

let failures = 0;
let warnings = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg, hint) {
  warnings++;
  console.log(`  ⚠️ ${msg}`);
  if (hint) console.log(`     → ${hint}`);
}
function fail(msg, hint) {
  failures++;
  console.log(`  ❌ ${msg}`);
  if (hint) console.log(`     → ${hint}`);
}

// ---------------------------------------------------------------------------
console.log("\n[1/8] Node.js 版本");
const major = parseInt(process.version.slice(1), 10);
if (major >= 20) ok(`${process.version}（>= 20）`);
else fail(`${process.version} 过旧，需要 Node.js >= 20`, "https://nodejs.org/ 或 nvm 安装 LTS");

// ---------------------------------------------------------------------------
console.log("\n[2/8] 原生绑定（better-sqlite3 / sharp / onnxruntime-node）");
{
  const { createRequire } = await import("node:module");
  const req = createRequire(resolve(repoRoot, "package.json"));

  // better-sqlite3：世界图存储
  try {
    const Database = req("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(a)");
    db.close();
    ok("better-sqlite3 绑定可加载，内存库读写正常");
  } catch {
    fail(
      "better-sqlite3 原生绑定缺失或 ABI 不匹配（世界图将无法初始化，且错误会被静默吞掉）",
      "运行 npm rebuild better-sqlite3；若网络受限需先配好 C++ 编译环境（Windows: VS Build Tools）",
    );
  }

  // sharp：@xenova/transformers 的传递依赖，src/utils/image.js 静态 import。
  // 绑定一缺，扩展 import 即崩（embedder.ts 的 env.sharp=false 防不住静态 import）。
  try {
    req("sharp");
    ok("sharp 绑定可加载（transformers.js 静态 import 链安全）");
  } catch {
    fail(
      "sharp 原生绑定缺失（扩展将 import 崩溃：Something went wrong installing the \"sharp\" module）",
      "运行 npm rebuild sharp；或 npm install --platform=win32 --arch=x64 sharp（按实际平台调整）",
    );
  }

  // onnxruntime-node：embedding 模型推理后端
  try {
    req("onnxruntime-node");
    ok("onnxruntime-node 绑定可加载（向量推理后端可用）");
  } catch {
    fail(
      "onnxruntime-node 原生绑定缺失（首次向量检索将失败）",
      "运行 npm rebuild onnxruntime-node；或重装：npm install onnxruntime-node",
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n[3/8] dist/ 构建产物");
const distIndex = resolve(repoRoot, "dist", "index.js");
if (existsSync(distIndex)) ok("dist/index.js 存在");
else fail("dist/ 不存在", "运行 npm run build");

// ---------------------------------------------------------------------------
console.log("\n[4/8] templates/novel/ 模板目录");
const tplDir = resolve(repoRoot, "templates", "novel");
if (existsSync(tplDir)) {
  const files = readdirSync(tplDir);
  ok(`存在（${files.length} 个模板文件）`);
} else {
  fail("templates/novel/ 不存在", "git 仓库不完整？重新 clone 或 checkout");
}

// ---------------------------------------------------------------------------
console.log("\n[5/8] LLM API key");
const hasKey = !!(process.env.DEEPSEEK_API_KEY || process.env.PI_API_KEY);
if (hasKey) {
  ok(`已配置（${process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY" : "PI_API_KEY"}）`);
  const model = process.env.PI_MODEL ?? "deepseek-v4-flash（默认）";
  console.log(`     模型: ${model}（可用 PI_MODEL / PI_PLANNER_MODEL / PI_ROLE_MODEL / PI_RENDERER_MODEL 分别覆盖）`);
} else {
  fail("未配置 DEEPSEEK_API_KEY 或 PI_API_KEY", "export DEEPSEEK_API_KEY=sk-...（调度器/角色池/渲染器都需要 LLM）");
}

// ---------------------------------------------------------------------------
console.log("\n[6/8] 向量模型环境（Embedder）");
// transformers.js v2 默认缓存路径是模块所在 node_modules 下的 .cache/（不是 ~/.cache/huggingface）
function hasModelCache(base) {
  const dir = join(base, "node_modules", "@xenova", "transformers", ".cache", "Xenova");
  return existsSync(dir) && readdirSync(dir).length > 0;
}
const hfCache = join(os.homedir(), ".cache", "huggingface", "hub");
const hfCacheExists = existsSync(hfCache) && readdirSync(hfCache).some((d) => d.startsWith("models--"));
if (hasModelCache(repoRoot)) {
  ok("模型已缓存（本仓库 node_modules，embedder 离线回退可用）");
} else if (hfCacheExists) {
  ok("HF 模型缓存存在（~/.cache/huggingface）");
} else if (process.env.HF_ENDPOINT) {
  ok(`未缓存但已配置镜像 HF_ENDPOINT=${process.env.HF_ENDPOINT}`);
} else {
  warn(
    "模型未缓存且未配置镜像：首次向量检索需从 huggingface.co 下载 ~50MB",
    "网络受限时：export HF_ENDPOINT=https://hf-mirror.com（embedder 也有离线回退，但前提是模型已缓存）",
  );
}

// ---------------------------------------------------------------------------
console.log("\n[7/8] pi 宿主版本（扩展 API 兼容性）");
// 扩展 API 由宿主 pi CLI 提供（不是本仓库 node_modules）。
// 兼容矩阵见 docs/SETUP.md §5：已验证 0.77（开发）/ 0.82（最新）API 一致。
{
  const r = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 10000 });
  const ver = (r.stdout ?? "").trim().split(/\s+/).pop();
  if (r.status === 0 && ver) {
    const minor = parseInt(ver.split(".")[1] ?? "0", 10);
    if (minor >= 77) ok(`pi ${ver}（>= 0.77，API 兼容）`);
    else fail(`pi ${ver} 过旧（< 0.77）`, "升级 pi 后重试");
  } else {
    warn("无法探测 pi 版本（pi 不在 PATH 或非交互环境）", "运行时宿主为 pi CLI，要求 >= 0.77；矩阵见 docs/SETUP.md §5");
  }
}

// ---------------------------------------------------------------------------
const novelIdx = process.argv.indexOf("--novel");
if (novelIdx >= 0 && process.argv[novelIdx + 1]) {
  const novelDir = resolve(process.argv[novelIdx + 1]);
  console.log(`\n[8/8] 小说工程结构（${novelDir}）`);
  const checks = [
    ["novel.json", "项目清单（可选但推荐，npm run init 会生成）", "warn"],
    ["规则集.md", "渲染规则集", "warn"],
    ["planner 规则集.md", "planner 规则集", "warn"],
    ["角色规则集.md", "角色规则集", "warn"],
    ["正文", "章节目录", "warn"],
    [join(".pi", "extensions", "narrative-engine", "index.js"), "引擎扩展（npm run sync 同步）", "fail"],
    [join(".pi", "extensions", "narrative-engine", "node_modules"), "扩展依赖（cd 扩展目录 && npm install）", "fail"],
    [join(".pi", "world-graph-v3", "world.db"), "世界图（首次运行自动创建）", "warn"],
  ];
  for (const [rel, desc, level] of checks) {
    if (existsSync(join(novelDir, rel))) ok(`${desc}`);
    else if (level === "fail") fail(`缺 ${rel}：${desc}`);
    else warn(`缺 ${rel}：${desc}`, "可运行 npm run init -- <目录> 重新生成骨架");
  }
  // 扩展目录的向量模型缓存
  const extDir = join(novelDir, ".pi", "extensions", "narrative-engine");
  if (existsSync(extDir)) {
    if (hasModelCache(extDir)) ok("扩展目录模型已缓存（向量检索离线可用）");
    else warn("扩展目录模型未缓存：首次向量检索需下载（可用 HF_ENDPOINT 镜像）");
    // 扩展目录的原生绑定（运行时真正加载的是这里的 node_modules）
    if (existsSync(join(extDir, "node_modules"))) {
      const { createRequire } = await import("node:module");
      const extReq = createRequire(join(extDir, "package.json"));
      for (const pkg of ["better-sqlite3", "sharp", "onnxruntime-node"]) {
        try {
          extReq(pkg);
          ok(`扩展目录 ${pkg} 绑定可加载`);
        } catch {
          fail(
            `扩展目录 ${pkg} 原生绑定缺失（扩展运行时将崩）`,
            `cd ${extDir} && npm rebuild ${pkg}`,
          );
        }
      }
    }
  }
} else {
  console.log("\n[8/8] 小说工程结构（跳过，--novel <目录> 可检查）");
}

// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(50)}`);
if (failures === 0 && warnings === 0) {
  console.log("🎉 全部通过，环境可用");
} else if (failures === 0) {
  console.log(`✅ 可用（${warnings} 个警告，不阻断）`);
} else {
  console.log(`💥 ${failures} 个失败项，${warnings} 个警告——按上方指引修复后重跑`);
}
process.exit(failures > 0 ? 1 : 0);
