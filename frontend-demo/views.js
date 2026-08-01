/**
 * 视图渲染函数
 * 每个函数返回 HTML 字符串；AfterRender 处理 DOM 副作用
 */

const ViewRender = {};
const ViewAfterRender = {};

// 用于 inline event handler 的单引号字符串转义（解决 Windows 路径反斜杠问题）
function q(str) {
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}

// =================== V1 项目管理 ===================
ViewRender.projects = () => {
  const active = App.activeProject;
  const projectName = active ? (active.meta?.name || active.relativePath) : null;
  const scanRoots = (App.viewState.scanRoots || MOCK_APP_CONFIG.launcher.defaultScanRoots).join('; ');

  return `
    <div class="p-6 max-w-6xl mx-auto w-full">
      <div class="mb-8">
        <h1 class="font-display text-3xl font-medium mb-2">Narrative Engine</h1>
        <p class="text-muted">AI 驱动的小说创作工作台</p>
      </div>

      ${active ? `
        <div class="card p-4 mb-6 flex items-center justify-between">
          <div class="flex items-center gap-3">
            ${icon('check-circle', 'w-5 h-5')}
            <div>
              <div class="text-sm text-muted">当前项目</div>
              <div class="font-semibold">${escapeHtml(projectName)}</div>
            </div>
          </div>
          <button class="btn btn-primary" onclick="navigate('#/graph')">进入 ${icon('arrow-right', 'w-4 h-4')}</button>
        </div>
      ` : ''}

      <div class="card p-4 mb-6">
        <div class="flex gap-3 mb-4">
          <input id="scan-root" class="input" placeholder="扫描根目录，多个用分号分隔" value="${escapeHtml(scanRoots)}">
          <button class="btn btn-secondary whitespace-nowrap" onclick="scanProjects()">${icon('scan-search', 'w-4 h-4')} 扫描</button>
        </div>
        <div class="flex items-center justify-between">
          <button class="btn btn-ghost text-sm" onclick="toggleCreateForm()">${icon('plus', 'w-4 h-4')} 新建项目</button>
        </div>
        <div id="create-form" class="hidden mt-4 pt-4 border-t border-[var(--border)]">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-sm text-muted mb-1">目录</label>
              <input id="new-project-dir" class="input" placeholder="D:\\novels\\new-project">
            </div>
            <div>
              <label class="block text-sm text-muted mb-1">名称（可选）</label>
              <input id="new-project-name" class="input" placeholder="新项目">
            </div>
          </div>
          <div class="flex justify-end gap-2 mt-4">
            <button class="btn btn-ghost" onclick="toggleCreateForm()">取消</button>
            <button class="btn btn-primary" onclick="createProject()">创建并激活</button>
          </div>
        </div>
      </div>

      <h2 class="font-semibold text-lg mb-4">项目列表</h2>
      <div id="project-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${renderProjectGrid()}
      </div>
    </div>
  `;
};

function renderProjectGrid() {
  const projects = App.viewState.scannedProjects || MOCK_PROJECTS;
  return projects.map(p => {
    const isActive = App.activeProject && App.activeProject.dir === p.dir;
    return `
      <div class="card card-hover p-4 relative group" onclick="activateProject(${q(p.dir)})">
        <div class="flex justify-between items-start mb-2">
          <h3 class="font-semibold truncate pr-6">${escapeHtml(p.meta?.name || p.relativePath)}</h3>
          <div class="dropdown" onclick="event.stopPropagation()">
            <button class="btn btn-icon btn-ghost btn-sm" onclick="toggleProjectMenu(${q(p.dir)})">${icon('more-vertical', 'w-4 h-4')}</button>
            <div id="menu-${p.dir.replace(/[\\/:]/g,'-')}" class="dropdown-menu hidden">
              ${p.needsMigration ? `<div class="dropdown-item" onclick="migrateProject(${q(p.dir)})">${icon('archive-restore', 'w-4 h-4')} 迁移</div>` : ''}
              <div class="dropdown-item" onclick="openFolder(${q(p.dir)})">${icon('folder-open', 'w-4 h-4')} 打开所在文件夹</div>
              ${isActive ? `<div class="dropdown-item text-error" onclick="closeProject(${q(p.dir)})">${icon('x', 'w-4 h-4')} 关闭项目</div>` : ''}
            </div>
          </div>
        </div>
        <div class="text-xs text-muted mb-3 truncate">${escapeHtml(p.dir)}</div>
        <div class="flex items-center gap-2 mb-3">
          <span class="badge" style="background:var(--muted);color:var(--foreground)">${p.chapterCount} 章</span>
          <span class="badge" style="background:var(--muted);color:var(--foreground)">${p.stats ? p.stats.entityCount + ' 实体' : '—'}</span>
          <span class="badge" style="background:var(--muted);color:var(--foreground)">${p.stats ? p.stats.eventCount + ' 事件' : '—'}</span>
        </div>
        <div class="flex items-center justify-between text-xs text-muted">
          <span>更新于 ${formatTime(p.lastModified)}</span>
          ${p.needsMigration ? `<span class="badge" style="background:var(--error-100);color:var(--error-700)">需迁移</span>` : ''}
          ${isActive ? `<span class="badge" style="background:var(--success-100);color:var(--success-700)">当前</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

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

function toggleCreateForm() { $('#create-form').classList.toggle('hidden'); }

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

ViewAfterRender.projects = () => {
  document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown')) document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
  });
};

// =================== V2 世界图 ===================
ViewRender.graph = () => {
  const typeFilter = App.viewState.graphType || 'all';
  const mode2D = App.viewState.graphMode !== '3d';
  const selectedId = App.viewState.selectedEntityId;
  const inspectorId = App.viewState.inspectorEntityId;
  const graphData = App.viewState.graphData || { entities: [], relations: [] };
  const status = App.viewState.graphStatus || { entityCount: 0, eventCount: 0 };

  const typeTabs = [{ id: 'all', label: '全部' }, ...Object.entries(ENTITY_TYPES).map(([k,v]) => ({ id: k, label: v.label }))].map(t =>
    `<button class="tab ${typeFilter === t.id ? 'active' : ''}" onclick="App.viewState.graphType='${t.id}'; render();">${t.label}</button>`
  ).join('');

  const listEntities = graphData.entities.filter(e => typeFilter === 'all' || e.entityType === typeFilter);

  return `
    <div class="app-main">
      <aside class="w-64 border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
        <div class="p-3 border-b border-[var(--border)]">
          <input class="input" placeholder="搜索实体…" oninput="filterGraphEntities(this.value)">
        </div>
        <div class="tabs px-3">${typeTabs}</div>
        <div class="flex-1 overflow-auto p-3 space-y-2" id="entity-list">
          ${listEntities.map(e => renderEntityListItem(e, selectedId)).join('')}
        </div>
      </aside>
      <div class="flex-1 flex flex-col min-w-0">
        <div class="h-12 border-b border-[var(--border)] bg-[var(--card)] flex items-center justify-between px-4">
          <div class="flex items-center gap-4 text-sm">
            <span class="text-muted">实体 <b class="text-[var(--foreground)]">${status.entityCount}</b></span>
            <span class="text-muted">事件 <b class="text-[var(--foreground)]">${status.eventCount}</b></span>
            <span class="text-muted">当前时间 <b class="text-[var(--foreground)]">${App.storyTime || '—'}</b></span>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn btn-sm btn-ghost" onclick="stepStoryTime(-1)">${icon('chevron-left', 'w-4 h-4')}</button>
            <button class="btn btn-sm btn-ghost" onclick="stepStoryTime(1)">${icon('chevron-right', 'w-4 h-4')}</button>
            <div class="w-px h-4 bg-[var(--border)] mx-1"></div>
            <button class="btn btn-sm ${mode2D ? 'btn-secondary' : 'btn-ghost'}" onclick="App.viewState.graphMode='2d';render();">2D</button>
            <button class="btn btn-sm ${!mode2D ? 'btn-secondary' : 'btn-ghost'}" onclick="App.viewState.graphMode='3d';render();">3D</button>
          </div>
        </div>
        <div class="flex-1 relative blueprint-grid overflow-hidden" id="graph-canvas-container">
          ${mode2D ? `<canvas id="graph-canvas" class="absolute inset-0 w-full h-full"></canvas>` : `<div class="flex items-center justify-center h-full text-muted">3D 视图占位（Demo 阶段使用 2D 画布）</div>`}
          <div class="absolute bottom-4 left-4 flex gap-2">
            <button class="btn btn-primary btn-sm" onclick="openQuickEvent()">${icon('plus', 'w-4 h-4')} 记事件</button>
            <button class="btn btn-secondary btn-sm" onclick="openQuickRelation()">${icon('link', 'w-4 h-4')} 加关系</button>
          </div>
        </div>
      </div>
      ${inspectorId ? renderInspector(inspectorId, graphData) : ''}
    </div>
  `;
};

function renderEntityListItem(e, selectedId) {
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#888' };
  return `
    <div class="tree-row ${selectedId === e.entityId ? 'active' : ''}" onclick="selectEntity('${e.entityId}')">
      <span class="w-2 h-2 rounded-full" style="background:${type.color}"></span>
      <span class="truncate flex-1">${escapeHtml(e.properties?.name || e.entityId)}</span>
      <span class="text-xs text-muted">${type.label}</span>
    </div>
  `;
}

function renderInspector(inspectorId, graphData) {
  const entity = graphData.entities.find(e => e.entityId === inspectorId);
  if (!entity) return '';
  const type = ENTITY_TYPES[entity.entityType] || { label: entity.entityType, color: '#888' };
  const rels = graphData.relations.filter(r => r.sourceId === inspectorId || r.targetId === inspectorId);
  return `
    <aside class="w-72 border-l border-[var(--border)] bg-[var(--card)] flex flex-col">
      <div class="p-4 border-b border-[var(--border)] flex justify-between items-start">
        <div>
          <span class="badge mb-2" style="background:${type.bg};color:${type.color}">${type.label}</span>
          <h3 class="font-semibold text-lg">${escapeHtml(entity.properties?.name || entity.entityId)}</h3>
          <div class="text-xs text-muted font-mono mt-1">${entity.entityId}</div>
        </div>
        <button class="btn btn-icon btn-ghost btn-sm" onclick="App.viewState.inspectorEntityId=null;render();">${icon('x', 'w-4 h-4')}</button>
      </div>
      <div class="flex-1 overflow-auto p-4 space-y-4">
        <div>
          <div class="text-sm text-muted mb-1">摘要</div>
          <p class="text-sm">${escapeHtml(entity.summary || '无摘要')}</p>
        </div>
        <div>
          <div class="text-sm text-muted mb-2">属性</div>
          <div class="space-y-1 text-sm">
            ${Object.entries(entity.properties || {}).map(([k,v]) => `<div class="flex justify-between"><span class="text-muted">${k}</span><span>${escapeHtml(v)}</span></div>`).join('')}
          </div>
        </div>
        <div>
          <div class="text-sm text-muted mb-2">关系 (${rels.length})</div>
          <div class="space-y-1 text-sm">
            ${rels.map(r => {
              const otherId = r.sourceId === inspectorId ? r.targetId : r.sourceId;
              const other = graphData.entities.find(e => e.entityId === otherId);
              const dir = r.sourceId === inspectorId ? '→' : '←';
              return `<div class="flex justify-between cursor-pointer hover:text-[var(--primary)]" onclick="selectEntity('${otherId}')">${dir} ${escapeHtml(other?.properties?.name || otherId)} <span class="text-muted">${r.label}</span></div>`;
            }).join('')}
          </div>
        </div>
        <button class="btn btn-secondary w-full" onclick="openEntityDetail('${entity.entityId}')">${icon('panel-right-open', 'w-4 h-4')} 打开详情抽屉</button>
      </div>
    </aside>
  `;
}

async function loadGraph() {
  const data = await apiCall('getGraph', App.storyTime, '0');
  App.viewState.graphData = data;
  const status = await apiCall('getStatus');
  App.viewState.graphStatus = status;
  App.storyTimes = status.storyTimes || [];
  if (!App.storyTime && App.storyTimes.length) App.storyTime = App.storyTimes[App.storyTimes.length - 1];
}

function selectEntity(id) {
  App.viewState.selectedEntityId = id;
  App.viewState.inspectorEntityId = id;
  render();
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

function filterGraphEntities(value) {
  App.viewState.graphFilter = value.toLowerCase();
  // 列表与画布同步过滤，避免整页刷新导致搜索框失焦
  $$('#entity-list .tree-row').forEach(row => {
    const name = (row.querySelector('span.truncate')?.textContent || '').toLowerCase();
    row.style.display = name.includes(App.viewState.graphFilter) ? '' : 'none';
  });
  // 仅重绘画布
  const canvas = $('#graph-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    drawGraph2D(ctx, canvas.width, canvas.height);
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
    render();
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
  closeModal();
  await withLoading(async () => {
    await apiCall('addRelation', $('#qr-source').value, $('#qr-target').value, $('#qr-label').value, $('#qr-st').value);
    toast('关系已添加', 'success');
    render();
  });
}

async function openEntityDetail(id) {
  await withLoading(async () => {
    const data = await apiCall('getEntityHistory', id);
    openDrawer(renderEntityDetailDrawer(data));
    refreshIcons();
  });
}

function renderEntityDetailDrawer(data) {
  const e = data.entity;
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#888', bg: '#eee' };
  return `
    <div class="drawer">
      <div class="drawer-header">
        <div>
          <span class="badge" style="background:${type.bg};color:${type.color}">${type.label}</span>
          <h2 class="font-semibold text-xl mt-1">${escapeHtml(e.properties?.name || e.entityId)}</h2>
        </div>
        <button class="btn btn-icon btn-ghost" onclick="closeDrawer()">${icon('x', 'w-5 h-5')}</button>
      </div>
      <div class="drawer-body">
        <div class="tabs mb-4">
          <div class="tab active" onclick="switchDetailTab(this,'detail-overview')">概览</div>
          <div class="tab" onclick="switchDetailTab(this,'detail-decls')">声明 (${data.declarations.length})</div>
          <div class="tab" onclick="switchDetailTab(this,'detail-rels')">关系 (${data.relations.length})</div>
          <div class="tab" onclick="switchDetailTab(this,'detail-events')">事件 (${data.events.length})</div>
        </div>
        <div id="detail-overview" class="detail-tab">
          <p class="text-sm mb-4">${escapeHtml(e.summary || '无摘要')}</p>
          <div class="card p-3 mb-4">
            <div class="text-sm text-muted mb-2">属性</div>
            <div class="space-y-1 text-sm">${Object.entries(e.properties || {}).map(([k,v]) => `<div class="flex justify-between"><span class="text-muted">${k}</span><span>${escapeHtml(v)}</span></div>`).join('')}</div>
          </div>
          <button class="btn btn-destructive w-full" onclick="killEntity('${e.entityId}')">实体退场</button>
        </div>
        <div id="detail-decls" class="detail-tab hidden">
          ${data.declarations.map(d => `<div class="card p-3 mb-2 text-sm"><div class="flex justify-between"><span>${d.property}</span><span class="text-muted">${d.validFrom} → ${d.validTo}</span></div><div class="mt-1">${escapeHtml(d.value)}</div></div>`).join('')}
        </div>
        <div id="detail-rels" class="detail-tab hidden">
          ${data.relations.map(r => `<div class="card p-3 mb-2 text-sm flex justify-between"><span>${r.sourceId} ${r.label} ${r.targetId}</span><span class="text-muted">${r.storyTime}</span></div>`).join('')}
        </div>
        <div id="detail-events" class="detail-tab hidden">
          ${data.events.map(ev => `<div class="card p-3 mb-2 text-sm cursor-pointer hover:border-[var(--primary)]" onclick="navigate('#/events?event=${ev.eventId}');closeDrawer();">
            <div class="flex justify-between"><span class="font-medium">${ev.storyTime}</span><span class="text-muted">${ev.type}</span></div>
            <div class="mt-1">${escapeHtml(ev.summary)}</div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function switchDetailTab(tab, panelId) {
  tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('.detail-tab').forEach(p => p.classList.add('hidden'));
  $('#' + panelId).classList.remove('hidden');
}

async function killEntity(id) {
  if (!confirm('确认让该实体退场？此操作不可撤销。')) return;
  closeDrawer();
  await withLoading(async () => {
    await apiCall('killEntity', id, App.storyTime);
    toast('实体已退场', 'info');
    render();
  });
}

ViewAfterRender.graph = () => {
  if (App.viewState.graphMode === '3d') return;
  const canvas = $('#graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const container = $('#graph-canvas-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  drawGraph2D(ctx, canvas.width, canvas.height);
};

function drawGraph2D(ctx, w, h) {
  const data = App.viewState.graphData || { entities: [], relations: [] };
  const filter = (App.viewState.graphFilter || '').toLowerCase();
  const typeFilter = App.viewState.graphType || 'all';
  let entities = data.entities.filter(e => typeFilter === 'all' || e.entityType === typeFilter);
  if (filter) entities = entities.filter(e => (e.properties?.name || e.entityId).toLowerCase().includes(filter));
  const entitySet = new Set(entities.map(e => e.entityId));
  const relations = data.relations.filter(r => entitySet.has(r.sourceId) && entitySet.has(r.targetId));

  // 简单力导向布局
  const positions = {};
  entities.forEach((e, i) => {
    const angle = (i / Math.max(entities.length, 1)) * Math.PI * 2;
    const radius = Math.min(w, h) * 0.32;
    positions[e.entityId] = { x: w/2 + Math.cos(angle) * radius, y: h/2 + Math.sin(angle) * radius };
  });
  // 简单迭代让连线均匀
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

  // 点击处理
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

// =================== V3 事件链 ===================
ViewRender.events = () => {
  const events = App.viewState.events || [];
  const selectedId = App.viewState.selectedEventId;
  const entityFilter = App.viewState.eventEntityFilter || [];
  const typeFilter = App.viewState.eventTypeFilter || [];
  const keyword = App.viewState.eventKeyword || '';

  const allEntities = [...new Set(events.map(e => e.entityId))];
  const filtered = events.filter(e => {
    if (entityFilter.length && !entityFilter.includes(e.entityId)) return false;
    if (typeFilter.length && !typeFilter.includes(e.type)) return false;
    if (keyword && !e.summary.toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  });

  const groups = groupByChapter(filtered);
  const selectedEvent = events.find(e => e.eventId === selectedId);

  return `
    <div class="app-main">
      <aside class="w-64 border-r border-[var(--border)] bg-[var(--card)] p-4 flex flex-col gap-4">
        <div>
          <label class="text-sm text-muted">关键词</label>
          <input class="input mt-1" placeholder="搜索摘要…" value="${escapeHtml(keyword)}" oninput="App.viewState.eventKeyword=this.value;render();">
        </div>
        <div>
          <label class="text-sm text-muted">实体</label>
          <div class="mt-1 space-y-1 max-h-48 overflow-auto text-sm">
            ${allEntities.map(id => {
              const name = events.find(e => e.entityId === id)?.entityType === 'character' ? (MOCK_ENTITIES.find(e=>e.entityId===id)?.properties?.name || id) : id;
              const checked = entityFilter.includes(id) ? 'checked' : '';
              return `<label class="flex items-center gap-2"><input type="checkbox" ${checked} onchange="toggleEventFilter('entity','${id}')"> <span class="truncate">${escapeHtml(name)}</span></label>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label class="text-sm text-muted">类型</label>
          <div class="mt-1 space-y-1 text-sm">
            ${['birth','change','death'].map(t => `<label class="flex items-center gap-2"><input type="checkbox" ${typeFilter.includes(t)?'checked':''} onchange="toggleEventFilter('type','${t}')"> ${t}</label>`).join('')}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="App.viewState.eventEntityFilter=[];App.viewState.eventTypeFilter=[];App.viewState.eventKeyword='';render();">${icon('rotate-ccw', 'w-4 h-4')} 重置</button>
      </aside>
      <div class="flex-1 overflow-auto p-6">
        <h2 class="font-display text-2xl font-medium mb-6">事件链</h2>
        ${Object.keys(groups).length === 0 ? emptyState('暂无匹配事件') : ''}
        ${Object.entries(groups).map(([ch, list]) => `
          <div class="mb-8">
            <h3 class="font-semibold text-lg mb-3 sticky top-0 bg-[var(--background)] py-2 z-10">${formatStoryTime(ch)}</h3>
            <div class="space-y-0">
              ${list.map(ev => renderEventCard(ev, selectedId)).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      ${selectedEvent ? renderEventDetail(selectedEvent) : ''}
    </div>
  `;
};

function renderEventCard(ev, selectedId) {
  const entity = MOCK_ENTITIES.find(e => e.entityId === ev.entityId);
  const typeColor = { birth: 'var(--success-500)', change: 'var(--brand-500)', death: 'var(--error-500)' }[ev.type] || 'var(--muted-foreground)';
  return `
    <div class="timeline-item ${App.storyTime === ev.storyTime ? 'current' : ''} cursor-pointer" onclick="App.viewState.selectedEventId='${ev.eventId}';render();">
      <div class="flex items-center gap-2 mb-1">
        <span class="badge" style="background:${typeColor}20;color:${typeColor}">${ev.type}</span>
        <span class="text-xs text-muted">${ev.storyTime}</span>
        <span class="badge" style="background:var(--muted);color:var(--foreground)">${ev.source === 'engine' ? 'AI' : '手动'}</span>
      </div>
      <div class="font-medium text-sm">${escapeHtml(entity?.properties?.name || ev.entityId)}</div>
      <p class="text-sm text-muted mt-1">${escapeHtml(ev.summary)}</p>
    </div>
  `;
}

function renderEventDetail(ev) {
  const entity = MOCK_ENTITIES.find(e => e.entityId === ev.entityId);
  const chain = App.viewState.chain || { events: [] };
  return `
    <aside class="w-80 border-l border-[var(--border)] bg-[var(--card)] flex flex-col">
      <div class="p-4 border-b border-[var(--border)] flex justify-between items-start">
        <div>
          <div class="text-xs text-muted">${ev.storyTime}</div>
          <h3 class="font-semibold text-lg">${escapeHtml(entity?.properties?.name || ev.entityId)}</h3>
        </div>
        <button class="btn btn-icon btn-ghost btn-sm" onclick="App.viewState.selectedEventId=null;render();">${icon('x', 'w-4 h-4')}</button>
      </div>
      <div class="flex-1 overflow-auto p-4 space-y-4">
        <p class="text-sm">${escapeHtml(ev.summary)}</p>
        <div class="card p-3">
          <div class="text-sm text-muted mb-2">新增事实</div>
          <div class="space-y-1 text-sm">${(ev.newFacts || []).map(f => `<div>• ${f.entityId}.${f.property} = ${escapeHtml(f.value)}</div>`).join('') || '—'}</div>
        </div>
        ${ev.invalidated?.length ? `<div class="card p-3"><div class="text-sm text-muted mb-2">失效声明</div><div class="space-y-1 text-sm">${ev.invalidated.map(d=>`<div>• ${d.declarationId} (${d.property})</div>`).join('')}</div></div>` : ''}
        <button class="btn btn-secondary w-full" onclick="navigate('#/graph');App.viewState.storyTime='${ev.storyTime}';render();">${icon('globe', 'w-4 h-4')} 跳转到世界图（此时刻）</button>
        <div>
          <div class="text-sm font-medium mb-2">因果链</div>
          <div class="space-y-2">
            ${chain.events.map(ce => `<div class="card p-2 text-sm ${ce.eventId===ev.eventId?'border-[var(--primary)]':''}">${ce.storyTime} ${escapeHtml(ce.summary.slice(0,40))}${ce.summary.length>40?'…':''}</div>`).join('')}
          </div>
        </div>
      </div>
    </aside>
  `;
}

function groupByChapter(events) {
  const g = {};
  for (const e of events) {
    const ch = e.storyTime.split('.')[0];
    (g[ch] ||= []).push(e);
  }
  return g;
}

function toggleEventFilter(kind, value) {
  const key = kind === 'entity' ? 'eventEntityFilter' : 'eventTypeFilter';
  const arr = App.viewState[key] || [];
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
  App.viewState[key] = arr;
  render();
}

async function loadEvents() {
  const data = await apiCall('getEvents');
  App.viewState.events = data.events;
  const selected = App.viewState.selectedEventId;
  if (selected) {
    const chain = await apiCall('getChain', selected);
    App.viewState.chain = chain;
  }
}

ViewAfterRender.events = () => {};

// =================== V4 创作编排 ===================
ViewRender.studio = () => {
  const sessions = App.viewState.chatSessions || [];
  const currentId = App.viewState.currentSessionId || (sessions[0]?.id);
  const messages = App.viewState.chatMessages || [];
  const status = App.viewState.schedulerStatus || { queue: { length: 0, items: [] }, plans: [], defaultMode: 'plan' };
  const busy = App.viewState.chatBusy;

  return `
    <div class="app-main">
      <aside class="w-64 border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
        <div class="p-3 border-b border-[var(--border)] flex justify-between items-center">
          <span class="font-medium">会话</span>
          <button class="btn btn-icon btn-ghost btn-sm" onclick="newSession()">${icon('plus', 'w-4 h-4')}</button>
        </div>
        <div class="flex-1 overflow-auto p-2 space-y-1">
          ${sessions.map(s => `
            <div class="tree-row ${currentId===s.id?'active':''}" onclick="switchSession('${s.id}')">
              ${icon('message-square', 'w-4 h-4')}
              <div class="flex-1 min-w-0">
                <div class="truncate text-sm font-medium">${escapeHtml(s.name)}</div>
                <div class="truncate text-xs text-muted">${escapeHtml(s.firstMessage)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </aside>
      <div class="flex-1 flex flex-col min-w-0">
        <div class="h-12 border-b border-[var(--border)] bg-[var(--card)] flex items-center justify-between px-4">
          <div class="flex items-center gap-3 text-sm">
            <span class="text-muted">模式</span>
            <button class="btn btn-sm ${status.defaultMode==='plan'?'btn-secondary':'btn-ghost'}" onclick="setSchedulerMode('plan')">plan</button>
            <button class="btn btn-sm ${status.defaultMode==='yolo'?'btn-secondary':'btn-ghost'}" onclick="setSchedulerMode('yolo')">yolo</button>
            <span class="badge ${status.queue.length>0?'':'hidden'}" style="background:var(--brand-100);color:var(--brand-700)">${status.queue.length} 个计划待审核</span>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openDispatchForm()">${icon('send', 'w-4 h-4')} 发起编排</button>
        </div>
        <div class="flex-1 overflow-auto p-4" id="chat-messages">
          ${messages.length === 0 ? emptyState('开始你的第一段剧情') : messages.map(m => renderMessage(m)).join('')}
          ${busy ? `<div class="message assistant"><div class="message-bubble"><div class="flex items-center gap-2 text-sm text-muted">${icon('loader-2', 'w-4 h-4 animate-spin')} 思考中…</div></div></div>` : ''}
          ${status.plans.map(p => renderPlanCard(p)).join('')}
        </div>
        <div class="p-4 border-t border-[var(--border)] bg-[var(--card)]">
          <div class="flex gap-2">
            <textarea id="chat-input" class="textarea flex-1" rows="1" placeholder="输入消息，@ 提及实体…" ${busy?'disabled':''} onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"></textarea>
            <button class="btn btn-primary" onclick="sendChat()" ${busy?'disabled':''}>${icon('send', 'w-4 h-4')}</button>
          </div>
        </div>
      </div>
      <aside class="w-72 border-l border-[var(--border)] bg-[var(--card)] p-4 flex flex-col gap-4">
        <div>
          <h3 class="font-medium mb-2">队列状态</h3>
          <div class="text-sm text-muted">队列长度 ${status.queue.length}</div>
          <div class="text-sm text-muted">待审核计划 ${status.plans.length}</div>
        </div>
        <div>
          <h3 class="font-medium mb-2">四代理状态</h3>
          <div class="space-y-2 text-sm">${['planner','role','reasoner','renderer'].map(s => `<div class="flex justify-between"><span class="text-muted capitalize">${s}</span><span class="badge" style="background:var(--muted);color:var(--foreground)">就绪</span></div>`).join('')}</div>
        </div>
        <div>
          <h3 class="font-medium mb-2">世界图变更</h3>
          <div class="text-sm text-muted">选择 plan 并发起的编排将在此显示变更摘要。</div>
        </div>
      </aside>
    </div>
  `;
};

function renderMessage(m) {
  return `
    <div class="message ${m.role}">
      <div class="message-bubble">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>
    </div>
  `;
}

function renderPlanCard(p) {
  return `
    <div class="plan-card mb-3">
      <div class="flex justify-between items-start mb-2">
        <div>
          <div class="font-medium">计划 ${p.planId}</div>
          <div class="text-xs text-muted">${p.storyTime} · ${p.mode} · ${p.characterIds.join(', ')}</div>
        </div>
        <span class="badge" style="background:var(--brand-100);color:var(--brand-700)">待审核</span>
      </div>
      <div class="flex gap-2 justify-end">
        <button class="btn btn-sm btn-ghost" onclick="discardPlan('${p.planId}')">丢弃</button>
        <button class="btn btn-sm btn-primary" onclick="commitPlan('${p.planId}')">提交</button>
      </div>
    </div>
  `;
}

function emptyState(text) {
  return `<div class="flex flex-col items-center justify-center h-64 text-muted"><p>${text}</p></div>`;
}

async function loadStudio() {
  const sessions = await apiCall('getChatSessions');
  App.viewState.chatSessions = sessions;
  const current = App.viewState.currentSessionId || sessions[0]?.id;
  if (current) {
    const msgs = await apiCall('getChatMessages', current);
    App.viewState.chatMessages = msgs;
    App.viewState.currentSessionId = current;
  }
  const status = await apiCall('getSchedulerStatus');
  App.viewState.schedulerStatus = status;
}

async function switchSession(id) {
  App.viewState.currentSessionId = id;
  await loadStudio();
  render();
}

function newSession() {
  const id = 'session-' + Date.now();
  App.viewState.chatSessions.unshift({ id, name: '新会话', created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: '' });
  App.viewState.currentSessionId = id;
  App.viewState.chatMessages = [];
  render();
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  App.viewState.chatMessages.push({ role: 'user', text, ts: new Date().toISOString() });
  App.viewState.chatBusy = true;
  render();
  try {
    await apiCall('sendChatMessage', text);
    await new Promise(r => setTimeout(r, 800));
    App.viewState.chatMessages.push({ role: 'assistant', text: '这是一个模拟回复。在实际后端中，这里会显示 SSE 流式输出内容。', ts: new Date().toISOString() });
  } catch (e) { handleApiError(e); }
  App.viewState.chatBusy = false;
  render();
}

async function setSchedulerMode(mode) {
  await withLoading(async () => {
    await apiCall('setSchedulerMode', mode);
    await loadStudio();
    render();
  });
}

function openDispatchForm() {
  openModal('发起编排',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">指令</label><textarea id="dp-instruction" class="textarea" rows="3">继续推进剧情</textarea></div>
      <div><label class="text-sm text-muted">角色 IDs（逗号分隔）</label><input id="dp-chars" class="input" value="char-01,char-02"></div>
      <div><label class="text-sm text-muted">故事时间</label><input id="dp-st" class="input" value="${App.storyTime || ''}"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitDispatch()">派发</button>`);
}

async function submitDispatch() {
  const instruction = $('#dp-instruction').value;
  const chars = $('#dp-chars').value.split(',').map(s => s.trim()).filter(Boolean);
  const st = $('#dp-st').value;
  closeModal();
  await withLoading(async () => {
    await apiCall('dispatch', { instruction, characterIds: chars, storyTime: st });
    await loadStudio();
    toast('编排已派发', 'success');
    render();
  });
}

async function commitPlan(planId) {
  await withLoading(async () => {
    const res = await apiCall('commitPlan', planId);
    await loadStudio();
    toast(`计划已提交，生成 ${res.chapterPath || '章节'}`, 'success');
    render();
  });
}

async function discardPlan(planId) {
  await withLoading(async () => {
    await apiCall('discardPlan', planId);
    await loadStudio();
    toast('计划已丢弃', 'info');
    render();
  });
}

ViewAfterRender.studio = () => {
  const el = $('#chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
};

// =================== V5 调试 ===================
ViewRender.debug = () => {
  const events = App.viewState.debugEvents || [];
  const level = App.viewState.debugLevel || 'all';
  const module = App.viewState.debugModule || '';
  const keyword = App.viewState.debugKeyword || '';

  const filtered = events.filter(e => {
    if (level !== 'all' && e.level !== level) return false;
    if (module && e.module !== module) return false;
    if (keyword && !e.message.toLowerCase().includes(keyword.toLowerCase())) return false;
    return true;
  });

  const modules = [...new Set(events.map(e => e.module))];

  return `
    <div class="flex flex-col h-full">
      <div class="h-14 border-b border-[var(--border)] bg-[var(--card)] flex items-center gap-3 px-4">
        <select class="select w-32" onchange="App.viewState.debugLevel=this.value;render();">
          <option value="all">全部级别</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option>
        </select>
        <select class="select w-40" onchange="App.viewState.debugModule=this.value;render();">
          <option value="">全部模块</option>
          ${modules.map(m => `<option value="${m}" ${module===m?'selected':''}>${m}</option>`).join('')}
        </select>
        <input class="input w-48" placeholder="关键词…" value="${escapeHtml(keyword)}" oninput="App.viewState.debugKeyword=this.value;render();">
        <div class="flex-1"></div>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" ${App.viewState.debugAutoScroll?'checked':''} onchange="App.viewState.debugAutoScroll=this.checked"> 自动滚动</label>
        <button class="btn btn-ghost btn-sm" onclick="clearDebug()">${icon('trash-2', 'w-4 h-4')} 清空</button>
      </div>
      <div class="flex-1 overflow-auto p-4 font-mono text-sm" id="debug-stream">
        ${filtered.length === 0 ? emptyState('暂无调试事件（发起一次编排即可看到流水线）') : filtered.map(e => renderDebugEvent(e)).join('')}
      </div>
    </div>
  `;
};

function renderDebugEvent(e) {
  const color = { info: 'var(--foreground)', warn: 'var(--brand-500)', error: 'var(--error-500)' }[e.level];
  return `
    <div class="py-1 border-b border-[var(--border)] last:border-0">
      <span class="text-xs text-muted">${formatTime(e.ts)}</span>
      <span class="text-xs mx-1" style="color:${color}">[${e.level.toUpperCase()}]</span>
      <span class="text-xs text-muted">${e.module}</span>
      <span class="ml-2">${escapeHtml(e.message)}</span>
      ${e.payload && Object.keys(e.payload).length ? `<div class="text-xs text-muted pl-20 mt-0.5">${escapeHtml(JSON.stringify(e.payload))}</div>` : ''}
    </div>
  `;
}

async function loadDebug() {
  const data = await apiCall('getDebugEvents');
  App.viewState.debugEvents = data.events;
}

async function clearDebug() {
  await withLoading(async () => { await apiCall('clearDebugEvents'); await loadDebug(); render(); toast('已清空', 'info'); });
}

ViewAfterRender.debug = () => {
  if (App.viewState.debugAutoScroll) {
    const el = $('#debug-stream');
    if (el) el.scrollTop = el.scrollHeight;
  }
};

// =================== V6 文件编辑 ===================
ViewRender.files = () => {
  const tree = App.viewState.fileTree || [];
  const tabs = App.viewState.openFileTabs || [];
  const activePath = App.viewState.activeFilePath;
  const activeFile = tabs.find(t => t.path === activePath);

  return `
    <div class="app-main">
      <aside class="w-60 border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
        <div class="p-3 border-b border-[var(--border)] flex justify-between items-center">
          <span class="font-medium">文件</span>
          <button class="btn btn-icon btn-ghost btn-sm" onclick="openCreateFile()">${icon('file-plus', 'w-4 h-4')}</button>
        </div>
        <div class="flex-1 overflow-auto p-2">${renderFileTree(tree)}</div>
      </aside>
      <div class="flex-1 flex flex-col min-w-0">
        <div class="h-10 border-b border-[var(--border)] bg-[var(--card)] flex items-center overflow-x-auto">
          ${tabs.map(t => `
            <div class="tab-item ${t.path===activePath?'active':''}" onclick="switchFileTab('${t.path}')">
              <span class="truncate max-w-[140px]">${escapeHtml(t.name)}</span>
              <span class="dirty-dot" style="${t.dirty ? '' : 'display:none;'}"></span>
              <button class="ml-1 hover:text-[var(--error)]" onclick="event.stopPropagation();closeFileTab('${t.path}')">${icon('x', 'w-3 h-3')}</button>
            </div>
          `).join('')}
        </div>
        ${activeFile ? `
          <div class="flex-1 flex flex-col min-h-0">
            <div class="h-10 border-b border-[var(--border)] bg-[var(--card)] flex items-center gap-2 px-3">
              <button class="btn btn-sm btn-ghost ${activeFile.preview?'active':''}" onclick="togglePreview()">${icon('eye', 'w-4 h-4')} 预览</button>
              <div class="w-px h-4 bg-[var(--border)]"></div>
              <button class="btn btn-sm btn-ghost" onclick="saveActiveFile()">${icon('save', 'w-4 h-4')} 保存</button>
              <span id="file-status" class="text-xs text-muted ml-auto">${activeFile.dirty ? '未保存' : (activeFile.mtime ? '修改于 ' + formatTime(activeFile.mtime) : '')}</span>
            </div>
            <div class="flex-1 flex min-h-0">
              ${activeFile.preview ? `<div class="flex-1 overflow-auto p-6 font-serif prose max-w-none"><div id="file-preview"></div></div>` : ''}
              <textarea id="file-editor" class="textarea flex-1 rounded-none border-0 bg-[var(--background)] font-mono text-sm leading-6 p-4 resize-none ${activeFile.preview?'hidden':''}"
                oninput="onFileChange(this.value)" spellcheck="false">${escapeHtml(activeFile.content || '')}</textarea>
            </div>
          </div>
        ` : `<div class="flex-1 flex items-center justify-center text-muted">从左侧选择一个文件开始编辑</div>`}
      </div>
    </div>
  `;
};

function renderFileTree(nodes, depth = 0) {
  return nodes.map(n => {
    if (n.type === 'dir') {
      return `
        <div class="tree-node" style="padding-left:${depth*12}px">
          <div class="tree-row font-medium text-sm" onclick="toggleTreeNode(this)">
            ${icon('chevron-down', 'w-3.5 h-3.5')}
            ${icon('folder', 'w-4 h-4')}
            <span>${escapeHtml(n.name)}</span>
          </div>
          <div class="tree-children">${renderFileTree(n.children, depth+1)}</div>
        </div>
      `;
    }
    return `
      <div class="tree-node" style="padding-left:${depth*12 + 18}px">
        <div class="tree-row text-sm ${App.viewState.activeFilePath===n.path?'active':''}" onclick="openFile('${n.path}')">
          ${icon('file-text', 'w-4 h-4')}
          <span class="truncate">${escapeHtml(n.name)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function toggleTreeNode(row) {
  const children = row.nextElementSibling;
  if (!children) return;
  children.classList.toggle('hidden');
  const chevron = row.querySelector('[data-lucide="chevron-down"]');
  if (chevron) chevron.style.transform = children.classList.contains('hidden') ? 'rotate(-90deg)' : 'rotate(0deg)';
}

async function loadFiles() {
  const data = await apiCall('getFileTree');
  App.viewState.fileTree = data;
}

async function openFile(path) {
  await withLoading(async () => {
    const tabs = App.viewState.openFileTabs || [];
    if (!tabs.find(t => t.path === path)) {
      const data = await apiCall('readFile', path);
      tabs.push({ path, name: path.split('/').pop(), content: data.content, mtime: data.mtime, dirty: false, baseMtime: data.mtime });
    }
    App.viewState.openFileTabs = tabs;
    App.viewState.activeFilePath = path;
    render();
  });
}

function switchFileTab(path) { App.viewState.activeFilePath = path; render(); }
function closeFileTab(path) {
  const tabs = App.viewState.openFileTabs || [];
  const idx = tabs.findIndex(t => t.path === path);
  if (idx >= 0) {
    if (tabs[idx].dirty && !confirm('文件未保存，确认关闭？')) return;
    tabs.splice(idx, 1);
  }
  App.viewState.openFileTabs = tabs;
  if (App.viewState.activeFilePath === path) App.viewState.activeFilePath = tabs[0]?.path || null;
  render();
}

function onFileChange(value) {
  const tabs = App.viewState.openFileTabs || [];
  const t = tabs.find(t => t.path === App.viewState.activeFilePath);
  if (!t) return;
  t.content = value;
  t.dirty = true;
  // 不整页刷新，仅更新 dirty 指示器，保持输入焦点
  const dot = $(`.tab-item.active .dirty-dot`);
  if (dot) dot.style.display = '';
}

async function saveActiveFile() {
  const tabs = App.viewState.openFileTabs || [];
  const t = tabs.find(t => t.path === App.viewState.activeFilePath);
  if (!t) return;
  try {
    const res = await apiCall('writeFile', t.path, t.content, t.baseMtime);
    t.baseMtime = res.mtime; t.mtime = res.mtime; t.dirty = false;
    toast('保存成功', 'success');
  } catch (e) {
    if (e.code === 'MTIME_CONFLICT') {
      openModal('文件冲突',
        `<p>文件已被他人修改。你可以选择重载最新内容，或强制保存覆盖。</p>`,
        `<button class="btn btn-ghost" onclick="reloadActiveFile();closeModal()">重载</button><button class="btn btn-primary" onclick="forceSaveActiveFile();closeModal()">强制保存</button>`);
    } else handleApiError(e);
  }
  render();
}

async function reloadActiveFile() {
  const t = (App.viewState.openFileTabs || []).find(t => t.path === App.viewState.activeFilePath);
  if (!t) return;
  const data = await apiCall('readFile', t.path);
  t.content = data.content; t.baseMtime = data.mtime; t.mtime = data.mtime; t.dirty = false;
  render();
}

async function forceSaveActiveFile() {
  const t = (App.viewState.openFileTabs || []).find(t => t.path === App.viewState.activeFilePath);
  if (!t) return;
  const res = await apiCall('writeFile', t.path, t.content);
  t.baseMtime = res.mtime; t.mtime = res.mtime; t.dirty = false;
  toast('强制保存成功', 'success');
  render();
}

function togglePreview() {
  const t = (App.viewState.openFileTabs || []).find(t => t.path === App.viewState.activeFilePath);
  if (t) { t.preview = !t.preview; render(); }
}

function openCreateFile() {
  openModal('新建文件',
    `<div><label class="text-sm text-muted">路径（以 .md 结尾）</label><input id="new-file-path" class="input" value="正文/ch007.md"></div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitCreateFile()">创建</button>`);
}

async function submitCreateFile() {
  const path = $('#new-file-path').value;
  closeModal();
  await withLoading(async () => {
    await apiCall('createFile', path);
    await loadFiles();
    await openFile(path);
    toast('文件已创建', 'success');
  });
}

ViewAfterRender.files = () => {
  const t = (App.viewState.openFileTabs || []).find(t => t.path === App.viewState.activeFilePath);
  if (t && t.preview) {
    const el = $('#file-preview');
    if (el) el.innerHTML = simpleMarkdown(t.content || '');
  }
};

function simpleMarkdown(md) {
  return escapeHtml(md)
    .replace(/^# (.*)$/gm, '<h1 class="text-2xl font-bold mb-4">$1</h1>')
    .replace(/^## (.*)$/gm, '<h2 class="text-xl font-bold mb-3 mt-6">$1</h2>')
    .replace(/^### (.*)$/gm, '<h3 class="text-lg font-bold mb-2 mt-4">$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-[var(--muted)] px-1 rounded">$1</code>')
    .replace(/\n/g, '<br>');
}

// =================== V7 设置 ===================
ViewRender.settings = () => {
  const appConfig = App.viewState.appConfig || MOCK_APP_CONFIG;
  const llm = App.viewState.llmStatus || MOCK_LLM_STATUS;
  const rulesets = App.viewState.rulesets || MOCK_RULESETS;
  const novel = App.viewState.novelJson || MOCK_NOVEL_JSON;
  const env = App.viewState.envConfig || MOCK_ENV_CONFIG;
  const active = App.activeProject;

  return `
    <div class="p-6 max-w-4xl mx-auto w-full">
      <h1 class="font-display text-2xl font-medium mb-6">设置</h1>

      <div class="card p-5 mb-6">
        <h2 class="font-semibold text-lg mb-4 flex items-center gap-2">${icon('sliders-horizontal', 'w-5 h-5')} 应用配置</h2>
        <div class="grid grid-cols-2 gap-4 mb-4">
          <div><label class="text-sm text-muted">主题</label><select class="select mt-1" onchange="saveAppConfig({theme:this.value})"><option value="light" ${appConfig.theme==='light'?'selected':''}>浅色</option><option value="dark" ${appConfig.theme==='dark'?'selected':''}>深色</option></select></div>
          <div><label class="text-sm text-muted">编辑器字号</label><input type="number" class="input mt-1" value="${appConfig.editorFontSize}" onchange="saveAppConfig({editorFontSize:parseInt(this.value)})"></div>
          <div><label class="text-sm text-muted">自动保存</label><select class="select mt-1" onchange="saveAppConfig({autosave:this.value==='true'})"><option value="true" ${appConfig.autosave?'selected':''}>开启</option><option value="false" ${!appConfig.autosave?'selected':''}>关闭</option></select></div>
          <div><label class="text-sm text-muted">自动保存间隔（秒）</label><input type="number" class="input mt-1" value="${appConfig.autosaveInterval}" onchange="saveAppConfig({autosaveInterval:parseInt(this.value)})"></div>
        </div>
      </div>

      <div class="card p-5 mb-6">
        <h2 class="font-semibold text-lg mb-4 flex items-center gap-2">${icon('brain', 'w-5 h-5')} 模型配置</h2>
        <div class="space-y-3">
          ${Object.entries(llm).map(([slot, cfg]) => `
            <div class="flex items-center gap-3 p-3 border border-[var(--border)] rounded-lg">
              <div class="w-24 font-medium capitalize">${slot}</div>
              <div class="flex-1 text-sm text-muted">${cfg.resolved ? cfg.resolved.provider + ' / ' + cfg.resolved.model : '未解析'}</div>
              <span class="badge" style="background:var(--muted);color:var(--foreground)">${cfg.source}</span>
              <span class="badge ${cfg.hasKey?'':'hidden'}" style="background:var(--success-100);color:var(--success-700)">有密钥</span>
              <button class="btn btn-sm btn-ghost" onclick="openLlmSlot('${slot}')">配置</button>
            </div>
          `).join('')}
        </div>
      </div>

      ${active ? `
        <div class="card p-5 mb-6">
          <h2 class="font-semibold text-lg mb-4 flex items-center gap-2">${icon('book-open', 'w-5 h-5')} 项目配置 · ${escapeHtml(active.meta?.name || active.relativePath)}</h2>
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div><label class="text-sm text-muted">小说名称</label><input class="input mt-1" value="${escapeHtml(novel.name)}" onchange="saveNovelJson({name:this.value})"></div>
              <div><label class="text-sm text-muted">章节目录</label><input class="input mt-1" value="${escapeHtml(novel.chaptersDir)}" onchange="saveNovelJson({chaptersDir:this.value})"></div>
            </div>
            <div>
              <label class="text-sm text-muted">渲染规则集</label>
              <textarea class="textarea mt-1 font-mono text-sm" rows="4" onchange="saveRuleset('render', this.value)">${escapeHtml(rulesets.render)}</textarea>
            </div>
            <div>
              <label class="text-sm text-muted">角色规则集</label>
              <textarea class="textarea mt-1 font-mono text-sm" rows="4" onchange="saveRuleset('role', this.value)">${escapeHtml(rulesets.role)}</textarea>
            </div>
            <div>
              <label class="text-sm text-muted">规划规则集</label>
              <textarea class="textarea mt-1 font-mono text-sm" rows="4" onchange="saveRuleset('planner', this.value)">${escapeHtml(rulesets.planner)}</textarea>
            </div>
          </div>
        </div>
      ` : `
        <div class="card p-5 mb-6 text-muted">项目配置需要先激活项目。</div>
      `}

      <div class="card p-5">
        <h2 class="font-semibold text-lg mb-4 flex items-center gap-2">${icon('terminal', 'w-5 h-5')} 环境变量</h2>
        <div class="grid grid-cols-2 gap-4">
          <div><label class="text-sm text-muted">HF_ENDPOINT</label><input class="input mt-1" value="${escapeHtml(env.HF_ENDPOINT)}" onchange="saveEnv({HF_ENDPOINT:this.value})"></div>
          <div><label class="text-sm text-muted">PI_DEBUG</label><input class="input mt-1" value="${escapeHtml(env.PI_DEBUG)}" onchange="saveEnv({PI_DEBUG:this.value})"></div>
          <div><label class="text-sm text-muted">PI_EMBEDDER_MODEL</label><input class="input mt-1" value="${escapeHtml(env.PI_EMBEDDER_MODEL)}" onchange="saveEnv({PI_EMBEDDER_MODEL:this.value})"></div>
        </div>
      </div>
    </div>
  `;
};

async function loadSettings() {
  App.viewState.appConfig = await apiCall('getAppConfig');
  App.viewState.llmStatus = await apiCall('getLlmStatus');
  if (App.activeProject) {
    App.viewState.rulesets = await apiCall('getRulesets');
    App.viewState.novelJson = await apiCall('getNovelJson');
    App.viewState.envConfig = await apiCall('getEnvConfig');
  }
}

async function saveAppConfig(patch) {
  await apiCall('setAppConfig', patch);
  if (patch.theme) toggleTheme();
  await loadSettings();
  toast('应用配置已保存', 'success');
  render();
}

function openLlmSlot(slot) {
  const cfg = (App.viewState.llmStatus || MOCK_LLM_STATUS)[slot];
  openModal(`配置模型 · ${slot}`,
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">Provider</label><input id="llm-provider" class="input" value="${escapeHtml(cfg.configured?.provider || cfg.resolved?.provider || '')}"></div>
      <div><label class="text-sm text-muted">Model</label><input id="llm-model" class="input" value="${escapeHtml(cfg.configured?.model || cfg.resolved?.model || '')}"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="apiCall('clearLlmSlot','${slot}');closeModal();loadSettings().then(render);toast('已清除','info')">清除</button><button class="btn btn-primary" onclick="submitLlmSlot('${slot}')">保存</button>`);
}

async function submitLlmSlot(slot) {
  const provider = $('#llm-provider').value;
  const model = $('#llm-model').value;
  closeModal();
  await apiCall('setLlmSlot', slot, provider, model);
  await loadSettings();
  toast('模型配置已保存', 'success');
  render();
}

async function saveRuleset(name, content) {
  await apiCall('setRuleset', name, content);
  await loadSettings();
  toast('规则集已保存', 'success');
  render();
}

async function saveNovelJson(patch) {
  await apiCall('setNovelJson', patch);
  await loadSettings();
  toast('novel.json 已保存', 'success');
  render();
}

async function saveEnv(patch) {
  await apiCall('setEnvConfig', patch);
  await loadSettings();
  toast('环境变量已保存', 'success');
  render();
}

ViewAfterRender.settings = () => {};

// =================== 视图数据加载入口 ===================
const viewLoaders = {
  graph: loadGraph,
  events: loadEvents,
  studio: loadStudio,
  debug: loadDebug,
  files: loadFiles,
  settings: loadSettings
};
