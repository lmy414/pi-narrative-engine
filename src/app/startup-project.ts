// src/app/startup-project.ts
/**
 * startup-project.ts — 启动项目解析（"记住但停在入口页"的后端半步）
 *
 * 优先级：--project 命令行参数 > app-config 的 launcher.lastProjectDir。
 * lastProjectDir 恢复失败（目录被删/损坏）只警告不阻断启动。
 */
import { existsSync } from "node:fs";
import type { ProjectRegistry, ProjectHandle } from "./project-registry.ts";

export interface StartupProjectOptions {
  /** 命令行 --project（最高优先级） */
  cliProjectDir?: string | null;
  /** app-config 记住的最近项目（目录不存在时忽略） */
  lastProjectDir?: string | null;
  /** 警告输出（缺省静默） */
  warn?: (msg: string) => void;
}

/**
 * 激活启动项目。返回激活成功的 handle；无可激活目录或激活失败返回 null。
 */
export async function activateStartupProject(
  registry: ProjectRegistry,
  opts: StartupProjectOptions,
): Promise<ProjectHandle | null> {
  const warn = opts.warn ?? (() => {});
  const restored =
    opts.lastProjectDir && existsSync(opts.lastProjectDir) ? opts.lastProjectDir : null;
  const dir = opts.cliProjectDir ?? restored;
  if (!dir) return null;
  try {
    return await registry.setActive(dir, { allowInit: true });
  } catch (err) {
    warn(`激活启动项目失败: ${(err as Error).message}（可稍后经 /api/projects/activate 激活）`);
    return null;
  }
}
