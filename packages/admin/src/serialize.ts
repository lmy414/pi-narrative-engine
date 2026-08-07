// packages/admin/src/serialize.ts
/**
 * serialize.ts — 文件写串行化（🟠-8 2026-08-08）
 *
 * 读-改-写类文件操作（app-config / env-store / novel-json）必须整体串行：
 * 两个并发写若各自基于旧值合并再落盘，后写者覆盖先写者 → 更新静默丢失。
 * 每模块一个队列实例（createWriteQueue 返回值）；fn 串行执行，
 * 单次失败不中断后续（tail 吞掉 rejection）。
 */
export function createWriteQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
