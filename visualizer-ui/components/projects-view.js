/* projects-view.js — 项目管理页（阶段 2a，原型设计体系）
 *
 * 功能（§11.2 取舍：统计 v1 只做章节数+最后修改时间，状态徽章=活跃标记）：
 * - 扫描根目录下的项目（localStorage 记住上次 root）
 * - 项目卡片：名称/路径/章节数/最后修改时间 + 激活/启动PI/打开文件夹
 * - 新建项目（目录 + 可选名称）
 * - 首次使用引导：无项目时显示引导卡片（§11.6 #5 最简版）
 * 事件：activate 成功后向上 emit("activated", dir)，由 app 重新加载世界图
 */
(function () {
  "use strict";
  var api = window.V3.api;
  var U = window.V3.putil;

  window.V3.components.ProjectsView = {
    props: {
      active: { type: Object, default: null }   // { dir, name } | null
    },
    emits: ["activated", "toast"],
    data: function () {
      return {
        scanRoot: "",
        projects: [],
        loading: false,
        error: "",
        scanned: false,
        showCreate: false,
        createDir: "",
        createName: "",
        creating: false,
        busyDir: ""   // 正在操作（激活）的项目目录
      };
    },
    mounted: function () {
      this.scanRoot = "";
      try { this.scanRoot = window.localStorage.getItem("ne.scanRoot") || ""; } catch (e) { /* 隐私模式 */ }
      if (this.scanRoot) this.scan();
    },
    methods: {
      fmtTime: U.formatDateTime,
      scan: function () {
        var self = this;
        if (!this.scanRoot.trim()) { this.error = "请先填写扫描根目录"; return; }
        this.loading = true;
        this.error = "";
        api.projectsScan(this.scanRoot.trim()).then(function (data) {
          self.projects = data.projects || [];
          self.scanned = true;
          self.loading = false;
          try { window.localStorage.setItem("ne.scanRoot", self.scanRoot.trim()); } catch (e) { /* 忽略 */ }
        }).catch(function (err) {
          self.loading = false;
          self.error = "扫描失败：" + err.message;
        });
      },
      isActive: function (p) {
        return !!this.active && this.active.dir === p.dir;
      },
      activate: function (p) {
        var self = this;
        if (this.isActive(p)) { this.$emit("activated", p.dir); return; }
        this.busyDir = p.dir;
        api.projectActivate(p.dir).then(function () {
          self.busyDir = "";
          self.$emit("activated", p.dir);
        }).catch(function (err) {
          self.busyDir = "";
          if (err.code === "MIGRATION_REQUIRED") {
            // 旧库：引导一键迁移（先自动备份 world.db）
            if (!window.confirm(
              "项目「" + p.meta.name + "」的数据库 schema 过旧，需要迁移后才能使用。\n" +
              "迁移前会自动备份 world.db。现在迁移吗？"
            )) return;
            self.busyDir = p.dir;
            api.projectMigrate(p.dir).then(function (r) {
              self.$emit("toast", {
                message: "迁移完成（v" + r.fromVersion + " → v" + r.toVersion + "，已备份）",
                type: "success"
              });
              return api.projectActivate(p.dir);
            }).then(function () {
              self.busyDir = "";
              self.$emit("activated", p.dir);
            }).catch(function (err2) {
              self.busyDir = "";
              self.$emit("toast", { message: "迁移失败：" + err2.message, type: "error" });
            });
            return;
          }
          self.$emit("toast", { message: "激活失败：" + err.message, type: "error" });
        });
      },
      openFolder: function (p) {
        var self = this;
        api.projectOpenFolder(p.dir).then(function () {
          self.$emit("toast", { message: "已在文件管理器中打开", type: "success" });
        }).catch(function (err) {
          self.$emit("toast", { message: "打开失败：" + err.message, type: "error" });
        });
      },
      create: function () {
        var self = this;
        if (!this.createDir.trim()) return;
        this.creating = true;
        api.projectCreate(this.createDir.trim(), this.createName.trim() || undefined).then(function (r) {
          self.creating = false;
          self.showCreate = false;
          self.$emit("toast", { message: "项目已创建：" + r.dir, type: "success" });
          self.createDir = "";
          self.createName = "";
          self.scan();
        }).catch(function (err) {
          self.creating = false;
          self.$emit("toast", { message: "创建失败：" + err.message, type: "error" });
        });
      }
    },
    template: `
      <div class="proto-page">
        <div class="page-head">
          <span class="page-title">项目管理</span>
          <span class="page-sub" v-if="active">当前项目：{{ active.name }}</span>
          <span class="page-sub" v-else>尚未激活项目</span>
          <span style="flex:1"></span>
          <button class="pbtn primary" @click="showCreate = true">
            <span data-icon="circle-plus"></span>新建项目
          </button>
        </div>

        <div class="pcard" style="margin-bottom:14px">
          <div style="display:flex;gap:8px;align-items:center">
            <span data-icon="search" style="color:var(--muted-foreground)"></span>
            <input class="pinput" v-model="scanRoot" placeholder="扫描根目录，如 D:\\novels"
                   @keyup.enter="scan" style="flex:1">
            <button class="pbtn" :disabled="loading" @click="scan">
              {{ loading ? "扫描中…" : "扫描" }}
            </button>
          </div>
        </div>

        <div v-if="error" class="proto-error">{{ error }}</div>

        <div v-if="scanned && !projects.length && !loading" class="proto-empty">
          <p style="margin:0 0 6px">该目录下没有发现小说项目。</p>
          <p style="margin:0">点击右上角「新建项目」创建第一个工程，或更换扫描目录。</p>
        </div>
        <div v-else-if="!scanned && !loading" class="proto-empty">
          输入扫描根目录后点击「扫描」，即可列出本地小说项目。
        </div>

        <div class="projects-grid">
          <div v-for="p in projects" :key="p.dir" class="pcard project-card"
               :class="{ active: isActive(p) }" @click="activate(p)">
            <div class="project-head">
              <span class="project-icon"><span data-icon="folder"></span></span>
              <div class="project-title-wrap">
                <div class="project-title">{{ p.meta.name }}</div>
                <div class="project-updated">最后更新 {{ fmtTime(p.lastModified) }}</div>
              </div>
              <span class="project-arrow"><span data-icon="chevron-right"></span></span>
            </div>
            <div class="project-meta">
              <div class="meta-cell"><span class="meta-label">章节</span><span class="meta-value">{{ p.chapterCount }}</span></div>
              <div class="meta-cell"><span class="meta-label">目录</span><span class="meta-value" style="font-size:11px">{{ p.relativePath }}</span></div>
            </div>
            <div class="project-foot">
              <span class="status-pill" :data-status="isActive(p) ? 'active' : 'inactive'">
                <span class="status-dot" :class="isActive(p) ? 'on' : 'off'"></span>
                {{ isActive(p) ? "活跃" : "未激活" }}
              </span>
              <span class="project-actions" @click.stop>
                <button class="pbtn small ghost" @click="openFolder(p)" title="在文件管理器中打开">
                  <span data-icon="external-link"></span>
                </button>
              </span>
            </div>
          </div>
        </div>

        <div v-if="showCreate" class="pmodal-mask" @click.self="showCreate = false">
          <div class="pmodal">
            <div class="pm-title">新建项目</div>
            <div class="pfield">
              <label class="plabel">项目目录（绝对路径）</label>
              <input class="pinput" v-model="createDir" placeholder="D:\\novels\\my-novel">
            </div>
            <div class="pfield">
              <label class="plabel">项目名（可选，缺省用目录名）</label>
              <input class="pinput" v-model="createName" placeholder="我的小说">
            </div>
            <div class="pm-actions">
              <button class="pbtn" @click="showCreate = false">取消</button>
              <button class="pbtn primary" :disabled="creating || !createDir.trim()" @click="create">
                {{ creating ? "创建中…" : "创建" }}
              </button>
            </div>
          </div>
        </div>
      </div>
    `
  };
})();
