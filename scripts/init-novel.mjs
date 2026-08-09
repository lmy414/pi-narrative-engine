#!/usr/bin/env node
/**
 * init-novel.mjs — 初始化一个小说工程（CLI 脚手架，Web UI 创建等价）
 *
 * 用法：
 *   node scripts/init-novel.mjs <目标目录> [--name <项目名>] [--force]
 *
 * 做什么（结构定义详见 docs/novel-project-structure.md，v3 2026-08-09）：
 *   1. 创建目录骨架：正文/、规则集/、笔记/ 草稿/ 设定/ 大纲/、.pi/world-graph-v3/
 *   2. 复制模板：小说.json（项目清单）、规则集三件（文风/检查/自定义）、.gitignore、README.md
 *
 * 幂等：已存在的文件不覆盖（除非 --force）。重复运行安全。
 * 扩展机制已废弃（pure-SDK 独立应用），不再同步任何扩展。
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const templatesDir = resolve(repoRoot, "templates", "novel");

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = { name: null, force: false, target: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--name" && argv[i + 1]) args.name = argv[++i];
		else if (a === "--force") args.force = true;
		else if (!a.startsWith("--") && !args.target) args.target = a;
	}
	return args;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

async function fileExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * 复制模板文件并做变量替换（{{name}} / {{date}}）
 * 幂等：目标已存在且未 --force 时跳过
 */
async function copyTemplate(srcName, destPath, vars, force) {
	if ((await fileExists(destPath)) && !force) {
		console.log(`  跳过（已存在）: ${destPath}`);
		return false;
	}
	let content = await readFile(resolve(templatesDir, srcName), "utf8");
	for (const [k, v] of Object.entries(vars)) {
		content = content.replaceAll(`{{${k}}}`, v);
	}
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, content, "utf8");
	console.log(`  已创建: ${destPath}`);
	return true;
}

async function ensureGitkeep(dir) {
	await mkdir(dir, { recursive: true });
	const keep = join(dir, ".gitkeep");
	if (!(await fileExists(keep))) {
		await writeFile(keep, "", "utf8");
	}
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.target) {
		console.error("用法: node scripts/init-novel.mjs <目标目录> [--name <项目名>] [--force]");
		process.exit(1);
	}

	const targetDir = resolve(args.target);
	const projectName = args.name ?? basename(targetDir);
	// M24 修复：engineVersion 与 package.json 同源，避免模板硬编码过期版本
	const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
	const vars = {
		name: projectName,
		date: new Date().toISOString().slice(0, 10),
		engineVersion: pkg.version ?? "0.0.0",
	};

	console.log(`[init] 目标目录: ${targetDir}`);
	console.log(`[init] 项目名: ${projectName}`);

	if (!existsSync(templatesDir)) {
		console.error(`[init] 模板目录不存在: ${templatesDir}`);
		process.exit(1);
	}

	// 1. 目录骨架（v3：正文/ 规则集/ 内容区域 + 运行时数据）
	console.log("[init] 创建目录骨架…");
	await ensureGitkeep(join(targetDir, "正文"));
	await ensureGitkeep(join(targetDir, "规则集"));
	for (const area of ["笔记", "草稿", "设定", "大纲"]) {
		await ensureGitkeep(join(targetDir, area));
	}
	await ensureGitkeep(join(targetDir, ".pi", "world-graph-v3"));

	// 2. 模板文件（v3：小说.json + 规则集三件 + .gitignore + README）
	console.log("[init] 复制模板文件…");
	await copyTemplate("小说.json", join(targetDir, "小说.json"), vars, args.force);
	await copyTemplate(join("规则集", "文风规则.md"), join(targetDir, "规则集", "文风规则.md"), vars, args.force);
	await copyTemplate(join("规则集", "检查规则.md"), join(targetDir, "规则集", "检查规则.md"), vars, args.force);
	await copyTemplate(join("规则集", "自定义规则.md"), join(targetDir, "规则集", "自定义规则.md"), vars, args.force);
	await copyTemplate("_gitignore", join(targetDir, ".gitignore"), vars, args.force);
	await copyTemplate("README.md", join(targetDir, "README.md"), vars, args.force);

	// 3. 下一步指引
	console.log(`
[init] ✅ 初始化完成。

下一步：
  1. 启动服务（pure-SDK 独立应用，无需扩展安装）：
     cd ${resolve(repoRoot)} && node scripts/app-server.mjs --project "${targetDir}"

  2. 浏览器访问 http://127.0.0.1:7421，激活本项目后直接口述剧情。
`);
}

main().catch((err) => {
	console.error("[init] 失败:", err);
	process.exit(1);
});
