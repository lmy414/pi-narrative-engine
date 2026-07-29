// packages/admin/src/updater.ts
/**
 * updater.ts — 扩展一键更新（git pull + build + sync）
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §5.3.5 / §6.4 / §8.3
 *
 * 流程：
 * 1. check：working tree clean 检查（不干净则报错，避免 pull 冲突）
 * 2. pull：git pull origin master
 * 3. build：npm run build
 * 4. sync：npm run sync -- --target <extensionDir>
 *
 * 通过 async generator 流式产出 UpdateEvent，调用方（HTTP SSE / CLI）
 * 逐行消费并转发给前端。
 *
 * 并发控制（设计 §8.3）：同一时刻只允许一个 update job，
 * 由调用方（HTTP 路由层）用 jobId 锁实现，本模块不内置锁。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { AdminError } from "./types.ts";

// ============================================================================
// 类型
// ============================================================================

/** 更新阶段 */
export type UpdateStage = "check" | "pull" | "build" | "sync" | "done" | "error";

/** 单条更新事件（对应 SSE 的一行） */
export interface UpdateEvent {
  /** 当前阶段 */
  stage: UpdateStage;
  /** 输出的一行文本（stdout/stderr 行级转发） */
  line: string;
  /** 阶段是否结束（每个阶段最后一条事件 done=true） */
  done?: boolean;
  /** 错误信息（stage=error 时） */
  error?: string;
}

/** runUpdate 选项 */
export interface UpdateOptions {
  /** 扩展仓库根目录（narrative-engine/） */
  repoRoot: string;
  /** 同步目标目录（<novelDir>/.pi/extensions/narrative-engine） */
  targetDir: string;
  /** git 远程分支，默认 "origin master" */
  remote?: string;
  /** 是否跳过 working tree clean 检查（危险，默认 false） */
  skipCleanCheck?: boolean;
}

// ============================================================================
// 可 mock 的内部依赖
// ============================================================================

export const _internals: {
  spawn: typeof spawn;
} = { spawn };

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 检查 working tree 是否干净
 * - git status --porcelain 输出为空 = 干净
 * - 非干净时返回脏文件列表
 */
export async function _checkWorkingTreeClean(repoRoot: string): Promise<{
  clean: boolean;
  dirtyFiles: string[];
}> {
  return new Promise((resolveCheck, reject) => {
    let stdout = "";
    let stderr = "";
    const child = _internals.spawn(
      "git",
      ["status", "--porcelain"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new AdminError(`git status 启动失败: ${err.message}`, "GIT_SPAWN_FAILED")),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new AdminError(
            `git status 退出码 ${code}（stderr: ${stderr.trim().slice(0, 200)}）`,
            "GIT_STATUS_FAILED",
          ),
        );
        return;
      }
      const dirtyFiles = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      resolveCheck({ clean: dirtyFiles.length === 0, dirtyFiles });
    });
  });
}

/**
 * 执行单个命令，行级转发 stdout/stderr
 *
 * @returns 退出码；通过 yield 转发每行输出
 */
async function _runCommand(
  args: { cmd: string; args: string[]; cwd: string; stage: UpdateStage },
  emit: (event: UpdateEvent) => void,
): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = _internals.spawn(args.cmd, args.args, {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stderrTail = "";
    const lineBuffer = (stream: NodeJS.ReadableStream, isStderr: boolean) => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          emit({
            stage: args.stage,
            line: isStderr ? `[stderr] ${line}` : line,
          });
          if (isStderr) stderrTail = line;
        }
      });
    };
    if (child.stdout) lineBuffer(child.stdout, false);
    if (child.stderr) lineBuffer(child.stderr, true);
    child.on("error", (err) => {
      reject(
        new AdminError(
          `${args.cmd} 启动失败: ${err.message}`,
          "COMMAND_SPAWN_FAILED",
        ),
      );
    });
    child.on("close", (code) => {
      // flush 残留 buffer
      resolveRun(code ?? 1);
    });
  });
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 执行一键更新（async generator 流式输出）
 *
 * 用法（CLI）：
 * ```ts
 * for await (const ev of runUpdate(opts)) {
 *   console.log(`[${ev.stage}] ${ev.line}`);
 * }
 * ```
 *
 * 用法（HTTP SSE）：路由层遍历 generator，每个 event 写一行 `data: JSON\n\n`。
 *
 * 失败时：stage="error"，error 字段含原因，generator 结束。
 * 成功时：stage="done"，generator 结束。
 */
export async function* runUpdate(
  options: UpdateOptions,
): AsyncGenerator<UpdateEvent, void, void> {
  const { repoRoot, targetDir, remote = "origin master", skipCleanCheck = false } = options;

  // 校验 repoRoot 存在
  if (!existsSync(join(repoRoot, ".git"))) {
    yield {
      stage: "error",
      line: "",
      error: `非 git 仓库: ${repoRoot}`,
    };
    return;
  }

  // 阶段 1：working tree clean 检查
  if (!skipCleanCheck) {
    yield { stage: "check", line: "检查 working tree 是否干净…" };
    try {
      const { clean, dirtyFiles } = await _checkWorkingTreeClean(repoRoot);
      if (!clean) {
        yield {
          stage: "error",
          line: "",
          error: `working tree 非干净，请先 commit 或 stash：\n${dirtyFiles.slice(0, 10).join("\n")}${dirtyFiles.length > 10 ? `\n（共 ${dirtyFiles.length} 个文件）` : ""}`,
        };
        return;
      }
      yield { stage: "check", line: "working tree 干净", done: true };
    } catch (err) {
      yield {
        stage: "error",
        line: "",
        error: (err as Error).message,
      };
      return;
    }
  }

  // 阶段 2：git pull
  yield { stage: "pull", line: `git pull ${remote}` };
  const pullQueue: UpdateEvent[] = [];
  const pullCode = await _runCommand(
    { cmd: "git", args: ["pull", ...remote.split(" ")], cwd: repoRoot, stage: "pull" },
    (ev) => pullQueue.push(ev),
  );
  for (const ev of pullQueue) yield ev;
  if (pullCode !== 0) {
    yield {
      stage: "error",
      line: "",
      error: `git pull 退出码 ${pullCode}`,
    };
    return;
  }
  yield { stage: "pull", line: "git pull 完成", done: true };

  // 阶段 3：npm run build
  yield { stage: "build", line: "npm run build" };
  const buildQueue: UpdateEvent[] = [];
  const buildCode = await _runCommand(
    { cmd: "npm", args: ["run", "build"], cwd: repoRoot, stage: "build" },
    (ev) => buildQueue.push(ev),
  );
  for (const ev of buildQueue) yield ev;
  if (buildCode !== 0) {
    yield {
      stage: "error",
      line: "",
      error: `npm run build 退出码 ${buildCode}`,
    };
    return;
  }
  yield { stage: "build", line: "build 完成", done: true };

  // 阶段 4：npm run sync -- --target <targetDir>
  yield { stage: "sync", line: `npm run sync -- --target ${targetDir}` };
  const syncQueue: UpdateEvent[] = [];
  const syncCode = await _runCommand(
    { cmd: "npm", args: ["run", "sync", "--", "--target", targetDir], cwd: repoRoot, stage: "sync" },
    (ev) => syncQueue.push(ev),
  );
  for (const ev of syncQueue) yield ev;
  if (syncCode !== 0) {
    yield {
      stage: "error",
      line: "",
      error: `npm run sync 退出码 ${syncCode}`,
    };
    return;
  }
  yield { stage: "sync", line: "sync 完成", done: true };

  // 完成
  yield {
    stage: "done",
    line: "更新完成，请在 pi 会话内执行 /reload 重新加载扩展",
    done: true,
  };
}

/**
 * 查询本地与远程版本对比（best-effort）
 *
 * - 本地版本：读 repoRoot/package.json 的 version
 * - 远程版本：git ls-remote origin refs/tags/* 取最新 tag
 * - 远程不可达时 remoteVersion 为 null
 *
 * 设计依据：docs/plans §6.4 GET /api/admin/version
 */
export async function compareVersions(repoRoot: string): Promise<{
  local: string;
  remote: string | null;
  updateAvailable: boolean;
}> {
  // 本地版本
  let local = "0.0.0";
  try {
    const pkgRaw = await fs.readFile(join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.version === "string") local = pkg.version;
  } catch {
    // 用 0.0.0 兜底
  }

  // 远程版本：git ls-remote 取 tags
  const remoteVersion = await new Promise<string | null>((resolveVer) => {
    let stdout = "";
    let settled = false;
    const child = _internals.spawn(
      "git",
      ["ls-remote", "--tags", "origin"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolveVer(null);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      // 解析 refs/tags/v0.1.2 形式，取最大版本号
      const tags = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes("refs/tags/"))
        .map((l) => l.replace(/^.*refs\/tags\//, "").replace(/\^\{\}$/, ""))
        .filter((t) => /^\d+\.\d+\.\d+/.test(t));
      if (tags.length === 0) {
        resolveVer(null);
        return;
      }
      // 简单字典序比较（语义版本格式一致时等价于版本比较）
      tags.sort();
      resolveVer(tags[tags.length - 1]);
    });
  });

  return {
    local,
    remote: remoteVersion,
    updateAvailable: remoteVersion !== null && remoteVersion !== local,
  };
}
