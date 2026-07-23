/**
 * storytime.ts — storyTime 命名规范工具函数
 *
 * storyTime 格式：`ch{chapter:03d}.ev{event:03d}`
 *
 * 核心约束（spec L207-218）：
 * - 字符串字典序 = 故事时间序（bi-temporal 查询依赖字符串比较）
 * - 章节号 3 位零填充（支持 ≤999 章）
 * - 事件序号 3 位零填充（每章 ≤999 事件）
 * - 跨章节自然递增：ch001.ev007 < ch002.ev001 ✓
 *
 * 多事件共享 storyTime：bi-temporal 模型允许同一 storyTime 有多个事件
 * （birth + change 同时发生），事件先后由 causedBy 表达。
 */

/** storyTime 正则（严格 3 位零填充） */
export const STORY_TIME_REGEX = /^ch\d{3}\.ev\d{3}$/;

/** 最大章节号（3 位零填充上限） */
export const MAX_CHAPTER = 999;

/** 每章最大事件号（3 位零填充上限） */
export const MAX_EVENT_PER_CHAPTER = 999;

/** storyTime 解析结果 */
export interface StoryTimeParts {
  chapter: number;
  event: number;
}

/**
 * 格式化为 storyTime 字符串
 *
 * @param chapter 章节号（1-999）
 * @param event 事件序号（1-999）
 * @returns storyTime 字符串，如 "ch001.ev001"
 * @throws RangeError 当 chapter 或 event 超出 [1, 999] 范围
 */
export function formatStoryTime(chapter: number, event: number): string {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > MAX_CHAPTER) {
    throw new RangeError(
      `chapter must be integer in [1, ${MAX_CHAPTER}], got: ${chapter}`,
    );
  }
  if (!Number.isInteger(event) || event < 1 || event > MAX_EVENT_PER_CHAPTER) {
    throw new RangeError(
      `event must be integer in [1, ${MAX_EVENT_PER_CHAPTER}], got: ${event}`,
    );
  }
  const ch = String(chapter).padStart(3, "0");
  const ev = String(event).padStart(3, "0");
  return `ch${ch}.ev${ev}`;
}

/**
 * 解析 storyTime 字符串
 *
 * @param s storyTime 字符串，如 "ch001.ev001"
 * @returns 解析结果 { chapter, event }
 * @throws Error 当字符串不符合 `^ch\d{3}\.ev\d{3}$` 格式，或 chapter/event 超出 [1, 999] 范围
 */
export function parseStoryTime(s: string): StoryTimeParts {
  if (!STORY_TIME_REGEX.test(s)) {
    throw new Error(
      `Invalid storyTime format (expected ch\\d{3}\\.ev\\d{3}): ${s}`,
    );
  }
  const chapter = parseInt(s.slice(2, 5), 10);
  const event = parseInt(s.slice(8, 11), 10);
  // 范围校验：ch000.ev000 / ch001.ev000 等都是语义非法
  if (chapter < 1 || chapter > MAX_CHAPTER) {
    throw new Error(`storyTime chapter out of range [1, ${MAX_CHAPTER}]: ${s}`);
  }
  if (event < 1 || event > MAX_EVENT_PER_CHAPTER) {
    throw new Error(
      `storyTime event out of range [1, ${MAX_EVENT_PER_CHAPTER}]: ${s}`,
    );
  }
  return { chapter, event };
}

/**
 * 校验字符串是否为合法 storyTime
 */
export function isValidStoryTime(s: string): boolean {
  if (!STORY_TIME_REGEX.test(s)) return false;
  try {
    parseStoryTime(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算下一个 storyTime
 *
 * - 同章内 event+1（如 ch001.ev001 → ch001.ev002）
 * - 跨章：event 超过 999 时进入下一章 event=1（如 ch001.ev999 → ch002.ev001）
 * - 超过最大章节号时抛错（如 ch999.ev999 无下一个）
 *
 * @param s 当前 storyTime
 * @returns 下一个 storyTime
 * @throws Error 当字符串非法或已到上限
 */
export function nextStoryTime(s: string): string {
  const { chapter, event } = parseStoryTime(s);
  if (event < MAX_EVENT_PER_CHAPTER) {
    return formatStoryTime(chapter, event + 1);
  }
  // event 已到 999，进入下一章
  if (chapter >= MAX_CHAPTER) {
    throw new Error(`storyTime already at maximum: ${s}`);
  }
  return formatStoryTime(chapter + 1, 1);
}

/**
 * 比较两个 storyTime 的字典序（等价于故事时间序）
 *
 * @param a storyTime a
 * @param b storyTime b
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareStoryTime(a: string, b: string): number {
  // 字符串字典序 = 故事时间序（因 3 位零填充）
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
