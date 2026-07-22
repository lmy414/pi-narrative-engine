#!/usr/bin/env node
/**
 * sync.mjs — 将扩展仓库的 dist/ 产物同步到小说工程的项目级扩展目录。
 *
 * 用法：
 *   node scripts/sync.mjs                 # 单次同步到默认目标
 *   node scripts/sync.mjs --watch         # 监听 dist/ 变化自动同步
 *   node scripts/sync.mjs --target <path> # 指定目标目录
 *
 * 默认目标：../novel/.pi/extensions/narrative-engine
 * （相对于扩展仓库根目录，可通过 --target 覆盖）
 *
 * 同步策略：
 * - 清空目标目录，然后递归复制 dist/ 下所有文件
 * - 复制 package.json（含 pi.extensions 声明 + 运行时依赖）
 * - 不同步 node_modules；目标目录首次需手动 `npm install`
 */

import { cp, mkdir, rm, readdir, watch, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const srcDir = resolve(repoRoot, "dist");
const srcPackageJson = resolve(repoRoot, "package.json");

const defaultTarget = resolve(repoRoot, "..", "novel", ".pi", "extensions", "narrative-engine");

function getTarget() {
	const idx = process.argv.indexOf("--target");
	if (idx >= 0 && process.argv[idx + 1]) {
		return resolve(process.argv[idx + 1]);
	}
	return defaultTarget;
}

function shouldWatch() {
	return process.argv.includes("--watch");
}

async function sync(target) {
	if (!existsSync(srcDir)) {
		console.error(`[sync] 源目录不存在: ${srcDir}`);
		console.error(`[sync] 请先运行 \`npm run build\` 生成 dist/ 产物。`);
		process.exit(1);
	}

	const entries = await readdir(srcDir);
	if (entries.length === 0) {
		console.error(`[sync] 源目录为空: ${srcDir}`);
		console.error(`[sync] 请先运行 \`npm run build\` 生成 dist/ 产物。`);
		process.exit(1);
	}

	// 清空目标目录后重新复制，避免残留旧文件
	if (existsSync(target)) {
		await rm(target, { recursive: true, force: true });
	}
	await mkdir(target, { recursive: true });

	// 复制 dist/ 产物
	await cp(srcDir, target, { recursive: true });

	// 复制 package.json（含 pi.extensions 声明）
	await copyFile(srcPackageJson, resolve(target, "package.json"));

	// 若仓库根存在 visualizer-ui/（可视化前端静态资源），一并复制
	const uiDir = resolve(repoRoot, "visualizer-ui");
	if (existsSync(uiDir)) {
		await cp(uiDir, resolve(target, "visualizer-ui"), { recursive: true });
		console.log(`[sync] 已复制 visualizer-ui/ → ${relative(repoRoot, resolve(target, "visualizer-ui"))}`);
	}

	console.log(`[sync] 已同步 ${relative(repoRoot, srcDir)}/ → ${relative(repoRoot, target)}`);
	console.log(`[sync] 已复制 package.json`);
	console.log(`[sync] 提示：首次同步后请在目标目录运行 \`npm install\` 安装运行时依赖`);
}

async function watchMode(target) {
	console.log(`[sync] watch 模式：监听 ${relative(repoRoot, srcDir)}/ 变化，目标 ${target}`);
	console.log("[sync] 提示：请同时在另一个终端运行 `npm run build -- --watch` 以生成 dist/ 产物");
	await sync(target);
	try {
		const watcher = watch(srcDir, { recursive: true });
		for await (const event of watcher) {
			console.log(`[sync] 检测到变化: ${event.filename ?? "(unknown)"}`);
			await sync(target);
		}
	} catch (err) {
		console.error("[sync] watch 失败:", err);
		process.exit(1);
	}
}

const target = getTarget();
if (shouldWatch()) {
	watchMode(target);
} else {
	sync(target).catch((err) => {
		console.error("[sync] 失败:", err);
		process.exit(1);
	});
}
