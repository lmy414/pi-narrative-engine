/**
 * frontend-demo/demo-utils.js — 页面状态与辅助函数（纯函数）
 *
 * 业务轴：StoryTime（格式 ch<NNN>.ev<NNN>）。
 * 同时兼容浏览器 <script> 与 Node 测试（vm 沙箱 / new Function 注入执行同一份源码）：
 * - 浏览器：window.DemoUtils
 * - Node（module 存在时）：module.exports
 */

// ==================== 视图框架全局对象（从 views.js 迁移，Task 11） ====================
// 各 views/*.js 加载时向这三个对象赋值（覆盖旧实现），app.js 通过它们调度渲染。
// 必须在 views/*.js 之前加载（demo-utils.js 为 index.html 第二个脚本）。
const ViewRender = {};
const ViewAfterRender = {};
const viewLoaders = {};

// 用于 inline event handler 的单引号字符串转义（解决 Windows 路径反斜杠问题）。
// 被 views/projects.js / views/debug.js 引用；
// views/files.js / views/settings.js 各有本地转义函数（flJs / settingsJs），不依赖此函数。
function q(str) {
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && typeof root === 'object') root.DemoUtils = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- StoryTime 比较 ----------

  /**
   * 解析 StoryTime 为 { chapter, event }。
   * 'Infinity' 作为最大值；无效输入按 0 处理。
   * @param {*} st
   * @returns {{chapter: number, event: number}}
   */
  function parseStoryTime(st) {
    if (st === 'Infinity') return { chapter: Infinity, event: Infinity };
    const m = /^ch(\d+)\.ev(\d+)$/i.exec(String(st));
    if (!m) return { chapter: 0, event: 0 };
    return { chapter: Number(m[1]), event: Number(m[2]) };
  }

  /**
   * 比较两个 StoryTime，返回 -1/0/1。
   * 按章节号、事件号比较；无效输入按 0 处理；'Infinity' 为最大值。
   * @param {*} a
   * @param {*} b
   * @returns {-1|0|1}
   */
  function compareStoryTime(a, b) {
    const pa = parseStoryTime(a);
    const pb = parseStoryTime(b);
    if (pa.chapter !== pb.chapter) return pa.chapter < pb.chapter ? -1 : 1;
    if (pa.event !== pb.event) return pa.event < pb.event ? -1 : 1;
    return 0;
  }

  // ---------- 章节分组 ----------

  const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  /**
   * 阿拉伯数字转中文数字（0-9999，如 12 → '十二'）。
   * @param {number} n
   * @returns {string}
   */
  function toChineseNumber(n) {
    n = Math.trunc(n);
    if (!Number.isFinite(n) || n < 0) return String(n);
    if (n === 0) return CN_DIGITS[0];
    const units = ['', '十', '百', '千'];
    const digits = String(n);
    const parts = [];
    let pendingZero = false;
    for (let i = 0; i < digits.length; i++) {
      const d = Number(digits[i]);
      const pos = digits.length - 1 - i; // 0=个位
      if (d === 0) {
        if (pos !== 0) pendingZero = true;
      } else {
        if (pendingZero) { parts.push(CN_DIGITS[0]); pendingZero = false; }
        if (pos === 1 && d === 1 && parts.length === 0) parts.push(units[1]);
        else parts.push(CN_DIGITS[d] + units[pos]);
      }
    }
    return parts.join('');
  }

  /**
   * 从 StoryTime 提取章节号（如 'ch001'），无法解析返回 ''。
   * @param {*} storyTime
   * @returns {string}
   */
  function chapterIdOf(storyTime) {
    const m = /^ch(\d+)\./i.exec(String(storyTime));
    return m ? 'ch' + m[1] : '';
  }

  /**
   * 章节号转数值，用于排序；空值视为无穷大（排最后）。
   * @param {string} chapter
   * @returns {number}
   */
  function chapterNumOf(chapter) {
    const m = /^ch(\d+)$/i.exec(String(chapter));
    return m ? Number(m[1]) : Infinity;
  }

  /**
   * 按章节分组事件，输出 [{ chapter, title, events }]。
   * 章节号按数值升序（稳定）；中文标题如 '第一章'；无章节的事件归入末尾空组。
   * @param {Array} events
   * @returns {Array<{chapter: string, title: string, events: Array}>}
   */
  function groupEventsByChapter(events) {
    const map = new Map();
    for (const ev of events || []) {
      const chapter = chapterIdOf(ev && ev.storyTime);
      if (!map.has(chapter)) map.set(chapter, []);
      map.get(chapter).push(ev);
    }
    return Array.from(map.entries())
      .sort((a, b) => chapterNumOf(a[0]) - chapterNumOf(b[0]))
      .map(([chapter, list]) => ({
        chapter,
        title: chapter ? '第' + toChineseNumber(chapterNumOf(chapter)) + '章' : '',
        events: list
      }));
  }

  // ---------- 事件筛选 ----------

  /**
   * 收集事件关联的实体 ID（事件自身 + newFacts/invalidated 中的实体）。
   * @param {object} event
   * @returns {Array<string>}
   */
  function eventEntityIds(event) {
    const ids = [];
    if (event && event.entityId) ids.push(event.entityId);
    const facts = [].concat((event && event.newFacts) || [], (event && event.invalidated) || []);
    for (const f of facts) {
      if (f && f.entityId && !ids.includes(f.entityId)) ids.push(f.entityId);
    }
    return ids;
  }

  /**
   * 按实体 / 类型 / 关键词筛选事件；全部为空时返回全部。
   * 实体命中事件.entityId 或事件关联实体（newFacts/invalidated）。
   * @param {Array} events
   * @param {{entityIds?: Array, types?: Array, keyword?: string}} [opts]
   * @returns {Array}
   */
  function filterEvents(events, opts) {
    const o = opts || {};
    const entityIds = Array.isArray(o.entityIds) ? o.entityIds : [];
    const types = Array.isArray(o.types) ? o.types : [];
    const keyword = String(o.keyword == null ? '' : o.keyword).trim();
    const hasEntity = entityIds.length > 0;
    const hasType = types.length > 0;
    const hasKeyword = keyword !== '';
    if (!hasEntity && !hasType && !hasKeyword) return events;
    return (events || []).filter(ev => {
      if (hasEntity && !eventEntityIds(ev).some(id => entityIds.includes(id))) return false;
      if (hasType && !types.includes(ev && ev.type)) return false;
      if (hasKeyword && !String((ev && ev.summary) || '').toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }

  // ---------- 会话分组 ----------

  /**
   * 取本地日历日键（'YYYY-M-D'），非法日期返回 null。
   * @param {string} iso
   * @returns {string|null}
   */
  function localDayKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /**
   * 按「今天 / 昨天 / 更早」分组会话（时间取 modified || created，按本地日历日比较）。
   * @param {Array} sessions
   * @param {string} [nowIso] 基准时间 ISO 字符串，缺省为当前时间
   * @returns {{today: Array, yesterday: Array, earlier: Array}}
   */
  function groupSessionsByTime(sessions, nowIso) {
    const now = new Date(nowIso || Date.now());
    const todayKey = localDayKey(now.toISOString());
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = localDayKey(yesterday.toISOString());
    const groups = { today: [], yesterday: [], earlier: [] };
    for (const s of sessions || []) {
      const key = localDayKey(s && (s.modified || s.created));
      if (key === todayKey) groups.today.push(s);
      else if (key === yesterdayKey) groups.yesterday.push(s);
      else groups.earlier.push(s);
    }
    return groups;
  }

  // ---------- 字数统计 ----------

  /**
   * 近似字数：CJK 字符每个算 1 字，连续英文字母/数字序列算 1 词。
   * @param {*} text
   * @returns {number}
   */
  function countWords(text) {
    const s = String(text == null ? '' : text);
    const cjk = (s.match(/[\p{Script=Han}]/gu) || []).length;
    const words = (s.match(/[A-Za-z0-9]+/g) || []).length;
    return cjk + words;
  }

  // ---------- 主题解析 ----------

  /**
   * 解析主题：'light'/'dark' 原样返回；'system' 跟随系统
   * window.matchMedia('(prefers-color-scheme: dark)')，无 matchMedia 时回退 'light'。
   * @param {*} value
   * @returns {'light'|'dark'}
   */
  function resolveTheme(value) {
    if (value === 'dark') return 'dark';
    if (value === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      return mq && mq.matches ? 'dark' : 'light';
    }
    return 'light';
  }

  // ---------- 状态命名空间 ----------

  /**
   * 确保 state[key] 为普通对象并返回（惰性创建；非对象值会被替换为空对象）。
   * @param {object} state
   * @param {string} key
   * @returns {object}
   */
  function namespaceState(state, key) {
    const cur = state[key];
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) state[key] = {};
    return state[key];
  }

  return {
    compareStoryTime,
    groupEventsByChapter,
    filterEvents,
    groupSessionsByTime,
    countWords,
    resolveTheme,
    namespaceState
  };
});
