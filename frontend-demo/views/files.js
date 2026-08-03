/**
 * frontend-demo/views/files.js — 文件视图（高保真重构，Task 9）
 *
 * 设计基准：narrative-engine-design/pages/files.html
 * （双栏文件工作区：左文件树 + 右编辑器；树节点 hover 菜单（新建文件/新建文件夹/重命名/删除）；
 *   类型图标按扩展名区分；多 Tab + dirty 圆点 + 关闭钮；Tab 下方路径栏 + 保存状态 + 最后保存时间；
 *   渲染/源码切换、字号调节、字数统计、Markdown 阅读排版；底部状态栏（行/列/UTF-8）；
 *   mtime 冲突 Banner（重新加载 / 强制保存））
 *
 * 覆盖约定（模式同 views/graph.js / views/events.js / views/studio.js）：
 *   - ViewRender.files / ViewAfterRender.files（views.js 中旧 ViewRender.files 赋值会被本文件后加载覆盖）
 *   - viewLoaders.files → flLoadData（views.js 中旧 loadFiles 函数声明保留，不修改）
 *   注意：本文件不依赖 views.js 的 q()（Task 11 将删除 views.js）；
 *   onclick 内联参数一律经本文件内定义的 flJs()（JS 字面量转义）包裹。
 *
 * 状态读写约定（viewState('files') 命名空间 + 平面双写，参考 events.js）：
 *   - flState(key, fallback) / setFlState(key, value)
 *   - 数据键用 flTree / flTabs / flActivePath / flMode / flFontSize / flConflictPath 等，
 *     避免与命名空间 routeId 'files' 同名（防止双写把命名空间覆盖成数组）
 *
 * 数据获取与写操作走 apiMock 闭环（api-mock.js 实际暴露方法）：
 *   getFileTree / readFile / writeFile / createFile / createFolder / renameNode / deleteNode / getNovelJson
 * 复用 demo-utils.js：DemoUtils.countWords
 */

// ==================== 常量 ====================

const FL_DEFAULT_FONT_SIZE = 16;
const FL_FONT_MIN = 12;
const FL_FONT_MAX = 24;
const FL_READABLE_EXTS = ['.md', '.txt', '.json'];   // api-mock readFile 允许的类型
const FL_EXT_ICON = { md: 'file-text', json: 'braces', db: 'database', txt: 'file-text' };
const FL_EXT_COLOR = { md: '#2563eb', json: '#059669', db: '#6b7280', txt: '#6b7280' }; // 类型语义色（同 debug 级别色先例）
const FL_FOLDER_COLOR = '#d97706';

// ==================== 状态访问器 ====================

function flState(key, fallback) {
  const ns = viewState('files');
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setFlState(key, value) {
  viewState('files')[key] = value;
  App.viewState[key] = value;
}

// ==================== 转义（onclick 内联参数） ====================

// JS 字面量转义（语义同 views.js 的 q()，但本地定义、不依赖 views.js）：
// 转义反斜杠 / 单引号 / 换行，使路径等用户可编辑文本可安全内联到 onclick 单引号串中
function flJs(str) {
  return "'" + String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r') + "'";
}

function flBasename(path) {
  const s = String(path);
  return s.split('/').pop() || s;
}

// 后端 /api/files/tree 节点只有 path/kind/size/mtime（无 name 字段），
// 统一派生 name = basename(path) 供树渲染/图标色使用（mock 自带 name 也以 basename 为准，语义一致）
function flNormalizeTree(nodes) {
  return (nodes || []).map((n) => ({
    ...n,
    name: flBasename(n.path),
    children: n.children ? flNormalizeTree(n.children) : n.children
  }));
}

function flExt(path) {
  const s = String(path);
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function flExtIcon(name) {
  const ext = flExt(name);
  return FL_EXT_ICON[ext.slice(1)] || 'file';
}

function flExtColor(name) {
  const ext = flExt(name);
  return FL_EXT_COLOR[ext.slice(1)] || 'var(--text-400)';
}

function flTimeHHmm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ==================== 数据加载（覆盖 viewLoaders.files） ====================

async function flLoadData() {
  const fileData = await apiCall('getFileTree');
  setFlState('flTree', flNormalizeTree(fileData.tree || []));

  if (flState('flChaptersDir', null) === null) {
    try {
      const novel = await apiCall('getNovelJson');
      setFlState('flChaptersDir', (novel.data && novel.data.chaptersDir) || '正文');
    } catch (e) {
      setFlState('flChaptersDir', '正文');
    }
  }

  // 展开状态：null 表示默认全部展开；有显式列表则保留用户折叠/展开
  if (flState('flExpandedDirs', null) === null) {
    setFlState('flExpandedDirs', null);
  }

  flBindGlobalGuards();
}

viewLoaders.files = flLoadData;

// ==================== 全局守卫（一次性绑定） ====================

let flGuardsBound = false;

function flBindGlobalGuards() {
  if (flGuardsBound) return;
  flGuardsBound = true;

  document.addEventListener('click', () => {
    if (flState('flOpenMenuPath', null)) {
      setFlState('flOpenMenuPath', null);
      // 仅关闭文件树右键菜单（纯视图内状态），无需整壳重建
      if (routeId() === 'files') renderView();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (routeId() !== 'files') return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      flSaveActive();
    }
  });
}

// ==================== 渲染 ====================

ViewRender.files = () => {
  const tabs = flState('flTabs', []);
  const activePath = flState('flActivePath', null);
  const active = tabs.find((t) => t.path === activePath) || null;

  return `
    <div class="fl-workspace">
      ${flSidebarHtml()}
      <div class="fl-editor">
        <div class="fl-tabbar-wrap">
          <div class="fl-tabbar">${flTabbarHtml(tabs, activePath)}</div>
          ${flTopStatusHtml(active)}
        </div>
        ${flConflictBannerHtml()}
        ${flToolbarHtml(active)}
        <div class="fl-editor-body">${flEditorBodyHtml(active)}</div>
        ${flStatusBarHtml(active)}
      </div>
    </div>`;
};

ViewAfterRender.files = () => {
  refreshIcons();
};

// ---------- 左栏：文件树 ----------

function flSidebarHtml() {
  return `
    <aside class="fl-sidebar">
      <div class="fl-sidebar-header">
        <span class="fl-sidebar-title">${icon('folder-tree', 'w-4 h-4')} 项目文件</span>
        <span class="fl-sidebar-actions">
          <button class="fl-new-btn" title="新建文件" onclick="flOpenCreate('file', null)">${icon('file-plus', 'w-4 h-4')}</button>
          ${ApiRuntime.isMock ? `<button class="fl-new-btn" title="新建文件夹" onclick="flOpenCreate('folder', null)">${icon('folder-plus', 'w-4 h-4')}</button>` : ''}
        </span>
      </div>
      <div class="fl-sidebar-hint">章节目录：${escapeHtml(flState('flChaptersDir', '正文'))}（来自 novel.json）</div>
      <div class="fl-tree">${flTreeHtml(flState('flTree', []), 0)}</div>
    </aside>`;
}

function flTreeHtml(nodes, depth) {
  return (nodes || []).map((n) => (n.kind === 'dir' ? flDirHtml(n, depth) : flFileHtml(n, depth))).join('');
}

function flDirHtml(node, depth) {
  const expanded = flIsDirExpanded(node.path);
  return `
    <div class="fl-node">
      <div class="fl-row" style="--fl-depth:${depth}">
        <span class="fl-caret ${expanded ? 'fl-caret-open' : ''}" onclick="flToggleDir(${flJs(node.path)})">${icon('chevron-right', 'w-3.5 h-3.5')}</span>
        <span class="fl-node-icon fl-folder-icon" onclick="flToggleDir(${flJs(node.path)})">${icon('folder', 'w-4 h-4')}</span>
        <span class="fl-node-name" onclick="flToggleDir(${flJs(node.path)})" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
        <span class="fl-more" onclick="event.stopPropagation();flToggleMenu(${flJs(node.path)})" title="更多操作">${icon('ellipsis', 'w-3.5 h-3.5')}</span>
        ${flMenuHtml(node.path, 'dir')}
      </div>
      ${expanded ? `<div class="fl-children">${flTreeHtml(node.children, depth + 1)}</div>` : ''}
    </div>`;
}

function flFileHtml(node, depth) {
  const active = flState('flActivePath', null) === node.path;
  return `
    <div class="fl-node">
      <div class="fl-row ${active ? 'fl-row-active' : ''}" style="--fl-depth:${depth}">
        <span class="fl-caret fl-caret-placeholder"></span>
        <span class="fl-node-icon" style="color:${flExtColor(node.name)}" onclick="flOpenFile(${flJs(node.path)})">${icon(flExtIcon(node.name), 'w-4 h-4')}</span>
        <span class="fl-node-name" onclick="flOpenFile(${flJs(node.path)})" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
        <span class="fl-more" onclick="event.stopPropagation();flToggleMenu(${flJs(node.path)})" title="更多操作">${icon('ellipsis', 'w-3.5 h-3.5')}</span>
        ${flMenuHtml(node.path, 'file')}
      </div>
    </div>`;
}

function flIsDirExpanded(path) {
  const ex = flState('flExpandedDirs', null);
  if (!ex) return true; // null = 默认全部展开
  return ex.indexOf(path) >= 0;
}

function flCollectDirs(nodes) {
  const out = [];
  (nodes || []).forEach((n) => {
    if (n.kind === 'dir') {
      out.push(n.path);
      out.push.apply(out, flCollectDirs(n.children));
    }
  });
  return out;
}

function flMenuHtml(path, type) {
  if (flState('flOpenMenuPath', null) !== path) return '';
  const items = [];
  if (type === 'dir') {
    items.push(flMenuItem('file-plus', '新建文件', `flOpenCreate('file',${flJs(path)})`));
    if (ApiRuntime.isMock) {
      items.push(flMenuItem('folder-plus', '新建文件夹', `flOpenCreate('folder',${flJs(path)})`));
      items.push(flMenuItem('pencil', '重命名', `flOpenRename(${flJs(path)})`));
      items.push(flMenuItem('trash-2', '删除', `flOpenDelete(${flJs(path)})`, true));
    }
  } else {
    items.push(flMenuItem('pencil', '重命名', `flOpenRename(${flJs(path)})`));
    items.push(flMenuItem('trash-2', '删除', `flOpenDelete(${flJs(path)})`, true));
  }
  return `<div class="fl-menu" onclick="event.stopPropagation()">${items.join('')}</div>`;
}

function flMenuItem(ic, label, onclick, danger) {
  return `<button class="fl-menu-item${danger ? ' fl-menu-item-danger' : ''}" onclick="event.stopPropagation();${onclick}">${icon(ic, 'w-3.5 h-3.5')}<span>${label}</span></button>`;
}

// ---------- 右栏：Tab 栏 + 路径栏 ----------

function flTabbarHtml(tabs, activePath) {
  if (!tabs.length) {
    return `<div class="fl-tabbar-empty">没有打开的文件</div>`;
  }
  return tabs.map((t, i) => `
    <div class="fl-tab ${t.path === activePath ? 'fl-tab-active' : ''}${t.dirty ? ' fl-tab-dirty' : ''}" id="fl-tab-${i}" onclick="flSwitchTab(${flJs(t.path)})" title="${escapeHtml(t.path)}">
      <span class="fl-tab-icon" style="color:${flExtColor(t.name)}">${icon(flExtIcon(t.name), 'w-3.5 h-3.5')}</span>
      <span class="fl-tab-name">${escapeHtml(t.name)}</span>
      ${t.dirty ? '<span class="fl-dirty-dot" title="未保存"></span>' : ''}
      <button class="fl-tab-close" title="关闭" onclick="event.stopPropagation();flCloseTab(${flJs(t.path)})">${icon('x', 'w-3 h-3')}</button>
    </div>`).join('');
}

function flTopStatusHtml(active) {
  if (!active) return '';
  return `
    <div class="fl-top-status">
      <span class="fl-file-path" title="${escapeHtml(active.path)}">${escapeHtml(active.path)}</span>
      <span class="fl-save-status ${active.dirty ? 'fl-save-status-dirty' : ''}" id="fl-save-status">${active.dirty ? '<span class="fl-dirty-dot"></span> 未保存' : '<span class="fl-save-dot"></span> 已保存'}</span>
      <span class="fl-last-saved" id="fl-last-saved">最后保存：${active.mtime ? flTimeHHmm(active.mtime) : '—'}</span>
    </div>`;
}

// ---------- 冲突 Banner ----------

function flConflictBannerHtml() {
  const path = flState('flConflictPath', null);
  if (!path) return '';
  const name = flBasename(path);
  return `
    <div class="fl-conflict-banner">
      ${icon('triangle-alert', 'w-4 h-4')}
      <span class="fl-conflict-text">文件已被其他进程修改：<strong>${escapeHtml(name)}</strong></span>
      <button class="fl-conflict-btn" onclick="flReloadActive()">${icon('refresh-cw', 'w-3.5 h-3.5')} 重新加载</button>
      <button class="fl-conflict-btn fl-conflict-btn-danger" onclick="flForceSaveActive()">${icon('save', 'w-3.5 h-3.5')} 强制保存</button>
      <button class="fl-conflict-close" title="忽略" onclick="flDismissConflict()">${icon('x', 'w-3.5 h-3.5')}</button>
    </div>`;
}

// ---------- 工具栏 ----------

function flToolbarHtml(active) {
  if (!active) return '';
  const mode = flState('flMode', 'render');
  const fontSize = flState('flFontSize', FL_DEFAULT_FONT_SIZE);
  const words = DemoUtils.countWords(active.content || '');
  return `
    <div class="fl-toolbar">
      <div class="fl-view-toggle">
        <button class="fl-view-btn ${mode === 'render' ? 'fl-view-btn-active' : ''}" onclick="flSetMode('render')">${icon('book-open', 'w-3.5 h-3.5')} 渲染</button>
        <button class="fl-view-btn ${mode === 'source' ? 'fl-view-btn-active' : ''}" onclick="flSetMode('source')">${icon('code', 'w-3.5 h-3.5')} 源码</button>
      </div>
      <div class="fl-font-ctl">
        <button class="fl-font-btn" title="减小字号" onclick="flAdjustFont(-1)">${icon('minus', 'w-3.5 h-3.5')}</button>
        <span class="fl-font-val" id="fl-font-val">${fontSize}px</span>
        <button class="fl-font-btn" title="增大字号" onclick="flAdjustFont(1)">${icon('plus', 'w-3.5 h-3.5')}</button>
      </div>
      <span class="fl-words" id="fl-words">${words} 字</span>
      <span class="fl-toolbar-spacer"></span>
      <button class="fl-save-btn" id="fl-save-btn" onclick="flSaveActive()" ${active.dirty ? '' : 'disabled'}>${icon('save', 'w-3.5 h-3.5')} 保存</button>
    </div>`;
}

// ---------- 编辑区 ----------

function flEditorBodyHtml(active) {
  if (!active) {
    return `<div class="fl-empty">${icon('file-text', 'w-10 h-10')}<p>从左侧选择一个文件开始编辑</p></div>`;
  }
  const mode = flState('flMode', 'render');
  const fontSize = flState('flFontSize', FL_DEFAULT_FONT_SIZE);
  if (mode === 'source') {
    return `<textarea id="fl-editor" class="fl-source-editor" style="font-size:${fontSize}px"
      oninput="flOnEdit(this.value)" onkeyup="flUpdateCursor()" onselect="flUpdateCursor()"
      spellcheck="false">${escapeHtml(active.content || '')}</textarea>`;
  }
  return `<div id="fl-doc" class="fl-doc" style="font-size:${fontSize}px">${flRenderMarkdown(active.content || '')}</div>`;
}

// ---------- 底部状态栏 ----------

function flStatusBarHtml(active) {
  if (!active) return '';
  const mode = flState('flMode', 'render');
  const content = active.content || '';
  let line = 1;
  let col = 0;
  if (mode === 'source') {
    const pos = flState('flCursor', 0) || 0;
    const before = content.slice(0, pos);
    line = (before.match(/\n/g) || []).length + 1;
    col = pos - before.lastIndexOf('\n');
  } else {
    line = (content.match(/\n/g) || []).length + 1;
  }
  return `
    <div class="fl-statusbar">
      <span id="fl-status-lc">第 ${line} 行 · 第 ${col} 列</span>
      <span class="fl-statusbar-spacer"></span>
      <span>UTF-8</span>
    </div>`;
}

// ---------- Markdown 阅读排版（转义后渲染，防注入） ----------

function flRenderMarkdown(md) {
  const esc = escapeHtml(md || '');
  const lines = esc.split(/\r?\n/);
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push('<p class="fl-para">' + para.map((l) => flInline(l)).join('<br>') + '</p>');
      para = [];
    }
  };
  const heading = (level) => (m) => { flush(); out.push('<h' + level + ' class="fl-h' + level + '">' + flInline(m[1]) + '</h' + level + '>'); };
  const h1 = heading(1), h2 = heading(2), h3 = heading(3), h4 = heading(4), h5 = heading(5), h6 = heading(6);

  for (const line of lines) {
    let m;
    if ((m = /^######\s+(.*)$/.exec(line))) h6(m);
    else if ((m = /^#####\s+(.*)$/.exec(line))) h5(m);
    else if ((m = /^####\s+(.*)$/.exec(line))) h4(m);
    else if ((m = /^###\s+(.*)$/.exec(line))) h3(m);
    else if ((m = /^##\s+(.*)$/.exec(line))) h2(m);
    else if ((m = /^#\s+(.*)$/.exec(line))) h1(m);
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flush(); out.push('<div class="fl-li">• ' + flInline(m[1]) + '</div>'); }
    else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) { flush(); out.push('<div class="fl-li fl-li-num">' + flInline(m[1]) + '</div>'); }
    else if (/^\s*$/.test(line)) { flush(); }
    else para.push(line);
  }
  flush();
  return out.join('\n');
}

function flInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code class="fl-code">$1</code>');
}

// ==================== 交互：Tab 管理 ====================

async function flOpenFile(path) {
  const ext = flExt(path);
  if (FL_READABLE_EXTS.indexOf(ext) < 0) {
    toast('该文件类型暂不支持编辑（' + (ext || '未知类型') + '）', 'info');
    return;
  }
  const tabs = flState('flTabs', []);
  let tab = tabs.find((t) => t.path === path);
  if (!tab) {
    try {
      const data = await apiCall('readFile', path);
      tab = { path, name: flBasename(path), content: data.content, mtime: data.mtime, dirty: false, baseMtime: data.mtime };
      tabs.push(tab);
      setFlState('flTabs', tabs);
    } catch (e) {
      handleApiError(e);
      return;
    }
  }
  setFlState('flActivePath', path);
  setFlState('flConflictPath', null);
  renderView();
}

function flSwitchTab(path) {
  setFlState('flActivePath', path);
  setFlState('flConflictPath', null);
  renderView();
}

function flCloseTab(path) {
  const tabs = (flState('flTabs', []) || []).slice();
  const idx = tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.dirty) {
    setFlState('flPendingClose', path);
    openModal('未保存的更改',
      `<p>「<strong>${escapeHtml(tab.name)}</strong>」有未保存的更改，要保存后再关闭吗？</p>`,
      `<button class="btn btn-ghost" onclick="flCloseModal()">取消</button>
       <button class="btn btn-ghost" onclick="flCloseDiscard()">不保存</button>
       <button class="btn btn-primary" onclick="flCloseSave()">保存</button>`);
    return;
  }
  flDoCloseTab(idx, tabs);
}

function flCloseModal() {
  closeModal();
  setFlState('flPendingClose', null);
}

async function flCloseSave() {
  const path = flState('flPendingClose', null);
  const tabs = flState('flTabs', []);
  const idx = tabs.findIndex((t) => t.path === path);
  closeModal();
  setFlState('flPendingClose', null);
  if (idx < 0) return;
  const tab = tabs[idx];
  try {
    const res = await apiCall('writeFile', tab.path, tab.content, tab.baseMtime);
    tab.baseMtime = res.mtime;
    tab.mtime = res.mtime;
    tab.dirty = false;
  } catch (e) {
    if (e.code === 'MTIME_CONFLICT') {
      setFlState('flConflictPath', tab.path);
      toast('保存冲突，请重新加载或强制保存', 'error');
    } else {
      handleApiError(e);
    }
    return;
  }
  flDoCloseTab(idx, tabs);
  toast('已保存并关闭', 'success');
}

function flCloseDiscard() {
  const path = flState('flPendingClose', null);
  const tabs = flState('flTabs', []);
  const idx = tabs.findIndex((t) => t.path === path);
  closeModal();
  setFlState('flPendingClose', null);
  if (idx >= 0) flDoCloseTab(idx, tabs);
}

function flDoCloseTab(idx, tabs) {
  const tab = tabs[idx];
  const activePath = flState('flActivePath', null);
  tabs.splice(idx, 1);
  setFlState('flTabs', tabs);
  if (activePath === tab.path) {
    const next = tabs[Math.min(idx, tabs.length - 1)] || null;
    setFlState('flActivePath', next ? next.path : null);
  }
  renderView();
}

// ==================== 交互：编辑 / dirty / 保存 / 冲突 ====================

function flActiveTab(path) {
  const tabs = flState('flTabs', []);
  return tabs.find((t) => t.path === (path || flState('flActivePath', null))) || null;
}

function flOnEdit(value) {
  const tab = flActiveTab();
  if (!tab || tab.content === value) return;
  tab.content = value;
  tab.dirty = true;
  setFlState('flTabs', flState('flTabs', [])); // 保持命名空间与平面双写同引用
  flUpdateUiAfterEdit();
}

function flUpdateUiAfterEdit() {
  const tab = flActiveTab();
  if (!tab) return;
  const badge = $('#fl-save-status');
  if (badge) {
    badge.innerHTML = tab.dirty
      ? '<span class="fl-dirty-dot"></span> 未保存'
      : '<span class="fl-save-dot"></span> 已保存';
  }
  const wc = $('#fl-words');
  if (wc) wc.textContent = DemoUtils.countWords(tab.content || '') + ' 字';
  const btn = $('#fl-save-btn');
  if (btn) btn.disabled = !tab.dirty;
  (flState('flTabs', [])).forEach((t, i) => {
    const el = $('#fl-tab-' + i);
    if (!el) return;
    el.classList.toggle('fl-tab-dirty', !!t.dirty);
    const dot = el.querySelector('.fl-dirty-dot');
    if (dot) dot.style.display = t.dirty ? '' : 'none';
  });
  const last = $('#fl-last-saved');
  if (last) last.textContent = tab.mtime ? '最后保存：' + flTimeHHmm(tab.mtime) : '最后保存：—';
}

function flUpdateCursor() {
  const el = $('#fl-editor');
  const pos = (el && el.selectionStart != null) ? el.selectionStart : 0;
  setFlState('flCursor', pos);
  const bar = $('#fl-status-lc');
  if (bar) {
    const tab = flActiveTab();
    const content = (tab && tab.content) || '';
    const before = content.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = pos - before.lastIndexOf('\n');
    bar.textContent = '第 ' + line + ' 行 · 第 ' + col + ' 列';
  }
}

async function flSaveActive() {
  const tab = flActiveTab();
  if (!tab || !tab.dirty) return;
  const btn = $('#fl-save-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiCall('writeFile', tab.path, tab.content, tab.baseMtime);
    tab.baseMtime = res.mtime;
    tab.mtime = res.mtime;
    tab.dirty = false;
    setFlState('flConflictPath', null);
    setFlState('flTabs', flState('flTabs', []));
    flUpdateUiAfterEdit();
    toast('已保存 ' + tab.name, 'success');
  } catch (e) {
    if (e.code === 'MTIME_CONFLICT') {
      setFlState('flConflictPath', tab.path);
      renderView();
    } else {
      handleApiError(e);
    }
  }
}

async function flReloadActive() {
  const path = flState('flConflictPath', null) || flState('flActivePath', null);
  const tab = flActiveTab(path);
  if (!tab) return;
  try {
    const data = await apiCall('readFile', tab.path);
    tab.content = data.content;
    tab.mtime = data.mtime;
    tab.baseMtime = data.mtime;
    tab.dirty = false;
    setFlState('flConflictPath', null);
    setFlState('flTabs', flState('flTabs', []));
    renderView();
    toast('已重新加载 ' + tab.name, 'success');
  } catch (e) {
    handleApiError(e);
  }
}

async function flForceSaveActive() {
  const path = flState('flConflictPath', null) || flState('flActivePath', null);
  const tab = flActiveTab(path);
  if (!tab) return;
  try {
    const res = await apiCall('writeFile', tab.path, tab.content); // 不带 baseMtime：以本地为准
    tab.baseMtime = res.mtime;
    tab.mtime = res.mtime;
    tab.dirty = false;
    setFlState('flConflictPath', null);
    setFlState('flTabs', flState('flTabs', []));
    flUpdateUiAfterEdit();
    toast('已强制保存 ' + tab.name, 'success');
  } catch (e) {
    handleApiError(e);
  }
}

function flDismissConflict() {
  setFlState('flConflictPath', null);
  renderView();
}

// ==================== 交互：视图切换 / 字号 ====================

function flSetMode(mode) {
  setFlState('flMode', mode);
  renderView();
}

function flAdjustFont(delta) {
  const cur = flState('flFontSize', FL_DEFAULT_FONT_SIZE);
  const next = Math.max(FL_FONT_MIN, Math.min(FL_FONT_MAX, cur + delta));
  setFlState('flFontSize', next);
  const doc = $('#fl-doc');
  if (doc) doc.style.fontSize = next + 'px';
  const ed = $('#fl-editor');
  if (ed) ed.style.fontSize = next + 'px';
  const val = $('#fl-font-val');
  if (val) val.textContent = next + 'px';
}

// ==================== 交互：文件树 ====================

function flToggleDir(path) {
  let ex = flState('flExpandedDirs', null);
  if (ex === null) {
    ex = flCollectDirs(flState('flTree', []));
  }
  const i = ex.indexOf(path);
  if (i >= 0) ex.splice(i, 1);
  else ex.push(path);
  setFlState('flExpandedDirs', ex);
  renderView();
}

function flToggleMenu(path) {
  setFlState('flOpenMenuPath', flState('flOpenMenuPath', null) === path ? null : path);
  renderView();
}

function flFindNode(nodes, path) {
  for (const n of nodes || []) {
    if (n.path === path) return n;
    if (n.children) {
      const f = flFindNode(n.children, path);
      if (f) return f;
    }
  }
  return null;
}

function flIsDirPath(path) {
  const n = flFindNode(flState('flTree', []), path);
  return !!n && n.kind === 'dir';
}

// ---------- 新建 / 重命名 / 删除（modal 闭环） ----------

function flOpenCreate(kind, parentPath) {
  const defaultPath = kind === 'file'
    ? (parentPath ? parentPath + '/新章节.md' : '正文/新章节.md')
    : (parentPath ? parentPath + '/新文件夹' : '正文/新文件夹');
  const title = kind === 'file' ? '新建文件' : '新建文件夹';
  const hint = kind === 'file' ? '仅支持 .md 文件' : '目录名';
  openModal(title,
    `<div class="fl-form-label">路径（${hint}）</div>
     <input id="fl-create-path" class="input" value="${escapeHtml(defaultPath)}" spellcheck="false" autocomplete="off"
       onkeydown="if(event.key==='Enter')flSubmitCreate('${kind}', $('#fl-create-path').value)">`,
    `<button class="btn btn-ghost" onclick="flCloseModal()">取消</button>
     <button class="btn btn-primary" onclick="flSubmitCreate('${kind}', $('#fl-create-path').value)">创建</button>`);
}

async function flSubmitCreate(kind, path) {
  const p = String(path || '').trim();
  if (!p) { toast('路径不能为空', 'error'); return; }
  try {
    if (kind === 'file') await apiCall('createFile', p);
    else await apiCall('createFolder', p);
  } catch (e) {
    handleApiError(e);
    return;
  }
  closeModal();
  setFlState('flOpenMenuPath', null);
  await flLoadData();
  renderView();
  toast(kind === 'file' ? '已创建 ' + flBasename(p) : '已创建文件夹 ' + flBasename(p), 'success');
  if (kind === 'file') flOpenFile(p);
}

function flOpenRename(path) {
  openModal('重命名',
    `<div class="fl-form-label">新路径（目录或 .md 文件）</div>
     <input id="fl-rename-path" class="input" value="${escapeHtml(path)}" spellcheck="false" autocomplete="off"
       onkeydown="if(event.key==='Enter')flSubmitRename(${flJs(path)}, $('#fl-rename-path').value)">`,
    `<button class="btn btn-ghost" onclick="flCloseModal()">取消</button>
     <button class="btn btn-primary" onclick="flSubmitRename(${flJs(path)}, $('#fl-rename-path').value)">重命名</button>`);
}

async function flSubmitRename(path, newPath) {
  const p = String(newPath || '').trim();
  if (!p) { toast('路径不能为空', 'error'); return; }
  try {
    await apiCall('renameNode', path, p);
  } catch (e) {
    handleApiError(e);
    return;
  }
  closeModal();
  setFlState('flOpenMenuPath', null);
  flSyncTabsAfterRename(path, p);
  await flLoadData();
  renderView();
  toast('已重命名', 'success');
}

function flOpenDelete(path) {
  const name = flBasename(path);
  const isDir = flIsDirPath(path);
  const tip = isDir ? '该目录及其全部内容将被删除' : '该文件将被删除';
  openModal('删除确认',
    `<p>确定要删除「<strong>${escapeHtml(name)}</strong>」吗？</p>
     <p class="text-xs text-muted">${tip}，此操作不可撤销。</p>`,
    `<button class="btn btn-ghost" onclick="flCloseModal()">取消</button>
     <button class="btn btn-destructive" onclick="flSubmitDelete(${flJs(path)})">删除</button>`);
}

async function flSubmitDelete(path) {
  try {
    await apiCall('deleteNode', path);
  } catch (e) {
    handleApiError(e);
    return;
  }
  closeModal();
  setFlState('flOpenMenuPath', null);
  flSyncTabsAfterDelete(path);
  await flLoadData();
  renderView();
  toast('已删除 ' + flBasename(path), 'success');
}

// ---------- 重命名 / 删除后同步已打开 Tab ----------

function flSyncTabsAfterRename(oldPath, newPath) {
  const tabs = flState('flTabs', []);
  let changed = false;
  for (const t of tabs) {
    if (t.path === oldPath || t.path.startsWith(oldPath + '/')) {
      t.path = newPath + t.path.slice(oldPath.length);
      t.name = flBasename(t.path);
      changed = true;
    }
  }
  const active = flState('flActivePath', null);
  if (active && (active === oldPath || active.startsWith(oldPath + '/'))) {
    setFlState('flActivePath', newPath + active.slice(oldPath.length));
  }
  if (changed) setFlState('flTabs', tabs);
}

function flSyncTabsAfterDelete(path) {
  const tabs = (flState('flTabs', []) || []).filter((t) => t.path !== path && !t.path.startsWith(path + '/'));
  setFlState('flTabs', tabs);
  const active = flState('flActivePath', null);
  if (active && (active === path || active.startsWith(path + '/'))) {
    setFlState('flActivePath', tabs.length ? tabs[0].path : null);
  }
}
