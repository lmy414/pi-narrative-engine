#!/usr/bin/env node
/**
 * package-sidecar.mjs — 把 unified-server 打包为 Tauri sidecar 资源（阶段 5）
 *
 * 布局（与 tauri-app/src-tauri/src/sidecar.rs 的 spawn_prod 对应）：
 *   <out>/runtime/node[.exe]     内置 Node 运行时（复制当前 process.execPath）
 *   <out>/server/main.js         esbuild 打包产物（TS/子包全部内联）
 *   <out>/server/node_modules/   运行时依赖（npm install --omit=dev）
 *                                含原生模块 better-sqlite3 / sqlite-vec / onnxruntime-node
 *   <out>/server/frontend-demo/  前端静态资源
 *   <out>/server/templates/      规则集模板
 *
 * 用法：
 *   node scripts/package-sidecar.mjs [--out <dir>] [--skip-install]
 *
 * - --out            输出目录，默认 tauri-app/src-tauri/resources
 * - --skip-install   跳过 npm install（离线验证 bundle 用，node_modules 不生成）
 *
 * 跨平台注意：node_modules 含原生绑定，必须在目标平台/目标 Node 大版本上
 * 执行本脚本（CI 按平台跑）。Windows 产物不可直接分发到 macOS/Linux。
 */

import { spawnSync } from "node:child_process";
import {
  cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

/** 运行时外部依赖（不打包，进 server/node_modules）
 *  仅列 bundle 实际引用的：原生三件套 + 向量库；
 *  epub2/sharp/pi-ai 不在 unified-server 依赖图内（sharp 由 @xenova/transformers 传递引入） */
const EXTERNALS = [
  "better-sqlite3",
  "sqlite-vec",
  "onnxruntime-node",
  "@xenova/transformers",
];

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {
    out: resolve(repoRoot, "tauri-app", "src-tauri", "resources"),
    skipInstall: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) args.out = resolve(argv[++i]);
    else if (argv[i] === "--skip-install") args.skipInstall = true;
  }
  return args;
}

function depVersion(name) {
  try {
    // 先试 package.json 直解（部分包 exports 不暴露 ./package.json）
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [repoRoot] });
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    try {
      // 回退：解析主入口后向上找最近的 package.json
      let dir = dirname(require.resolve(name, { paths: [repoRoot] }));
      for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, "utf8"));
          if (pkg.name === name || pkg.name === name.split("/").pop()) return pkg.version;
        }
        dir = dirname(dir);
      }
    } catch {
      // 包不存在，跳过
    }
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const serverDir = join(args.out, "server");
  const runtimeDir = join(args.out, "runtime");

  console.log(`[package] 输出目录: ${args.out}`);
  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  // 1. esbuild 打包：src/app/main.ts → server/main.js
  //    所有 src/* 与 @pi/* 子包 TS 源码内联；原生/大型依赖保持外部
  console.log("[package] esbuild 打包 src/app/main.ts …");
  await esbuild.build({
    entryPoints: [resolve(repoRoot, "src", "app", "main.ts")],
    outfile: join(serverDir, "main.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: false,
    // M-Qual-7：混淆剥离注释（此前 minify: false 暴露内部实现细节）
    minify: true,
    external: EXTERNALS,
    logLevel: "info",
  });

  // 2. server/package.json + npm install --omit=dev
  const deps = {};
  for (const name of EXTERNALS) {
    const v = depVersion(name);
    if (v) deps[name] = v;
  }
  writeFileSync(
    join(serverDir, "package.json"),
    JSON.stringify({ name: "narrative-engine-server", private: true, type: "module", dependencies: deps }, null, 2) + "\n",
  );
  console.log(`[package] server/package.json 依赖: ${Object.keys(deps).join(", ")}`);

  if (!args.skipInstall) {
    console.log("[package] npm install --omit=dev（原生模块按本平台解析）…");
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(cmd, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: serverDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.error) {
      console.error(`[package] npm install 启动失败: ${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`[package] npm install 失败（退出码 ${r.status}）`);
      process.exit(1);
    }
  } else {
    console.log("[package] 跳过 npm install（--skip-install）");
  }

  // 3. 前端与模板资源（前端统一为 frontend-demo；旧版 visualizer-ui 已删除）
  cpSync(resolve(repoRoot, "frontend-demo"), join(serverDir, "frontend-demo"), { recursive: true });
  cpSync(resolve(repoRoot, "templates"), join(serverDir, "templates"), { recursive: true });
  console.log("[package] 已复制 frontend-demo/ 与 templates/");

  // 4. 内置 Node 运行时（当前平台；CI 应按平台下载对应 Node 发行版）
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  copyFileSync(process.execPath, join(runtimeDir, nodeName));
  console.log(`[package] 已复制 Node 运行时: ${process.version} → runtime/${nodeName}`);

  console.log("[package] 完成。目录结构:");
  console.log(`  ${join(args.out, "runtime", nodeName)}`);
  console.log(`  ${join(serverDir, "main.js")}`);
  console.log(`  ${join(serverDir, "node_modules")}${args.skipInstall ? "（未生成）" : ""}`);
}

main().catch((err) => {
  console.error("[package] 失败:", err);
  process.exit(1);
});
