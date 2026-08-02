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
    `<div class="dropdown-item ${App.storyTime === st ? 'active' : ''}" onclick="App.storyTime='${st}';render()"><span class="font-mono">${escapeHtml(st)}</span></div>`
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
      all.push(...data);
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
    App.activeProject = null;
    App.storyTimes = [];
    App.storyTime = null;
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
// drawGraph2D 内部引用自由变量 canvas（graph.js 用 var canvas; 提供全局绑定）。

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
      <div><label class="text-sm text-muted">类型</label><select id="qe-type" class="select"><option value="birth">birth</option><option value="change">change</option><option value="death">death</option></select></div>
      <div><label class="text-sm text-muted">故事时间</label><input id="qe-st" class="input" value="${App.storyTime || ''}"></div>
      <div><label class="text-sm text-muted">实体 ID</label><input id="qe-entity" class="input" value="${App.viewState.selectedEntityId || ''}"></div>
      <div><label class="text-sm text-muted">摘要</label><textarea id="qe-summary" class="textarea" rows="3"></textarea></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitQuickEvent()">保存</button>`);
}

async function submitQuickEvent() {
  const body = {
    eventId: $('#qe-id').value,
    type: $('#qe-type').value,
    storyTime: $('#qe-st').value,
    entityId: $('#qe-entity').value,
    summary: $('#qe-summary').value
  };
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

function drawGraph2D(ctx, w, h) {
  const data = App.viewState.graphData || { entities: [], relations: [] };
  const filter = (App.viewState.graphFilter || '').toLowerCase();
  const typeFilter = App.viewState.graphType || 'all';
  let entities = data.entities.filter(e => typeFilter === 'all' || e.entityType === typeFilter);
  if (filter) entities = entities.filter(e => (e.properties?.name || e.entityId).toLowerCase().includes(filter));
  const entitySet = new Set(entities.map(e => e.entityId));
  const relations = data.relations.filter(r => entitySet.has(r.sourceId) && entitySet.has(r.targetId));

  const positions = {};
  entities.forEach((e, i) => {
    const angle = (i / Math.max(entities.length, 1)) * Math.PI * 2;
    const radius = Math.min(w, h) * 0.32;
    positions[e.entityId] = { x: w/2 + Math.cos(angle) * radius, y: h/2 + Math.sin(angle) * radius };
  });
  for (let it = 0; it < 30; it++) {
    relations.forEach(r => {
      const a = positions[r.sourceId], b = positions[r.targetId];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, dist = Math.sqrt(dx*dx+dy*dy) || 1;
      const target = 160;
      const force = (dist - target) * 0.03;
      const fx = (dx/dist) * force, fy = (dy/dist) * force;
      a.x += fx; a.y += fy; b.x -= fx; b.y -= fy;
    });
    entities.forEach((e, i) => {
      const p = positions[e.entityId];
      p.x = Math.max(90, Math.min(w - 90, p.x));
      p.y = Math.max(50, Math.min(h - 50, p.y));
    });
  }

  ctx.clearRect(0,0,w,h);
  relations.forEach(r => {
    const a = positions[r.sourceId], b = positions[r.targetId];
    if (!a || !b) return;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-500');
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground');
    ctx.font = '11px Poppins';
    ctx.fillText(r.label, mx + 4, my - 4);
  });

  entities.forEach(e => {
    const p = positions[e.entityId];
    const type = ENTITY_TYPES[e.entityType] || { color: '#888', bg: '#eee' };
    const selected = App.viewState.selectedEntityId === e.entityId;
    ctx.fillStyle = type.bg;
    ctx.strokeStyle = type.color;
    ctx.lineWidth = selected ? 3 : 1.5;
    roundRect(ctx, p.x - 80, p.y - 36, 160, 72, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = type.color;
    ctx.font = '600 13px Poppins';
    const name = e.properties?.name || e.entityId;
    ctx.fillText(truncate(name, 16), p.x - 72, p.y - 8);
    ctx.font = '11px Poppins';
    ctx.fillText(ENTITY_TYPES[e.entityType]?.label || e.entityType, p.x - 72, p.y + 12);
  });

  canvas.onclick = ev => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    for (const e of entities) {
      const p = positions[e.entityId];
      if (x >= p.x-80 && x <= p.x+80 && y >= p.y-36 && y <= p.y+36) {
        selectEntity(e.entityId); return;
      }
    }
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y); ctx.closePath();
}
function truncate(s, n) { return s.length > n ? s.slice(0, n-1) + '…' : s; }

// =================== 初始化 ===================
async function init() {
  bindShellClickGuard();
  // 恢复上次保存的主题（支持 system 解析；失败则保持默认浅色）
  try {
    const cfg = await apiCall('getAppConfig');
    if (cfg && cfg.theme) settingsApplyTheme(cfg.theme);
  } catch (e) { /* 忽略，使用默认主题 */ }
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
