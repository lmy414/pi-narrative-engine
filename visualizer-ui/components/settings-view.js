/* settings-view.js — 设置页（阶段 2a，原型设计体系）
 *
 * 子页（左导航）：概览 / 扩展配置 / 规则集 / 向量模型 / 依赖与升级 / 高级
 * 功能边界（config-ui 设计文档 §4.2）：
 * - LLM 模型与 Key 归 PI 管，本页只读展示，不提供编辑
 * - .env 只写扩展专属变量（HF_ENDPOINT / PI_DEBUG / PI_EMBEDDER_MODEL）
 * - 规则集保存即生效；.env 改动需重启 PI 会话生效
 */
(function () {
  "use strict";
  var api = window.V3.api;
  var U = window.V3.putil;

  var SECTIONS = [
    { key: "overview", label: "概览", icon: "house" },
    { key: "config", label: "扩展配置", icon: "settings" },
    { key: "rulesets", label: "规则集", icon: "pen-line" },
    { key: "embedder", label: "向量模型", icon: "box" },
    { key: "deps", label: "依赖与升级", icon: "circle-check" },
    { key: "advanced", label: "高级", icon: "tag" }
  ];

  var RULESET_TABS = [
    { name: "render", label: "渲染规则集" },
    { name: "planner", label: "planner 规则集" },
    { name: "role", label: "角色规则集" }
  ];

  window.V3.components.SettingsView = {
    components: { StreamView: window.V3.components.StreamView },
    props: {
      active: { type: Object, default: null }
    },
    emits: ["toast"],
    data: function () {
      return {
        sections: SECTIONS,
        section: "overview",
        // 概览
        piStatus: null,
        version: null,
        embedderStatus: null,
        overviewLoading: false,
        // 扩展配置
        config: null,
        configForm: { HF_ENDPOINT: "", PI_DEBUG: "", PI_EMBEDDER_MODEL: "" },
        configSaving: false,
        // 规则集
        rulesets: [],
        rulesetTab: "render",
        rulesetDraft: "",
        rulesetSaved: "",
        rulesetSaving: false,
        // 依赖与升级
        doctor: null,
        doctorLoading: false,
        updateLines: [],
        updateRunning: false,
        updateSource: null,
        // 扩展管理（§5.4）
        extConfig: null,         // app-config 的 extension 段
        extCheck: null,          // update-check 结果
        extReinstalling: false,
        // 高级
        novelJson: null,
        novelForm: { name: "", chaptersDir: "", storyTimeFormat: "" },
        novelSaving: false
      };
    },
    computed: {
      currentRuleset: function () {
        for (var i = 0; i < this.rulesets.length; i++) {
          if (this.rulesets[i].name === this.rulesetTab) return this.rulesets[i];
        }
        return null;
      },
      rulesetDirty: function () {
        return this.rulesetDraft !== this.rulesetSaved;
      },
      updateAvailable: function () {
        return !!(this.version && this.version.updateAvailable);
      }
    },
    watch: {
      active: function () { this.loadSection(); },
      section: function () { this.loadSection(); },
      rulesetTab: function () {
        var r = this.currentRuleset;
        this.rulesetDraft = r ? r.content : "";
        this.rulesetSaved = this.rulesetDraft;
      }
    },
    mounted: function () { this.loadSection(); },
    methods: {
      fmtSize: U.formatBytes,
      toast: function (message, type) {
        this.$emit("toast", { message: message, type: type || "success" });
      },
      loadSection: function () {
        if (this.section === "overview") this.loadOverview();
        else if (this.section === "config") this.loadConfig();
        else if (this.section === "rulesets") this.loadRulesets();
        else if (this.section === "embedder") this.loadEmbedder();
        else if (this.section === "advanced") this.loadNovelJson();
        else if (this.section === "deps") this.loadExtension();
        // deps 的 doctor 手动触发（较慢）
      },
      // ============ 扩展管理 ============
      loadExtension: function () {
        var self = this;
        api.adminAppConfig().then(function (c) {
          self.extConfig = c.extension || null;
        }).catch(function () { self.extConfig = null; });
      },
      toggleExtension: function () {
        var self = this;
        if (!this.extConfig) return;
        var next = this.extConfig.mode === "disabled" ? "enabled" : "disabled";
        api.adminExtensionMode(next).then(function (ext) {
          self.extConfig = ext;
          self.toast(next === "disabled"
            ? "扩展已禁用：下次启动 PI 为纯净模式（--no-extensions）"
            : "扩展已启用：下次启动 PI 生效");
        }).catch(function (err) {
          self.toast("切换失败：" + err.message, "error");
        });
      },
      checkExtension: function () {
        var self = this;
        api.adminExtensionUpdateCheck().then(function (r) {
          self.extCheck = r;
          self.toast(r.updateAvailable ? "快照有新版本：" + r.available : "已安装版本与快照一致");
        }).catch(function (err) {
          self.toast("检查失败：" + err.message, "error");
        });
      },
      reinstallExtension: function () {
        var self = this;
        if (this.extReinstalling) return;
        if (!window.confirm("从应用内置快照重装全局扩展（含 npm install，可能耗时较长）？")) return;
        this.extReinstalling = true;
        api.adminExtensionReinstall(false).then(function (r) {
          self.extReinstalling = false;
          self.toast("重装完成（复制 " + r.copiedFiles + " 个文件）");
          self.loadExtension();
        }).catch(function (err) {
          self.extReinstalling = false;
          self.toast("重装失败：" + err.message, "error");
        });
      },
      // ============ 概览 ============
      loadOverview: function () {
        var self = this;
        this.overviewLoading = true;
        var safe = function (p) { return p.catch(function () { return null; }); };
        Promise.all([
          safe(api.adminPiStatus()),
          safe(api.adminVersion()),
          safe(api.adminEmbedderStatus())
        ]).then(function (rs) {
          self.piStatus = rs[0];
          self.version = rs[1];
          self.embedderStatus = rs[2];
          self.overviewLoading = false;
        });
      },
      // ============ 扩展配置 ============
      loadConfig: function () {
        var self = this;
        if (!this.active) { this.config = null; return; }
        api.adminConfig().then(function (c) {
          self.config = c;
          var v = c.values || {};
          self.configForm = {
            HF_ENDPOINT: v.HF_ENDPOINT || "",
            PI_DEBUG: v.PI_DEBUG || "",
            PI_EMBEDDER_MODEL: v.PI_EMBEDDER_MODEL || ""
          };
        }).catch(function (err) {
          if (err.code !== "NO_ACTIVE_PROJECT") self.toast("读取配置失败：" + err.message, "error");
        });
      },
      saveConfig: function () {
        var self = this;
        this.configSaving = true;
        var updates = {};
        ["HF_ENDPOINT", "PI_DEBUG", "PI_EMBEDDER_MODEL"].forEach(function (k) {
          var v = (self.configForm[k] || "").trim();
          updates[k] = v === "" ? null : v;   // 空 = 删除该 KEY
        });
        api.adminConfigWrite(updates).then(function (c) {
          self.config = c;
          self.configSaving = false;
          self.toast("已保存到 .env（重启 PI 会话后生效）");
        }).catch(function (err) {
          self.configSaving = false;
          self.toast("保存失败：" + err.message, "error");
        });
      },
      // ============ 规则集 ============
      loadRulesets: function () {
        var self = this;
        if (!this.active) { this.rulesets = []; return; }
        api.adminRulesets().then(function (data) {
          self.rulesets = data.rulesets || [];
          var r = self.currentRuleset;
          self.rulesetDraft = r ? r.content : "";
          self.rulesetSaved = self.rulesetDraft;
        }).catch(function (err) {
          if (err.code !== "NO_ACTIVE_PROJECT") self.toast("读取规则集失败：" + err.message, "error");
        });
      },
      saveRuleset: function () {
        var self = this;
        this.rulesetSaving = true;
        api.adminRulesetWrite(this.rulesetTab, this.rulesetDraft).then(function (r) {
          self.rulesetSaving = false;
          self.rulesetSaved = self.rulesetDraft;
          var i = self.rulesets.findIndex(function (x) { return x.name === self.rulesetTab; });
          if (i >= 0) self.rulesets.splice(i, 1, r);
          self.toast("规则集已保存（即时生效）");
        }).catch(function (err) {
          self.rulesetSaving = false;
          self.toast("保存失败：" + err.message, "error");
        });
      },
      resetRuleset: function () {
        var self = this;
        if (!window.confirm("从模板恢复默认规则集？当前内容将被覆盖。")) return;
        api.adminRulesetReset(this.rulesetTab).then(function (r) {
          var i = self.rulesets.findIndex(function (x) { return x.name === self.rulesetTab; });
          if (i >= 0) self.rulesets.splice(i, 1, r);
          self.rulesetDraft = r.content;
          self.rulesetSaved = r.content;
          self.toast("已恢复默认规则集");
        }).catch(function (err) {
          self.toast("恢复失败：" + err.message, "error");
        });
      },
      // ============ 向量模型 ============
      loadEmbedder: function () {
        var self = this;
        api.adminEmbedderStatus().then(function (s) {
          self.embedderStatus = s;
        }).catch(function (err) {
          self.toast("读取向量模型状态失败：" + err.message, "error");
        });
        // M21 修复：向量模型子页复用 configForm 保存 PI_EMBEDDER_MODEL，
        // 必须先 loadConfig 填充 HF_ENDPOINT/PI_DEBUG，否则 saveConfig 会用空串覆盖
        this.loadConfig();
      },
      clearCache: function () {
        var self = this;
        if (!window.confirm("清理向量模型缓存？下次使用将重新下载。")) return;
        api.adminEmbedderCacheClear().then(function (r) {
          self.toast("缓存已清理（释放 " + U.formatBytes(r.clearedBytes) + "）");
          self.loadEmbedder();
        }).catch(function (err) {
          self.toast("清理失败：" + err.message, "error");
        });
      },
      warmup: function () {
        var self = this;
        api.adminEmbedderWarmup().then(function (r) {
          self.toast("预热完成（" + r.latencyMs + "ms）");
          self.loadEmbedder();
        }).catch(function (err) {
          self.toast("预热失败：" + err.message, "error");
        });
      },
      // ============ 依赖与升级 ============
      runDoctor: function () {
        var self = this;
        this.doctorLoading = true;
        api.adminDoctor().then(function (r) {
          self.doctor = r;
          self.doctorLoading = false;
        }).catch(function (err) {
          self.doctorLoading = false;
          self.toast("依赖检查失败：" + err.message, "error");
        });
      },
      checkVersion: function () {
        var self = this;
        api.adminVersion().then(function (v) {
          self.version = v;
          self.toast(v.updateAvailable ? "发现新版本：" + v.remote : "已是最新版本");
        }).catch(function (err) {
          self.toast("检查更新失败：" + err.message, "error");
        });
      },
      startUpdate: function () {
        var self = this;
        if (this.updateRunning) return;
        if (!window.confirm("执行一键更新（git pull + build + sync）？")) return;
        this.updateLines = [];
        this.updateRunning = true;
        var es = api.adminUpdateStream();
        this.updateSource = es;
        es.onmessage = function (e) {
          var evt;
          try { evt = JSON.parse(e.data); } catch (err) { return; }
          self.updateLines.push(evt);
          if (evt.stage === "done" || evt.stage === "error") {
            self.updateRunning = false;
            es.close();
            self.updateSource = null;
            if (evt.stage === "done") {
              self.toast("更新完成，请在 PI 会话内执行 /reload");
            } else {
              self.toast("更新失败：" + (evt.error || "未知错误"), "error");
            }
          }
        };
        es.onerror = function () {
          self.updateRunning = false;
          es.close();
          self.updateSource = null;
        };
      },
      // ============ 高级 ============
      loadNovelJson: function () {
        var self = this;
        if (!this.active) { this.novelJson = null; return; }
        api.adminNovelJson().then(function (r) {
          self.novelJson = r.data;
          self.novelForm = {
            name: r.data.name || "",
            chaptersDir: r.data.chaptersDir || "",
            storyTimeFormat: r.data.storyTimeFormat || ""
          };
        }).catch(function (err) {
          if (err.code !== "NO_ACTIVE_PROJECT") self.toast("读取 novel.json 失败：" + err.message, "error");
        });
      },
      saveNovelJson: function () {
        var self = this;
        this.novelSaving = true;
        api.adminNovelJsonWrite(this.novelForm).then(function (d) {
          self.novelJson = d;
          self.novelSaving = false;
          self.toast("novel.json 已保存");
        }).catch(function (err) {
          self.novelSaving = false;
          self.toast("保存失败：" + err.message, "error");
        });
      },
      rulesetLabel: function (name) {
        var t = RULESET_TABS.find(function (x) { return x.name === name; });
        return t ? t.label : name;
      }
    },
    template: `
      <div class="proto-page">
        <div v-if="!active" class="proto-empty">
          尚未激活项目。设置页大部分功能需要活跃项目，请先到「项目管理」页激活。
        </div>
        <div v-else class="settings-layout">
          <nav class="settings-nav">
            <div v-for="s in sections" :key="s.key" class="sn-item"
                 :class="{ active: section === s.key }" @click="section = s.key">
              <span :data-icon="s.icon"></span>{{ s.label }}
            </div>
          </nav>

          <div class="settings-content">
            <!-- 概览 -->
            <template v-if="section === 'overview'">
              <div class="pcard settings-section">
                <div class="sec-title">当前状态</div>
                <div class="overview-grid">
                  <div>
                    <div class="ov-item"><span class="ov-label">当前项目</span><span class="ov-value">{{ active.name }}</span></div>
                    <div class="ov-item"><span class="ov-label">PI 模型</span>
                      <span class="ov-value">{{ piStatus && piStatus.model ? piStatus.model.id : "（PI 未连接）" }}</span>
                    </div>
                    <div class="ov-item"><span class="ov-label">API Key</span>
                      <span class="check-status" :class="piStatus && piStatus.hasKey ? 'pass' : 'warn'">
                        <span :data-icon="piStatus && piStatus.hasKey ? 'circle-check' : 'circle-alert'"></span>
                        {{ piStatus ? (piStatus.hasKey ? "已配置" : "未配置") : "未知" }}
                      </span>
                    </div>
                    <div class="ov-item"><span class="ov-label">PI 版本</span>
                      <span class="ov-value">{{ piStatus && piStatus.piVersion ? piStatus.piVersion : "未知" }}</span>
                    </div>
                  </div>
                  <div>
                    <div class="ov-item"><span class="ov-label">扩展版本</span>
                      <span class="ov-value">{{ version ? version.local : "…" }}
                        <span v-if="updateAvailable" class="status-pill" data-status="active">可更新 {{ version.remote }}</span>
                      </span>
                    </div>
                    <div class="ov-item"><span class="ov-label">向量模型</span>
                      <span class="ov-value">{{ embedderStatus ? embedderStatus.model : "…" }}</span>
                    </div>
                    <div class="ov-item"><span class="ov-label">模型缓存</span>
                      <span class="check-status" :class="embedderStatus && embedderStatus.cachePresent ? 'pass' : 'warn'">
                        <span :data-icon="embedderStatus && embedderStatus.cachePresent ? 'circle-check' : 'circle-alert'"></span>
                        {{ embedderStatus ? (embedderStatus.cachePresent ? "已下载" : "未下载") : "…" }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="sec-desc" style="margin-top:10px;margin-bottom:0">
                  模型与 Key 请在 PI 内配置：/model 切换模型，pi login 登录，或设置环境变量。
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="pbtn" @click="section = 'deps'; runDoctor()">
                  <span data-icon="circle-check"></span>一键检查依赖
                </button>
                <button class="pbtn" @click="section = 'deps'; checkVersion()">
                  <span data-icon="arrow-right"></span>检查更新
                </button>
              </div>
            </template>

            <!-- 扩展配置 -->
            <template v-if="section === 'config'">
              <div class="pcard settings-section">
                <div class="sec-title">扩展环境变量（写入项目 .env）</div>
                <div class="pfield">
                  <label class="plabel">HF 镜像（HF_ENDPOINT，如 hf-mirror.com，留空为官方）</label>
                  <input class="pinput" v-model="configForm.HF_ENDPOINT" placeholder="hf-mirror.com">
                </div>
                <div class="pfield">
                  <label class="plabel">调试总线（PI_DEBUG，off 为关闭）</label>
                  <select class="pselect" v-model="configForm.PI_DEBUG">
                    <option value="">启用（默认）</option>
                    <option value="off">关闭</option>
                  </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <button class="pbtn primary" :disabled="configSaving" @click="saveConfig">
                    {{ configSaving ? "保存中…" : "保存到 .env" }}
                  </button>
                  <span class="sec-desc" style="margin:0">需重启 PI 会话生效</span>
                </div>
              </div>
              <div class="pcard settings-section">
                <div class="sec-title">PI 配置指引（只读）</div>
                <div class="sec-desc">
                  LLM 模型与 API Key 由 PI 本体管理：/model 切换模型；pi login 登录；
                  环境变量 DEEPSEEK_API_KEY 等；settings.json 的 defaultModel。
                </div>
              </div>
            </template>

            <!-- 规则集 -->
            <template v-if="section === 'rulesets'">
              <div class="pcard settings-section">
                <div class="sec-title" style="display:flex;gap:8px;align-items:center">
                  <div class="tab-nav">
                    <a v-for="t in [
                        { name: 'render', label: '渲染规则集' },
                        { name: 'planner', label: 'planner 规则集' },
                        { name: 'role', label: '角色规则集' }
                      ]" :key="t.name" class="tab-item" :class="{ active: rulesetTab === t.name }"
                       @click="rulesetTab = t.name">{{ t.label }}</a>
                  </div>
                  <span style="flex:1"></span>
                  <span v-if="rulesetDirty" class="dirty" style="font-size:12px;color:var(--chart-1)">●未保存</span>
                </div>
                <textarea class="ptextarea" rows="18" v-model="rulesetDraft"
                          :placeholder="currentRuleset ? '' : '（文件不存在，保存时将创建）'"></textarea>
                <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
                  <button class="pbtn primary" :disabled="!rulesetDirty || rulesetSaving" @click="saveRuleset">
                    {{ rulesetSaving ? "保存中…" : "保存" }}
                  </button>
                  <button class="pbtn" @click="resetRuleset">恢复默认</button>
                  <span class="sec-desc" style="margin:0" v-if="currentRuleset">
                    字数 {{ currentRuleset.content.length }} · 保存即时生效
                  </span>
                </div>
              </div>
            </template>

            <!-- 向量模型 -->
            <template v-if="section === 'embedder'">
              <div class="pcard settings-section">
                <div class="sec-title">向量模型</div>
                <div class="ov-item"><span class="ov-label">当前模型</span>
                  <span class="ov-value">{{ embedderStatus ? embedderStatus.model : "…" }}</span>
                </div>
                <div class="ov-item"><span class="ov-label">维度</span>
                  <span class="ov-value">{{ embedderStatus && embedderStatus.dim ? embedderStatus.dim : "512（默认）" }}</span>
                </div>
                <div class="pfield" style="margin-top:10px">
                  <label class="plabel">切换模型（PI_EMBEDDER_MODEL，需同为 512 维，留空恢复默认）</label>
                  <input class="pinput" v-model="configForm.PI_EMBEDDER_MODEL" placeholder="Xenova/bge-small-zh-v1.5">
                </div>
                <button class="pbtn primary" :disabled="configSaving" @click="saveConfig">保存到 .env</button>
              </div>
              <div class="pcard settings-section">
                <div class="sec-title">缓存</div>
                <div class="ov-item"><span class="ov-label">状态</span>
                  <span class="check-status" :class="embedderStatus && embedderStatus.cachePresent ? 'pass' : 'warn'">
                    {{ embedderStatus ? (embedderStatus.cachePresent ? "已下载（" + fmtSize(embedderStatus.cacheSizeBytes) + "）" : "未下载") : "…" }}
                  </span>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px">
                  <button class="pbtn" @click="warmup">重新下载 / 预热</button>
                  <button class="pbtn danger" @click="clearCache">清理缓存</button>
                </div>
              </div>
            </template>

            <!-- 依赖与升级 -->
            <template v-if="section === 'deps'">
              <div class="pcard settings-section">
                <div class="sec-title" style="display:flex;align-items:center;gap:8px">
                  依赖检查
                  <span style="flex:1"></span>
                  <button class="pbtn small" :disabled="doctorLoading" @click="runDoctor">
                    {{ doctorLoading ? "检查中…" : "重新检查" }}
                  </button>
                </div>
                <table class="ptable" v-if="doctor">
                  <thead><tr><th>检查项</th><th>状态</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr v-for="(c, i) in doctor.checks" :key="i">
                      <td>{{ c.name }}</td>
                      <td><span class="check-status" :class="c.status">
                        <span :data-icon="c.status === 'pass' ? 'circle-check' : (c.status === 'warn' ? 'circle-alert' : 'circle-pause')"></span>
                        {{ c.status === "pass" ? "通过" : (c.status === "warn" ? "警告" : "失败") }}
                      </span></td>
                      <td style="color:var(--muted-foreground)">{{ c.message }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="sec-desc">点击「重新检查」运行 8 项依赖自检。</div>
              </div>
              <div class="pcard settings-section">
                <div class="sec-title">扩展管理（全局）</div>
                <div class="ov-item"><span class="ov-label">运行模式</span>
                  <span class="status-pill" :data-status="extConfig && extConfig.mode !== 'disabled' ? 'active' : 'inactive'">
                    <span class="status-dot" :class="extConfig && extConfig.mode !== 'disabled' ? 'on' : 'off'"></span>
                    {{ extConfig ? (extConfig.mode === 'disabled' ? '已禁用（纯净 PI）' : '已启用') : '…' }}
                  </span>
                </div>
                <div class="ov-item"><span class="ov-label">已安装版本</span>
                  <span class="ov-value">{{ extConfig && extConfig.version ? extConfig.version : '未安装' }}</span>
                </div>
                <div class="ov-item" v-if="extCheck"><span class="ov-label">快照版本</span>
                  <span class="ov-value">{{ extCheck.available || '未知' }}
                    <span v-if="extCheck.updateAvailable" class="status-pill" data-status="active">可更新</span>
                  </span>
                </div>
                <div style="display:flex;gap:8px;margin-top:8px">
                  <button class="pbtn" :disabled="!extConfig" @click="toggleExtension">
                    {{ extConfig && extConfig.mode === 'disabled' ? '启用扩展' : '禁用扩展' }}
                  </button>
                  <button class="pbtn" @click="checkExtension">检查更新</button>
                  <button class="pbtn danger" :disabled="extReinstalling" @click="reinstallExtension">
                    {{ extReinstalling ? '重装中…' : '重装扩展' }}
                  </button>
                </div>
                <div class="sec-desc" style="margin-top:8px;margin-bottom:0">
                  模式切换在下次启动 PI 时生效；重装从应用内置快照复制并执行 npm install。
                </div>
              </div>
              <div class="pcard settings-section">
                <div class="sec-title">扩展升级</div>
                <div class="ov-item"><span class="ov-label">当前版本</span>
                  <span class="ov-value">{{ version ? version.local : "未检查" }}</span>
                </div>
                <div class="ov-item"><span class="ov-label">最新版本</span>
                  <span class="ov-value">{{ version && version.remote ? version.remote : "未知" }}</span>
                </div>
                <div style="display:flex;gap:8px;margin:10px 0">
                  <button class="pbtn" @click="checkVersion">检查更新</button>
                  <button class="pbtn primary" :disabled="updateRunning" @click="startUpdate">
                    {{ updateRunning ? "更新中…" : "一键更新" }}
                  </button>
                </div>
                <stream-view :lines="updateLines" :running="updateRunning"></stream-view>
                <div class="sec-desc" style="margin-top:8px;margin-bottom:0">
                  完成后请在 PI 会话内执行 /reload
                </div>
              </div>
            </template>

            <!-- 高级 -->
            <template v-if="section === 'advanced'">
              <div class="pcard settings-section">
                <div class="sec-title">novel.json</div>
                <div class="pfield">
                  <label class="plabel">项目名</label>
                  <input class="pinput" v-model="novelForm.name">
                </div>
                <div class="pfield">
                  <label class="plabel">章节目录</label>
                  <input class="pinput" v-model="novelForm.chaptersDir">
                </div>
                <div class="pfield">
                  <label class="plabel">故事时间格式</label>
                  <input class="pinput" v-model="novelForm.storyTimeFormat">
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <button class="pbtn primary" :disabled="novelSaving" @click="saveNovelJson">
                    {{ novelSaving ? "保存中…" : "保存" }}
                  </button>
                  <span class="sec-desc" style="margin:0">engineVersion / worldGraphDir 为只读</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    `
  };
})();
