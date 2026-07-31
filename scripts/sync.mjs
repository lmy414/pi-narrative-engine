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
 * - 增量同步：只清空目标的 dist/ 和 packages/，重新复制
 * - 保留目标的 node_modules/（首次需手动 npm install，后续无需）
 * - 复制 dist/ 产物、package.json、visualizer-ui/、packages/
 *
 * 设计依据：
 * - dist/index.js 用 bare specifier import underworld-graph 等子包
 * - 子包 package.json 的 exports 指向 ./src/index.ts，由 pi 扩展加载器的 jiti 解析
 * - 因此 packages/ 必须随 dist/ 一起同步到目标
 * - underworld-graph 是外部 npm 包（file: 协议联调），node_modules/underworld-graph 由 sync 直接复制
 */

import { cp, mkdir, rm, readdir, watch, copyFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const srcDir = resolve(repoRoot, "dist");
const srcPackageJson = resolve(repoRoot, "package.json");
const srcPackagesDir = resolve(repoRoot, "packages");
const srcUiDir = resolve(repoRoot, "visualizer-ui");
// 2026-07-29 配置页改造：同步 templates/ 供 @pi/admin 的 resetRuleset 在运行时读取
const srcTemplatesDir = resolve(repoRoot, "templates");

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

/**
 * 安全清空并重建子目录（保留父目录其他内容）
 */
async function freshCopyDir(src, dest) {
	if (existsSync(dest)) {
		await rm(dest, { recursive: true, force: true });
	}
	await mkdir(dest, { recursive: true });
	await cp(src, dest, { recursive: true });
}

/**
 * 列出源目录下所有相对路径（用于精准清理目标根目录的同名条目）
 */
async function listRelativePaths(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		const rel = relative(base, full);
		if (entry.isDirectory()) {
			out.push(rel, ...(await listRelativePaths(full, base)));
		} else {
			out.push(rel);
		}
	}
	return out;
}

/**
 * 把 srcDir 的内容复制到 target 根目录，覆盖同名文件
 * 但不删除 target 下未在 srcDir 出现的条目（保留 node_modules/ 等）
 *
 * 设计：dist 的 .js 文件铺在 target 根目录（与 pi.extensions 入口约定一致），
 * 因此不能 rm -rf 整个 target，否则会清掉 node_modules。
 */
async function replaceDistAtRoot(src, target) {
	// 先清掉旧的 dist 条目（基于 srcDir 当前列表）
	const relPaths = await listRelativePaths(src);
	for (const rel of relPaths) {
		const dest = resolve(target, rel);
		if (existsSync(dest)) {
			await rm(dest, { recursive: true, force: true });
		}
	}
	// 复制新内容
	await cp(src, target, { recursive: true });
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

	// 创建目标根目录（若不存在）
	await mkdir(target, { recursive: true });

	// 1. 复制 dist/ 到 target 根（保留 node_modules/，只覆盖 dist 条目）
	await replaceDistAtRoot(srcDir, target);
	console.log(`[sync] 已同步 ${relative(repoRoot, srcDir)}/ → ${relative(repoRoot, target)}`);

	// 2. 复制 package.json（含 pi.extensions 声明 + workspaces）
	await copyFile(srcPackageJson, resolve(target, "package.json"));
	console.log(`[sync] 已复制 package.json`);

	// 3. 复制 packages/（@pi/* 子包源码，由 jiti 加载）
	if (existsSync(srcPackagesDir)) {
		await freshCopyDir(srcPackagesDir, resolve(target, "packages"));
		console.log(`[sync] 已复制 packages/ → ${relative(repoRoot, resolve(target, "packages"))}`);
	}

	// 3.5 复制 node_modules/underworld-graph（file: 协议联调阶段）
	// 2026-07-31 underworld-graph 独立化：根 package.json 用 file:../underworld-graph，
	// sync 后扩展目录的 file: 路径会断裂（相对路径指向不存在的位置）。
	// 因此 sync 时直接把 node_modules/underworld-graph 复制到目标，让扩展目录无需 npm install 即可用。
	// npm 发布后改为 ^0.1.0，扩展目录 npm install 从 npm 拉取，此段可移除。
	// 注意：file: 协议在 Windows 下 npm 用 Junction 安装，fs.cp 默认尝试重新创建 symlink 会 EPERM，
	// 需用 realpath 解析真实路径后按普通目录复制。
	const srcUnderworldDir = resolve(repoRoot, "node_modules", "underworld-graph");
	if (existsSync(srcUnderworldDir)) {
		const realSrcUnderworldDir = await realpath(srcUnderworldDir);
		const destUnderworldDir = resolve(target, "node_modules", "underworld-graph");
		await freshCopyDir(realSrcUnderworldDir, destUnderworldDir);
		console.log(`[sync] 已复制 node_modules/underworld-graph → ${relative(repoRoot, destUnderworldDir)}`);
	}

	// 4. 复制 visualizer-ui/（可视化前端静态资源）
	if (existsSync(srcUiDir)) {
		await freshCopyDir(srcUiDir, resolve(target, "visualizer-ui"));
		console.log(`[sync] 已复制 visualizer-ui/ → ${relative(repoRoot, resolve(target, "visualizer-ui"))}`);
	}

	// 5. 复制 templates/（@pi/admin 的 resetRuleset 在运行时读取规则集模板）
	if (existsSync(srcTemplatesDir)) {
		await freshCopyDir(srcTemplatesDir, resolve(target, "templates"));
		console.log(`[sync] 已复制 templates/ → ${relative(repoRoot, resolve(target, "templates"))}`);
	}

	// 6. 检查 node_modules 是否已存在
	const targetNodeModules = resolve(target, "node_modules");
	if (!existsSync(targetNodeModules)) {
		console.log(`[sync] 提示：首次同步后请在目标目录运行 \`npm install\` 安装运行时依赖`);
	} else {
		console.log(`[sync] 已保留 node_modules/（如需重装请手动删除后 npm install）`);
	}
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
