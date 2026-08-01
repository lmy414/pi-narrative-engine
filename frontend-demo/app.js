/**
 * Narrative Engine Frontend Demo
 * 轻量 SPA：hash 路由 + 模拟 API 驱动
 */

// =================== 全局状态 ===================
const App = {
  route: '#/projects',
  activeProject: null,
  storyTime: null,
  storyTimes: [],
  searchQuery: '',
  searchResults: [],
  theme: 'light',
  toasts: [],
  modal: null,
  drawer: null,
  loading: false,
  // 视图级状态：按路由命名空间（viewState(routeId).xxx），保留平面字段以兼容 views.js
  viewState: {}
};

const ROUTES = [
  { id: 'projects', hash: '#/projects', label: '项目', icon: 'folder-open' },
  { id: 'graph', hash: '#/graph', label: '世界图', icon: 'globe' },
  { id: 'events', hash: '#/events', label: '事件链', icon: 'git-branch' },
  { id: 'studio', hash: '#/studio', label: '创作编排', icon: 'sparkles' },
  { id: 'debug', hash: '#/debug', label: '调试', icon: 'bug' },
  { id: 'files', hash: '#/files', label: '文件', icon: 'file-text' },
  { id: 'settings', hash: '#/settings', label: '设置', icon: 'settings' }
];

const VIEWS_NEED_PROJECT = new Set(['graph', 'events', 'studio', 'debug', 'files', 'settings-project']);

// =================== 工具函数 ===================
function $(selector) { return document.querySelector(selector); }
function $$(selector) { return Array.from(document.querySelectorAll(selector)); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function formatStoryTime(st) {
  if (!st) return '—';
  if (!st.includes('.')) return `第 ${parseInt(String(st).replace('ch',''),10) || 0} 章`;
  const [ch, ev] = st.split('.');
  return `第 ${parseInt(String(ch).replace('ch',''),10) || 0} 章 · 事件 ${parseInt(String(ev).replace('ev',''),10) || 0}`;
}
function icon(name, cls = '') {
  return `<i data-lucide="${name}" class="${cls}"></i>`;
}
function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

// =================== API 包装 ===================
async function apiCall(name, ...args) {
  if (!ApiMock[name]) throw new Error('未知 API: ' + name);
  const res = await ApiMock[name](...args);
  if (!res.ok) {
    const err = new Error(res.error?.message || '请求失败');
    err.code = res.error?.code;
    err.status = res._status || 400;
    throw err;
  }
  return res.data;
}

async function withLoading(fn) {
  App.loading = true;
  renderShell();
  try { return await fn(); }
  finally { App.loading = false; renderShell(); }
}

function handleApiError(err) {
  if (err.code === 'NO_ACTIVE_PROJECT') {
    toast('请先激活项目', 'info');
    navigate('#/projects');
  } else if (err.code === 'MIGRATION_REQUIRED') {
    toast('项目需要迁移', 'info');
  } else {
    toast(err.message || '请求失败', 'error');
  }
}

// =================== Toast / Modal / Drawer ===================
function toast(message, type = 'info') {
  const id = Date.now() + Math.random();
  App.toasts.push({ id, message, type });
  renderToasts();
  setTimeout(() => { App.toasts = App.toasts.filter(t => t.id !== id); renderToasts(); }, 3000);
}
function renderToasts() {
  let el = $('#toast-container');
  if (!el) { el = document.createElement('div'); el.id = 'toast-container'; el.className = 'toast-container'; document.body.appendChild(el); }
  el.innerHTML = App.toasts.map(t => `<div class="toast ${t.type}">${escapeHtml(t.message)}</div>`).join('');
}

function openModal(title, bodyHtml, footerHtml) {
  App.modal = { title, bodyHtml, footerHtml };
  renderModal();
}
function closeModal() { App.modal = null; renderModal(); }
function renderModal() {
  let el = $('#modal-root');
  if (!App.modal) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'modal-root'; document.body.appendChild(el); }
  el.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header"><h3 class="font-semibold">${escapeHtml(App.modal.title)}</h3><button class="btn btn-icon btn-ghost" onclick="closeModal()">${icon('x')}</button></div>
        <div class="modal-body">${App.modal.bodyHtml}</div>
        <div class="modal-footer">${App.modal.footerHtml}</div>
      </div>
    </div>`;
  refreshIcons();
}

function openDrawer(html) {
  App.drawer = html;
  renderDrawer();
}
function closeDrawer() { App.drawer = null; renderDrawer(); }
function renderDrawer() {
  let el = $('#drawer-root');
  if (!App.drawer) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'drawer-root'; document.body.appendChild(el); }
  el.innerHTML = `<div class="drawer-overlay" onclick="if(event.target===this)closeDrawer()"></div>${App.drawer}`;
  refreshIcons();
}

// =================== 路由 ===================
function navigate(hash, statePatch = {}) {
  if (statePatch) Object.assign(App, statePatch);
  window.location.hash = hash;
}
async function parseRoute() {
  const hash = window.location.hash || '#/projects';
  const [base, query] = hash.split('?');
  App.route = ROUTES.some(r => r.hash === base) ? base : '#/projects';
  const params = Object.fromEntries(new URLSearchParams(query || '').entries());
  // URL 参数写入当前路由命名空间；同时保留平面兼容（views.js 仍读 App.viewState.params）
  viewState(routeId()).params = params;
  App.viewState.params = params;
  await render();
}

function routeId() { return App.route.replace('#/',''); }
function routeNeedsProject() { return VIEWS_NEED_PROJECT.has(routeId()); }

// 视图状态命名空间访问器：App.viewState[routeId] 惰性创建并返回
function viewState(routeId) {
  App.viewState[routeId] = App.viewState[routeId] || {};
  return App.viewState[routeId];
}
window.viewState = viewState;

// =================== Shell ===================
function renderShell() {
  const active = routeId();
  const nav = ROUTES.map(r => {
    const disabled = (r.id !== 'projects' && r.id !== 'settings') && !App.activeProject;
    return `<a href="${r.hash}" class="nav-item ${active === r.id ? 'active' : ''} ${disabled ? 'disabled' : ''}" data-hash="${r.hash}">${icon(r.icon, 'w-4 h-4')}<span>${r.label}</span></a>`;
  }).join('');

  const projectName = App.activeProject ? App.activeProject.meta?.name || App.activeProject.relativePath : '未激活项目';
  const stOptions = App.storyTimes.map(st => `<option value="${st}" ${App.storyTime === st ? 'selected' : ''}>${st}</option>`).join('');

  const html = `
    <header class="app-header">
      <div class="flex items-center gap-3">
        <div class="brand-logo">${icon('book-open', 'w-5 h-5')}</div>
        <div>
          <h1 class="font-display text-lg font-medium leading-tight">Narrative Engine</h1>
          <p class="text-xs text-muted">AI 驱动的小说创作工作台</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        ${App.activeProject ? `
          <div class="project-chip" onclick="navigate('#/projects')">
            ${icon('folder', 'w-3.5 h-3.5')}
            <span class="truncate max-w-[160px]">${escapeHtml(projectName)}</span>
          </div>
          <div class="storytime-select">
            ${icon('clock', 'w-3.5 h-3.5 text-muted')}
            <select class="select" onchange="App.storyTime=this.value; render();" ${!App.storyTimes.length ? 'disabled' : ''}>
              <option value="">故事时间</option>
              ${stOptions}
            </select>
          </div>
        ` : ''}
        <div class="global-search">
          ${icon('search', 'w-4 h-4 text-muted')}
          <input type="text" class="input" placeholder="搜索实体或事件…" value="${escapeHtml(App.searchQuery)}"
            oninput="onGlobalSearch(this.value)" onfocus="renderSearchDropdown()" onblur="setTimeout(hideSearchDropdown,200)">
          <div id="search-dropdown" class="search-dropdown hidden"></div>
        </div>
        <button class="btn btn-icon btn-ghost" onclick="toggleTheme()" title="切换主题">${icon(App.theme === 'light' ? 'moon' : 'sun', 'w-4 h-4')}</button>
      </div>
    </header>
    <div class="app-main">
      <aside class="app-sidebar">
        <nav class="sidebar-nav">${nav}</nav>
      </aside>
      <main class="app-content" id="view-root"></main>
    </div>
    ${App.loading ? `<div class="global-loading"><div class="spinner"></div></div>` : ''}
  `;

  const app = $('#app');
  app.innerHTML = `<div class="app-shell">${html}</div>`;
  refreshIcons();
  attachNavHandlers();
}

function attachNavHandlers() {
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      const hash = el.dataset.hash;
      if (el.classList.contains('disabled')) {
        e.preventDefault();
        toast('请先激活项目', 'info');
      }
    });
  });
}

function renderSearchDropdown() {
  const el = $('#search-dropdown');
  if (!el) return;
  if (!App.searchResults.length) { el.classList.add('hidden'); return; }
  el.innerHTML = App.searchResults.map(r => `
    <div class="search-item" onclick="onSearchSelect('${r.type}','${r.id}')">
      <span class="badge type-${r.entityType || r.type}">${r.type === 'entity' ? ENTITY_TYPES[r.entityType]?.label || r.entityType : '事件'}</span>
      <span class="truncate">${escapeHtml(r.name)}</span>
    </div>
  `).join('');
  el.classList.remove('hidden');
}
function hideSearchDropdown() { const el = $('#search-dropdown'); if (el) el.classList.add('hidden'); }

async function onGlobalSearch(value) {
  App.searchQuery = value;
  if (!App.activeProject || value.length < 1) { App.searchResults = []; hideSearchDropdown(); return; }
  try {
    const data = await apiCall('search', value, App.storyTime);
    App.searchResults = data.results.slice(0, 8);
    renderSearchDropdown();
  } catch (e) { App.searchResults = []; }
}

function onSearchSelect(type, id) {
  hideSearchDropdown();
  if (type === 'entity') navigate('#/graph', { viewState: { ...App.viewState, selectedEntityId: id } });
  else navigate('#/events', { viewState: { ...App.viewState, selectedEventId: id } });
}

function toggleTheme() {
  App.theme = App.theme === 'light' ? 'dark' : 'light';
  document.documentElement.className = App.theme;
  render();
}

// =================== 初始化 ===================
async function init() {
  document.documentElement.className = App.theme;
  try {
    const data = await apiCall('getActiveProject');
    App.activeProject = data.active ? MOCK_PROJECTS.find(p => p.dir === data.active.dir) || null : null;
    if (App.activeProject) {
      const status = await apiCall('getStatus');
      App.storyTimes = status.storyTimes || [];
      App.storyTime = App.storyTimes[App.storyTimes.length - 1] || null;
    }
  } catch (e) { handleApiError(e); }
  await parseRoute();
  window.addEventListener('hashchange', parseRoute);
}

async function render() {
  const view = routeId();
  if (routeNeedsProject() && !App.activeProject && view !== 'settings') {
    navigate('#/projects');
    return;
  }
  // URL 参数映射到视图状态
  if (App.viewState.params?.event && view === 'events') {
    App.viewState.selectedEventId = App.viewState.params.event;
  }
  renderShell();
  const root = $('#view-root');
  if (!root) return;
  if (viewLoaders[view]) {
    App.loading = true;
    renderShell();
    try { await viewLoaders[view](); }
    catch (e) { handleApiError(e); }
    finally { App.loading = false; renderShell(); }
  }
  if (ViewRender[view]) root.innerHTML = ViewRender[view]();
  else root.innerHTML = ViewRender.projects();
  refreshIcons();
  if (ViewAfterRender[view]) ViewAfterRender[view]();
}

init();
