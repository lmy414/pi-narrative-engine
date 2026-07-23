/* event-timeline.js — 事件链页签：全部事件的纵向时间线 */
(function () {
  "use strict";
  var U = window.V3.util;

  window.V3.components.EventTimeline = {
    name: "EventTimeline",
    props: {
      events: { type: Array, default: function () { return []; } },
      /* { entityId: 显示名 } */
      entityNames: { type: Object, default: function () { return {}; } }
    },
    data: function () {
      return { expanded: {}, flashId: "" };
    },
    computed: {
      sorted: function () {
        return this.events.slice().sort(function (a, b) {
          if (a.storyTime !== b.storyTime) return a.storyTime < b.storyTime ? -1 : 1;
          return 0;
        });
      }
    },
    methods: {
      typeName: function (t) {
        return { birth: "诞生", death: "消亡", change: "变更" }[t] || t;
      },
      typeColor: function (t) {
        return { birth: "#4caf7d", death: "#c0392b", change: "#4A90E2" }[t] || "#8a93a5";
      },
      fmtValue: U.fmtValue,
      entityName: function (id) { return this.entityNames[id] || id; },
      modName: function (m) { return U.MOD_NAME[m] || m; },
      toggle: function (id) { this.expanded[id] = !this.expanded[id]; },
      jumpTo: function (id) {
        var self = this;
        this.expanded[id] = true;
        this.$nextTick(function () {
          var el = self.$refs["card-" + id];
          el = Array.isArray(el) ? el[0] : el;
          if (!el) return;
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          self.flashId = id;
          setTimeout(function () { self.flashId = ""; }, 1600);
        });
      }
    },
    template: `
      <div id="events-page">
        <el-timeline v-if="sorted.length" style="max-width:760px;margin:0 auto">
          <el-timeline-item v-for="e in sorted" :key="e.eventId" :timestamp="e.storyTime" placement="top">
            <el-card class="event-card" :class="{ flash: flashId === e.eventId }" :ref="'card-' + e.eventId"
                     shadow="hover" @click="toggle(e.eventId)">
              <div class="line1">
                <span class="mod" :style="{ background: typeColor(e.type) + '33', color: typeColor(e.type) }">{{ typeName(e.type) }}</span>
                <b>{{ entityName(e.entityId) }}</b>
                <span class="text-2 small">{{ e.entityId }}</span>
                <span v-if="e.newFacts && e.newFacts.length" class="small text-2">新增 {{ e.newFacts.length }} 声明</span>
                <span v-if="e.invalidated && e.invalidated.length" class="small text-2">闭合 {{ e.invalidated.length }} 声明</span>
                <span class="src-tag" :class="e.source === 'user' ? 'user' : 'engine'">{{ e.source === 'user' ? '人工' : '引擎' }}</span>
                <span v-if="e.summary" class="text-2 small" style="width:100%">{{ e.summary }}</span>
              </div>
              <div v-if="expanded[e.eventId]" class="detail">
                <template v-if="e.newFacts && e.newFacts.length">
                  <h5>新增声明</h5>
                  <table>
                    <tr v-for="(f, i) in e.newFacts" :key="i">
                      <td style="width:110px">{{ entityName(f.entityId) }}</td>
                      <td style="width:90px">{{ f.property }}</td>
                      <td>{{ fmtValue(f.value) }}</td>
                      <td style="width:56px"><span class="mod" :class="f.modality">{{ modName(f.modality) }}</span></td>
                    </tr>
                  </table>
                </template>
                <template v-if="e.invalidated && e.invalidated.length">
                  <h5>闭合声明</h5>
                  <table>
                    <tr v-for="(f, i) in e.invalidated" :key="i">
                      <td style="width:90px">{{ f.property }}</td>
                      <td class="text-2">{{ f.declarationId }}</td>
                    </tr>
                  </table>
                </template>
                <div v-if="e.causedBy" style="margin-top:6px">
                  由 <span class="caused-by" @click.stop="jumpTo(e.causedBy)">{{ e.causedBy }}</span> 引起
                </div>
                <div class="text-2 small" style="margin-top:6px">eventId：{{ e.eventId }}</div>
              </div>
            </el-card>
          </el-timeline-item>
        </el-timeline>
        <div v-else style="text-align:center;color:#8a93a5;padding:80px 0;line-height:2">
          还没有任何事件<br>回到「工作台」新建实体或修改属性后，这里会记录每一次世界变更
        </div>
      </div>
    `
  };
})();
