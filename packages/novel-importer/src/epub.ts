/**
 * epub.ts — EPUB 分章模块（阶段 1）
 *
 * 移植自 V2 narrative-engine/scripts/import-novel-v2.mjs（L100-150）：
 * - htmlToPlainText: HTML 转纯文本
 * - readChaptersFromEpub: 用 epub2 库读取章节
 *
 * 输出：`[{ chapterId, title, content }]`
 *
 * 章节筛选规则（与 V2 一致）：
 * - 优先用 toc.ncx 顺序（更准确），不可用时回退 flow
 * - 跳过文本长度 < 200 的章节（封面/版权页等）
 * - chapterId 从 1 递增
 */

import { EPub } from "epub2";

/**
 * HTML 转纯文本
 *
 * 处理：
 * 1. 移除 <style>/<script> 标签内容
 * 2. 标签转换行
 * 3. HTML 实体反转义
 * 4. 多余空行压缩
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 单章节
 */
export interface Chapter {
  /** 章节序号（1-based，递增） */
  chapterId: number;
  /** 章节标题（来自 toc.ncx 或默认 "第N节"） */
  title: string;
  /** 纯文本内容（已 htmlToPlainText 处理） */
  content: string;
}

/**
 * 从 EPUB 文件读取所有章节
 *
 * @param epubPath EPUB 文件绝对路径
 * @param options 可选配置
 *   - minContentLength: 最小内容长度（默认 200，短于此长度跳过）
 *   - chapterFilter: 限定章节序号（1-based），缺省全部
 * @returns 章节数组（chapterId 从 1 递增）
 */
export async function readChaptersFromEpub(
  epubPath: string,
  options: {
    minContentLength?: number;
    chapterFilter?: number[];
  } = {},
): Promise<Chapter[]> {
  const minLen = options.minContentLength ?? 200;
  const filter = options.chapterFilter
    ? new Set(options.chapterFilter)
    : null;

  // epub2 的类型不完整，用最小类型断言
  const ep = await EPub.createAsync(epubPath);
  const flowSrc = (ep.toc && ep.toc.length > 0) ? ep.toc : (ep.flow || []);
  const chapters: Chapter[] = [];
  // 🟠-17（2026-08-08）：单章读取失败不再静默吞掉——汇总 warn 便于排查
  // （epub2 getChapter 对 manifest 不匹配条目必失败，此前无任何日志）
  const failedChapters: string[] = [];

  for (let i = 0; i < flowSrc.length; i++) {
    const item = flowSrc[i] as { id: string; title?: string };
    const id = item.id;
    let chapterHtml: string;
    try {
      chapterHtml = await new Promise<string>((resolve, reject) => {
        // epub2 的 getChapter 是回调风格
        (ep as unknown as {
          getChapter(id: string, cb: (err: Error | null, text: string) => void): void;
        }).getChapter(id, (err, text) => {
          if (err) reject(err);
          else resolve(text);
        });
      });
    } catch (err) {
      // 单章读取失败跳过，不中断整体流程
      failedChapters.push(`#${i + 1}${item.title ? ` ${item.title}` : ""}（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }

    const text = htmlToPlainText(chapterHtml);
    if (text.length < minLen) continue;

    // 🟠-17：chapterId 用原始目录序号（此前是过滤后序号 chapters.length+1，
    // 短章被跳过或读取失败后用户按原书目录选章会选错）
    const candidateId = i + 1;
    chapters.push({
      chapterId: candidateId,
      title: (item.title || `第${candidateId}节`).trim(),
      content: text,
    });
  }

  // 🟠-17：汇总失败章节（此前静默吞掉）
  if (failedChapters.length > 0) {
    const shown = failedChapters.slice(0, 10).join("；");
    console.warn(
      `[epub] ${failedChapters.length} 章读取失败已跳过: ${shown}${failedChapters.length > 10 ? `；等共 ${failedChapters.length} 章` : ""}`,
    );
  }

  // 应用章节过滤（在收集后过滤，保持 chapterId 与原 EPUB 顺序一致）
  if (filter) {
    return chapters.filter((c) => filter.has(c.chapterId));
  }
  return chapters;
}

/**
 * 并行限流工具（移植自 V2 L156-178）
 *
 * 按指定并发数并行执行异步任务，保持结果顺序与输入一致。
 *
 * @param items 输入数组
 * @param limit 最大并发数
 * @param fn 异步处理函数（接收 item + index，返回结果）
 * @param onProgress 进度回调（done, total）
 * @returns 结果数组（与 items 同序）
 */
export async function parallelWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i]!, i);
        } catch (err) {
          // 与 V2 一致：错误转为 _error 字段（类型断言放宽）
          results[i] = { _error: (err as Error).message } as unknown as R;
        }
        done++;
        if (onProgress) onProgress(done, total);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
