/* stream-view.js — 通用流式日志查看器（§11.6 #2：抽象供更新/自检等 SSE 场景复用）
 *
 * 哑组件：父组件持有 EventSource 并 push 行，本组件负责渲染与自动滚动。
 * props:
 *   lines   — [{ stage?, line, error?, ts? }]（UpdateEvent 兼容）
 *   running — 是否进行中（显示光标态）
 */
(function () {
  "use strict";

  window.V3.components.StreamView = {
    props: {
      lines: { type: Array, default: function () { return []; } },
      running: { type: Boolean, default: false }
    },
    watch: {
      "lines.length": function () { this.scrollBottom(); }
    },
    updated: function () { this.scrollBottom(); },
    methods: {
      scrollBottom: function () {
        var el = this.$refs.log;
        if (el) el.scrollTop = el.scrollHeight;
      },
      lineClass: function (l) {
        if (l.error || l.stage === "error") return "line-error";
        if (l.stage && l.stage !== "done") return "line-stage";
        return "";
      },
      fmt: function (l) {
        var text = l.error || l.line || "";
        if (l.stage && !l.error) return "[" + l.stage + "] " + text;
        return text;
      }
    },
    template: `
      <div class="stream-log" ref="log">
        <div v-for="(l, i) in lines" :key="i" :class="lineClass(l)">{{ fmt(l) }}</div>
        <div v-if="running" class="line-stage">▍</div>
        <div v-if="!lines.length && !running" style="color:var(--muted-foreground)">（暂无输出）</div>
      </div>
    `
  };
})();
