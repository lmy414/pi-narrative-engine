/**
 * Narrative Engine Frontend Demo
 * 轻量 SPA：hash 路由 + unified-server 真实 API 驱动
 */

// =================== 全局状态 ===================
const App = {
  route: '#/projects',
  activeProject: null,
  storyTime: null,
  storyTimes: [],
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

// 工作台顶部导航项（不含项目管理——项目管理为独立启动器页面）
const WORKSPACE_NAV = [
  { id: 'graph', hash: '#/graph', label: '世界图', icon: 'globe' },
  { id: 'events', hash: '#/events', label: '事件链', icon: 'git-branch' },
  { id: 'studio', hash: '#/studio', label: '创作编排', icon: 'sparkles' },
  { id: 'debug', hash: '#/debug', label: '调试', icon: 'bug' },
  { id: 'files', hash: '#/files', label: '文件', icon: 'file-text' },
  { id: 'settings', hash: '#/settings', label: '设置', icon: 'settings' }
];

const VIEWS_NEED_PROJECT = new Set(['graph', 'events', 'studio', 'debug', 'files', 'settings-project']);
const mockRequested = new URLSearchParams(window.location.search).get('mock') === '1';
const ApiRuntime = {
  isMock: mockRequested,
  client: mockRequested ? ApiMock : ApiClient,
  subscribeChat(onEvent, onError) {
    return this.isMock ? () => {} : this.client.subscribeChat(onEvent, onError);
  },
  subscribeDebug(onEvent, onError) {
    return this.isMock ? () => {} : this.client.subscribeDebug(onEvent, onError);
  }
};

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
  if (!ApiRuntime.client[name]) throw new Error('未知 API: ' + name);
  const res = await ApiRuntime.client[name](...args);
  if (!res.ok) {
    const err = new Error(res.error?.message || '请求失败');
    err.code = res.error?.code;
    err.status = res._status || 400;
    throw err;
  }
  return res.data;
}

// 仅维护 loading 标志，不再重建壳层（原 loading 覆盖层无对应 CSS，为不可见死代码）
async function withLoading(fn) {
  App.loading = true;
  try { return await fn(); }
  finally { App.loading = false; }
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
  const alreadyOpen = !!el;
  if (!el) { el = document.createElement('div'); el.id = 'drawer-root'; document.body.appendChild(el); }
  el.innerHTML = `<div class="drawer-overlay" onclick="if(event.target===this)closeDrawer()"></div>${App.drawer}`;
  // 已打开状态下的内容更新不再播放入场动画（避免抽屉「重新弹出一次」）
  if (alreadyOpen) { const d = el.querySelector('.detail-drawer, .drawer'); if (d) d.style.animation = 'none'; }
  refreshIcons();
}

// =================== 路由 ===================
function navigate(hash, statePatch = {}) {
  cleanupRouteRuntime(routeId());
  if (statePatch) Object.assign(App, statePatch);
  window.location.hash = hash;
}
function cleanupRouteRuntime(id) {
  if (id === 'studio' && typeof cleanupStudioView === 'function') cleanupStudioView();
  if (id === 'debug' && typeof cleanupDebugView === 'function') cleanupDebugView();
  if (id === 'graph' && typeof cleanupGraphView === 'function') cleanupGraphView();
  else if (id === 'events') stopStoryTimeWatcher();
}

// =================== 全局 StoryTime 同步（graph/events/驻留失效共用） ===================

/**
 * 用后端 status.storyTimes 同步全局 storyTimes / storyTime（BUG-004 修复核心）：
 * - storyTime 为空 → 置为最新时刻
 * - 用户位于时间线前沿（等于旧列表最大值）→ 新时刻出现时自动前进到最新
 * - 用户停留在历史时刻且仍存在 → 保持不变（不打断手动选择）
 */
function syncStoryTime(times) {
  const list = times || [];
  const prevMax = App.storyTimes.length ? App.storyTimes[App.storyTimes.length - 1] : null;
  const atFrontier = !App.storyTime || App.storyTime === prevMax;
  App.storyTimes = list;
  if (!list.length) {
    if (atFrontier) App.storyTime = null;
    return;
  }
  if (atFrontier || !list.includes(App.storyTime)) {
    App.storyTime = list[list.length - 1];
  }
}

// 驻留视图失效：停留在 graph/events 页时，后台编排 commit 落盘新时刻后自动刷新。
// 每 8s 轻量轮询 /status 对比时间线前沿，变化才触发重载（不打断手动选择的历史时刻）。
let storyTimeWatcher = null;
function startStoryTimeWatcher() {
  if (ApiRuntime.isMock || storyTimeWatcher) return;
  storyTimeWatcher = setInterval(async () => {
    try {
      const status = await apiCall('getStatus');
      const prev = App.storyTime;
      syncStoryTime(status.storyTimes || []);
      if (App.storyTime !== prev) {
        refreshShellStoryTime();
        renderView({ reload: true });
      }
    } catch (e) { /* 状态拉取失败静默忽略，下个周期重试 */ }
  }, 8000);
}
function stopStoryTimeWatcher() {
  if (storyTimeWatcher) { clearInterval(storyTimeWatcher); storyTimeWatcher = null; }
}

// 顶栏 StoryTime 选择器联动：watcher 触发 renderView({reload:true}) 只重渲 #view-root，
// 壳层选择器不重建（BUG-005 修复），这里就地更新当前值与下拉选项
function refreshShellStoryTime() {
  const container = $('.top-nav .storytime-selector');
  if (!container) return;
  const value = container.querySelector('.storytime-value');
  if (value) value.innerHTML = escapeHtml(App.storyTime || '—');
  const dropdown = container.querySelector('#storytime-dropdown');
  if (dropdown) {
    dropdown.innerHTML = App.storyTimes.map(st =>
      `<div class="dropdown-item ${App.storyTime === st ? 'active' : ''}" onclick="App.storyTime=${q(st)};render()"><span class="font-mono">${escapeHtml(st)}</span></div>`
    ).join('');
  }
}

// =================== 项目切换状态清理（BUG-003） ===================

/**
 * 切换/创建/关闭项目时清理项目级视图状态，防止跨项目污染：
 * - 丢弃全部路由命名空间与平面字段（studio 会话/消息、files 打开的 tabs、
 *   graph/events 数据与选中态、entityIndex、plan details、筛选/搜索等）
 * - 保留 projects 命名空间与扫描列表平面字段（项目清单与项目本身无关）
 * - 复位 storyTimes / storyTime（由新项目 status 重新填充）
 */
function resetProjectScopedState() {
  const keep = new Set(['projects', 'scannedProjects', 'scanRoots']);
  Object.keys(App.viewState).forEach((k) => { if (!keep.has(k)) delete App.viewState[k]; });
  stopStoryTimeWatcher();
  App.storyTimes = [];
  App.storyTime = null;
}
async function parseRoute() {
  const previousRoute = routeId();
  const hash = window.location.hash || '#/projects';
  const [base, query] = hash.split('?');
  App.route = ROUTES.some(r => r.hash === base) ? base : '#/projects';
  if (previousRoute !== routeId()) cleanupRouteRuntime(previousRoute);
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
function projectDisplayName() {
  return App.activeProject ? (App.activeProject.meta?.name || App.activeProject.relativePath) : '未激活项目';
}

function renderShell() {
  const active = routeId();
  const html = active === 'projects' ? launcherShellHtml() : workspaceShellHtml(active);
  const app = $('#app');
  app.innerHTML = `<div class="app-shell">${html}</div>`;
  refreshIcons();
  attachNavHandlers();
}

// 工作台壳层：顶部导航（logo + 项目菜单 / 6 导航项 / StoryTime + 搜索 + 帮助 + 主题 + 头像）
function workspaceShellHtml(active) {
  const nav = WORKSPACE_NAV.map(r => {
    const disabled = r.id !== 'settings' && !App.activeProject;
    return `<a href="${r.hash}" class="nav-item ${active === r.id ? 'active' : ''} ${disabled ? 'disabled' : ''}" data-hash="${r.hash}">${icon(r.icon, 'w-3.5 h-3.5')}<span>${r.label}</span></a>`;
  }).join('');

  return `
    <nav class="top-nav">
      <div class="flex items-center gap-2 min-w-0">
        <div class="logo-mark">N</div>
        <div class="project-menu dropdown" onclick="toggleNavProjectMenu(event)">
          <span class="project-name">${escapeHtml(projectDisplayName())}</span>
          ${icon('chevron-down', 'w-3.5 h-3.5')}
          <div id="project-dropdown" class="dropdown-menu hidden">
            ${App.activeProject ? `<div class="dropdown-item disabled">${icon('folder', 'w-4 h-4')}${escapeHtml(projectDisplayName())}</div>` : ''}
            <div class="dropdown-item" onclick="navigate('#/projects')">${icon('folder-open', 'w-4 h-4')}项目管理</div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1">${nav}</div>
      <div class="flex items-center gap-2">
        ${storyTimeSelectorHtml()}
        <button class="icon-btn" title="帮助" onclick="toast('Demo 版帮助中心暂未开放', 'info')">${icon('circle-help', 'w-4 h-4')}</button>
        <button class="icon-btn" title="切换主题" onclick="toggleTheme()">${icon(App.theme === 'light' ? 'moon' : 'sun', 'w-4 h-4')}</button>
        <div class="avatar" title="Demo 用户">Z</div>
      </div>
    </nav>
    <div id="view-root" class="app-main"></div>
  `;
}

// StoryTime 全局选择器（点击展开下拉，选择后切换当前故事时间）
// 仅世界图页显示：目前只有 graphLoadData（getGraph）消费 storyTime，其他页面显示无意义
function storyTimeSelectorHtml() {
  if (routeId() !== 'graph') return '';
  if (!App.activeProject || !App.storyTimes.length) return '';
  const options = App.storyTimes.map(st =>
    `<div class="dropdown-item ${App.storyTime === st ? 'active' : ''}" onclick="App.storyTime=${q(st)};render()"><span class="font-mono">${escapeHtml(st)}</span></div>`
  ).join('');
  return `
    <div class="storytime-selector dropdown" onclick="toggleNavStoryTime(event)">
      <div class="flex flex-col leading-tight">
        <span class="storytime-label">StoryTime</span>
        <span class="storytime-value">${escapeHtml(App.storyTime || '—')}</span>
      </div>
      ${icon('chevron-down', 'w-3.5 h-3.5')}
      <div id="storytime-dropdown" class="dropdown-menu hidden">${options}</div>
    </div>
  `;
}

// 启动器壳层（项目管理页）：logo + 项目名 + 设置/主题入口，无工作台导航
function launcherShellHtml() {
  return `
    <nav class="top-nav launcher-nav">
      <div class="launcher-inner">
        <div class="launcher-brand">
          <div class="logo-mark">N</div>
          <span class="brand-title">Narrative Engine</span>
        </div>
        <div class="launcher-actions">
          ${App.activeProject ? `
            <div class="project-chip" onclick="navigate('#/graph')">
              ${icon('folder', 'w-3.5 h-3.5')}
              <span class="truncate max-w-[160px]">${escapeHtml(projectDisplayName())}</span>
            </div>
          ` : ''}
          <button class="btn btn-ghost btn-sm" onclick="toggleTheme()" title="切换主题">${icon(App.theme === 'light' ? 'moon' : 'sun', 'w-4 h-4')} 主题</button>
          <button class="btn btn-ghost btn-sm" onclick="navigate('#/settings')">${icon('settings', 'w-4 h-4')} 设置</button>
          <div class="avatar" title="Demo 用户">Z</div>
        </div>
      </div>
    </nav>
    <div id="view-root" class="app-main"></div>
  `;
}

// 壳层下拉控制（函数名避开 views.js 的 toggleProjectMenu(dir)）
function toggleDropdown(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const willShow = el.classList.contains('hidden');
  document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== el) m.classList.add('hidden'); });
  if (willShow) el.classList.remove('hidden');
}
function toggleNavProjectMenu(e) { if (e) e.stopPropagation(); toggleDropdown('project-dropdown'); }
function toggleNavStoryTime(e) { if (e) e.stopPropagation(); toggleDropdown('storytime-dropdown'); }

// 页面其他区域点击时关闭所有下拉（幂等绑定一次）
let shellClickGuardBound = false;
function bindShellClickGuard() {
  if (shellClickGuardBound) return;
  shellClickGuardBound = true;
  document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
  });
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

function toggleTheme() {
  App.theme = App.theme === 'light' ? 'dark' : 'light';
  document.documentElement.className = App.theme;
  // 同步到应用配置 + 设置页状态，保证「设置 → 应用偏好 → 主题」高亮与顶栏切换一致
  apiCall('setAppConfig', { theme: App.theme }).catch(() => {});
  const cfg = typeof settingsState === 'function' ? settingsState('setAppConfig', null) : null;
  if (cfg) setSettingsState('setAppConfig', { ...cfg, theme: App.theme });
  render();
}

// =================== 项目管理交互（从 views.js 迁移，Task 11） ===================
// views/projects.js 通过 onclick 引用这些函数；函数体依赖 app.js 的 apiCall/withLoading/toast 等。

async function scanProjects() {
  const input = $('#scan-root').value;
  const roots = input.split(/[;，]/).map(s => s.trim()).filter(Boolean);
  App.viewState.scanRoots = roots;
  await withLoading(async () => {
    const all = [];
    for (const root of roots) {
      const data = await apiCall('scanProjects', root);
      all.push(...(data.projects || []));
    }
    App.viewState.scannedProjects = all;
    if (roots.length) await apiCall('setAppConfig', { launcher: { defaultScanRoots: roots } });
    render();
  });
}

async function createProject() {
  const dir = $('#new-project-dir').value.trim();
  const name = $('#new-project-name').value.trim();
  if (!dir) return toast('请输入目录', 'error');
  await withLoading(async () => {
    await apiCall('createProject', dir, name || undefined);
    await apiCall('activateProject', dir);
    resetProjectScopedState();
    const active = await apiCall('getActiveProject');
    App.activeProject = {
      dir,
      relativePath: active.active?.name || name || dir.split(/[\\/]/).pop(),
      meta: { name: active.active?.name || name || dir.split(/[\\/]/).pop() }
    };
    const status = await apiCall('getStatus');
    App.storyTimes = status.storyTimes || [];
    App.storyTime = App.storyTimes[App.storyTimes.length - 1] || null;
    toast('项目已创建并激活', 'success');
    navigate('#/graph');
  });
}

async function activateProject(dir) {
  await withLoading(async () => {
    try {
      await apiCall('activateProject', dir);
      resetProjectScopedState();
      const active = await apiCall('getActiveProject');
      const scanned = projectsList().find((project) => project.dir === dir);
      App.activeProject = scanned || {
        dir,
        relativePath: active.active?.name || dir.split(/[\\/]/).pop(),
        meta: { name: active.active?.name || dir.split(/[\\/]/).pop() }
      };
      const status = await apiCall('getStatus');
      App.storyTimes = status.storyTimes || [];
      App.storyTime = App.storyTimes[App.storyTimes.length - 1] || null;
      toast('项目已激活', 'success');
      navigate('#/graph');
    } catch (e) {
      if (e.code === 'MIGRATION_REQUIRED') {
        openModal('项目需要迁移',
          `<p>该项目需要先迁移数据结构。迁移会自动备份 world.db。</p>`,
          `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="migrateThenActivate(${q(dir)})">迁移并激活</button>`);
      } else handleApiError(e);
    }
  });
}

async function migrateThenActivate(dir) {
  closeModal();
  await withLoading(async () => {
    await apiCall('migrateProject', dir);
    await apiCall('activateProject', dir);
    resetProjectScopedState();
    const active = await apiCall('getActiveProject');
    const scanned = projectsList().find((project) => project.dir === dir);
    App.activeProject = scanned || {
      dir,
      relativePath: active.active?.name || dir.split(/[\\/]/).pop(),
      meta: { name: active.active?.name || dir.split(/[\\/]/).pop() }
    };
    const status = await apiCall('getStatus');
    App.storyTimes = status.storyTimes || [];
    App.storyTime = App.storyTimes[App.storyTimes.length - 1] || null;
    toast('迁移并激活成功', 'success');
    navigate('#/graph');
  });
}

async function migrateProject(dir) {
  await withLoading(async () => {
    await apiCall('migrateProject', dir);
    render();
    toast('迁移完成', 'success');
  });
}

async function openFolder(dir) {
  await withLoading(async () => { await apiCall('openFolder', dir); toast('已打开文件夹', 'info'); });
}

async function closeProject(dir) {
  await withLoading(async () => {
    await apiCall('closeProject', dir);
    resetProjectScopedState();
    App.activeProject = null;
    render();
    toast('项目已关闭', 'info');
  });
}

function toggleProjectMenu(dir) {
  const id = 'menu-' + dir.replace(/[\\/:]/g,'-');
  const el = $('#' + id);
  if (!el) return;
  document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== el) m.classList.add('hidden'); });
  el.classList.toggle('hidden');
}

// =================== 世界图交互（从 views.js 迁移，Task 11） ===================
// views/graph.js 通过 onclick 和 ViewAfterRender.graph 引用这些函数。

function selectEntity(id) {
  App.viewState.selectedEntityId = id;
  App.viewState.inspectorEntityId = id;
  renderView();
}

function stepStoryTime(delta) {
  if (!App.storyTimes.length) return;
  const idx = App.storyTimes.indexOf(App.storyTime);
  const next = idx + delta;
  if (next >= 0 && next < App.storyTimes.length) {
    App.storyTime = App.storyTimes[next];
    render();
  }
}

function openQuickEvent() {
  openModal('快速记事件',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">事件 ID</label><input id="qe-id" class="input" value="evt-${Date.now()}"></div>
      <div><label class="text-sm text-muted">类型</label><select id="qe-type" class="select" onchange="onQuickEventTypeChange()"><option value="birth">birth</option><option value="change">change</option><option value="death">death</option></select></div>
      <div id="qe-etype-row"><label class="text-sm text-muted">实体类型</label><select id="qe-etype" class="select"><option value="character">character（角色）</option><option value="location">location（地点）</option><option value="item">item（物品）</option><option value="concept">concept（概念）</option></select></div>
      <div><label class="text-sm text-muted">实体名称</label><input id="qe-name" class="input" placeholder="如：艾莉亚（birth 事件填写）" spellcheck="false"></div>
      <div><label class="text-sm text-muted">故事时间</label><input id="qe-st" class="input" value="${App.storyTime || ''}"></div>
      <div><label class="text-sm text-muted">实体 ID</label><input id="qe-entity" class="input" value="${App.viewState.selectedEntityId || ''}"></div>
      <div><label class="text-sm text-muted">摘要</label><textarea id="qe-summary" class="textarea" rows="3"></textarea></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitQuickEvent()">保存</button>`);
}

function onQuickEventTypeChange() {
  const row = $('#qe-etype-row');
  if (!row) return;
  const t = $('#qe-type');
  row.style.display = t && t.value === 'birth' ? '' : 'none';
}

async function submitQuickEvent() {
  const type = $('#qe-type').value;
  const entityId = $('#qe-entity').value;
  const name = ($('#qe-name').value || '').trim();
  const body = {
    eventId: $('#qe-id').value,
    type,
    storyTime: $('#qe-st').value,
    entityId,
    summary: $('#qe-summary').value
  };
  // birth 事件补实体类型与名称（newFacts.name → 实体属性 name），否则新实体无名显示 entityId
  if (type === 'birth') {
    body.entityType = $('#qe-etype').value;
    if (name) body.newFacts = [{ entityId, property: 'name', value: name, modality: 'fact' }];
  }
  closeModal();
  await withLoading(async () => {
    await apiCall('addEvent', body);
    toast('事件已记录', 'success');
    renderView({ reload: true });
  });
}

function openQuickRelation() {
  openModal('快速加关系',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">源实体 ID</label><input id="qr-source" class="input" value="${App.viewState.selectedEntityId || ''}"></div>
      <div><label class="text-sm text-muted">目标实体 ID</label><input id="qr-target" class="input"></div>
      <div><label class="text-sm text-muted">关系标签</label><input id="qr-label" class="input" value="关联"></div>
      <div><label class="text-sm text-muted">故事时间</label><input id="qr-st" class="input" value="${App.storyTime || ''}"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitQuickRelation()">保存</button>`);
}

async function submitQuickRelation() {
  const source = $('#qr-source').value, target = $('#qr-target').value;
  const label = $('#qr-label').value, st = $('#qr-st').value;
  closeModal();
  await withLoading(async () => {
    await apiCall('addRelation', source, target, label, st);
    toast('关系已添加', 'success');
    renderView({ reload: true });
  });
}

// =================== 初始化 ===================
async function init() {
  bindShellClickGuard();
  // 恢复上次保存的主题（支持 system 解析；失败则保持默认浅色）
  try {
    const cfg = await apiCall('getAppConfig');
    if (cfg && cfg.theme) settingsApplyTheme(cfg.theme);
    const roots = cfg?.launcher?.defaultScanRoots || [];
    viewState('projects').scanRoots = roots;
    App.viewState.scanRoots = roots;
  } catch (e) { /* 忽略，使用默认主题 */ }
  document.documentElement.className = App.theme;
  try {
    const data = await apiCall('getActiveProject');
    App.activeProject = data.active ? {
      dir: data.active.dir,
      relativePath: data.active.name || data.active.dir.split(/[\\/]/).pop(),
      meta: { name: data.active.name || data.active.dir.split(/[\\/]/).pop() },
      forceFulltext: !!data.active.forceFulltext
    } : null;
    if (App.activeProject) {
      const status = await apiCall('getStatus');
      App.storyTimes = status.storyTimes || [];
      App.storyTime = App.storyTimes[App.storyTimes.length - 1] || null;
    }
    if (!ApiRuntime.isMock && roots.length) {
      const projects = [];
      for (const root of roots) {
        try {
          const result = await apiCall('scanProjects', root);
          projects.push(...(result.projects || []));
        } catch (_) { /* 单个默认根失效不阻断启动 */ }
      }
      viewState('projects').scannedProjects = projects;
      App.viewState.scannedProjects = projects;
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
  // 先跑 loader，再一次性重建壳层：壳层能反映 loader 更新过的 App.storyTime 等状态
  if (viewLoaders[view]) {
    App.loading = true;
    try { await viewLoaders[view](); }
    catch (e) { handleApiError(e); }
    finally { App.loading = false; }
  }
  renderShell();
  const root = $('#view-root');
  if (!root) return;
  if (ViewRender[view]) root.innerHTML = ViewRender[view]();
  else root.innerHTML = ViewRender.projects();
  refreshIcons();
  if (ViewAfterRender[view]) ViewAfterRender[view]();
}

// 仅重渲当前视图（不动壳层）：用于标签/筛选等纯视图内状态切换，避免整页闪烁与滚动丢失
async function renderView({ reload = false } = {}) {
  const view = routeId();
  const root = $('#view-root');
  if (!root) return render();
  if (reload && viewLoaders[view]) {
    try { await viewLoaders[view](); }
    catch (e) { handleApiError(e); }
  }
  if (ViewRender[view]) root.innerHTML = ViewRender[view]();
  refreshIcons();
  if (ViewAfterRender[view]) ViewAfterRender[view]();
}

init();
