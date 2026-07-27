/* app.js — Vue 应用根：全局状态（storyTime / 选中实体 / 角色视角）与数据编排 */
(function () {
  "use strict";
  var U = window.V3.util;
  var api = window.V3.api;
  var C = window.V3.components;

  var app = window.Vue.createApp({
    components: {
      TimelineBar: C.TimelineBar,
      EntityList: C.EntityList,
      Graph3d: C.Graph3d,
      SnapshotTable: C.SnapshotTable,
      DetailEditor: C.DetailEditor,
      EntityForm: C.EntityForm,
      EventTimeline: C.EventTimeline,
      HelpTour: C.HelpTour,
      DebugView: C.DebugView
    },
    data: function () {
      return {
        mainTab: "workbench",        // workbench | events | debug
        storyTimes: [],
        storyTime: "",
        events: [],
        includeClosed: false,
        entities: [],
        relations: [],
        selectedId: "",
        centerView: "overview",      // neighborhood | overview | table
        characterViewId: "",
        charViewDeclIds: [],         // 角色可见的 declarationId 列表
        loading: false,
        entityDialog: false,
        helpDialog: false,
        loadError: ""
      };
    },
    computed: {
      eventCounts: function () {
        var m = {};
        this.events.forEach(function (e) { m[e.storyTime] = (m[e.storyTime] || 0) + 1; });
        return m;
      },
      /* 当前生效视图数据：未开「含已消亡」时前端再过滤一道 */
      viewEntities: function () {
        if (this.includeClosed) return this.entities;
        return this.entities.filter(function (e) { return !U.isDead(e); });
      },
      viewRelations: function () {
        if (this.includeClosed) return this.relations;
        return this.relations.filter(function (r) { return !U.isClosed(r); });
      },
      selectedEntity: function () {
        for (var i = 0; i < this.viewEntities.length; i++) {
          if (this.viewEntities[i].entityId === this.selectedId) return this.viewEntities[i];
        }
        return null;
      },
      characters: function () {
        return this.viewEntities.filter(function (e) { return e.type === "character"; });
      },
      entityNames: function () {
        var m = {};
        this.entities.forEach(function (e) { m[e.entityId] = U.displayName(e); });
        return m;
      },
      /* 角色视角：可见声明集合 */
      charViewSet: function () {
        var s = {}; this.charViewDeclIds.forEach(function (id) { s[id] = 1; }); return s;
      },
      /* 角色视角下不可见的实体：有属性但全部不可见（自己除外） */
      hiddenEntityIds: function () {
        if (!this.characterViewId) return [];
        var self = this;
        var out = [];
        this.viewEntities.forEach(function (e) {
          if (e.entityId === self.characterViewId) return;
          var props = e.properties || [];
          if (!props.length) return; // 无属性的实体无可隐藏，保持可见
          var anyVisible = props.some(function (f) { return self.charViewSet[f.declarationId]; });
          if (!anyVisible) out.push(e.entityId);
        });
        return out;
      },
      hiddenDeclIds: function () {
        if (!this.characterViewId) return [];
        var self = this;
        var out = [];
        this.viewEntities.forEach(function (e) {
          (e.properties || []).forEach(function (f) {
            if (!self.charViewSet[f.declarationId]) out.push(f.declarationId);
          });
        });
        return out;
      },
      tableDimmedIds: function () {
        return this.hiddenEntityIds.concat(this.hiddenDeclIds);
      }
    },
    watch: {
      storyTime: function () { this.loadGraph(); },
      includeClosed: function () { this.loadGraph(); },
      characterViewId: function () { this.loadCharacterView(); }
    },
    mounted: function () { this.init(); },
    methods: {
      init: function () {
        var self = this;
        this.loading = true;
        Promise.all([api.status(), api.events()]).then(function (rs) {
          self.storyTimes = rs[0].storyTimes || [];
          self.events = (rs[1] && rs[1].events) || [];
          if (self.storyTimes.length) {
            self.storyTime = self.storyTimes[self.storyTimes.length - 1]; // 触发 loadGraph
          } else {
            self.loading = false;
          }
        }).catch(function (err) {
          self.loading = false;
          self.loadError = err.message;
          window.ElementPlus.ElMessage({ message: "初始化失败：" + err.message, type: "error" });
        });
      },
      loadGraph: function () {
        var self = this;
        if (!this.storyTime) { this.entities = []; this.relations = []; this.loading = false; return; }
        this.loading = true;
        api.graph(this.storyTime, this.includeClosed).then(function (g) {
          self.entities = g.entities || [];
          self.relations = g.relations || [];
          self.loading = false;
          self.loadCharacterView();
        }).catch(function (err) {
          self.loading = false;
          window.ElementPlus.ElMessage({ message: "加载世界快照失败：" + err.message, type: "error" });
        });
      },
      loadCharacterView: function () {
        var self = this;
        if (!this.characterViewId || !this.storyTime) { this.charViewDeclIds = []; return; }
        api.characterView(this.characterViewId, this.storyTime).then(function (data) {
          self.charViewDeclIds = (data.view || []).map(function (f) { return f.declarationId; });
        }).catch(function (err) {
          self.charViewDeclIds = [];
          window.ElementPlus.ElMessage({ message: "角色视角加载失败：" + err.message, type: "error" });
        });
      },
      refreshEvents: function () {
        var self = this;
        return api.events().then(function (data) { self.events = (data && data.events) || []; });
      },
      /* 任何编辑成功后调用：刷新当前时刻数据 + 事件数 */
      onChanged: function () {
        this.refreshEvents();
        this.loadGraph();
      },
      onSelect: function (id) {
        this.selectedId = id;
        if (this.mainTab !== "workbench") this.mainTab = "workbench";
      },
      onCreated: function (id) {
        this.selectedId = id;
        this.onChanged();
      },
      refresh: function () {
        var self = this;
        api.status().then(function (s) {
          self.storyTimes = s.storyTimes || [];
          if (self.storyTimes.length && self.storyTimes.indexOf(self.storyTime) < 0) {
            self.storyTime = self.storyTimes[self.storyTimes.length - 1];
          } else {
            self.loadGraph();
          }
          self.refreshEvents();
        }).catch(function (err) {
          window.ElementPlus.ElMessage({ message: "刷新失败：" + err.message, type: "error" });
        });
      },
      charViewLabel: function () {
        if (!this.characterViewId) return "";
        return "视角：" + (this.entityNames[this.characterViewId] || this.characterViewId);
      }
    },
    template: `
      <header id="topbar">
        <div class="row">
          <span class="brand">World Graph<span class="ver">可视化 V3</span></span>
          <el-radio-group v-model="mainTab" size="small">
            <el-radio-button value="workbench">工作台</el-radio-button>
            <el-radio-button value="events">事件链</el-radio-button>
            <el-radio-button value="debug">调试</el-radio-button>
          </el-radio-group>
          <span class="spacer"></span>
          <span class="tb-label">角色视角</span>
          <el-select v-model="characterViewId" size="small" style="width:150px" placeholder="关闭视角">
            <el-option value="" label="关闭视角"></el-option>
            <el-option v-for="c in characters" :key="c.entityId" :value="c.entityId"
                       :label="(entityNames[c.entityId] || c.entityId) + '（' + c.entityId + '）'"></el-option>
          </el-select>
          <el-button size="small" @click="refresh">刷新</el-button>
          <el-button size="small" @click="helpDialog = true">帮助</el-button>
        </div>
        <timeline-bar v-model="storyTime" :story-times="storyTimes" :event-counts="eventCounts"></timeline-bar>
      </header>

      <main id="main" v-show="mainTab === 'workbench'" v-loading="loading">
        <entity-list :entities="viewEntities" :relations="viewRelations"
                     :selected-id="selectedId" :story-time="storyTime"
                     :dimmed-ids="hiddenEntityIds" v-model:include-closed="includeClosed"
                     @select="onSelect" @new-entity="entityDialog = true"></entity-list>

        <section id="center">
          <div class="view-switch">
            <el-radio-group v-model="centerView" size="small">
              <el-radio-button value="neighborhood">邻域图</el-radio-button>
              <el-radio-button value="overview">全景图</el-radio-button>
              <el-radio-button value="table">快照表</el-radio-button>
            </el-radio-group>
          </div>
          <graph-3d v-if="centerView !== 'table'" :mode="centerView"
                    :entities="viewEntities" :relations="viewRelations"
                    :selected-id="selectedId" :dimmed-ids="hiddenEntityIds"
                    @select="onSelect"></graph-3d>
          <snapshot-table v-else :entities="viewEntities" :dimmed-ids="tableDimmedIds"
                          @select="onSelect"></snapshot-table>
        </section>

        <detail-editor :entity="selectedEntity" :selected-id="selectedId"
                       :all-entities="viewEntities" :relations="viewRelations"
                       :story-time="storyTime" :locked-decl-ids="hiddenDeclIds"
                       @changed="onChanged" @select="onSelect"></detail-editor>
      </main>

      <event-timeline v-show="mainTab === 'events'" :events="events" :entity-names="entityNames"></event-timeline>

      <debug-view v-show="mainTab === 'debug'"></debug-view>

      <entity-form v-model="entityDialog" :story-time="storyTime" @created="onCreated"></entity-form>
      <help-tour v-model="helpDialog"></help-tour>
    `
  });

  app.use(window.ElementPlus, { locale: window.ElementPlusLocaleZhCn });
  app.mount("#app");
})();
