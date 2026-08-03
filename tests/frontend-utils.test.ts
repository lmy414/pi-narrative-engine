/**
 * frontend-utils.test.ts — visualizer-ui/proto-utils.js 纯函数测试
 *
 * proto-utils.js 是 UMD 双导出（window.V3.putil / module.exports），
 * 本测试经 default import 引用其纯函数：
 * - flattenFileTree: 嵌套树 → 深度优先缩进列表
 * - formatBytes / formatDateTime: 边界与格式化
 * - renderMarkdown: 标题/列表/代码块/引用/行内元素/XSS 转义
 * - countChars: 非空白字符计数
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// proto-utils.js 是浏览器 script 标签加载的 UMD 纯 JS（根 package 为 ESM，
// 直接 import/require 都拿不到导出），测试用 Function 注入 module/window 执行
const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, "..", "visualizer-ui", "proto-utils.js"), "utf8");
const fakeModule = { exports: {} as any };
const fakeWindow: Record<string, any> = {};
new Function("module", "exports", "window", code)(fakeModule, fakeModule.exports, fakeWindow);
const U = (fakeModule.exports && Object.keys(fakeModule.exports).length)
  ? fakeModule.exports
  : fakeWindow.V3.putil;

// ============ flattenFileTree ============

test("flattenFileTree: 深度优先拍平并携带 depth/name", () => {
  const tree = [
    {
      path: "设定", kind: "dir", size: null, mtime: null,
      children: [
        { path: "设定/角色", kind: "dir", size: null, mtime: null, children: [
          { path: "设定/角色/主角.md", kind: "file", size: 10, mtime: "2026-07-29T00:00:00Z" },
        ] },
      ],
    },
    { path: "正文", kind: "dir", size: null, mtime: null, children: [
      { path: "正文/ch001.md", kind: "file", size: 5, mtime: "2026-07-29T00:00:00Z" },
    ] },
  ];
  const flat = U.flattenFileTree(tree);
  assert.deepEqual(
    flat.map((n: any) => `${n.depth}:${n.kind}:${n.name}`),
    ["0:dir:设定", "1:dir:角色", "2:file:主角.md", "0:dir:正文", "1:file:ch001.md"],
  );
});

test("flattenFileTree: 空输入返回空数组", () => {
  assert.deepEqual(U.flattenFileTree([]), []);
  assert.deepEqual(U.flattenFileTree(null), []);
});

// ============ formatBytes ============

test("formatBytes: 各量级与边界", () => {
  assert.equal(U.formatBytes(0), "0 B");
  assert.equal(U.formatBytes(512), "512 B");
  assert.equal(U.formatBytes(1024), "1.0 KB");
  assert.equal(U.formatBytes(1536), "1.5 KB");
  assert.equal(U.formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(U.formatBytes(-1), "-");
  assert.equal(U.formatBytes(NaN), "-");
});

// ============ formatDateTime ============

test("formatDateTime: ISO → 本地 YYYY-MM-DD HH:mm；非法输入原样返回", () => {
  const out = U.formatDateTime("2026-07-29T08:30:00Z");
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(U.formatDateTime("not-a-date"), "not-a-date");
  assert.equal(U.formatDateTime(""), "");
});

// ============ renderMarkdown ============

test("renderMarkdown: 标题/段落/加粗/行内码", () => {
  const html = U.renderMarkdown("# 标题\n\n正文 **加粗** 与 `code`");
  assert.ok(html.includes("<h1>标题</h1>"));
  assert.ok(html.includes("<strong>加粗</strong>"));
  assert.ok(html.includes("<code>code</code>"));
});

test("renderMarkdown: 无序/有序列表成组", () => {
  const html = U.renderMarkdown("- 甲\n- 乙\n\n1. 一\n2. 二");
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<li>甲</li>"));
  assert.ok(html.includes("<ol>"));
  assert.ok(html.includes("<li>二</li>"));
});

test("renderMarkdown: 代码块原样转义、不解析行内元素", () => {
  const html = U.renderMarkdown("```\nconst a = \"<b>not bold</b>\";\n```");
  assert.ok(html.includes("<pre><code>"));
  assert.ok(html.includes("&lt;b&gt;not bold&lt;/b&gt;"));
  assert.ok(!html.includes("<b>not bold</b>"));
});

test("renderMarkdown: 引用块合并连续行", () => {
  const html = U.renderMarkdown("> 第一行\n> 第二行");
  assert.ok(html.includes("<blockquote>"));
  assert.ok(html.includes("第一行<br>第二行"));
});

test("renderMarkdown: XSS 面——脚本与事件属性被转义", () => {
  const html = U.renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<img"));
});

test("renderMarkdown: javascript: 链接被剥离", () => {
  const html = U.renderMarkdown("[点我](javascript:alert(1))");
  assert.ok(!html.includes("javascript:"));
});

test("renderMarkdown: javascript: 绕过变体被剥离（🔴-10）", () => {
  // 黑名单正则仅匹配字面量 javascript:，以下变体均可绕过旧实现
  const bypassCases = [
    "[x](jav\tascript:alert(1))",       // 制表符（HTML href 解析前 trim 控制符）
    "[x](jav%73cript:alert(1))",         // percent 编码
    "[x](JaVaScRiPt:alert(1))",          // 大小写混合
    "[x](data:text/html,<script>alert(1)</script>)", // data: 协议
    "[x](vbscript:msgbox(1))",           // vbscript:
    "[x](java\nscript:alert(1))",        // 换行控制符
  ];
  for (const md of bypassCases) {
    const html = U.renderMarkdown(md);
    assert.ok(!html.includes("<a "), "不应生成链接: " + md + " → " + html);
    assert.ok(!html.includes("javascript:"), "不应残留 javascript: " + md);
    assert.ok(!html.includes("data:text/html"), "不应残留 data: " + md);
  }
});

test("renderMarkdown: 合法链接协议保留（http/https/mailto/相对路径）", () => {
  assert.ok(U.renderMarkdown("[官网](https://example.com)").includes('href="https://example.com"'));
  assert.ok(U.renderMarkdown("[邮件](mailto:a@b.com)").includes('href="mailto:a@b.com"'));
  assert.ok(U.renderMarkdown("[内网](http://127.0.0.1:7421/x)").includes('href="http://127.0.0.1:7421/x"'));
  assert.ok(U.renderMarkdown("[相对](./docs/1.md)").includes('href="./docs/1.md"'));
});

test("renderMarkdown: 分割线", () => {
  assert.ok(U.renderMarkdown("---").includes("<hr>"));
});

// ============ countChars ============

test("countChars: 忽略空白字符", () => {
  assert.equal(U.countChars("你好 世界\n"), 4);
  assert.equal(U.countChars(""), 0);
  assert.equal(U.countChars("  \n\t "), 0);
});
