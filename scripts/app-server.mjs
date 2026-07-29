#!/usr/bin/env node
/**
 * app-server.mjs — unified-server 独立启动入口（薄壳，模式同 visualizer.mjs）
 *
 * 为什么不是纯 .mjs：服务源码是 TypeScript（import specifier 带 .ts
 * 后缀），node 无法直接加载。本脚本只做参数透传，spawn 仓库内的 tsx
 * 运行 src/app/main.ts，由它完成真正的启动逻辑。
 *
 * 用法：
 *   node scripts/app-server.mjs [--project <dir>] [--port 7421] [--embed]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// 用 node 直接跑 tsx 的 cli.mjs，避免 spawn .cmd（Windows 上需要 shell: true，
// 会触发 DEP0190 参数拼接告警且不利于参数转义）
const tsxCli = resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const entry = resolve(repoRoot, "src", "app", "main.ts");

if (!existsSync(tsxCli)) {
  console.error(`[app-server] 未找到 tsx: ${tsxCli}`);
  console.error("[app-server] 请先在仓库根目录运行 npm install");
  process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
