/* proto-utils.js — 原型体系新页面的纯函数工具（无 DOM 依赖，可 node 测试）
 *
 * 双导出：浏览器挂 window.V3.putil；node 测试经 module.exports 引用。
 * 包含：文件树拍平、字节/时间格式化、迷你 markdown 渲染（文件编辑器预览用）。
 * 迷你渲染器按 §11.3 约束实现：不引 marked.js，覆盖标题/加粗/斜体/行内码/
 * 代码块/引用/列表/分割线/链接/段落，输出前整体 HTML 转义，无 XSS 面。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.V3 = root.V3 || {};
    root.V3.putil = mod;
  }
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /* 文件树拍平为缩进列表（编辑器侧栏渲染用）
   * 输入 listFileTree 的嵌套结构，输出 [{ path, kind, depth, name }] 深度优先 */
  function flattenFileTree(nodes, depth, out) {
    out = out || [];
    depth = depth || 0;
    (nodes || []).forEach(function (n) {
      var name = n.path.split("/").pop();
      out.push({ path: n.path, kind: n.kind, depth: depth, name: name, mtime: n.mtime, size: n.size });
      if (n.children && n.children.length) flattenFileTree(n.children, depth + 1, out);
    });
    return out;
  }

  /* 字节格式化：1024 → "1.0 KB" */
  function formatBytes(n) {
    if (typeof n !== "number" || isNaN(n) || n < 0) return "-";
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB"];
    var v = n;
    var u = -1;
    do { v = v / 1024; u++; } while (v >= 1024 && u < units.length - 1);
    return v.toFixed(1) + " " + units[u];
  }

  /* ISO 时间 → "YYYY-MM-DD HH:mm"（本地时区），非法输入原样返回 */
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    function p2(x) { return (x < 10 ? "0" : "") + x; }
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
      " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
  }

  /* HTML 转义 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 链接协议白名单（🔴-10 修复）：仅放行 http/https/mailto。
   * 先 percent-decode 并剥离 C0 控制符/空白再提取 scheme，防止
   * java%73cript: / jav\tascript: / data:text/html 等绕过黑名单正则。 */
  function safeLinkHref(href) {
    var decoded;
    try { decoded = decodeURIComponent(href); } catch (e) { decoded = href; }
    var cleaned = String(decoded).replace(/[\u0000-\u0020\u007f]+/g, "");
    var m = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (m && !/^(https?|mailto)$/i.test(m[1])) return null;
    return href;
  }

  /* 行内 markdown：**粗** *斜* `码` [文](url) */
  function renderInline(text) {
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      var href = safeLinkHref(u);
      if (href === null) return escapeHtml(t); // 危险协议：保留文字，不生成链接
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    return s;
  }

  /* 迷你 markdown 渲染：输出 HTML 字符串（先整体转义再还愿行内元素，无 XSS 面） */
  function renderMarkdown(md) {
    var lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var i = 0;
    var listType = null; // "ul" | "ol" | null
    function closeList() {
      if (listType) { html.push("</" + listType + ">"); listType = null; }
    }
    while (i < lines.length) {
      var line = lines[i];
      // 代码块 ```
      if (/^```/.test(line)) {
        closeList();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过收尾 ```
        html.push("<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }
      // 标题
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        var level = h[1].length;
        html.push("<h" + level + ">" + renderInline(h[2]) + "</h" + level + ">");
        i++;
        continue;
      }
      // 分割线
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        closeList();
        html.push("<hr>");
        i++;
        continue;
      }
      // 引用
      if (/^>\s?/.test(line)) {
        closeList();
        var qbuf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        html.push("<blockquote>" + qbuf.map(renderInline).join("<br>") + "</blockquote>");
        continue;
      }
      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; }
        html.push("<li>" + renderInline(line.replace(/^\s*[-*+]\s+/, "")) + "</li>");
        i++;
        continue;
      }
      // 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listType !== "ol") { closeList(); html.push("<ol>"); listType = "ol"; }
        html.push("<li>" + renderInline(line.replace(/^\s*\d+\.\s+/, "")) + "</li>");
        i++;
        continue;
      }
      // 空行
      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }
      // 段落（合并连续普通行）
      closeList();
      var pbuf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i])) {
        pbuf.push(lines[i]);
        i++;
      }
      html.push("<p>" + pbuf.map(renderInline).join("<br>") + "</p>");
    }
    closeList();
    return html.join("\n");
  }

  /* 字数统计（编辑器状态栏）：非空白字符数 */
  function countChars(text) {
    var m = String(text || "").replace(/\s/g, "");
    return m.length;
  }

  return {
    flattenFileTree: flattenFileTree,
    formatBytes: formatBytes,
    formatDateTime: formatDateTime,
    escapeHtml: escapeHtml,
    renderMarkdown: renderMarkdown,
    countChars: countChars
  };
});
