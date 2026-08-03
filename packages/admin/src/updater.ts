// packages/admin/src/updater.ts
/**
 * updater.ts — 本地/远程版本对比（GET /api/admin/version 后端）
 *
 * pure-SDK 架构迁移后，一键更新执行链（runUpdate：git pull + build + sync）
 * 已删除——其 sync 阶段依赖已不存在的 npm run sync（pi 扩展时代产物），
 * 且应用不再有"同步到 .pi/extensions/"的部署形态。
 * 本模块只保留版本对比能力（现有 UI 升级卡片的数据源）。
 *
 * 设计依据：docs/plans/2026-07-29-config-ui-design.md §6.4
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 可 mock 的内部依赖
// ============================================================================

export const _internals: {
  spawn: typeof spawn;
} = { spawn };

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 简易 semver 比较（M16 修复）
 *
 * 仅按 `.` 分隔的数字段逐段比较，避免字典序导致 0.1.10 < 0.1.2 的误判。
 * parseInt 会忽略段内的非数字后缀（如 "2-alpha" → 2），足以处理常见 tag。
 *
 * @returns 负数 a<b，0 相等，正数 a>b
 */
export function _compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  const pb = b.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0);
    const nb = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0);
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * 查询本地与远程版本对比（best-effort）
 *
 * - 本地版本：读 repoRoot/package.json 的 version
 * - 远程版本：git ls-remote origin refs/tags/* 取最新 tag
 * - 远程不可达或超时（默认 5s）时 remoteVersion 为 null
 *
 * 设计依据：docs/plans §6.4 GET /api/admin/version
 * BUG-009 修复：git ls-remote 走网络在弱网下可达 14s+，加 timeoutMs 超时
 * 兜底（kill 子进程并按不可达处理），避免版本检查拖慢设置页。
 */
export async function compareVersions(
  repoRoot: string,
  opts: { timeoutMs?: number } = {},
): Promise<{
  local: string;
  remote: string | null;
  updateAvailable: boolean;
}> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  // 本地版本
  let local = "0.0.0";
  try {
    const pkgRaw = await fs.readFile(join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.version === "string") local = pkg.version;
  } catch {
    // 用 0.0.0 兜底
  }

  // 远程版本：git ls-remote 取 tags（超时 kill 并按不可达处理）
  const remoteVersion = await new Promise<string | null>((resolveVer) => {
    let stdout = "";
    let settled = false;
    const child = _internals.spawn(
      "git",
      ["ls-remote", "--tags", "origin"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolveVer(null);
    }, timeoutMs);
    // 注意：不做 timer.unref()——mock/无 fd 场景下事件循环一旦清空，
    // node:test 会判定 "Promise resolution is still pending" 提前终止
    // （node 22 CI 实测失败）；子进程 stdio 管道本身会保持事件循环活跃。
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveVer(null);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 解析 refs/tags/v0.1.2 形式，取最大版本号
      const tags = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes("refs/tags/"))
        .map((l) => l.replace(/^.*refs\/tags\//, "").replace(/\^\{\}$/, ""))
        // M15 修复：支持 v 前缀 tag（v0.1.2 → 0.1.2）
        .map((t) => t.replace(/^v/, ""))
        .filter((t) => /^\d+\.\d+\.\d+/.test(t));
      if (tags.length === 0) {
        resolveVer(null);
        return;
      }
      // M16 修复：语义化版本比较，避免 0.1.10 < 0.1.2 的字典序错误
      tags.sort(_compareSemver);
      resolveVer(tags[tags.length - 1]);
    });
  });

  return {
    local,
    remote: remoteVersion,
    updateAvailable: remoteVersion !== null && remoteVersion !== local,
  };
}
