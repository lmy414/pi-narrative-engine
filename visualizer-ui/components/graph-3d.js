/* graph-3d.js — 中栏 3D 关系图（3d-force-graph 隔离层：邻域图 / 全景图共用） */
(function () {
  "use strict";
  var U = window.V3.util;

  window.V3.components.Graph3d = {
    name: "Graph3d",
    props: {
      mode: { type: String, default: "overview" }, // neighborhood | overview
      entities: { type: Array, default: function () { return []; } },
      relations: { type: Array, default: function () { return []; } },
      selectedId: { type: String, default: "" },
      dimmedIds: { type: Array, default: function () { return []; } }
    },
    emits: ["select"],
    data: function () {
      return { graph: null, ro: null };
    },
    computed: {
      dimmedSet: function () {
        var s = {}; this.dimmedIds.forEach(function (id) { s[id] = 1; }); return s;
      },
      dataSet: function () {
        var self = this;
        var entities = this.entities, relations = this.relations;
        if (this.mode === "neighborhood") {
          if (!this.selectedId) return { nodes: [], links: [] };
          var keep = {}; keep[this.selectedId] = 1;
          relations.forEach(function (r) {
            if (r.sourceId === self.selectedId) keep[r.targetId] = 1;
            if (r.targetId === self.selectedId) keep[r.sourceId] = 1;
          });
          entities = entities.filter(function (e) { return keep[e.entityId]; });
          relations = relations.filter(function (r) {
            return r.sourceId === self.selectedId || r.targetId === self.selectedId;
          });
        }
        var byId = {};
        entities.forEach(function (e) { byId[e.entityId] = e; });
        var nodes = entities.map(function (e) {
          return {
            id: e.entityId,
            name: U.displayName(e),
            type: e.type,
            summary: e.summary || "",
            dead: U.isDead(e)
          };
        });
        var links = relations
          .filter(function (r) { return byId[r.sourceId] && byId[r.targetId]; })
          .map(function (r) {
            return {
              source: r.sourceId, target: r.targetId,
              label: r.label, closed: U.isClosed(r)
            };
          });
        return { nodes: nodes, links: links };
      },
      titleText: function () {
        if (this.mode === "neighborhood") {
          var ent = null;
          for (var i = 0; i < this.entities.length; i++) {
            if (this.entities[i].entityId === this.selectedId) { ent = this.entities[i]; break; }
          }
          return ent ? "邻域图 · " + U.displayName(ent) + " 的一度关系" : "邻域图";
        }
        return "全景图 · " + this.entities.length + " 实体 / " + this.relations.length + " 关系";
      },
      emptyText: function () {
        if (this.dataSet.nodes.length) return "";
        if (this.mode === "neighborhood") {
          if (!this.selectedId) {
            return "在左侧列表或全景图中选择一个实体\n这里展示它与直接相关实体的关系图";
          }
          return "该实体在当前时刻不存在\n（尚未诞生或已消亡）";
        }
        return "此刻的世界还是一片空白\n点击左上角「+ 新建实体」开始";
      }
    },
    watch: {
      entities: function () { this.pushData(); },
      relations: function () { this.pushData(); },
      selectedId: function () { this.repaint(); this.focusSelected(); },
      dimmedSet: function () { this.repaint(); },
      mode: function () { this.pushData(); }
    },
    mounted: function () {
      var self = this;
      var holder = this.$refs.holder;
      this.graph = window.ForceGraph3D()(holder)
        .backgroundColor("#14171d")
        .nodeColor(function (n) { return self.nodeColor(n); })
        .nodeOpacity(0.92)
        .nodeResolution(24)
        .nodeLabel(function (n) {
          return n.name + "（" + (U.TYPE_NAME[n.type] || n.type) + "）" +
            (n.dead ? " †" : "") + (n.summary ? "<br>" + n.summary : "");
        })
        .linkColor(function (l) { return l.closed ? "#3a3f4a" : "#5a6478"; })
        .linkWidth(function (l) { return l.closed ? 0.6 : 1.2; })
        .linkDirectionalArrowLength(4)
        .linkDirectionalArrowRelPos(1)
        .linkLabel(function (l) { return l.label + (l.closed ? "（已闭合）" : ""); })
        .nodeThreeObject(function (n) {
          var sprite = new window.SpriteText(n.name);
          sprite.color = self.dimmedSet[n.id] ? "#5a6272" : "#dfe4ec";
          sprite.textHeight = 5;
          sprite.position.y = 10;
          return sprite;
        })
        .nodeThreeObjectExtend(true)
        .onNodeClick(function (n) { self.$emit("select", n.id); })
        .onNodeHover(function (n) { holder.style.cursor = n ? "pointer" : "default"; });
      this.fit();
      this.pushData();
      this.ro = new ResizeObserver(function () { self.fit(); });
      this.ro.observe(holder);
    },
    beforeUnmount: function () {
      if (this.ro) this.ro.disconnect();
      if (this.graph) this.graph._destructor && this.graph._destructor();
    },
    methods: {
      nodeColor: function (n) {
        if (n.id === this.selectedId) return "#e74c3c";
        if (this.dimmedSet[n.id]) return "#3a4150";
        if (n.dead) return "#6b7280";
        return U.TYPE_COLOR[n.type] || "#888";
      },
      fit: function () {
        var holder = this.$refs.holder;
        if (this.graph && holder) this.graph.width(holder.clientWidth).height(holder.clientHeight);
      },
      pushData: function () {
        if (!this.graph) return;
        this.graph.graphData({ nodes: this.dataSet.nodes, links: this.dataSet.links });
        this.repaint();
      },
      /* 选中/置灰态变化 → 触发颜色重算 */
      repaint: function () {
        if (!this.graph) return;
        this.graph.nodeColor(this.graph.nodeColor());
        this.graph.nodeThreeObject(this.graph.nodeThreeObject());
      },
      focusSelected: function () {
        var self = this;
        if (!this.graph || !this.selectedId) return;
        var tryFocus = function (attempt) {
          var nodes = self.graph.graphData().nodes;
          var n = null;
          for (var i = 0; i < nodes.length; i++) if (nodes[i].id === self.selectedId) { n = nodes[i]; break; }
          if (!n) return;
          if (n.x === undefined) {
            if (attempt < 10) setTimeout(function () { tryFocus(attempt + 1); }, 300);
            return;
          }
          var dist = 90;
          var ratio = 1 + dist / Math.hypot(n.x, n.y, n.z || 1);
          self.graph.cameraPosition(
            { x: n.x * ratio, y: n.y * ratio, z: (n.z || 1) * ratio }, n, 900);
        };
        tryFocus(0);
      }
    },
    template: `
      <div class="graph-wrap">
        <div ref="holder" class="graph-holder"></div>
        <div class="view-title">{{ titleText }}</div>
        <div class="hint">左键旋转 · 右键平移 · 滚轮缩放 · 悬停看摘要 · 点击节点查看详情</div>
        <div v-if="emptyText" class="graph-empty" style="white-space:pre-line">{{ emptyText }}</div>
      </div>
    `
  };
})();
