#!/usr/bin/env node
/**
 * build.mjs — 逐文件转译 src/**\/*.ts → dist/**\/*.js
 *
 * 为什么不用 tsc：源码使用 `.ts` 后缀的 import specifier（配合
 * allowImportingTsExtensions），tsc 在该选项下禁止 emit（TS5096）。
 * 因此构建用 esbuild transform-only。
 *
 * 关键：把 `.ts` specifier 重写为 `.js`，让产物可被标准 Node ESM resolver
 * 直接加载（pi 扩展加载器不一定走 jiti，保持 specifier 原样会导致
 * `Cannot find module './foo.ts'` 错误）。
 *
 * 注意：bare specifier（如 `underworld-graph`、`@earendil-works/pi-ai`）
 * 不重写，由 Node 标准解析 + 包的 exports 字段处理。
 *
 * 用法：node scripts/build.mjs [--watch]
 */

import { transform } from "esbuild";
import { readdir, readFile, writeFile, mkdir, rm, watch, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const srcDir = resolve(repoRoot, "src");
const outDir = resolve(repoRoot, "dist");

async function listTsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(p)));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * 把相对路径 import specifier 中的 .ts 重写为 .js
 * - `from "./foo.ts"` → `from "./foo.js"`
 * - `from "./foo"` 不变（让 resolver 自己加扩展）
 * - `from "underworld-graph"` 等 bare specifier 不变
 */
function rewriteTsSpecifiers(code) {
  // 匹配 import ... from "..." / export ... from "..."
  // 仅处理以 ./ 或 ../ 开头的相对路径，且以 .ts 结尾的
  return code.replace(
    /((?:import|export)[^"]*from\s+["'])(\.{1,2}\/[^"']*\.ts)(["'])/g,
    (full, prefix, spec, quote) => `${prefix}${spec.replace(/\.ts$/, ".js")}${quote}`,
  );
}

async function compileFile(file) {
  const code = await readFile(file, "utf-8");
  const result = await transform(code, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  const rewritten = rewriteTsSpecifiers(result.code);
  const rel = relative(srcDir, file).replace(/\.ts$/, ".js");
  const dest = join(outDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, rewritten, "utf-8");
  return rel;
}

async function build() {
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files = await listTsFiles(srcDir);
  for (const f of files) {
    const rel = await compileFile(f);
    console.log(`[build] ${rel}`);
  }
  // 复制非 TS 资产（skills/*/SKILL.md 由 pi skill 加载机制读取）
  // 运行时通过 import.meta.url 相对 dist/index.js 定位 SKILLS_DIR，必须随产物一起输出
  const srcSkillsDir = join(srcDir, "skills");
  if (existsSync(srcSkillsDir)) {
    await cp(srcSkillsDir, join(outDir, "skills"), { recursive: true });
    console.log(`[build] skills/ 资产已复制`);
  }
  // 从 docs/ 精选机制/排错相关文档 → dist/skills/narrative-engine/references/
  // 设计：源码层面 docs/ 是唯一源（不新增冗余），构建时复制到 skill 目录下
  // 让 LLM 在机制不清楚或工具报错时能 read references/*.md 自助排错
  // 精选标准：工具 API / 机制设计 / 已知修复记录；过滤 legacy / audits 历史快照 / 用户向文档
  const docsDir = join(repoRoot, "docs");
  const refsDir = join(outDir, "skills", "narrative-engine", "references");
  if (existsSync(docsDir)) {
    await mkdir(refsDir, { recursive: true });
    const docsToInclude = [
      // api.md 已拆分为 docs/api/ 多文档（2026-07-31），整目录复制
      "api",
      "novel-project-structure.md",
      "plans/2026-07-25-scheduler-design.md",
      "plans/2026-07-24-role-pool-design.md",
      "plans/2026-07-24-renderer.md",
      "audits/2026-07-27-fix-plan.md",
    ];
    for (const rel of docsToInclude) {
      const src = join(docsDir, rel);
      if (existsSync(src)) {
        const dest = join(refsDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await cp(src, dest, { recursive: true });
      } else {
        console.warn(`[build] 文档缺失，跳过: ${rel}`);
      }
    }
    console.log(`[build] references/ 已复制 ${docsToInclude.length} 个文档`);
  }
  console.log(`[build] 完成：${files.length} 个文件 → ${relative(repoRoot, outDir)}/`);
}

if (process.argv.includes("--watch")) {
  await build();
  console.log(`[build] watch 模式：监听 ${relative(repoRoot, srcDir)}/`);
  const watcher = watch(srcDir, { recursive: true });
  for await (const event of watcher) {
    if (event.filename && event.filename.endsWith(".ts")) {
      try {
        const rel = await compileFile(join(srcDir, event.filename));
        console.log(`[build] ${rel}`);
      } catch (err) {
        console.error("[build] 编译失败:", err);
      }
    }
  }
} else {
  build().catch((err) => {
    console.error("[build] 失败:", err);
    process.exit(1);
  });
}
