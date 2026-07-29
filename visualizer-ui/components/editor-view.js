/* editor-view.js — 文件编辑器页（阶段 2a，原型设计体系）
 *
 * 功能（§11.3 取舍：textarea + 自研迷你渲染预览，不引 Monaco/marked）：
 * - 左栏：项目文件树（目录可折叠，仅 .md）
 * - 编辑：textarea + 字数/修改时间状态栏 + 未保存标记
 * - 保存带 baseMtime 乐观锁；409 冲突时提示并支持「重新加载」
 * - 预览：putil.renderMarkdown 迷你渲染（无 XSS 面）
 * - 新建/删除文件（删除二次确认）
 * 依赖：需要活跃项目（无活跃时显示引导，不报错）
 */
(function () {
  "use strict";
  var api = window.V3.api;
  var U = window.V3.putil;

  window.V3.components.EditorView = {
    props: {
      active: { type: Object, default: null }
    },
    emits: ["toast"],
    data: function () {
      return {
        tree: [],
        collapsed: {},          // dir path -> true
        current: null,          // { path, mtime, size }
        draft: "",
        savedDraft: "",         // 上次保存/加载的内容（dirty 判定）
        loadingTree: false,
        loadingFile: false,
        saving: false,
        preview: false,
        error: "",
        showCreate: false,
        createPath: "",
        showDelete: false
      };
    },
    computed: {
      flatTree: function () {
        var self = this;
        return U.flattenFileTree(this.tree).filter(function (n) {
          // 折叠目录的后代不显示
          var parts = n.path.split("/");
          for (var i = 1; i < parts.length; i++) {
            if (self.collapsed[parts.slice(0, i).join("/")]) return false;
          }
          return true;
        });
      },
      dirty: function () {
        return this.current !== null && this.draft !== this.savedDraft;
      },
      charCount: function () {
        return U.countChars(this.draft);
      },
      previewHtml: function () {
        return U.renderMarkdown(this.draft);
      }
    },
    watch: {
      active: function () { this.loadTree(); }
    },
    mounted: function () { this.loadTree(); },
    methods: {
      fmtTime: U.formatDateTime,
      fmtSize: U.formatBytes,
      loadTree: function () {
        var self = this;
        if (!this.active) { this.tree = []; this.current = null; return; }
        this.loadingTree = true;
        this.error = "";
        api.filesTree().then(function (data) {
          self.tree = data.tree || [];
          self.loadingTree = false;
        }).catch(function (err) {
          self.loadingTree = false;
          if (err.code !== "NO_ACTIVE_PROJECT") self.error = "加载文件树失败：" + err.message;
        });
      },
      toggleDir: function (path) {
        this.collapsed = Object.assign({}, this.collapsed, { [path]: !this.collapsed[path] });
      },
      selectFile: function (node) {
        var self = this;
        if (node.kind === "dir") { this.toggleDir(node.path); return; }
        if (this.dirty && !window.confirm("当前文件有未保存修改，切换将丢弃，继续？")) return;
        this.loadingFile = true;
        this.error = "";
        api.filesRead(node.path).then(function (f) {
          self.current = { path: f.path, mtime: f.mtime, size: f.size };
          self.draft = f.content;
          self.savedDraft = f.content;
          self.loadingFile = false;
          self.preview = false;
        }).catch(function (err) {
          self.loadingFile = false;
          self.error = "打开文件失败：" + err.message;
        });
      },
      save: function () {
        var self = this;
        if (!this.current || this.saving) return;
        this.saving = true;
        this.error = "";
        api.filesWrite(this.current.path, this.draft, this.current.mtime).then(function (f) {
          self.current = { path: f.path, mtime: f.mtime, size: f.size };
          self.savedDraft = self.draft;
          self.saving = false;
          self.$emit("toast", { message: "已保存：" + f.path, type: "success" });
        }).catch(function (err) {
          self.saving = false;
          if (err.code === "MTIME_CONFLICT") {
            self.error = "文件已被外部修改（保存冲突）。点击文件名重新加载，或复制当前内容后重试。";
          } else {
            self.error = "保存失败：" + err.message;
          }
        });
      },
      reloadCurrent: function () {
        if (!this.current) return;
        this.savedDraft = this.draft; // 绕过 dirty 确认
        var path = this.current.path;
        this.current = null;
        this.selectFile({ path: path, kind: "file" });
      },
      createFile: function () {
        var self = this;
        var p = this.createPath.trim();
        if (!p) return;
        if (!/\.md$/i.test(p)) p += ".md";
        api.filesCreate(p).then(function (f) {
          self.showCreate = false;
          self.createPath = "";
          self.$emit("toast", { message: "已创建：" + f.path, type: "success" });
          self.loadTree();
          self.selectFile({ path: f.path, kind: "file" });
        }).catch(function (err) {
          self.$emit("toast", { message: "创建失败：" + err.message, type: "error" });
        });
      },
      removeFile: function () {
        var self = this;
        if (!this.current) return;
        api.filesDelete(this.current.path).then(function () {
          self.showDelete = false;
          self.$emit("toast", { message: "已删除：" + self.current.path, type: "success" });
          self.current = null;
          self.draft = "";
          self.savedDraft = "";
          self.loadTree();
        }).catch(function (err) {
          self.showDelete = false;
          self.$emit("toast", { message: "删除失败：" + err.message, type: "error" });
        });
      },
      onKeydown: function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          this.save();
        }
      }
    },
    template: `
      <div class="proto-page" @keydown="onKeydown">
        <div v-if="!active" class="proto-empty">
          尚未激活项目。请先到「项目管理」页激活一个项目，再回来编辑文件。
        </div>
        <template v-else>
          <div v-if="error" class="proto-error">
            {{ error }}
            <button v-if="current" class="pbtn small" style="margin-left:8px" @click="reloadCurrent">重新加载</button>
          </div>
          <div class="editor-layout">
            <aside class="editor-tree">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
                <span style="flex:1;font-size:12px;color:var(--muted-foreground)">项目文件</span>
                <button class="pbtn small ghost" title="新建文件" @click="showCreate = true">
                  <span data-icon="circle-plus"></span>
                </button>
                <button class="pbtn small ghost" title="刷新" @click="loadTree">
                  <span data-icon="funnel"></span>
                </button>
              </div>
              <div v-if="loadingTree" style="font-size:12px;color:var(--muted-foreground)">加载中…</div>
              <template v-for="n in flatTree" :key="n.path">
                <div class="tree-item" :class="{ dir: n.kind === 'dir', selected: current && current.path === n.path }"
                     :style="{ paddingLeft: (8 + n.depth * 14) + 'px' }"
                     @click="selectFile(n)">
                  <span :data-icon="n.kind === 'dir' ? (collapsed[n.path] ? 'folder' : 'folder-open') : 'file'"></span>
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ n.name }}</span>
                </div>
              </template>
              <div v-if="!loadingTree && !flatTree.length" style="font-size:12px;color:var(--muted-foreground);padding:8px">
                项目中还没有 markdown 文件，点击 + 新建。
              </div>
            </aside>

            <section class="editor-main">
              <div class="editor-toolbar">
                <span class="doc-title">
                  {{ current ? current.path : "未打开文件" }}
                  <span v-if="dirty" class="dirty" style="font-size:12px">●未保存</span>
                </span>
                <button class="pbtn small" :disabled="!current" @click="preview = !preview">
                  {{ preview ? "编辑" : "预览" }}
                </button>
                <button class="pbtn small primary" :disabled="!current || !dirty || saving" @click="save">
                  {{ saving ? "保存中…" : "保存" }}
                </button>
                <button class="pbtn small danger" :disabled="!current" @click="showDelete = true">
                  <span data-icon="trash-2"></span>
                </button>
              </div>
              <div class="editor-area">
                <div v-if="!current" class="proto-empty" style="height:100%;display:flex;align-items:center;justify-content:center">
                  从左侧选择或新建一个文件开始编辑
                </div>
                <div v-else-if="preview" class="md-preview" v-html="previewHtml"></div>
                <textarea v-else class="ptextarea" v-model="draft"
                          placeholder="开始撰写文档…" :disabled="loadingFile"></textarea>
              </div>
              <div class="editor-statusbar" v-if="current">
                <span>{{ charCount }} 字</span>
                <span>大小 {{ fmtSize(current.size) }}</span>
                <span>最后编辑 {{ fmtTime(current.mtime) }}</span>
                <span style="flex:1"></span>
                <span>Ctrl+S 保存</span>
              </div>
            </section>
          </div>
        </template>

        <div v-if="showCreate" class="pmodal-mask" @click.self="showCreate = false">
          <div class="pmodal">
            <div class="pm-title">新建文件</div>
            <div class="pfield">
              <label class="plabel">相对路径（.md 后缀可省略）</label>
              <input class="pinput" v-model="createPath" placeholder="正文/ch002 或 设定/角色/主角"
                     @keyup.enter="createFile">
            </div>
            <div class="pm-actions">
              <button class="pbtn" @click="showCreate = false">取消</button>
              <button class="pbtn primary" :disabled="!createPath.trim()" @click="createFile">创建</button>
            </div>
          </div>
        </div>

        <div v-if="showDelete" class="pmodal-mask" @click.self="showDelete = false">
          <div class="pmodal">
            <div class="pm-title">删除文件</div>
            <p style="font-size:13px;color:var(--muted-foreground)">
              确定删除 {{ current ? current.path : "" }} 吗？此操作不可撤销。
            </p>
            <div class="pm-actions">
              <button class="pbtn" @click="showDelete = false">取消</button>
              <button class="pbtn danger" @click="removeFile">删除</button>
            </div>
          </div>
        </div>
      </div>
    `
  };
})();
