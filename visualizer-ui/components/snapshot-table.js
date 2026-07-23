/* snapshot-table.js — 中栏视图：世界快照表（全部实体 × 全部属性，按实体分组展开） */
(function () {
  "use strict";
  var U = window.V3.util;

  window.V3.components.SnapshotTable = {
    name: "SnapshotTable",
    props: {
      entities: { type: Array, default: function () { return []; } },
      dimmedIds: { type: Array, default: function () { return []; } }
    },
    emits: ["select"],
    data: function () {
      return { typeFilter: "", modFilter: "", kw: "" };
    },
    computed: {
      dimmedSet: function () {
        var s = {}; this.dimmedIds.forEach(function (id) { s[id] = 1; }); return s;
      },
      rows: function () {
        var self = this;
        var kw = this.kw.trim().toLowerCase();
        var out = [];
        this.entities.forEach(function (e) {
          if (self.typeFilter && e.type !== self.typeFilter) return;
          var props = (e.properties || []).filter(function (f) {
            if (self.modFilter && f.modality !== self.modFilter) return false;
            return true;
          });
          var entText = (e.entityId + " " + U.displayName(e) + " " + (e.summary || "")).toLowerCase();
          var entHit = !kw || entText.indexOf(kw) >= 0;
          var childRows = props.filter(function (f) {
            if (!kw || entHit) return true;
            return (f.property + " " + U.fmtValue(f.value)).toLowerCase().indexOf(kw) >= 0;
          }).map(function (f) {
            return {
              id: f.declarationId,
              entityId: e.entityId,
              isEntity: false,
              property: f.property,
              value: U.fmtValue(f.value),
              modality: f.modality,
              validFrom: f.validFrom,
              dimmed: !!self.dimmedSet[f.declarationId]
            };
          });
          if (kw && !entHit && !childRows.length) return;
          if (self.modFilter && !childRows.length) return;
          out.push({
            id: "ent-" + e.entityId,
            entityId: e.entityId,
            isEntity: true,
            name: U.displayName(e),
            type: e.type,
            summary: e.summary || "",
            dead: U.isDead(e),
            dimmed: !!self.dimmedSet[e.entityId],
            children: childRows
          });
        });
        return out;
      }
    },
    methods: {
      typeColor: function (t) { return U.TYPE_COLOR[t] || "#888"; },
      typeName: function (t) { return U.TYPE_NAME[t] || t; },
      modName: function (m) { return U.MOD_NAME[m] || m; },
      rowClass: function (scope) {
        return scope.row.dimmed ? "dimmed" : "";
      },
      onRowClick: function (row) {
        this.$emit("select", row.entityId);
      }
    },
    template: `
      <div class="table-wrap">
        <div class="table-filters">
          <el-select v-model="typeFilter" placeholder="类型" clearable size="small" style="width:96px">
            <el-option v-for="t in ['character','location','item','concept']" :key="t"
                       :value="t" :label="typeName(t)"></el-option>
          </el-select>
          <el-select v-model="modFilter" placeholder="模态" clearable size="small" style="width:96px">
            <el-option value="fact" label="事实"></el-option>
            <el-option value="belief" label="信念"></el-option>
            <el-option value="hypothesis" label="推测"></el-option>
          </el-select>
          <el-input v-model="kw" placeholder="关键词过滤" clearable size="small" style="width:150px"></el-input>
        </div>
        <el-table :data="rows" row-key="id" :row-class-name="rowClass" @row-click="onRowClick"
                  size="small" style="width:100%"
                  :tree-props="{ children: 'children' }">
          <el-table-column label="实体 / 属性" min-width="220">
            <template #default="scope">
              <template v-if="scope.row.isEntity">
                <i style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"
                   :style="{ background: typeColor(scope.row.type) }"></i>
                <b>{{ scope.row.name }}</b>
                <span class="text-2 small" style="margin-left:6px">{{ scope.row.entityId }}</span>
                <span v-if="scope.row.dead" style="color:#c0392b;font-size:10px;margin-left:4px">†</span>
              </template>
              <template v-else>{{ scope.row.property }}</template>
            </template>
          </el-table-column>
          <el-table-column label="值 / 摘要" min-width="240">
            <template #default="scope">
              <span v-if="scope.row.isEntity" class="text-2">{{ scope.row.summary || '（无摘要）' }}</span>
              <span v-else>{{ scope.row.value }}</span>
            </template>
          </el-table-column>
          <el-table-column label="模态" width="90">
            <template #default="scope">
              <span v-if="!scope.row.isEntity" class="mod" :class="scope.row.modality">{{ modName(scope.row.modality) }}</span>
              <span v-else class="text-2 small">{{ typeName(scope.row.type) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="生效时间" width="110">
            <template #default="scope">
              <span v-if="!scope.row.isEntity" class="text-2">{{ scope.row.validFrom }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <div style="padding:30px;color:#8a93a5">没有匹配的实体或属性<br><span class="small">调整筛选条件，或在左上角新建实体</span></div>
          </template>
        </el-table>
      </div>
    `
  };
})();
