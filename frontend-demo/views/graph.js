/**
 * 世界图视图 V3 —— 高保真重构（视觉基准：narrative-engine-design/pages/world-graph.html 三栏工作台）
 *
 * 本文件直接覆盖 views.js 中的旧世界图实现（模式同 views/projects.js）：
 *   - ViewRender.graph / ViewAfterRender.graph
 *   - viewLoaders.graph → graphLoadData（原 loadGraph 固定 includeClosed='0'，无法支撑「显示已闭合」开关）
 *
 * 复用 views.js 全局函数（不在本文件重复定义，避免同名覆盖）：
 *   loadGraph / selectEntity / stepStoryTime / filterGraphEntities / openQuickEvent /
 *   submitQuickEvent / openQuickRelation / submitQuickRelation / openEntityDetail /
 *   killEntity / drawGraph2D / roundRect / truncate
 *
 * 状态读写约定（T1 命名空间访问器，兼容旧平面字段）：
 *   graphState(key, fallback)  读取：一般键优先 viewState('graph')[key] 回退 App.viewState[key]；
 *                              selectedEntityId/inspectorEntityId 例外：flat 优先（复用函数只写平面字段）
 *   setGraphState(key, value)  写入：命名空间与平面字段同时写，兼容 loadGraph/drawGraph2D 等旧函数
 */

// ==================== 状态读写 ====================

// 旧 drawGraph2D（views.js）内部引用自由变量 `canvas`（闭包依赖），
// 本文件提供全局绑定以复用该函数，不修改 views.js。
var canvas;

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

// ==================== 数据加载 ====================

/**
 * 世界图数据加载器（覆盖 viewLoaders.graph）。
 * 相比旧 loadGraph：支持「显示已闭合」开关（includeClosed），并缓存事件供 Inspector 使用。
 */
async function graphLoadData() {
  const includeClosed = graphState('includeClosed', false);
  const data = await apiCall('getGraph', App.storyTime, includeClosed ? '1' : '0');
  setGraphState('graphData', data);

  const status = await apiCall('getStatus');
  setGraphState('graphStatus', status);
  App.storyTimes = status.storyTimes || [];
  if (!App.storyTime && App.storyTimes.length) {
    App.storyTime = App.storyTimes[App.storyTimes.length - 1];
  }

  // 事件缓存：StoryTime 变化时刷新（供 Inspector「最近事件」）
  if (graphState('_eventsAt', null) !== App.storyTime) {
    const evData = await apiCall('getEvents');
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
  const searchFilter = (graphState('graphFilter', '') || '').toLowerCase();
  const mode3D = graphState('graphMode', '2d') === '3d';
  const selectedId = graphState('selectedEntityId', null);
  const inspectorId = graphState('inspectorEntityId', selectedId);
  const includeClosed = graphState('includeClosed', false);
  const characterView = graphState('characterView', 'omniscient');
  const graphData = graphState('graphData', { entities: [], relations: [] });
  const status = graphState('graphStatus', { entityCount: 0, eventCount: 0 });
  const entities = graphData.entities || [];

  const matchesFilter = (e) => {
    if (typeFilter !== 'all' && e.entityType !== typeFilter) return false;
    if (searchFilter) {
      const hay = `${e.properties && e.properties.name ? e.properties.name : e.entityId} ${e.summary || ''} ${e.entityId}`.toLowerCase();
      if (!hay.includes(searchFilter)) return false;
    }
    return true;
  };
  const listEntities = entities.filter(matchesFilter);

  const typeTabs = [{ id: 'all', label: '全部' }]
    .concat(Object.keys(ENTITY_TYPES).map((t) => ({ id: t, label: ENTITY_TYPES[t].label })))
    .map((t) => `<button type="button" class="type-tab${t.id === typeFilter ? ' active' : ''}" onclick="setGraphType('${t.id}')">${t.label}</button>`)
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
      .map((e) => ({ id: e.entityId, label: `${(e.properties && e.properties.name) || e.entityId} 视角` })),
  ]
    .map((o) => `<option value="${o.id}"${o.id === characterView ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
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
          <div class="view-toggle" role="group" title="视图模式">
            <button type="button" class="view-toggle-btn${!mode3D ? ' active' : ''}" onclick="setViewMode('2d')">2D</button>
            <button type="button" class="view-toggle-btn${mode3D ? ' active' : ''}" onclick="setViewMode('3d')">3D</button>
          </div>
        </div>
      </div>

      <div class="scene-canvas" id="graph-canvas-container">
        ${mode3D ? graphSceneSVG() : '<canvas id="graph-canvas" class="graph-canvas-2d"></canvas>'}
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
  if (graphState('graphMode', '2d') === '3d') return; // 3D：SVG 已在 HTML 中
  canvas = $('#graph-canvas'); // 赋值全局 canvas，供旧 drawGraph2D 闭包引用
  if (!canvas) return;
  const container = $('#graph-canvas-container');
  canvas.width = container ? container.clientWidth : canvas.parentElement.clientWidth;
  canvas.height = container ? container.clientHeight : canvas.parentElement.clientHeight;
  const ctx = canvas.getContext('2d');
  drawGraph2D(ctx, canvas.width, canvas.height);
};

// ==================== 左侧实体列表 ====================

function graphEntityItemHtml(e, selectedId) {
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#8a8a8a' };
  const name = (e.properties && e.properties.name) || e.entityId;
  return `
  <div class="entity-item${e.entityId === selectedId ? ' selected' : ''}" onclick="selectEntity('${e.entityId}')" data-entity-id="${e.entityId}">
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
  const name = (entity.properties && entity.properties.name) || entity.entityId;

  // 属性
  const props = Object.entries(entity.properties || {})
    .filter(([k]) => k !== 'name')
    .map(([k, v]) => `
      <div class="prop-row">
        <span class="prop-key">${escapeHtml(k)}</span>
        <span class="prop-value">${escapeHtml(String(v))}</span>
        <button type="button" class="prop-edit" title="编辑 ${escapeHtml(k)}" onclick="editGraphProperty('${entity.entityId}', '${escapeHtml(k)}')">${icon('pencil', 'w-3.5 h-3.5')}</button>
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
      const otherName = (other.properties && other.properties.name) || other.entityId;
      return `
      <div class="rel-row" onclick="selectEntity('${otherId}')" title="选中 ${escapeHtml(otherName)}">
        <span class="entity-dot" style="background:${otherType.color}"></span>
        <span class="rel-name">${escapeHtml(otherName)}</span>
        <span class="rel-meta"><span class="rel-label">${escapeHtml(r.label)}</span>${icon(out ? 'arrow-right' : 'arrow-left', 'w-3 h-3 rel-arrow')}</span>
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
      <div class="event-row" onclick="navigate('#/events?event=${ev.eventId}')" title="查看事件链">
        <span class="event-time">${escapeHtml(ev.storyTime)}</span>
        <span class="event-type-tag">${escapeHtml(ev.type)}</span>
        <span class="event-summary">${escapeHtml(ev.summary || '')}</span>
      </div>`)
    .join('');

  return `
  <div class="inspector-header">
    <div class="inspector-type-row">
      <span class="type-badge" style="background:${type.bg};color:${type.color}">${escapeHtml(type.label)}</span>
      <button type="button" class="icon-btn" title="更多操作" onclick="openEntityDetail('${entity.entityId}')">${icon('more-horizontal', 'w-4 h-4')}</button>
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

// ==================== 3D 占位场景（高保真 SVG） ====================

const graphSvgCap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** 按选中实体为中心的 BFS 深度，为实体分配前景/中景/远景层级 */
function graphSceneSVG() {
  const data = graphState('graphData', { entities: [], relations: [] });
  const typeFilter = graphState('graphType', 'all');
  const searchFilter = (graphState('graphFilter', '') || '').toLowerCase();
  const selectedId = graphState('selectedEntityId', null);
  const entities = (data.entities || []).filter((e) => {
    if (typeFilter !== 'all' && e.entityType !== typeFilter) return false;
    if (searchFilter) {
      const hay = `${e.properties && e.properties.name ? e.properties.name : e.entityId} ${e.summary || ''} ${e.entityId}`.toLowerCase();
      if (!hay.includes(searchFilter)) return false;
    }
    return true;
  });
  const ids = new Set(entities.map((e) => e.entityId));
  const relations = (data.relations || []).filter((r) => ids.has(r.sourceId) && ids.has(r.targetId));

  // 无向邻接 + BFS 深度
  const adj = {};
  relations.forEach((r) => {
    (adj[r.sourceId] = adj[r.sourceId] || []).push(r.targetId);
    (adj[r.targetId] = adj[r.targetId] || []).push(r.sourceId);
  });
  const depth = {};
  if (selectedId && ids.has(selectedId)) {
    depth[selectedId] = 0;
    const queue = [selectedId];
    while (queue.length) {
      const cur = queue.shift();
      (adj[cur] || []).forEach((nb) => {
        if (depth[nb] === undefined) {
          depth[nb] = depth[cur] + 1;
          queue.push(nb);
        }
      });
    }
  }

  // 布局：前景居中、中景内环、远景外环
  const W = 900, H = 600, CX = 450, CY = 310;
  const layers = { 0: [], 1: [], 2: [] };
  entities.forEach((e) => {
    const d = depth[e.entityId] === undefined ? 2 : depth[e.entityId];
    layers[d === 0 ? 0 : d === 1 ? 1 : 2].push(e);
  });
  const pos = {};
  const ring = (arr, r, startAngle) => {
    const n = arr.length;
    arr.forEach((e, i) => {
      const a = startAngle + (i * 2 * Math.PI) / Math.max(n, 1);
      pos[e.entityId] = { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
    });
  };
  if (layers[0].length) pos[layers[0][0].entityId] = { x: CX, y: CY - 24 };
  ring(layers[1], 165, -Math.PI / 2);
  ring(layers[2], 268, -Math.PI / 2 + Math.PI / 8);

  const entityById = {};
  entities.forEach((e) => (entityById[e.entityId] = e));

  const defs = Object.entries(ENTITY_TYPES)
    .map(([t, v]) => {
      const id = graphSvgCap(t);
      return `
    <radialGradient id="nodeGlow${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${v.color}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${v.color}" stop-opacity="0"/>
    </radialGradient>
    <marker id="arrow${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${v.color}"/>
    </marker>`;
    })
    .join('');

  // 背景透视网格（远景→近景，静态绘制）
  const grid = `
  <ellipse cx="${CX}" cy="${CY}" rx="360" ry="165" fill="none" stroke="var(--border-200)" stroke-width="1" opacity="0.35"/>
  <ellipse cx="${CX}" cy="${CY}" rx="265" ry="120" fill="none" stroke="var(--border-200)" stroke-width="1" opacity="0.30"/>
  <ellipse cx="${CX}" cy="${CY}" rx="170" ry="76" fill="none" stroke="var(--border-200)" stroke-width="1" opacity="0.25"/>
  <ellipse cx="${CX}" cy="${CY}" rx="75" ry="34" fill="none" stroke="var(--border-200)" stroke-width="1" opacity="0.20"/>
  <circle cx="${CX}" cy="${CY}" r="3" fill="var(--border-400)" opacity="0.45"/>
  ${Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const x = CX + 620 * Math.cos(a);
    const y = CY + 280 * Math.sin(a);
    return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border-200)" stroke-width="1" opacity="0.20"/>`;
  }).join('')}`;

  const nodeParts = entities
    .map((e) => {
      const p = pos[e.entityId];
      if (!p) return '';
      return graphSvgNode(e, depth[e.entityId] === 0 ? 0 : depth[e.entityId] === 1 ? 1 : 2, p.x, p.y, selectedId === e.entityId);
    })
    .join('');

  const relParts = relations
    .map((r) => {
      const a = pos[r.sourceId];
      const b = pos[r.targetId];
      if (!a || !b) return '';
      const target = entityById[r.targetId];
      const tType = ENTITY_TYPES[target.entityType] || { color: '#8a8a8a' };
      const dA = depth[r.sourceId] === undefined ? 2 : depth[r.sourceId];
      const dB = depth[r.targetId] === undefined ? 2 : depth[r.targetId];
      const isDeep = Math.min(dA, dB) >= 2;
      const opacity = isDeep ? 0.25 : dA === 0 || dB === 0 ? 0.6 : 0.4;
      const dash = isDeep ? ' stroke-dasharray="5 5"' : '';
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const label = isDeep
        ? ''
        : `<g transform="translate(${mx.toFixed(1)} ${my.toFixed(1)})" opacity="0.95">
      <rect x="${-(r.label.length * 5.6 + 9)}" y="-10.5" width="${r.label.length * 11.2 + 18}" height="18" rx="9" fill="var(--bg-50)" stroke="var(--border-300)" stroke-width="0.8"/>
      <text y="3.5" text-anchor="middle" font-size="9.5" fill="var(--text-500)" font-family="var(--font-sans)">${escapeHtml(r.label)}</text>
    </g>`;
      return `
    <line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${tType.color}" stroke-width="1.6" opacity="${opacity}" marker-end="url(#arrow${graphSvgCap(target.entityType)})"${dash}/>
    ${label}`;
    })
    .join('');

  const emptyHint = entities.length
    ? ''
    : `<text x="${CX}" y="${CY}" text-anchor="middle" font-size="14" fill="var(--text-400)" font-family="var(--font-sans)">当前筛选下没有实体</text>`;

  return `
  <svg class="graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="世界图 3D 占位场景">
    <defs>
      <filter id="softShadow" x="-60%" y="-60%" width="220%" height="220%">
        <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.22"/>
      </filter>
      ${defs}
    </defs>
    <g id="graph-svg-grid">${grid}</g>
    <g id="graph-svg-relations">${relParts}</g>
    <g id="graph-svg-nodes">${nodeParts}</g>
    ${emptyHint}
  </svg>`;
}

/** 单个 SVG 节点：d=0 前景（大节点+副标题+选中光环） / d=1 中景（发光+名称） / d=2 远景（小圆点无文字，浮标弱化） */
function graphSvgNode(e, d, x, y, isSelected) {
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#8a8a8a' };
  const color = type.color;
  const name = (e.properties && e.properties.name) || e.entityId;
  const typeName = type.label;
  const glowId = `url(#nodeGlow${graphSvgCap(e.entityType)})`;
  const xf = x.toFixed(1);
  const yf = y.toFixed(1);

  if (d === 2) {
    // 远景：小圆点 + 首字 + 弱化浮标
    const short = name.length > 3 ? name.slice(0, 3) : name;
    return `
    <g class="svg-node svg-node-distant" opacity="0.85">
      <circle cx="${xf}" cy="${yf}" r="15" fill="var(--bg-50)" stroke="${color}" stroke-width="1.4"/>
      <text x="${xf}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--text-500)" font-family="var(--font-sans)" opacity="0.75">${escapeHtml(short)}</text>
      <text x="${xf}" y="${(y + 34).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="var(--text-400)" font-family="var(--font-sans)" opacity="0.6">${escapeHtml(name)}</text>
    </g>`;
  }

  const glow = `<circle cx="${xf}" cy="${yf}" r="${d === 0 ? 46 : 30}" fill="${glowId}" filter="url(#softShadow)"/>`;
  const rings = isSelected
    ? `
    <circle cx="${xf}" cy="${yf}" r="56" fill="none" stroke="${color}" stroke-width="1" opacity="0.25"/>
    <circle cx="${xf}" cy="${yf}" r="51" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.5"/>`
    : '';

  let shape;
  const stroke = `stroke="${color}" stroke-width="2"`;
  if (e.entityType === 'character') {
    const r = d === 0 ? 36 : 22;
    shape = `<circle cx="${xf}" cy="${yf}" r="${r}" fill="var(--bg-50)" ${stroke}/>`;
  } else if (e.entityType === 'location') {
    const w = d === 0 ? 82 : 52;
    const h = d === 0 ? 48 : 32;
    shape = `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" rx="10" fill="var(--bg-50)" ${stroke}/>`;
  } else if (e.entityType === 'item') {
    const w = d === 0 ? 76 : 46;
    const h = d === 0 ? 44 : 28;
    shape = `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" rx="7" fill="var(--bg-50)" ${stroke}/>`;
  } else {
    // concept：菱形
    const s = d === 0 ? 40 : 26;
    shape = `<polygon points="${xf},${(y - s).toFixed(1)} ${(x + s).toFixed(1)},${yf} ${xf},${(y + s).toFixed(1)} ${(x - s).toFixed(1)},${yf}" fill="var(--bg-50)" ${stroke}/>`;
  }

  const isCircle = e.entityType === 'character';
  const nameY = isCircle ? y + (d === 0 ? 56 : 38) : y + (d === 0 ? 44 : 30);
  const sub = (e.properties && e.properties.role) || typeName;
  const star = isSelected ? `<text x="${(x + 42).toFixed(1)}" y="${(y - 34).toFixed(1)}" font-size="16" fill="${color}">✦</text>` : '';
  const nameSize = d === 0 ? 14 : 10.5;
  const nameYpos = d === 0 ? nameY : y + (isCircle ? 14 : 6);

  return `
  <g class="svg-node svg-node-${d === 0 ? 'foreground' : 'mid'}">
    ${glow}
    ${rings}
    ${shape}
    ${star}
    <text x="${xf}" y="${nameYpos}" text-anchor="middle" font-size="${nameSize}" font-weight="500" fill="var(--foreground)" font-family="var(--font-display)">${escapeHtml(name)}</text>
    ${d === 0 ? `<text x="${xf}" y="${nameY + 14}" text-anchor="middle" font-size="9.5" fill="var(--text-400)" font-family="var(--font-mono)">${escapeHtml(sub)}</text>` : ''}
  </g>`;
}

// ==================== 交互（新函数，不与 views.js 重名） ====================

function setGraphType(type) {
  setGraphState('graphType', type);
  renderView();
}

/** 搜索：立即过滤实体列表 DOM 并重绘画布（避免全量 render 丢失输入焦点）；3D 模式仅刷新 SVG 场景 */
function graphSearchEntities(value) {
  setGraphState('graphFilter', value.toLowerCase());
  const kw = value.toLowerCase();
  $$('#entity-list .entity-item').forEach((row) => {
    const hay = `${row.querySelector('.entity-name') ? row.querySelector('.entity-name').textContent : ''} ${row.querySelector('.entity-summary') ? row.querySelector('.entity-summary').textContent : ''}`.toLowerCase();
    row.style.display = hay.includes(kw) ? '' : 'none';
  });
  if (graphState('graphMode', '2d') === '3d') {
    const scene = $('#graph-canvas-container');
    if (scene) {
      const svg = scene.querySelector('svg.graph-svg');
      if (svg) svg.outerHTML = graphSceneSVG();
    }
    return;
  }
  const canvas = $('#graph-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    drawGraph2D(ctx, canvas.width, canvas.height);
  }
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

function setViewMode(mode) {
  if (mode !== '2d' && mode !== '3d') return;
  setGraphState('graphMode', mode);
  renderView();
}

/** 视图重置：Canvas 模式下重绘初始布局（drawGraph2D 每次重算布局，即恢复初始位置） */
function resetSceneView() {
  if (graphState('graphMode', '2d') === '3d') {
    toast('3D 场景为静态占位，无需重置', 'info');
    return;
  }
  const canvas = $('#graph-canvas');
  if (!canvas) return;
  const container = $('#graph-canvas-container');
  canvas.width = container ? container.clientWidth : canvas.parentElement.clientWidth;
  canvas.height = container ? container.clientHeight : canvas.parentElement.clientHeight;
  const ctx = canvas.getContext('2d');
  drawGraph2D(ctx, canvas.width, canvas.height);
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
    <label class="st-pick-row" onclick="selectGraphStoryTime('${st}')">
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
  const value = entity && entity.properties ? entity.properties[key] : '';
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
