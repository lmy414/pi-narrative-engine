/**
 * 世界图视图 V3 —— 高保真重构（视觉基准：narrative-engine-design/pages/world-graph.html 三栏工作台）
 *
 * 本文件直接覆盖 views.js 中的旧世界图实现（模式同 views/projects.js）：
 *   - ViewRender.graph / ViewAfterRender.graph
 *   - viewLoaders.graph → graphLoadData（原 loadGraph 固定 includeClosed='0'，无法支撑「显示已闭合」开关）
 *
 * 场景渲染：仅 3D（3d-force-graph / three.js WebGL），2D canvas 模块已移除。
 *
 * 复用 views.js 全局函数（不在本文件重复定义，避免同名覆盖）：
 *   loadGraph / selectEntity / stepStoryTime / filterGraphEntities / openQuickEvent /
 *   submitQuickEvent / openQuickRelation / submitQuickRelation / openEntityDetail /
 *   killEntity
 *
 * 状态读写约定（T1 命名空间访问器，兼容旧平面字段）：
 *   graphState(key, fallback)  读取：一般键优先 viewState('graph')[key] 回退 App.viewState[key]；
 *                              selectedEntityId/inspectorEntityId 例外：flat 优先（复用函数只写平面字段）
 *   setGraphState(key, value)  写入：命名空间与平面字段同时写，兼容 loadGraph 等旧函数
 */

// ==================== 状态读写 ====================

function graphState(key, fallback) {
  const ns = viewState('graph');
  // 选中态（selectedEntityId / inspectorEntityId）以 flat 平面字段优先：
  // selectEntity / Inspector 关闭按钮等复用函数（views.js，不可改）只写 App.viewState，
  // ns 仅由 setGraphState 双写备份，flat 恒不旧于 ns，flat 优先可避免 ns 陈旧导致选中失效。
  if (key === 'selectedEntityId' || key === 'inspectorEntityId') {
    if (App.viewState[key] !== undefined) return App.viewState[key];
    if (ns[key] !== undefined) return ns[key];
    return fallback;
  }
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setGraphState(key, value) {
  viewState('graph')[key] = value;
  App.viewState[key] = value;
}

/** BUG-029：角色视角模式的可见实体 ID 集——该角色 + 直接关系邻居（omniscient 返回 null 表示不过滤） */
function characterViewNeighborIds(characterView, relations) {
  if (!characterView || characterView === 'omniscient') return null;
  const ids = new Set([characterView]);
  (relations || []).forEach((r) => {
    if (r.sourceId === characterView) ids.add(r.targetId);
    if (r.targetId === characterView) ids.add(r.sourceId);
  });
  return ids;
}

// ==================== 数据加载 ====================

/**
 * 世界图数据加载器（覆盖 viewLoaders.graph）。
 * 相比旧 loadGraph：支持「显示已闭合」开关（includeClosed），并缓存事件供 Inspector 使用。
 * M-Logic-11 修复：代际守卫——快速切换 storyTime / 重复进入时，过期请求的写入被丢弃，
 * 防止后发先至用旧 storyTime 数据覆盖新数据（页面数据与 App.storyTime 不一致）。
 */
let graphLoadSeq = 0;
async function graphLoadData() {
  const seq = ++graphLoadSeq;
  // 先拉 status 确定 storyTime（新项目/新 commit 后 storyTime 为空或落后时先同步到最新），
  // 再带 storyTime 拉图——真实后端在 storyTime 为空时直接 400 STORY_TIME_REQUIRED（mock 忽略参数所以 mock 不坏）
  const status = await apiCall('getStatus');
  if (seq !== graphLoadSeq) return;
  setGraphState('graphStatus', status);
  syncStoryTime(status.storyTimes || []);

  // 🟠-27（2026-08-08）：空项目（无 storyTime）直接渲染空态——
  // 此前带空 storyTime 调 getGraph 必现 400 STORY_TIME_REQUIRED toast；
  // 事件缓存/默认选中依赖实体数据，一并跳过
  const storyTimes = (status && status.storyTimes) || [];
  if (storyTimes.length === 0) {
    setGraphState('graphData', { entities: [], relations: [], storyTime: null });
    setGraphState('events', []);
    App.viewState.entityIndex = {};
    return;
  }

  const includeClosed = graphState('includeClosed', false);
  const data = await apiCall('getGraph', App.storyTime, includeClosed ? '1' : '0');
  if (seq !== graphLoadSeq) return;
  setGraphState('graphData', data);
  App.viewState.entityIndex = Object.fromEntries((data.entities || []).map((entity) => [entity.entityId, entity]));

  // 事件缓存：StoryTime 变化时刷新（供 Inspector「最近事件」）
  if (graphState('_eventsAt', null) !== App.storyTime) {
    const evData = await apiCall('getEvents');
    if (seq !== graphLoadSeq) return;
    setGraphState('events', evData.events || []);
    setGraphState('_eventsAt', App.storyTime);
  }

  // 无任何选中时默认选中首个实体（贴近设计稿默认态：打开即见 Inspector）
  if (!graphState('selectedEntityId', null) && data.entities.length) {
    const first = data.entities[0];
    setGraphState('selectedEntityId', first.entityId);
    setGraphState('inspectorEntityId', first.entityId);
  }
}
viewLoaders.graph = graphLoadData;

// ==================== 渲染 ====================

ViewRender.graph = () => {
  const typeFilter = graphState('graphType', 'all');
  const selectedId = graphState('selectedEntityId', null);
  const inspectorId = graphState('inspectorEntityId', selectedId);
  const includeClosed = graphState('includeClosed', false);
  const characterView = graphState('characterView', 'omniscient');
  const graphData = graphState('graphData', { entities: [], relations: [] });
  const status = graphState('graphStatus', { entityCount: 0, eventCount: 0 });
  const entities = graphData.entities || [];
  // BUG-029：角色视角模式——预计算邻居 ID 集，列表与 3D 场景共用
  const viewNeighborIds = characterViewNeighborIds(characterView, graphData.relations);

  const matchesFilter = (e) => {
    if (typeFilter !== 'all' && e.entityType !== typeFilter) return false;
    // F-1 修复（2026-08-08）：搜索过滤由 graphSearchEntities 做 DOM 级即时过滤，
    // 渲染层不再按 searchFilter 过滤列表（否则清空输入时行集合不完整、列表残留过滤结果）
    if (viewNeighborIds && !viewNeighborIds.has(e.entityId)) return false;
    return true;
  };
  const listEntities = entities.filter(matchesFilter);

  const typeTabs = [{ id: 'all', label: '全部' }]
    .concat(Object.keys(ENTITY_TYPES).map((t) => ({ id: t, label: ENTITY_TYPES[t].label })))
    .map((t) => `<button type="button" class="type-tab${t.id === typeFilter ? ' active' : ''}" onclick="setGraphType(${q(t.id)})">${t.label}</button>`)
    .join('');

  const listItems = listEntities.map((e) => graphEntityItemHtml(e, selectedId)).join('');

  const statsText =
    status.entityCount != null
      ? `${status.entityCount} 实体 · ${status.eventCount} 事件`
      : `${App.activeProject && App.activeProject.stats ? App.activeProject.stats.entityCount + ' 实体 · ' + App.activeProject.stats.eventCount + ' 事件' : '—'}`;

  const characterOptions = [
    { id: 'omniscient', label: '全知视角' },
    ...entities
      .filter((e) => e.entityType === 'character')
      .map((e) => ({ id: e.entityId, label: `${e.name || e.entityId} 视角` })),
  ]
    .map((o) => `<option value="${escapeHtml(o.id)}"${o.id === characterView ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
    .join('');

  return `
  <div class="graph-workspace">
    <aside class="sidebar-left">
      <div class="sidebar-header">
        <h2 class="sidebar-title">实体</h2>
        <button type="button" class="icon-btn" title="筛选选项" onclick="resetGraphFilters()">${icon('filter', 'w-4 h-4')}</button>
      </div>
      <div class="type-tab-bar">${typeTabs}</div>
      <div class="entity-search">
        ${icon('search', 'w-4 h-4')}
        <input type="text" placeholder="搜索实体…" value="${escapeHtml(graphState('graphFilter', ''))}" oninput="graphSearchEntities(this.value)" spellcheck="false">
      </div>
      <div class="entity-list" id="entity-list">
        ${listItems || '<div class="entity-list-empty">没有匹配的实体</div>'}
      </div>
    </aside>

    <div class="scene-container">
      <div class="status-bar">
        <div class="status-left">
          <div class="status-storytime" title="切换时间点">
            <span class="status-label">StoryTime</span>
            <button type="button" class="status-nav-btn" onclick="stepStoryTime(-1)">${icon('chevron-left', 'w-3.5 h-3.5')}</button>
            <button type="button" class="storytime-value" onclick="pickGraphStoryTime()">${escapeHtml(App.storyTime || '—')}</button>
            <button type="button" class="status-nav-btn" onclick="stepStoryTime(1)">${icon('chevron-right', 'w-3.5 h-3.5')}</button>
          </div>
          <div class="status-stats">${escapeHtml(statsText)}</div>
          ${characterView !== 'omniscient' ? `<span class="view-mode-badge">${icon('eye', 'w-3 h-3')} 视角模式</span>` : ''}
        </div>
        <div class="status-right">
          <label class="include-closed-toggle" title="显示已闭合关系">
            <span class="toggle-label">显示已闭合</span>
            <span class="switch"><input type="checkbox" ${includeClosed ? 'checked' : ''} onchange="toggleIncludeClosed(this)"><span class="slider"></span></span>
          </label>
          <div class="character-view-selector">
            <select onchange="changeCharacterView(this.value)" title="视角选择">
              ${characterOptions}
            </select>
          </div>
        </div>
      </div>

      <div class="scene-canvas" id="graph-canvas-container">
        <div id="graph-3d" class="graph-3d-container"></div>
        <div class="scene-toolbar">
          <button type="button" class="toolbar-btn toolbar-primary" title="快速记事件" onclick="openQuickEvent()">${icon('pencil', 'w-4 h-4')}</button>
          <button type="button" class="toolbar-btn" title="快速加关系" onclick="openQuickRelation()">${icon('share-2', 'w-4 h-4')}</button>
          <button type="button" class="toolbar-btn" title="视图重置" onclick="resetSceneView()">${icon('rotate-cw', 'w-4 h-4')}</button>
        </div>
      </div>
    </div>

    <aside class="sidebar-right">
      ${graphInspectorHtml(inspectorId)}
    </aside>
  </div>`;
};

ViewAfterRender.graph = () => {
  graphInit3D();
  startStoryTimeWatcher();
};

/** 切出世界图视图时销毁 3D 场景与挂起的防抖重建，释放 WebGL 上下文 */
function cleanupGraphView() {
  if (_graph3dRebuildTimer) { clearTimeout(_graph3dRebuildTimer); _graph3dRebuildTimer = null; }
  graphDispose3D();
  stopStoryTimeWatcher();
}

// ==================== 左侧实体列表 ====================

function graphEntityItemHtml(e, selectedId) {
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#8a8a8a' };
  const name = e.name || e.entityId;
  return `
  <div class="entity-item${e.entityId === selectedId ? ' selected' : ''}" onclick="graphSelectEntity(${q(e.entityId)})" data-entity-id="${escapeHtml(e.entityId)}">
    <span class="entity-dot" style="background:${type.color}"></span>
    <div class="entity-info">
      <div class="entity-name">${escapeHtml(name)}</div>
      <div class="entity-summary">${escapeHtml(e.summary || '')}</div>
    </div>
  </div>`;
}

// ==================== 右侧 Inspector ====================

function graphInspectorHtml(inspectorId) {
  if (!inspectorId) {
    return `
    <div class="inspector-empty">
      <div class="inspector-empty-icon">${icon('mouse-pointer', 'w-5 h-5')}</div>
      <p>在图中选择实体以查看详情</p>
    </div>`;
  }
  const graphData = graphState('graphData', { entities: [], relations: [] });
  const entity = (graphData.entities || []).find((e) => e.entityId === inspectorId);
  if (!entity) return '';

  const type = ENTITY_TYPES[entity.entityType] || { label: entity.entityType, color: '#8a8a8a', bg: '#f0f0f0' };
  const name = entity.name || entity.entityId;

  // 属性（0.3.0 决策①：声明列表展示——property + description + modality 徽标；
  // 名字声明剔除（标题已显示 Entity.name 快照），避免重复）
  const props = (entity.properties || [])
    .filter((d) => d.property !== '名字' && d.property !== 'name')
    .map((d) => `
      <div class="prop-row">
        <span class="prop-key">${escapeHtml(d.property)}</span>
        <span class="prop-value">${escapeHtml(d.description)}</span>
        ${d.modality && d.modality !== 'fact' ? `<span class="decl-modality">${escapeHtml(d.modality)}</span>` : ''}
        <button type="button" class="prop-edit" title="编辑 ${escapeHtml(d.property)}" onclick="editGraphProperty(${q(entity.entityId)}, ${q(d.property)})">${icon('pencil', 'w-3.5 h-3.5')}</button>
      </div>`)
    .join('');
  const aliveRow = entity.alive === undefined ? '' : `
    <div class="prop-row">
      <span class="prop-key">状态</span>
      <span class="prop-value"><span class="alive-badge${entity.alive ? ' alive' : ''}"><span class="alive-dot"></span>${entity.alive ? '存活' : '已退场'}</span></span>
    </div>`;

  // 关系
  const rels = (graphData.relations || []).filter((r) => r.sourceId === inspectorId || r.targetId === inspectorId);
  const outCount = rels.filter((r) => r.sourceId === inspectorId).length;
  const inCount = rels.length - outCount;
  const relRows = rels
    .map((r) => {
      const out = r.sourceId === inspectorId;
      const otherId = out ? r.targetId : r.sourceId;
      const other = (graphData.entities || []).find((e) => e.entityId === otherId);
      if (!other) return '';
      const otherType = ENTITY_TYPES[other.entityType] || { color: '#8a8a8a' };
      const otherName = other.name || other.entityId;
      return `
      <div class="rel-row" onclick="graphSelectEntity(${q(otherId)})" title="选中 ${escapeHtml(otherName)}">
        <span class="entity-dot" style="background:${otherType.color}"></span>
        <span class="rel-name">${escapeHtml(otherName)}</span>
        <span class="rel-meta"><span class="rel-label">${escapeHtml(r.label)}</span>${icon(out ? 'arrow-right' : 'arrow-left', 'w-3 h-3 rel-arrow')}</span>
        ${r.description ? `<span class="rel-desc" title="${escapeHtml(r.description)}">${escapeHtml(r.description)}</span>` : ''}
      </div>`;
    })
    .join('');

  // 最近事件
  const eventRows = (graphState('events', []) || [])
    .filter((ev) => ev.entityId === inspectorId && DemoUtils.compareStoryTime(ev.storyTime, App.storyTime) <= 0)
    .sort((a, b) => DemoUtils.compareStoryTime(a.storyTime, b.storyTime))
    .slice(-3)
    .reverse()
    .map((ev) => `
      <div class="event-row" onclick="navigate('#/events?event=' + encodeURIComponent(${q(ev.eventId)}))" title="查看事件链">
        <span class="event-time">${escapeHtml(ev.storyTime)}</span>
        <span class="event-type-tag">${escapeHtml(ev.type)}</span>
        <span class="event-summary">${escapeHtml(ev.summary || '')}</span>
      </div>`)
    .join('');

  return `
  <div class="inspector-header">
    <div class="inspector-type-row">
      <span class="type-badge" style="background:${type.bg};color:${type.color}">${escapeHtml(type.label)}</span>
      <button type="button" class="icon-btn" title="更多操作" onclick="openEntityDetail(${q(entity.entityId)})">${icon('more-horizontal', 'w-4 h-4')}</button>
    </div>
    <h3 class="inspector-name">${escapeHtml(name)}</h3>
    <div class="inspector-id">${escapeHtml(entity.entityId)}</div>
  </div>
  <div class="inspector-body">
    <section class="inspector-section">
      <div class="inspector-section-title">属性</div>
      ${props}
      ${aliveRow}
      ${props ? '' : '<div class="section-muted">暂无属性</div>'}
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">关系 <span class="section-count">${rels.length}</span></div>
      <div class="rel-summary"><span>出 ${outCount}</span><span class="rel-summary-divider"></span><span>入 ${inCount}</span></div>
      ${relRows || '<div class="section-muted">暂无关系</div>'}
    </section>
    <section class="inspector-section">
      <div class="inspector-section-title">最近事件</div>
      ${eventRows || '<div class="section-muted">暂无事件</div>'}
    </section>
  </div>`;
}

// ==================== 3D 场景（3d-force-graph / three.js WebGL） ====================
// 经 index.html 以 CDN UMD 引入，全局 ForceGraph3D。
// 数据沿用 graphLoadData 的 graphData（entities/relations），筛选语义与 2D canvas 一致。

let _graph3d = null; // 当前实例；重建/切出前销毁 WebGL 资源，避免累积上下文
let _graph3dRebuildTimer = null; // 搜索输入防抖：停止连续输入后 250ms 才重建 3D 场景

/** 销毁当前 3D 场景（WebGL 上下文释放）；重建与切出视图共用 */
function graphDispose3D() {
  if (!_graph3d) return;
  try {
    _graph3d.pauseAnimation();
    if (typeof _graph3d._destructor === 'function') _graph3d._destructor();
  } catch (e) { /* noop：组件销毁异常不影响页面 */ }
  _graph3d = null;
}

/** 初始化/重建 3D 场景：ViewAfterRender.graph 在 3D 模式下调用，筛选变更时整棵重建 */
function graphInit3D() {
  const container = $('#graph-3d');
  if (!container) return;
  if (typeof ForceGraph3D !== 'function') {
    container.innerHTML = '<div class="graph-3d-fallback">3D 组件加载失败（CDN 不可达），请检查网络后刷新</div>';
    return;
  }
  const data = graphState('graphData', { entities: [], relations: [] });
  const typeFilter = graphState('graphType', 'all');
  const searchFilter = (graphState('graphFilter', '') || '').toLowerCase();
  let entities = (data.entities || []).filter((e) => typeFilter === 'all' || e.entityType === typeFilter);
  if (searchFilter) entities = entities.filter((e) => (e.name || e.entityId).toLowerCase().includes(searchFilter));
  // BUG-029：角色视角模式——仅保留该角色及其直接关系邻居
  const viewNeighborIds = characterViewNeighborIds(graphState('characterView', 'omniscient'), data.relations);
  if (viewNeighborIds) entities = entities.filter((e) => viewNeighborIds.has(e.entityId));
  const ids = new Set(entities.map((e) => e.entityId));
  const links = (data.relations || [])
    .filter((r) => ids.has(r.sourceId) && ids.has(r.targetId))
    .map((r) => ({ source: r.sourceId, target: r.targetId, label: r.label }));
  const nodes = entities.map((e) => ({
    id: e.entityId,
    name: e.name || e.entityId,
    type: e.entityType
  }));

  // BUG-036：_graph3d 已存在时走增量更新——保留相机视角与已有节点位置，
  // 仅更新 graphData + 重建标签层，不销毁 WebGL 实例、不触发 zoomToFit。
  // StoryTime 步进、筛选、视角变更等数据变化均走此路径，避免"拉远再拉近"跳动。
  // 用户可通过 resetSceneView() 按钮手动重新取景。
  if (_graph3d) {
    _graph3d.graphData({ nodes, links });
    const oldLayer = container.querySelector('.graph-3d-labels');
    if (oldLayer) oldLayer.remove();
    graph3dLabelLayer(container, nodes);
    return;
  }

  graphDispose3D();
  container.innerHTML = ''; // 清掉旧 canvas / 标签层，避免重复初始化累积

  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg-50').trim() || '#ffffff';
  const textColor = css.getPropertyValue('--text-600').trim() || '#555555';
  const linkColor = css.getPropertyValue('--border-500').trim() || '#999999';
  const arrowColor = css.getPropertyValue('--text-500').trim() || '#666666'; // 亮色主题下 border-400 浅灰箭头白底不可见
  _graph3d = ForceGraph3D()(container)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .backgroundColor(bg)
    .graphData({ nodes, links })
    .nodeThreeObject((n) => graph3dNodeObject(n, textColor))
    /* M-Qual-6 修复：3d-force-graph label 是 HTML tooltip，实体名/关系标签必须转义
       （数据被污染时悬停即 XSS） */
    .nodeLabel((n) => `${escapeHtml(n.name)} · ${escapeHtml((ENTITY_TYPES[n.type] || {}).label || n.type)}`)
    .linkLabel((l) => escapeHtml(l.label))
    .linkColor(() => linkColor)
    .linkWidth(0.6)
    .linkOpacity(0.4)
    .linkDirectionalArrowLength(2.5)
    .linkDirectionalArrowRelPos(0.85)
    .linkDirectionalArrowColor(() => arrowColor)
    .onNodeClick((n) => graph3dSelectNode(n))
    .onBackgroundClick(() => { if (_graph3d) _graph3d.zoomToFit(600, 40); });
  // 布局更舒展：增强排斥力、拉长连边
  _graph3d.d3Force('charge').strength(-160);
  if (_graph3d.d3Force('link')) _graph3d.d3Force('link').distance(70);
  graph3dLabelLayer(container, nodes);
  // 力布局收敛后自动取景
  setTimeout(() => { if (_graph3d) _graph3d.zoomToFit(600, 40); }, 800);
}

/** 实体选中：3D 场景未就绪时回退 selectEntity 全量重渲 */
function graphSelectEntity(id) {
  if (_graph3d) {
    const n = _graph3d.graphData().nodes.find((x) => x.id === id);
    if (n) { graph3dSelectNode(n); return; }
  }
  selectEntity(id);
}

/** 3D 节点选中：局部更新左侧列表选中态 + 右侧 Inspector，并聚焦相机。
    不能走 selectEntity/renderView——整体重渲会销毁 3D 容器、相机被重置回默认取景 */
function graph3dSelectNode(n) {
  setGraphState('selectedEntityId', n.id);
  setGraphState('inspectorEntityId', n.id);
  $$('#entity-list .entity-item').forEach((row) =>
    row.classList.toggle('selected', row.dataset.entityId === n.id));
  const side = document.querySelector('.sidebar-right');
  if (side) { side.innerHTML = graphInspectorHtml(n.id); refreshIcons(); }
  graph3dFocusNode(n);
}

/** 相机聚焦：点击节点后飞向该节点（保持当前视角方向，拉到固定距离） */
function graph3dFocusNode(n) {
  if (!_graph3d || n.x === undefined) return;
  const dist = 60;
  const hyp = Math.hypot(n.x, n.y, n.z || 0) || 1;
  const ratio = 1 + dist / hyp;
  _graph3d.cameraPosition(
    { x: n.x * ratio, y: n.y * ratio, z: (n.z || 0) * ratio },
    { x: n.x, y: n.y, z: n.z || 0 },
    1200
  );
}

/** 3D 节点：按类型的几何体（标签由 DOM 投影层负责，见 graph3dLabelLayer） */
function graph3dNodeObject(n, textColor) {
  const color = (ENTITY_TYPES[n.type] || {}).color || '#8a8a8a';
  const group = new THREE.Group();
  let geo;
  if (n.type === 'character') geo = new THREE.SphereGeometry(4.5, 24, 24);
  else if (n.type === 'location') geo = new THREE.BoxGeometry(7, 7, 7);
  else if (n.type === 'item') geo = new THREE.OctahedronGeometry(5);
  else geo = new THREE.TetrahedronGeometry(5.5); // concept
  group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.15 })));
  return group;
}

/** DOM 名称标签层：每帧把节点三维坐标投影到屏幕，定位 HTML 标签（规避 three 版本混用问题） */
// 各类型几何体的世界半径（与 graph3dNodeObject 保持一致），用于计算标签的屏幕偏移
const NODE_R = { character: 4.5, location: 5, item: 5, concept: 5.5 };

function graph3dLabelLayer(container, nodes) {
  const layer = document.createElement('div');
  layer.className = 'graph-3d-labels';
  container.appendChild(layer);
  const els = {};
  nodes.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'graph-3d-label';
    el.textContent = n.name;
    layer.appendChild(el);
    els[n.id] = el;
  });
  const updateLabels = () => {
    // BUG-036：增量更新时旧标签层会被 remove()，但 onEngineTick/controls.change
    // 回调无法注销。检查 layer.isConnected 后直接 return，避免旧回调操作已移除的 DOM。
    if (!_graph3d || !layer.isConnected) return;
    const cam = _graph3d.camera();
    const w = container.clientWidth, h = container.clientHeight;
    const fovTan = Math.tan((cam.fov * Math.PI / 180) / 2);
    nodes.forEach((n) => {
      const obj = n.__threeObj;
      const el = els[n.id];
      if (!obj || !el) return;
      const v = obj.position.clone().project(cam);
      if (v.z > 1) { el.style.display = 'none'; return; }
      el.style.display = '';
      const dist = cam.position.distanceTo(obj.position);
      // 标签锚在节点屏幕半径下沿（随缩放变化），避免推近后标签被几何体盖住
      const worldR = NODE_R[n.type] || 5;
      const screenR = Math.min(90, worldR * (h / 2) / (dist * fovTan));
      el.style.transform = `translate(-50%, 0) translate(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * h + screenR + 6).toFixed(1)}px)`;
      // 字号随相机距离缩放（120 为基准距离），避免拉远后标签喧宾夺主、推近后显得过小
      el.style.fontSize = (Math.min(16, Math.max(9, 11 * 120 / dist))).toFixed(1) + 'px';
    });
  };
  _graph3d.onEngineTick(updateLabels);
  // BUG-034 修复：力模拟收敛后 onEngineTick 不再触发，相机旋转/缩放时标签不更新。
  // 补充监听 OrbitControls 的 change 事件，相机变换时同步更新标签位置。
  try {
    const controls = _graph3d.controls();
    if (controls && typeof controls.addEventListener === 'function') {
      controls.addEventListener('change', updateLabels);
    }
  } catch (e) { /* controls 不可用时降级为仅 onEngineTick */ }
}
// ==================== 交互（新函数，不与 views.js 重名） ====================

function setGraphType(type) {
  setGraphState('graphType', type);
  renderView();
}

/**
 * 搜索：立即过滤实体列表 DOM（F-1 修复后渲染层不再按搜索过滤，
 * 行集合始终完整，清空输入即恢复全量）；3D 场景防抖重建（避免每键一次 WebGL 重建）
 */
function graphSearchEntities(value) {
  setGraphState('graphFilter', value.toLowerCase());
  const kw = value.toLowerCase();
  $$('#entity-list .entity-item').forEach((row) => {
    const hay = `${row.querySelector('.entity-name') ? row.querySelector('.entity-name').textContent : ''} ${row.querySelector('.entity-summary') ? row.querySelector('.entity-summary').textContent : ''}`.toLowerCase();
    row.style.display = hay.includes(kw) ? '' : 'none';
  });
  if (_graph3dRebuildTimer) clearTimeout(_graph3dRebuildTimer);
  _graph3dRebuildTimer = setTimeout(() => { _graph3dRebuildTimer = null; graphInit3D(); }, 250);
}

function toggleIncludeClosed(cb) {
  setGraphState('includeClosed', !!cb.checked);
  // graphLoadData 读取 includeClosed 调 getGraph，需重新拉取
  renderView({ reload: true });
}

function changeCharacterView(value) {
  setGraphState('characterView', value);
  renderView();
}

/** 视图重置：3D 相机取景重置 */
function resetSceneView() {
  if (_graph3d) _graph3d.zoomToFit(600, 40);
}

function resetGraphFilters() {
  setGraphState('graphType', 'all');
  setGraphState('graphFilter', '');
  renderView();
}

/** 点击 StoryTime 值 → 弹出时间点选择器 */
function pickGraphStoryTime() {
  if (!App.storyTimes || !App.storyTimes.length) return;
  const options = App.storyTimes
    .map(
      (st) => `
    <label class="st-pick-row" onclick="selectGraphStoryTime(${q(st)})">
      <span class="st-pick-radio">${st === App.storyTime ? '●' : '○'}</span>
      <span class="st-pick-value">${escapeHtml(st)}</span>
    </label>`
    )
    .join('');
  openModal('选择 StoryTime', options, `<button class="btn btn-ghost" onclick="closeModal()">取消</button>`);
}

function selectGraphStoryTime(st) {
  closeModal();
  App.storyTime = st;
  render();
}

// —— Inspector 属性编辑（复用 addProperty API） ——

let _graphPropEditTarget = null;

function editGraphProperty(entityId, key) {
  const graphData = graphState('graphData', { entities: [] });
  const entity = (graphData.entities || []).find((e) => e.entityId === entityId);
  // 0.3.0：属性为声明数组，预填取同 property 的最新 description
  const decl = entity && Array.isArray(entity.properties)
    ? entity.properties.find((d) => d.property === key)
    : null;
  const value = decl ? decl.description : '';
  _graphPropEditTarget = { entityId, key };
  openModal(
    `编辑属性 · ${escapeHtml(key)}`,
    `<div><label class="text-sm text-muted">实体 ID</label><div class="font-mono text-sm mt-0.5">${escapeHtml(entityId)}</div></div>
     <div class="mt-2"><label class="text-sm text-muted">${escapeHtml(key)}</label><input id="graph-prop-input" class="input mt-0.5" value="${escapeHtml(String(value))}" spellcheck="false"></div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="submitGraphProperty()">保存</button>`
  );
}

async function submitGraphProperty() {
  const target = _graphPropEditTarget;
  if (!target) return;
  const input = $('#graph-prop-input');
  const value = input ? input.value : '';
  closeModal();
  await withLoading(async () => {
    await apiCall('addProperty', target.entityId, target.key, value, App.storyTime);
    toast('属性已更新', 'success');
  });
  // 服务端数据已变更，重新拉取图数据
  renderView({ reload: true });
}
