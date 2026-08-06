#!/usr/bin/env node
/**
 * init-novel.mjs — 初始化一个小说工程
 *
 * 用法：
 *   node scripts/init-novel.mjs <目标目录> [--name <项目名>] [--force] [--skip-extension]
 *
 * 做什么（结构定义详见 docs/novel-project-structure.md）：
 *   1. 创建目录骨架：正文/、.pi/extensions/、.pi/world-graph-v3/
 *   2. 复制模板：novel.json（项目清单）、规则集三件套、.gitignore、README.md
 *   3. 缺省同步引擎扩展到 <目录>/.pi/extensions/narrative-engine（--skip-extension 跳过）
 *
 * 幂等：已存在的文件不覆盖（除非 --force）。重复运行安全。
 *
 * 初始化后还需手动一步（原生模块编译，可能耗时数分钟）：
 *   cd <目录>/.pi/extensions/narrative-engine && npm install
 */

import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const templatesDir = resolve(repoRoot, "templates", "novel");

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = { name: null, force: false, skipExtension: false, target: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--name" && argv[i + 1]) args.name = argv[++i];
		else if (a === "--force") args.force = true;
		else if (a === "--skip-extension") args.skipExtension = true;
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
		console.error("用法: node scripts/init-novel.mjs <目标目录> [--name <项目名>] [--force] [--skip-extension]");
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

	// 1. 目录骨架
	console.log("[init] 创建目录骨架…");
	await ensureGitkeep(join(targetDir, "正文"));
	await ensureGitkeep(join(targetDir, ".pi", "extensions"));
	await ensureGitkeep(join(targetDir, ".pi", "world-graph-v3"));

	// 2. 模板文件
	console.log("[init] 复制模板文件…");
	await copyTemplate("novel.json", join(targetDir, "novel.json"), vars, args.force);
	await copyTemplate("规则集.md", join(targetDir, "规则集.md"), vars, args.force);
	await copyTemplate("planner 规则集.md", join(targetDir, "planner 规则集.md"), vars, args.force);
	await copyTemplate("角色规则集.md", join(targetDir, "角色规则集.md"), vars, args.force);
	await copyTemplate("_gitignore", join(targetDir, ".gitignore"), vars, args.force);
	await copyTemplate("README.md", join(targetDir, "README.md"), vars, args.force);

	// 3. 同步引擎扩展（缺省执行）
	if (!args.skipExtension) {
		console.log("[init] 同步引擎扩展…");
		const extTarget = join(targetDir, ".pi", "extensions", "narrative-engine");
		const r = spawnSync(
			process.execPath,
			[resolve(repoRoot, "scripts", "sync.mjs"), "--target", extTarget],
			{ stdio: "inherit" },
		);
		if (r.status !== 0) {
			console.warn("[init] ⚠️ 扩展同步失败（可稍后手动执行 npm run sync --target <dir>）");
		}
	}

	// 4. 下一步指引
	console.log(`
[init] ✅ 初始化完成。

下一步：
  1. 安装扩展依赖（含原生模块编译，可能需数分钟）：
     cd "${join(targetDir, ".pi", "extensions", "narrative-engine")}" && npm install

  2. 启动创作：
     cd "${targetDir}" && pi

  3. 然后直接口述剧情即可。也可以先用 import_novel 导入已有小说。
`);
}

main().catch((err) => {
	console.error("[init] 失败:", err);
	process.exit(1);
});
