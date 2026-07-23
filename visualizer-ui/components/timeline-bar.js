/* timeline-bar.js — 顶部故事时间轴（刻度条，storyTime 的第一公民呈现） */
(function () {
  "use strict";
  window.V3.components.TimelineBar = {
    name: "TimelineBar",
    props: {
      storyTimes: { type: Array, default: function () { return []; } },
      modelValue: { type: String, default: "" },
      /* { storyTime: 事件数 } */
      eventCounts: { type: Object, default: function () { return {}; } }
    },
    emits: ["update:modelValue"],
    methods: {
      tickStyle: function (i) {
        var n = this.storyTimes.length;
        var pct = n <= 1 ? 50 : (i / (n - 1)) * 94 + 3;
        return { left: pct + "%" };
      },
      pick: function (t) { this.$emit("update:modelValue", t); }
    },
    template: `
      <div class="timeline-bar">
        <span class="tb-label">故事时间</span>
        <div class="timeline-track">
          <div class="rail"></div>
          <div v-for="(t, i) in storyTimes" :key="t"
               class="tick" :class="{ active: t === modelValue }"
               :style="tickStyle(i)" @click="pick(t)">
            <div class="dot"></div>
            <div class="lbl">{{ t }}</div>
            <div v-if="eventCounts[t]" class="evt">{{ eventCounts[t] }} 事件</div>
          </div>
        </div>
        <span class="timeline-now">当前：{{ modelValue || '—' }}</span>
      </div>
    `
  };
})();
