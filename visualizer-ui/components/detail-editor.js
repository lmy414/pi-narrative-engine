/* detail-editor.js — 右栏详情编辑器：基本信息 / 属性 / 关系 / 可见性 / 历史 */
(function () {
  "use strict";
  var U = window.V3.util;
  var api = window.V3.api;
  var ElMessage = function (opts) { window.ElementPlus.ElMessage(opts); };

  window.V3.components.DetailEditor = {
    name: "DetailEditor",
    components: { RelationForm: window.V3.components.RelationForm },
    props: {
      entity: { type: Object, default: null },          // 当前时刻快照（可能为 null）
      selectedId: { type: String, default: "" },
      allEntities: { type: Array, default: function () { return []; } },
      relations: { type: Array, default: function () { return []; } }, // 当前时刻全部关系（含已闭合，视开关）
      storyTime: { type: String, default: "" },
      lockedDeclIds: { type: Array, default: function () { return []; } } // 角色视角下不可见的声明
    },
    emits: ["changed", "select"],
    data: function () {
      return {
        summaryDraft: "",
        summarySaving: false,
        rows: [],          // 已有属性编辑行
        newRows: [],       // 新增属性行
        savingProps: false,
        relDialog: false,
        visDeclId: "",
        visRecords: [],
        visLoading: false,
        visForm: { characterId: "", confidence: 1, source: "" },
        visSaving: false,
        history: null,
        historyLoading: false
      };
    },
    computed: {
      lockedSet: function () {
        var s = {}; this.lockedDeclIds.forEach(function (id) { s[id] = 1; }); return s;
      },
      dead: function () { return U.isDead(this.entity); },
      myRelations: function () {
        var self = this;
        if (!this.entity) return [];
        return this.relations.filter(function (r) {
          return r.sourceId === self.entity.entityId || r.targetId === self.entity.entityId;
        });
      },
      activeRelCount: function () {
        return this.myRelations.filter(function (r) { return !U.isClosed(r); }).length;
      },
      characters: function () {
        return this.allEntities.filter(function (e) { return e.type === "character" && !U.isDead(e); });
      },
      entityNames: function () {
        var m = {};
        this.allEntities.forEach(function (e) { m[e.entityId] = U.displayName(e); });
        return m;
      },
      historyItems: function () {
        if (!this.history) return [];
        var items = [];
        (this.history.entities || []).forEach(function (e) {
          items.push({
            t: e.validFrom, kind: "实体版本",
            text: "类型「" + (U.TYPE_NAME[e.type] || e.type) + "」" + (e.summary ? " · " + e.summary : ""),
            closed: e.validTo !== "Infinity", validTo: e.validTo
          });
        });
        (this.history.facts || []).forEach(function (f) {
          items.push({
            t: f.validFrom, kind: "属性",
            text: f.property + " = " + U.fmtValue(f.value) + "（" + (U.MOD_NAME[f.modality] || f.modality) + "）",
            closed: f.validTo !== "Infinity", validTo: f.validTo
          });
        });
        (this.history.relations || []).forEach(function (r) {
          items.push({
            t: r.validFrom, kind: "关系",
            text: r.sourceId + " —" + r.label + "→ " + r.targetId,
            closed: r.validTo !== "Infinity", validTo: r.validTo
          });
        });
        items.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
        return items;
      }
    },
    watch: {
      selectedId: function () { this.resetEditor(); },
      storyTime: function () { this.resetEditor(); },
      entity: {
        deep: true,
        handler: function () { this.fillFromEntity(); }
      },
      visDeclId: function () { this.loadVisibility(); }
    },
    mounted: function () {
      this.resetEditor();
    },
    methods: {
      typeName: function (t) { return U.TYPE_NAME[t] || t; },
      typeColor: function (t) { return U.TYPE_COLOR[t] || "#888"; },
      modName: function (m) { return U.MOD_NAME[m] || m; },
      displayName: U.displayName,
      fmtValue: U.fmtValue,
      isClosed: U.isClosed,

      resetEditor: function () {
        this.history = null;
        this.visDeclId = "";
        this.visRecords = [];
        this.newRows = [];
        this.fillFromEntity();
        this.loadHistory();
      },
      fillFromEntity: function () {
        this.summaryDraft = this.entity ? (this.entity.summary || "") : "";
        this.rows = this.entity ? (this.entity.properties || []).map(function (f) {
          return {
            declarationId: f.declarationId,
            property: f.property,
            value: U.fmtValue(f.value),
            origValue: f.value,
            modality: f.modality,
            origModality: f.modality,
            deleted: false
          };
        }) : [];
      },
      loadHistory: function () {
        var self = this;
        if (!this.selectedId) return;
        this.historyLoading = true;
        api.entityHistory(this.selectedId).then(function (h) {
          self.history = h; self.historyLoading = false;
        }).catch(function () { self.historyLoading = false; });
      },

      /* ---------- 基本信息 ---------- */
      saveSummary: function () {
        var self = this;
        if (!this.entity || this.summaryDraft === (this.entity.summary || "")) return;
        this.summarySaving = true;
        api.updateSummary(this.entity.entityId, this.summaryDraft).then(function () {
          self.summarySaving = false;
          ElMessage({ message: "摘要已保存", type: "success", duration: 2000 });
          self.$emit("changed");
        }).catch(function (err) {
          self.summarySaving = false;
          ElMessage({ message: "摘要保存失败：" + err.message, type: "error" });
        });
      },

      /* ---------- 属性编辑 ---------- */
      addRow: function () {
        this.newRows.push({ property: "", value: "", modality: "fact" });
      },
      removeNewRow: function (i) { this.newRows.splice(i, 1); },
      resetProps: function () { this.fillFromEntity(); this.newRows = []; },
      saveProps: function () {
        var self = this;
        var invalidated = [], newFacts = [];
        this.rows.forEach(function (r) {
          var newVal = U.parseValue(r.value);
          var changed = JSON.stringify(newVal) !== JSON.stringify(r.origValue) || r.modality !== r.origModality;
          if (r.deleted || changed) {
            invalidated.push({ declarationId: r.declarationId, property: r.property });
          }
          if (!r.deleted && changed) {
            newFacts.push({ entityId: self.entity.entityId, property: r.property, value: newVal, modality: r.modality });
          }
        });
        var badNew = false;
        this.newRows.forEach(function (r) {
          if (!r.property.trim()) {
            if (r.value.trim()) badNew = true;
            return;
          }
          newFacts.push({
            entityId: self.entity.entityId,
            property: r.property.trim(),
            value: U.parseValue(r.value),
            modality: r.modality
          });
        });
        if (badNew) { ElMessage({ message: "有新增行填了值但缺少属性名", type: "warning" }); return; }
        if (!invalidated.length && !newFacts.length) {
          ElMessage({ message: "没有改动", type: "info", duration: 2000 }); return;
        }
        var evt = {
          eventId: U.newEventId(),
          type: "change",
          storyTime: this.storyTime,
          entityId: this.entity.entityId,
          summary: "编辑 " + U.displayName(this.entity) + " 的属性（新增/修改 " + newFacts.length + " 条，失效 " + invalidated.length + " 条）",
          newFacts: newFacts,
          invalidated: invalidated
        };
        this.savingProps = true;
        api.postEvent(evt).then(function () {
          self.savingProps = false;
          ElMessage({ message: "属性修改已保存（生成 1 条 change 事件）", type: "success" });
          self.newRows = [];
          self.$emit("changed");
        }).catch(function (err) {
          self.savingProps = false;
          ElMessage({ message: "保存失败：" + err.message, type: "error" });
        });
      },

      /* ---------- 关系 ---------- */
      relPeerName: function (r) {
        var peer = r.sourceId === this.entity.entityId ? r.targetId : r.sourceId;
        return (this.entityNames[peer] || peer) + "（" + peer + "）";
      },
      relDir: function (r) {
        return r.sourceId === this.entity.entityId ? "→" : "←";
      },
      closeRel: function (r) {
        var self = this;
        window.ElementPlus.ElMessageBox.confirm(
          "闭合关系「" + r.label + "」（" + r.sourceId + " → " + r.targetId + "）？闭合后它将从「" + this.storyTime + "」起不再生效，历史记录保留。",
          "闭合关系",
          { confirmButtonText: "闭合", cancelButtonText: "取消", type: "warning" }
        ).then(function () {
          return api.closeRelation(r.sourceId, r.targetId, r.label, self.storyTime);
        }).then(function () {
          ElMessage({ message: "关系已闭合", type: "success", duration: 2000 });
          self.$emit("changed");
        }).catch(function (err) {
          if (err && err.message) ElMessage({ message: "闭合失败：" + err.message, type: "error" });
        });
      },
      onRelSubmit: function (payload) {
        var self = this;
        api.createRelation(payload.sourceId, payload.targetId, payload.label, this.storyTime).then(function () {
          self.relDialog = false;
          ElMessage({ message: "关系已创建", type: "success", duration: 2000 });
          self.$emit("changed");
        }).catch(function (err) {
          ElMessage({ message: "创建失败：" + err.message, type: "error" });
        });
      },

      /* ---------- 可见性 ---------- */
      loadVisibility: function () {
        var self = this;
        if (!this.visDeclId) { this.visRecords = []; return; }
        this.visLoading = true;
        api.declarationVisibility(this.visDeclId, this.storyTime).then(function (data) {
          self.visRecords = (data && data.visibility) || [];
          self.visLoading = false;
        }).catch(function (err) {
          self.visLoading = false;
          ElMessage({ message: "可见性加载失败：" + err.message, type: "error" });
        });
      },
      addVisibility: function () {
        var self = this;
        if (!this.visDeclId) { ElMessage({ message: "请先选择属性", type: "warning" }); return; }
        if (!this.visForm.characterId) { ElMessage({ message: "请选择角色", type: "warning" }); return; }
        this.visSaving = true;
        api.createVisibility(
          this.visForm.characterId, this.visDeclId,
          this.visForm.confidence, this.visForm.source.trim() || "manual",
          this.storyTime
        ).then(function () {
          self.visSaving = false;
          ElMessage({ message: "可见性已添加", type: "success", duration: 2000 });
          self.visForm = { characterId: "", confidence: 1, source: "" };
          self.loadVisibility();
          self.$emit("changed");
        }).catch(function (err) {
          self.visSaving = false;
          ElMessage({ message: "添加失败：" + err.message, type: "error" });
        });
      },
      revokeVisibility: function (rec) {
        var self = this;
        api.closeVisibility(rec.characterId, this.visDeclId, this.storyTime).then(function () {
          ElMessage({ message: "已撤销", type: "success", duration: 2000 });
          self.loadVisibility();
          self.$emit("changed");
        }).catch(function (err) {
          ElMessage({ message: "撤销失败：" + err.message, type: "error" });
        });
      },

      /* ---------- 消亡 ---------- */
      killEntity: function () {
        var self = this;
        var name = U.displayName(this.entity);
        window.ElementPlus.ElMessageBox.confirm(
          "确定让「" + name + "」在故事时间「" + this.storyTime + "」消亡吗？" +
          "该实体当前有 " + this.activeRelCount + " 条生效中的关系。消亡后实体不再出现于之后的时刻，历史记录保留。",
          "消亡实体",
          { confirmButtonText: "消亡", cancelButtonText: "取消", type: "error" }
        ).then(function () {
          return api.postEvent({
            eventId: U.newEventId(),
            type: "death",
            storyTime: self.storyTime,
            entityId: self.entity.entityId,
            summary: "消亡实体 " + name
          });
        }).then(function () {
          ElMessage({ message: "「" + name + "」已消亡", type: "success" });
          self.$emit("changed");
        }).catch(function (err) {
          if (err && err.message) ElMessage({ message: "操作失败：" + err.message, type: "error" });
        });
      }
    },
    template: `
      <aside id="right">
        <div v-if="!entity" class="empty">
          <template v-if="selectedId">实体「{{ selectedId }}」在故事时间「{{ storyTime }}」不存在<br>（尚未诞生或已消亡）</template>
          <template v-else>点击左侧列表或图中的节点<br>查看和编辑实体详情</template>
        </div>
        <template v-else>
          <div class="detail-head">
            <span class="name">{{ displayName(entity) }}</span>
            <span class="mod" :style="{ background: typeColor(entity.type) + '33', color: typeColor(entity.type) }">{{ typeName(entity.type) }}</span>
            <span v-if="dead" style="color:#c0392b;font-size:12px">† 已消亡</span>
            <span class="spacer"></span>
            <el-button v-if="!dead" type="danger" size="small" plain @click="killEntity">消亡实体</el-button>
          </div>

          <div class="sec">
            <h3>基本信息</h3>
            <div class="kv"><span class="k">实体 ID</span><span class="v">{{ entity.entityId }}</span></div>
            <div class="kv"><span class="k">类型</span><span class="v" :style="{ color: typeColor(entity.type) }">{{ typeName(entity.type) }}</span></div>
            <div class="kv"><span class="k">诞生</span><span class="v">{{ entity.validFrom }}</span></div>
            <div class="kv"><span class="k">消亡</span><span class="v">{{ dead ? entity.validTo : '至今' }}</span></div>
            <div class="kv" style="align-items:flex-start"><span class="k">摘要</span>
              <span class="v">
                <el-input v-model="summaryDraft" type="textarea" :rows="2" :disabled="dead"
                          placeholder="一句话描述这个实体，仅作者可见" @blur="saveSummary"></el-input>
                <div class="form-tip">失焦自动保存{{ summarySaving ? '（保存中…）' : '' }}</div>
              </span>
            </div>
          </div>

          <div class="sec">
            <h3>属性（当前时刻生效）</h3>
            <div class="note">每次保存生成一条 change 事件，旧值不会丢失，可在「历史」区查看。值会自动识别数字 / true / false。</div>
            <el-table :data="rows" size="small" style="width:100%">
              <el-table-column label="属性名" width="76">
                <template #default="scope"><span :class="{ strike: scope.row.deleted }">{{ scope.row.property }}</span></template>
              </el-table-column>
              <el-table-column label="值" min-width="110">
                <template #default="scope">
                  <el-input v-model="scope.row.value" size="small"
                            :disabled="dead || scope.row.deleted || lockedSet[scope.row.declarationId]"></el-input>
                  <div v-if="lockedSet[scope.row.declarationId]" class="form-tip">当前角色视角不可见，已锁定</div>
                </template>
              </el-table-column>
              <el-table-column label="模态" width="86">
                <template #default="scope">
                  <el-select v-model="scope.row.modality" size="small"
                             :disabled="dead || scope.row.deleted || lockedSet[scope.row.declarationId]">
                    <el-option value="fact" label="事实"></el-option>
                    <el-option value="belief" label="信念"></el-option>
                    <el-option value="hypothesis" label="推测"></el-option>
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="" width="52">
                <template #default="scope">
                  <el-button v-if="!scope.row.deleted" size="small" text type="danger"
                             :disabled="dead || lockedSet[scope.row.declarationId]"
                             @click="scope.row.deleted = true">删除</el-button>
                  <el-button v-else size="small" text @click="scope.row.deleted = false">撤销</el-button>
                </template>
              </el-table-column>
              <template #empty><div class="text-2 small" style="padding:8px">该实体在此刻没有属性</div></template>
            </el-table>

            <div v-for="(r, i) in newRows" :key="i" style="display:flex;gap:6px;margin-top:6px">
              <el-input v-model="r.property" size="small" placeholder="属性名" style="width:80px"></el-input>
              <el-input v-model="r.value" size="small" placeholder="值" style="flex:1"></el-input>
              <el-select v-model="r.modality" size="small" style="width:82px">
                <el-option value="fact" label="事实"></el-option>
                <el-option value="belief" label="信念"></el-option>
                <el-option value="hypothesis" label="推测"></el-option>
              </el-select>
              <el-button size="small" text type="danger" @click="removeNewRow(i)">×</el-button>
            </div>
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
              <el-button size="small" :disabled="dead" @click="addRow">+ 添加属性</el-button>
              <span class="spacer" style="flex:1"></span>
              <el-button size="small" :disabled="dead" @click="resetProps">重置</el-button>
              <el-button size="small" type="primary" :loading="savingProps" :disabled="dead" @click="saveProps">保存修改</el-button>
            </div>
          </div>

          <div class="sec">
            <h3>关系</h3>
            <el-table :data="myRelations" size="small" style="width:100%">
              <el-table-column label="方向" width="46">
                <template #default="scope"><span class="rel-dir">{{ relDir(scope.row) }}</span></template>
              </el-table-column>
              <el-table-column label="对端" min-width="110">
                <template #default="scope">
                  <span :class="{ strike: isClosed(scope.row) }" style="cursor:pointer;color:#6ea8fe"
                        @click="$emit('select', scope.row.sourceId === entity.entityId ? scope.row.targetId : scope.row.sourceId)">{{ relPeerName(scope.row) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="关系名" min-width="80">
                <template #default="scope"><span :class="{ strike: isClosed(scope.row) }">{{ scope.row.label }}</span></template>
              </el-table-column>
              <el-table-column label="生效时间" width="76">
                <template #default="scope"><span class="text-2 small">{{ scope.row.validFrom }}</span></template>
              </el-table-column>
              <el-table-column label="" width="56">
                <template #default="scope">
                  <el-button v-if="!isClosed(scope.row)" size="small" text type="danger"
                             :disabled="dead" @click="closeRel(scope.row)">闭合</el-button>
                  <span v-else class="text-2 small">已闭合</span>
                </template>
              </el-table-column>
              <template #empty><div class="text-2 small" style="padding:8px">此刻没有关系</div></template>
            </el-table>
            <el-button size="small" style="margin-top:8px" :disabled="dead" @click="relDialog = true">+ 新建关系</el-button>
            <relation-form v-model="relDialog" :source-id="entity.entityId" :source-name="displayName(entity)"
                           :entities="allEntities" :story-time="storyTime" @submit="onRelSubmit"></relation-form>
          </div>

          <div class="sec">
            <h3>可见性</h3>
            <div class="note">设置哪些角色「知道」某条属性。角色视角模式下，不可见的属性会被置灰。</div>
            <el-select v-model="visDeclId" placeholder="选择要查看的属性" size="small" style="width:100%">
              <el-option v-for="f in (entity.properties || [])" :key="f.declarationId" :value="f.declarationId"
                         :label="f.property + ' = ' + fmtValue(f.value)"></el-option>
            </el-select>
            <div v-loading="visLoading" style="margin-top:8px">
              <el-table v-if="visDeclId" :data="visRecords" size="small" style="width:100%">
                <el-table-column label="角色" min-width="90">
                  <template #default="scope">{{ entityNames[scope.row.characterId] || scope.row.characterId }}</template>
                </el-table-column>
                <el-table-column label="置信度" width="64">
                  <template #default="scope">{{ scope.row.confidence }}</template>
                </el-table-column>
                <el-table-column label="来源" min-width="80">
                  <template #default="scope"><span class="text-2">{{ scope.row.source }}</span></template>
                </el-table-column>
                <el-table-column label="" width="56">
                  <template #default="scope">
                    <el-button v-if="scope.row.validTo === 'Infinity'" size="small" text type="danger"
                               @click="revokeVisibility(scope.row)">撤销</el-button>
                    <span v-else class="text-2 small">已撤销</span>
                  </template>
                </el-table-column>
                <template #empty><div class="text-2 small" style="padding:8px">该属性暂无可见性记录（默认所有角色不可见）</div></template>
              </el-table>
              <div v-if="visDeclId" style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap">
                <el-select v-model="visForm.characterId" size="small" placeholder="角色" style="width:110px" filterable>
                  <el-option v-for="c in characters" :key="c.entityId" :value="c.entityId"
                             :label="displayName(c)"></el-option>
                </el-select>
                <el-input-number v-model="visForm.confidence" size="small" :min="0" :max="1" :step="0.1"
                                 style="width:96px"></el-input-number>
                <el-input v-model="visForm.source" size="small" placeholder="来源：witnessed=目击 rumor=传闻" style="flex:1;min-width:120px"></el-input>
                <el-button size="small" type="primary" :loading="visSaving" @click="addVisibility">添加</el-button>
              </div>
            </div>
          </div>

          <div class="sec">
            <h3>历史</h3>
            <div class="note">该实体的全部版本记录（含已闭合，删除线表示已失效）。</div>
            <div v-loading="historyLoading">
              <el-timeline v-if="historyItems.length" style="padding-left:2px">
                <el-timeline-item v-for="(it, i) in historyItems" :key="i" :timestamp="it.t + (it.closed ? ' → ' + it.validTo : '')" size="small">
                  <span class="text-2 small">[{{ it.kind }}]</span>
                  <span :class="{ strike: it.closed }"> {{ it.text }}</span>
                </el-timeline-item>
              </el-timeline>
              <div v-else-if="!historyLoading" class="text-2 small">暂无历史记录</div>
            </div>
          </div>
        </template>
      </aside>
    `
  };
})();
