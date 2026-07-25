/* timeline-bar.js — 顶部故事时间轴（两级分组：章节→事件，防重叠）
 *
 * 优化背景：48+ 个 storyTime 时旧版单轨全标签渲染必然重叠。
 * 方案：
 * - 层级模式（ch001.ev001 这类 "组.序号" 结构占多数时）：
 *   上排章级刻度（少量，全标签），下排当前章的事件刻度（点为主，标签稀疏）
 * - 扁平模式（无层级结构）：
 *   全点 + 稀疏标签（首/尾/当前/每 k 个）+ ‹ › 步进按钮 + 下拉直跳
 */
(function () {
  "use strict";

  /* 按最后一个 "." 分组（ch001.ev001 → 组 ch001，项 ev001） */
  function groupStoryTimes(storyTimes) {
    if (!storyTimes.length) return null;
    var groups = [];
    var byName = {};
    var hierarchical = 0;
    storyTimes.forEach(function (t) {
      var idx = t.lastIndexOf(".");
      if (idx > 0) hierarchical++;
      var key = idx > 0 ? t.slice(0, idx) : t;
      if (!byName[key]) { byName[key] = { name: key, items: [] }; groups.push(byName[key]); }
      byName[key].items.push(t);
    });
    /* 大多数有层级且组数 >= 2 才用分组模式 */
    if (hierarchical >= storyTimes.length * 0.6 && groups.length >= 2) return groups;
    return null;
  }

  window.V3.components.TimelineBar = {
    name: "TimelineBar",
    props: {
      storyTimes: { type: Array, default: function () { return []; } },
      modelValue: { type: String, default: "" },
      /* { storyTime: 事件数 } */
      eventCounts: { type: Object, default: function () { return {}; } }
    },
    emits: ["update:modelValue"],
    computed: {
      groups: function () { return groupStoryTimes(this.storyTimes); },
      grouped: function () { return !!this.groups; },
      /* 当前选中项所在的组（无选中时回退最后一组） */
      activeGroup: function () {
        if (!this.groups) return null;
        var mv = this.modelValue;
        var hit = this.groups.find(function (g) { return g.items.indexOf(mv) >= 0; });
        return hit || this.groups[this.groups.length - 1];
      },
      /* 扁平模式：标签显示间隔（<=12 全显，否则约 12 个标签） */
      flatLabelEvery: function () {
        var n = this.storyTimes.length;
        return n <= 12 ? 1 : Math.ceil(n / 12);
      },
      /* 章级标签显示间隔（章太多时同样稀疏化） */
      chapterLabelEvery: function () {
        var n = (this.groups || []).length;
        return n <= 12 ? 1 : Math.ceil(n / 12);
      }
    },
    methods: {
      tickStyle: function (i, total) {
        var n = total || this.storyTimes.length;
        var pct = n <= 1 ? 50 : (i / (n - 1)) * 94 + 3;
        return { left: pct + "%" };
      },
      /* 事件标签只显示序号部分（ev001），省空间 */
      shortName: function (t) {
        var idx = t.lastIndexOf(".");
        return idx > 0 ? t.slice(idx + 1) : t;
      },
      showFlatLabel: function (i, t) {
        var n = this.storyTimes.length;
        return t === this.modelValue || i === 0 || i === n - 1 || i % this.flatLabelEvery === 0;
      },
      showChapterLabel: function (gi, g) {
        return g === this.activeGroup || gi === 0 || gi === this.groups.length - 1
          || gi % this.chapterLabelEvery === 0;
      },
      showEventLabel: function (group, i, t) {
        return t === this.modelValue || group.items.length <= 8
          || i === 0 || i === group.items.length - 1;
      },
      pickGroup: function (g) {
        /* 点章节：若当前选中已在该组则不动，否则跳到组内第一项 */
        if (g.items.indexOf(this.modelValue) < 0) this.pick(g.items[0]);
      },
      pick: function (t) { this.$emit("update:modelValue", t); },
      step: function (d) {
        var i = this.storyTimes.indexOf(this.modelValue);
        if (i < 0) i = d > 0 ? -1 : this.storyTimes.length;
        var next = Math.min(this.storyTimes.length - 1, Math.max(0, i + d));
        if (this.storyTimes[next]) this.pick(this.storyTimes[next]);
      }
    },
    template: `
      <div class="timeline-bar">
        <span class="tb-label">故事时间</span>
        <button class="tb-step" @click="step(-1)" title="上一时刻">‹</button>

        <div class="timeline-track" :class="{ grouped: grouped }">
          <!-- 层级模式：章级 + 事件级双排 -->
          <template v-if="grouped">
            <div class="row chapters">
              <div class="rail"></div>
              <div v-for="(g, gi) in groups" :key="g.name"
                   class="tick chapter" :class="{ active: g === activeGroup }"
                   :style="tickStyle(gi, groups.length)" @click="pickGroup(g)"
                   :title="g.name + '（' + g.items.length + ' 个时刻）'">
                <div class="dot"></div>
                <div v-if="showChapterLabel(gi, g)" class="lbl">{{ g.name }}</div>
              </div>
            </div>
            <div class="row events" v-if="activeGroup">
              <div class="rail"></div>
              <div v-for="(t, i) in activeGroup.items" :key="t"
                   class="tick event" :class="{ active: t === modelValue }"
                   :style="tickStyle(i, activeGroup.items.length)" @click="pick(t)"
                   :title="t + (eventCounts[t] ? '（' + eventCounts[t] + ' 事件）' : '')">
                <div class="dot"></div>
                <div v-if="showEventLabel(activeGroup, i, t)" class="lbl">{{ shortName(t) }}</div>
              </div>
            </div>
          </template>

          <!-- 扁平模式：全点 + 稀疏标签 -->
          <template v-else>
            <div class="rail"></div>
            <div v-for="(t, i) in storyTimes" :key="t"
                 class="tick" :class="{ active: t === modelValue }"
                 :style="tickStyle(i)" @click="pick(t)"
                 :title="t + (eventCounts[t] ? '（' + eventCounts[t] + ' 事件）' : '')">
              <div class="dot"></div>
              <div v-if="showFlatLabel(i, t)" class="lbl">{{ t }}</div>
            </div>
          </template>
        </div>

        <button class="tb-step" @click="step(1)" title="下一时刻">›</button>
        <select class="tb-jump" :value="modelValue"
                @change="pick($event.target.value)" title="直接跳转">
          <option v-for="t in storyTimes" :key="t" :value="t">{{ t }}</option>
        </select>
        <span class="timeline-now">当前：{{ modelValue || '—' }}</span>
      </div>
    `
  };
})();
