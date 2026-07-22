#!/usr/bin/env node
/**
 * build.mjs — 逐文件转译 src/**\/*.ts → dist/**\/*.js
 *
 * 为什么不用 tsc：源码使用 `.ts` 后缀的 import specifier（配合
 * allowImportingTsExtensions），tsc 在该选项下禁止 emit（TS5096）。
 * 运行时由 pi 扩展加载器 / tsx 解析 `.ts` specifier（@pi/world-graph 的
 * exports 也直接指向 src/index.ts），因此构建只需 transpile-only、
 * 保持 specifier 原样 —— 这正是 esbuild transform 的行为。
 *
 * 用法：node scripts/build.mjs [--watch]
 */

import { transform } from "esbuild";
import { readdir, readFile, writeFile, mkdir, rm, watch } from "node:fs/promises";
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

async function compileFile(file) {
  const code = await readFile(file, "utf-8");
  const result = await transform(code, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  const rel = relative(srcDir, file).replace(/\.ts$/, ".js");
  const dest = join(outDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, result.code, "utf-8");
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
