/**
 * utils.ts — 调度器内部工具函数
 *
 * - randomId：生成短随机 ID（用于 planId / eventId 后缀）
 * - groupBy：按 key 函数分组（commit 函数按 entityId 分组 state_changes 用）
 *
 * 设计原则：纯函数，无副作用，无外部依赖
 */

/**
 * 生成指定长度的随机 ID（小写字母+数字）
 *
 * @param length 长度，缺省 6
 * @returns 随机字符串，如 "a3b2c1"
 */
export function randomId(length = 6): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * 按 key 函数将数组分组为 Map<key, items[]>
 *
 * 用于 commit 阶段按 entityId 分组 state_changes，
 * 每个 entityId 生成一个独立的 change 事件（设计文档决策 #7）。
 *
 * @param arr 输入数组
 * @param keyFn 分组键函数
 * @returns Map<key, items[]>
 */
export function groupBy<T, K>(
  arr: T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) {
      list.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
