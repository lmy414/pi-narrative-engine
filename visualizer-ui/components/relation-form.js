/* relation-form.js — 新建关系弹窗（当前实体 → 对端实体） */
(function () {
  "use strict";
  var U = window.V3.util;

  window.V3.components.RelationForm = {
    name: "RelationForm",
    props: {
      modelValue: { type: Boolean, default: false },
      sourceId: { type: String, default: "" },
      sourceName: { type: String, default: "" },
      entities: { type: Array, default: function () { return []; } },
      storyTime: { type: String, default: "" }
    },
    emits: ["update:modelValue", "submit"],
    data: function () {
      return { targetId: "", label: "" };
    },
    computed: {
      candidates: function () {
        var self = this;
        return this.entities
          .filter(function (e) { return e.entityId !== self.sourceId && !U.isDead(e); })
          .map(function (e) {
            return { id: e.entityId, name: U.displayName(e), type: e.type };
          });
      }
    },
    watch: {
      modelValue: function (v) { if (v) { this.targetId = ""; this.label = ""; } }
    },
    methods: {
      typeName: function (t) { return U.TYPE_NAME[t] || t; },
      ok: function () {
        if (!this.targetId) {
          window.ElementPlus.ElMessage({ message: "请选择对端实体", type: "warning" }); return;
        }
        if (!this.label.trim()) {
          window.ElementPlus.ElMessage({ message: "请填写关系名", type: "warning" }); return;
        }
        this.$emit("submit", {
          sourceId: this.sourceId,
          targetId: this.targetId,
          label: this.label.trim()
        });
      }
    },
    template: `
      <el-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)"
                 title="新建关系" width="440px">
        <el-form label-width="80px" label-position="left">
          <el-form-item label="起点">
            <span>{{ sourceName }} <span class="text-2 small">（{{ sourceId }}）</span></span>
          </el-form-item>
          <el-form-item label="对端实体">
            <el-select v-model="targetId" filterable placeholder="搜索并选择关系指向的实体" style="width:100%">
              <el-option v-for="c in candidates" :key="c.id" :value="c.id"
                         :label="c.name + '（' + typeName(c.type) + ' · ' + c.id + '）'"></el-option>
            </el-select>
            <div class="form-tip">关系方向：{{ sourceName }} —关系名→ 对端实体</div>
          </el-form-item>
          <el-form-item label="关系名">
            <el-input v-model="label" placeholder="如 师徒 / 持有 / located_in（位于）"></el-input>
            <div class="form-tip">中文或英文均可，会显示在关系图的连线上</div>
          </el-form-item>
        </el-form>
        <div class="form-tip">关系将在故事时间「{{ storyTime }}」生效</div>
        <template #footer>
          <el-button @click="$emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" @click="ok">创建</el-button>
        </template>
      </el-dialog>
    `
  };
})();
