/* entity-form.js — 新建实体对话框（birth 事件） */
(function () {
  "use strict";
  var U = window.V3.util;
  var api = window.V3.api;

  window.V3.components.EntityForm = {
    name: "EntityForm",
    props: {
      modelValue: { type: Boolean, default: false },
      storyTime: { type: String, default: "" }
    },
    emits: ["update:modelValue", "created"],
    data: function () {
      return {
        id: "",
        type: "character",
        summary: "",
        props: [],
        saving: false
      };
    },
    computed: {
      idValid: function () { return /^[a-z0-9][a-z0-9-_]*$/.test(this.id); },
      typeOptions: function () {
        var D = U.TYPE_DESC;
        return [
          { value: "character", label: D.character },
          { value: "location", label: D.location },
          { value: "item", label: D.item },
          { value: "concept", label: D.concept }
        ];
      }
    },
    watch: {
      modelValue: function (v) {
        if (v) { this.id = ""; this.type = "character"; this.summary = ""; this.props = []; }
      }
    },
    methods: {
      addProp: function () { this.props.push({ property: "", value: "", modality: "fact" }); },
      removeProp: function (i) { this.props.splice(i, 1); },
      submit: function () {
        var self = this;
        if (!this.idValid) {
          window.ElementPlus.ElMessage({ message: "实体 ID 需以小写字母或数字开头，仅含小写字母/数字/连字符/下划线", type: "warning" });
          return;
        }
        var newFacts = [];
        for (var i = 0; i < this.props.length; i++) {
          var p = this.props[i];
          if (!p.property.trim()) {
            if (p.value.trim()) {
              window.ElementPlus.ElMessage({ message: "有属性行填了值但缺少属性名", type: "warning" });
              return;
            }
            continue;
          }
          newFacts.push({
            entityId: this.id,
            property: p.property.trim(),
            value: U.parseValue(p.value),
            modality: p.modality
          });
        }
        var evt = {
          eventId: U.newEventId(),
          type: "birth",
          storyTime: this.storyTime,
          entityId: this.id,
          entityType: this.type,
          summary: this.summary.trim(),
          newFacts: newFacts
        };
        this.saving = true;
        api.postEvent(evt).then(function () {
          self.saving = false;
          self.$emit("update:modelValue", false);
          window.ElementPlus.ElMessage({ message: "实体「" + self.id + "」已创建", type: "success" });
          self.$emit("created", self.id);
        }).catch(function (err) {
          self.saving = false;
          window.ElementPlus.ElMessage({ message: "创建失败：" + err.message, type: "error" });
        });
      }
    },
    template: `
      <el-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)"
                 title="新建实体" width="520px">
        <el-form label-width="80px" label-position="left">
          <el-form-item label="实体 ID" required>
            <el-input v-model="id" placeholder="如 linmo、qingshuang-jian"></el-input>
            <div class="form-tip" :style="{ color: id && !idValid ? '#c0392b' : '' }">
              唯一标识，创建后不可改。小写字母/数字开头，可含 - 和 _
            </div>
          </el-form-item>
          <el-form-item label="类型" required>
            <el-select v-model="type" style="width:100%">
              <el-option v-for="o in typeOptions" :key="o.value" :value="o.value" :label="o.label"></el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="摘要">
            <el-input v-model="summary" placeholder="一句话描述这个实体"></el-input>
            <div class="form-tip">会显示在列表和图节点悬停提示里，仅作者可见、不影响剧情逻辑</div>
          </el-form-item>
          <el-form-item label="初始属性">
            <div style="width:100%">
              <div v-for="(p, i) in props" :key="i" style="display:flex;gap:6px;margin-bottom:6px">
                <el-input v-model="p.property" size="small" placeholder="属性名，如 姓名" style="width:110px"></el-input>
                <el-input v-model="p.value" size="small" placeholder="值，如 林墨" style="flex:1"></el-input>
                <el-select v-model="p.modality" size="small" style="width:86px">
                  <el-option value="fact" label="事实"></el-option>
                  <el-option value="belief" label="信念"></el-option>
                  <el-option value="hypothesis" label="推测"></el-option>
                </el-select>
                <el-button size="small" text type="danger" @click="removeProp(i)">×</el-button>
              </div>
              <el-button size="small" @click="addProp">+ 添加属性行</el-button>
              <div class="form-tip">每行一个属性，作为该实体的「事实声明」存进图谱，之后可随时增删改</div>
            </div>
          </el-form-item>
        </el-form>
        <div class="form-tip" style="margin-top:4px">该实体将在故事时间「{{ storyTime }}」诞生</div>
        <template #footer>
          <el-button @click="$emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="!idValid" @click="submit">创建</el-button>
        </template>
      </el-dialog>
    `
  };
})();
