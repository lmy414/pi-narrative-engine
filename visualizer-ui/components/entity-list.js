/* entity-list.js — 左栏：搜索 + 类型筛选 + 含已消亡开关 + 实体列表 */
(function () {
  "use strict";
  var U = window.V3.util;
  var api = window.V3.api;

  window.V3.components.EntityList = {
    name: "EntityList",
    props: {
      entities: { type: Array, default: function () { return []; } },
      relations: { type: Array, default: function () { return []; } },
      selectedId: { type: String, default: "" },
      storyTime: { type: String, default: "" },
      /* 角色视角下不可见的实体 id 集合（Array） */
      dimmedIds: { type: Array, default: function () { return []; } },
      includeClosed: { type: Boolean, default: false }
    },
    emits: ["select", "new-entity", "update:includeClosed"],
    data: function () {
      return {
        q: "",
        types: { character: true, location: true, item: true, concept: true },
        searchResults: null,   // 非 null 时展示检索结果（EntitySnapshot 数组）
        searchDegraded: false, // /api/search 不可用，已降级本地过滤
        searching: false
      };
    },
    computed: {
      dimmedSet: function () {
        var s = {}; this.dimmedIds.forEach(function (id) { s[id] = 1; }); return s;
      },
      shown: function () {
        var self = this;
        var src = this.searchResults !== null ? this.searchResults : this.entities;
        return src.filter(function (e) {
          if (!self.types[e.type]) return false;
          if (!self.includeClosed && U.isDead(e)) return false;
          if (self.searchResults === null && self.q) return self.localMatch(e);
          return true;
        });
      }
    },
    watch: {
      q: function () { this.onQuery(); },
      storyTime: function () { if (this.q) this.onQuery(); }
    },
    methods: {
      typeColor: function (t) { return U.TYPE_COLOR[t] || "#888"; },
      typeName: function (t) { return U.TYPE_NAME[t] || t; },
      displayName: U.displayName,
      isDead: U.isDead,
      localMatch: function (e) {
        var hay = (e.entityId + " " + (e.summary || "") + " " +
          (e.properties || []).map(function (f) { return f.property + " " + U.fmtValue(f.value); }).join(" ")
        ).toLowerCase();
        return hay.indexOf(this.q.toLowerCase()) >= 0;
      },
      onQuery: U.debounce(function () {
        var self = this;
        if (!this.q) { this.searchResults = null; return; }
        if (this.searchDegraded) { this.searchResults = null; return; } // 本地过滤即可
        this.searching = true;
        api.search(this.q, this.storyTime).then(function (data) {
          self.searchResults = (data.results || []).map(function (r) { return r.snapshot; }).filter(Boolean);
          self.searching = false;
        }).catch(function (err) {
          self.searching = false;
          if (err && err.status === 501) {
            self.searchDegraded = true;
            self.searchResults = null; // 回退本地 contains 过滤
            window.ElementPlus.ElMessage({
              message: "检索服务不可用，已降级为本地包含匹配",
              type: "warning",
              duration: 3000
            });
          } else {
            self.searchResults = null;
            window.ElementPlus.ElMessage({ message: "搜索失败：" + err.message, type: "error", duration: 3000 });
          }
        });
      }, 300),
      toggleType: function (t) { this.types[t] = !this.types[t]; },
      pick: function (id) { this.$emit("select", id); }
    },
    template: `
      <aside id="left">
        <div class="pad">
          <el-button type="primary" style="width:100%" @click="$emit('new-entity')">+ 新建实体</el-button>
          <el-input v-model="q" placeholder="搜索实体（名称/摘要/属性）" clearable style="margin-top:10px"></el-input>
          <div class="form-tip" v-if="searchDegraded">检索不可用，当前为本地包含匹配</div>
          <div class="chips">
            <span v-for="t in ['character','location','item','concept']" :key="t"
                  class="chip" :class="{ on: types[t] }" :data-type="t"
                  @click="toggleType(t)">{{ typeName(t) }}</span>
          </div>
          <div class="switches">
            <el-switch :model-value="includeClosed" @update:model-value="$emit('update:includeClosed', $event)"
                       inline-prompt active-text="含" inactive-text="否"></el-switch>
            <span class="form-tip" style="margin-top:0">含已消亡实体与已闭合关系</span>
          </div>
        </div>
        <div class="entity-list" v-loading="searching">
          <template v-if="shown.length">
            <div v-for="e in shown" :key="e.entityId"
                 class="ent" :class="{ sel: e.entityId === selectedId, dimmed: dimmedSet[e.entityId] }"
                 @click="pick(e.entityId)">
              <div class="n">
                <i class="dot" :style="{ background: typeColor(e.type) }"></i>
                {{ displayName(e) }}
                <span class="eid">{{ e.entityId }}</span>
                <span v-if="isDead(e)" class="dead">†已消亡</span>
              </div>
              <div class="s">{{ e.summary || '（无摘要）' }}</div>
            </div>
          </template>
          <div v-else style="padding:24px 12px;color:#8492a6;font-size:12px;text-align:center;line-height:2">
            <template v-if="q">无匹配实体</template>
            <template v-else>暂无实体<br>点击上方「+ 新建实体」创建第一个</template>
          </div>
        </div>
        <div class="count">{{ shown.length }} / {{ entities.length }} 个实体 · {{ relations.length }} 条关系</div>
      </aside>
    `
  };
})();
