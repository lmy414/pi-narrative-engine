/**
 * frontend-demo/views/events.js — 事件链视图（高保真重构，Task 6）
 *
 * 设计基准：narrative-engine-design/pages/event-chain.html（三栏布局：筛选 / 章节化时间线 / 因果追溯）
 *
 * 覆盖约定（模式同 views/graph.js）：
 *   - ViewRender.events / ViewAfterRender.events
 *   - viewLoaders.events → eventLoadData（views.js 中旧 loadEvents 声明保留，不修改）
 *
 * 状态读写约定（viewState('events') 命名空间 + 平面字段双写，参考 graph.js setGraphState）：
 *   - eventState(key, fallback)  读取：命名空间优先，回退平面 App.viewState[key]；
 *     selectedEventId 例外：平面优先（app.js 的 ?event= 参数映射 / entity-detail.js /
 *     graph.js Inspector 跳转只写平面字段）
 *   - setEventState(key, value)  写入：命名空间与平面字段同时写
 *
 * 复用（demo-utils.js，不重写）：DemoUtils.compareStoryTime / groupEventsByChapter / filterEvents
 * 数据获取走 apiMock 闭环（api-mock.js 实际暴露）：getEvents / getStatus / getChain
 *
 * 跨页 StoryTime 修复：跳转世界图「此时刻」不再写 App.viewState.storyTime 这类
 * 世界图不读的平面垃圾字段（旧代码缺陷）；改为先更新全局 App.storyTime（与顶部
 * StoryTime 选择器同一语义）再 navigate('#/graph')，保证跨页 StoryTime 一致。
 */

// ==================== 状态访问器 ====================

function eventState(key, fallback) {
  const ns = viewState('events');
  if (key === 'selectedEventId') {
    if (App.viewState[key] !== undefined) return App.viewState[key];
    if (ns[key] !== undefined) return ns[key];
    return fallback;
  }
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setEventState(key, value) {
  viewState('events')[key] = value;
  App.viewState[key] = value;
}

// ==================== 数据加载（覆盖 viewLoaders.events） ====================

async function eventLoadData() {
  const data = await apiCall('getEvents');
  const events = data && data.events ? data.events : [];
  // 注意：数据键用 eventList 而非 events —— 命名空间键名本身是 'events'，
  // 若双写同名键会把 viewState('events') 命名空间对象覆盖成数组（参考 graph.js 用 graphData 键）
  setEventState('eventList', events);

  // 刷新全局 storyTimes / storyTime（与 graph.js 同源），保证跨页一致
  const status = await apiCall('getStatus');
  setEventState('eventsStatus', status);
  App.storyTimes = (status && status.storyTimes) || [];
  if (!App.storyTime && App.storyTimes.length) {
    App.storyTime = App.storyTimes[App.storyTimes.length - 1];
  }

  // 默认选中：优先当前 storyTime 对应事件，否则最后一个事件
  let selectedId = eventState('selectedEventId', null);
  if (!selectedId && events.length) {
    const cur = events.find(e => e.storyTime === App.storyTime);
    selectedId = cur ? cur.eventId : events[events.length - 1].eventId;
    setEventState('selectedEventId', selectedId);
  }

  // 选中事件默认展开
  if (selectedId) {
    const expanded = (eventState('eventExpanded', []) || []).slice();
    if (!expanded.includes(selectedId)) {
      expanded.push(selectedId);
      setEventState('eventExpanded', expanded);
    }
    const chain = await apiCall('getChain', selectedId);
    setEventState('chain', chain);
  }
}

viewLoaders.events = eventLoadData;

// ==================== 实体辅助 ====================

/**
 * 收集事件关联实体 ID（事件自身 + newFacts/invalidated 中的实体）。
 * DemoUtils 未导出该内部函数；此处保持与 demo-utils.js filterEvents
 * 实体匹配逻辑完全一致的语义（不重写 DemoUtils 导出函数）。
 * @param {object} ev
 * @returns {string[]}
 */
function eventEntityIds(ev) {
  const ids = [];
  if (ev && ev.entityId) ids.push(ev.entityId);
  const facts = [].concat((ev && ev.newFacts) || [], (ev && ev.invalidated) || []);
  for (const f of facts) {
    if (f && f.entityId && !ids.includes(f.entityId)) ids.push(f.entityId);
  }
  return ids;
}

function eventEntity(entityId) {
  return (MOCK_ENTITIES || []).find(e => e.entityId === entityId) || null;
}

function eventEntityName(entityId) {
  const e = eventEntity(entityId);
  return e ? ((e.properties && e.properties.name) || entityId) : entityId;
}

function eventEntityTypeLabel(entityId) {
  const e = eventEntity(entityId);
  if (!e) return '';
  return (ENTITY_TYPES && ENTITY_TYPES[e.entityType] && ENTITY_TYPES[e.entityType].label) || e.entityType || '';
}

function eventEntityTypeColor(entityId) {
  const e = eventEntity(entityId);
  return (ENTITY_TYPES && e && ENTITY_TYPES[e.entityType] && ENTITY_TYPES[e.entityType].color) || 'var(--brand-500)';
}

// ==================== 事件文本辅助 ====================

function eventInvalidText(inv) {
  if (!inv) return '';
  const decl = (MOCK_DECLARATIONS || []).find(d => d.declarationId === inv.declarationId);
  if (decl) {
    const v = decl.value == null ? '∅' : decl.value;
    return `${eventEntityName(decl.entityId)}.${decl.property} = ${v}`;
  }
  return inv.property || inv.declarationId || '';
}

function eventCausalNodeText(ev, depth) {
  const id = ev.eventId || '';
  if (depth === 0) return `${id} 当前`;
  const s = String(ev.summary || '').replace(/[「」『』，。！？、,.:;…]/g, '');
  return `${id} ${s.slice(0, 4)}`;
}

// ==================== 筛选与时间线（复用 DemoUtils） ====================

function eventFilteredEvents() {
  const events = eventState('eventList', []) || [];
  return DemoUtils.filterEvents(events, {
    entityIds: eventState('eventEntityFilter', []) || [],
    types: eventState('eventTypeFilter', []) || [],
    keyword: eventState('eventKeyword', '')
  });
}

function eventSortedGroups() {
  const filtered = eventFilteredEvents()
    .slice()
    .sort((a, b) => DemoUtils.compareStoryTime(a.storyTime, b.storyTime));
  return DemoUtils.groupEventsByChapter(filtered);
}

function eventTimelineSubtitleHtml() {
  const groups = eventSortedGroups();
  const total = groups.reduce((sum, g) => sum + g.events.length, 0);
  return `共 ${groups.length} 章 · ${total} 个事件 · 当前 storyTime: ${escapeHtml(App.storyTime || '—')}`;
}

// ==================== 事件卡渲染 ====================

function eventCardHtml(ev, selectedId, expandedIds) {
  const isSelected = ev.eventId === selectedId;
  const isCurrent = !!App.storyTime && ev.storyTime === App.storyTime;
  const isExpanded = (expandedIds || []).includes(ev.eventId);
  const type = ev.type || 'change';
  const isEngine = ev.source === 'engine';

  const entityName = eventEntityName(ev.entityId);
  const entityTypeLabel = eventEntityTypeLabel(ev.entityId);
  const entityColor = eventEntityTypeColor(ev.entityId);

  let extraHtml = '';
  if (ev.newFacts && ev.newFacts.length) {
    const facts = ev.newFacts.map(f =>
      `<div class="ev-extra-fact"><span class="ev-fact-dot ev-dot-new"></span>${escapeHtml(eventEntityName(f.entityId))}.${escapeHtml(f.property)} = ${escapeHtml(f.value == null ? '∅' : f.value)}</div>`
    ).join('');
    extraHtml += `<div class="ev-extra-block"><div class="ev-extra-label">新事实</div>${facts}</div>`;
  }
  if (ev.invalidated && ev.invalidated.length) {
    const invs = ev.invalidated.map(d =>
      `<div class="ev-extra-fact ev-extra-fact-invalid"><span class="ev-fact-dot ev-dot-invalid"></span>${escapeHtml(eventInvalidText(d))}</div>`
    ).join('');
    extraHtml += `<div class="ev-extra-block"><div class="ev-extra-label">失效声明</div>${invs}</div>`;
  }

  return `
  <article class="ev-event-card ev-card-${escapeHtml(type)}${isSelected ? ' selected' : ''}${isCurrent ? ' current-storytime' : ''}${isExpanded ? ' expanded' : ''}" data-event-id="${escapeHtml(ev.eventId)}" onclick="eventSelectEvent('${escapeHtml(ev.eventId)}')">
    <span class="ev-source-pill ${isEngine ? 'ev-source-engine' : 'ev-source-manual'}">${isEngine ? 'AI' : '手动'}</span>
    <div class="ev-event-meta">
      <span class="ev-event-time">${escapeHtml(ev.storyTime || '')}</span>
      <span class="ev-event-badge ev-badge-${escapeHtml(type)}">${escapeHtml(type)}</span>
      ${isCurrent ? '<span class="ev-current-marker">当前</span>' : ''}
    </div>
    <h3 class="ev-event-summary">${escapeHtml(ev.summary || '')}</h3>
    <div class="ev-event-entity">
      <span class="ev-entity-chip">
        <span class="ev-entity-avatar" style="background:${entityColor}">${escapeHtml(entityName.charAt(0))}</span>
        <span class="ev-entity-chip-name">${escapeHtml(entityName)}</span>
        ${entityTypeLabel ? `<span class="ev-entity-chip-type">（${escapeHtml(entityTypeLabel)}）</span>` : ''}
      </span>
    </div>
    <div class="ev-event-expand" onclick="event.stopPropagation();eventToggleExpand('${escapeHtml(ev.eventId)}')">
      <span class="ev-event-expand-text">${isExpanded ? '收起详情' : '展开详情'}</span>
      ${icon('chevron-down', 'ev-event-expand-icon')}
    </div>
    <div class="ev-event-detail-extra">
      ${extraHtml || `<p class="ev-detail-text">${escapeHtml(ev.summary || '暂无详情')}</p>`}
    </div>
  </article>`;
}

function eventTimelineInnerHtml() {
  const groups = eventSortedGroups();
  const selectedId = eventState('selectedEventId', null);
  const expanded = eventState('eventExpanded', []) || [];
  if (!groups.length) {
    return '<div class="ev-empty">没有匹配的事件，调整筛选条件试试。</div>';
  }
  return groups.map(g => `
    <section class="ev-chapter-group">
      <header class="ev-chapter-header">
        <div class="ev-chapter-header-left">
          <span class="ev-chapter-number">${escapeHtml(g.title)}</span>
          <span class="ev-chapter-name">${escapeHtml(g.chapter)}</span>
        </div>
        <span class="ev-chapter-count">${g.events.length} 个事件</span>
      </header>
      <div class="ev-chapter-events">
        ${g.events.map(ev => eventCardHtml(ev, selectedId, expanded)).join('')}
      </div>
    </section>`).join('');
}

// ==================== 左栏筛选面板 ====================

function eventFilterEntitiesHtml() {
  const events = eventState('eventList', []) || [];
  const ids = [...new Set(events.flatMap(ev => eventEntityIds(ev)))];
  const selected = eventState('eventEntityFilter', []) || [];
  if (!ids.length) return '';
  return ids.map(id => {
    const name = eventEntityName(id);
    const color = eventEntityTypeColor(id);
    const checked = selected.includes(id) ? ' checked' : '';
    return `
    <div class="ev-entity-item${checked}" data-entity-filter-id="${escapeHtml(id)}" onclick="eventToggleEntity('${escapeHtml(id)}')">
      <div class="ev-entity-checkbox"></div>
      <div class="ev-entity-avatar" style="background:${color}">${escapeHtml(name.charAt(0))}</div>
      <span class="ev-entity-name">${escapeHtml(name)}</span>
    </div>`;
  }).join('');
}

function eventTypeTagsHtml() {
  const cur = eventState('eventTypeFilter', []) || [];
  const active = cur.length ? cur[0] : 'all';
  const tags = [
    { type: 'all', label: '全部' },
    { type: 'birth', label: 'birth 诞生' },
    { type: 'change', label: 'change 变更' },
    { type: 'death', label: 'death 退场' }
  ];
  return tags.map(t =>
    `<span class="ev-type-tag${active === t.type ? ' active' : ''}" data-type="${t.type}" onclick="eventSelectType('${t.type}')">${escapeHtml(t.label)}</span>`
  ).join('');
}

// ==================== 右栏因果追溯（SVG） ====================

function eventCausalSvgHtml(selectedEvent) {
  const chain = eventState('chain', { events: [] }) || { events: [] };
  const nodes = chain.events || [];
  const byId = {};
  nodes.forEach(n => { byId[n.eventId] = n; });
  const selId = selectedEvent.eventId;

  // BFS：从当前事件沿 causes 反向求深度（causes 指向更早的前因）
  const depth = {};
  if (byId[selId]) {
    depth[selId] = 0;
    const queue = [selId];
    while (queue.length) {
      const cur = queue.shift();
      for (const c of (byId[cur] && byId[cur].causes) || []) {
        if (byId[c] && depth[c] === undefined) {
          depth[c] = depth[cur] + 1;
          queue.push(c);
        }
      }
    }
  }

  const maxDepth = nodes.reduce((m, n) => Math.max(m, depth[n.eventId] === undefined ? 0 : depth[n.eventId]), 0);
  const layers = Array.from({ length: maxDepth + 1 }, () => []);
  nodes.forEach(n => {
    const d = depth[n.eventId] === undefined ? maxDepth : depth[n.eventId];
    layers[d].push(n);
  });
  layers.forEach(l => l.sort((a, b) => DemoUtils.compareStoryTime(a.storyTime, b.storyTime)));

  const LAYER_W = 96;
  const PAD_L = 14;
  const PAD_T = 16;
  const NODE_H = [44, 36, 32, 30];
  const Y_GAP = 12;
  const W = 320;

  const nodeH = d => NODE_H[Math.min(d, NODE_H.length - 1)];
  const nodeW = (n, d) => {
    const text = eventCausalNodeText(n, d);
    return Math.min(150, Math.max(92, text.length * 6.4 + 22));
  };

  const layerH = layers.map((l, d) => (l.length ? l.length * nodeH(d) + (l.length - 1) * Y_GAP : 0));
  const H = Math.max(240, ...layerH.map(h => h + PAD_T * 2 + 24));

  const pos = {};
  layers.forEach((l, d) => {
    const layerMaxW = Math.max(92, ...l.map(n => nodeW(n, d)));
    l.forEach((n, i) => {
      const w = nodeW(n, d);
      pos[n.eventId] = { x: PAD_L + d * LAYER_W + (layerMaxW - w) / 2, y: PAD_T + i * (nodeH(d) + Y_GAP), w, h: nodeH(d) };
    });
  });

  const edgeParts = [];
  nodes.forEach(e => {
    for (const c of (e.causes || [])) {
      const a = pos[c];
      const b = pos[e.eventId];
      if (!a || !b) continue;
      const d = depth[e.eventId] === undefined ? 0 : depth[e.eventId];
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      edgeParts.push(`<path class="ev-causal-edge edge-depth-${Math.min(d, 2)}" d="M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}" marker-end="url(#evArrow)"/>`);
    }
  });

  const nodeParts = nodes.map(n => {
    const d = depth[n.eventId] === undefined ? 0 : depth[n.eventId];
    const p = pos[n.eventId];
    if (!p) return '';
    const isCurrent = n.eventId === selId;
    const text = eventCausalNodeText(n, d);
    return `
    <g class="ev-causal-node ${isCurrent ? 'ev-node-current' : `ev-node-past ev-node-depth-${Math.min(d, 3)}`}" data-event-id="${escapeHtml(n.eventId)}" onclick="eventSelectEvent('${escapeHtml(n.eventId)}')">
      <rect class="ev-node-rect" x="0" y="0" width="${p.w}" height="${p.h}" rx="${isCurrent ? 10 : d === 3 ? 7 : d === 2 ? 8 : 9}" stroke-width="${isCurrent ? 1.5 : 1}"/>
      <text class="ev-node-text" x="${p.w / 2}" y="${p.h / 2 + (isCurrent ? 5 : 4)}" text-anchor="middle" font-size="${isCurrent ? 13 : 11}" font-family="var(--font-mono)">${escapeHtml(text)}</text>
    </g>`;
  }).join('');

  return `<svg class="ev-causal-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="因果追溯图">
    <defs><marker id="evArrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon class="ev-causal-edge-arrow" points="0 0, 10 3.5, 0 7"/></marker></defs>
    ${edgeParts.join('')}
    ${nodeParts}
  </svg>`;
}

function eventCausalPanelHtml(ev) {
  const isEngine = ev.source === 'engine';
  const type = ev.type || 'change';

  const entities = [...new Set(eventEntityIds(ev))];
  const entityListHtml = entities.length ? entities.map(id => {
    const name = eventEntityName(id);
    const color = eventEntityTypeColor(id);
    const role = eventEntityTypeLabel(id);
    return `
    <div class="ev-entity-list-item" onclick="eventJumpToEntity('${escapeHtml(id)}')">
      <div class="ev-entity-avatar" style="background:${color}">${escapeHtml(name.charAt(0))}</div>
      <div class="ev-entity-list-meta">
        <div class="ev-entity-list-name">${escapeHtml(name)}</div>
        <div class="ev-entity-list-role">${escapeHtml(role || '未分类')}</div>
      </div>
    </div>`;
  }).join('') : '<div class="ev-panel-empty">暂无关联实体</div>';

  let factHtml = '';
  if (ev.newFacts && ev.newFacts.length) {
    factHtml = ev.newFacts.map(f =>
      `<div class="ev-fact-item ev-fact-new"><span class="ev-fact-dot ev-dot-new"></span><span class="ev-fact-text">${escapeHtml(eventEntityName(f.entityId))}.${escapeHtml(f.property)} = ${escapeHtml(f.value == null ? '∅' : f.value)}</span></div>`
    ).join('');
  }

  let invalidHtml = '';
  if (ev.invalidated && ev.invalidated.length) {
    invalidHtml = ev.invalidated.map(d =>
      `<div class="ev-fact-item ev-fact-invalid"><span class="ev-fact-dot ev-dot-invalid"></span><span class="ev-fact-text">${escapeHtml(eventInvalidText(d))}</span></div>`
    ).join('');
  }

  return `
  <aside class="ev-causal-panel">
    <div class="ev-panel-header">
      <h2 class="ev-panel-title">因果追溯 · ${escapeHtml(ev.eventId)}</h2>
      <p class="ev-panel-subtitle">向前回溯到根</p>
    </div>
    <div class="ev-causal-graph-section">
      <div class="ev-causal-section-title">因果关系图</div>
      ${eventCausalSvgHtml(ev)}
    </div>
    <div class="ev-detail-section">
      <div class="ev-detail-label">事件详情</div>
      <div class="ev-detail-meta-row"><span class="ev-detail-meta-label">类型</span><span class="ev-event-badge ev-badge-${escapeHtml(type)}">${escapeHtml(type)}</span></div>
      <div class="ev-detail-meta-row"><span class="ev-detail-meta-label">时间点</span><span class="ev-detail-meta-value">${escapeHtml(ev.storyTime || '—')}</span></div>
      <div class="ev-detail-meta-row"><span class="ev-detail-meta-label">来源</span><span class="ev-source-badge ${isEngine ? 'ev-source-ai' : 'ev-source-manual'}">${icon('brain', 'w-3.5 h-3.5')} ${isEngine ? 'AI 推理' : '手动'}</span></div>
    </div>
    <div class="ev-detail-section">
      <div class="ev-detail-label">摘要</div>
      <p class="ev-detail-text">${escapeHtml(ev.summary || '暂无摘要')}</p>
    </div>
    <div class="ev-detail-section">
      <div class="ev-detail-label">涉及实体</div>
      ${entityListHtml}
    </div>
    ${factHtml ? `<div class="ev-detail-section"><div class="ev-detail-label">新事实</div><div class="ev-fact-list">${factHtml}</div></div>` : ''}
    ${invalidHtml ? `<div class="ev-detail-section"><div class="ev-detail-label">失效声明</div><div class="ev-fact-list">${invalidHtml}</div></div>` : ''}
    <button class="ev-btn-jump" onclick="eventJumpToGraph('${escapeHtml(ev.storyTime || '')}')">${icon('globe', 'w-4 h-4')} 跳转到世界图（此时刻）</button>
  </aside>`;
}

// ==================== 视图渲染（覆盖 ViewRender.events） ====================

ViewRender.events = () => {
  const events = eventState('eventList', []) || [];
  const selectedId = eventState('selectedEventId', null);
  const selectedEvent = selectedId ? events.find(e => e.eventId === selectedId) : null;

  const entityFilterHtml = eventFilterEntitiesHtml();

  return `
  <div class="ev-workspace">
    <aside class="ev-filter-panel">
      <div class="ev-filter-head">
        <h2 class="ev-filter-title">筛选</h2>
      </div>
      <div class="ev-filter-section">
        <div class="ev-filter-label">实体</div>
        <div class="ev-filter-search">
          ${icon('search', 'ev-filter-search-icon')}
          <input type="text" class="ev-filter-input" placeholder="搜索实体..." oninput="eventSearchEntityInput(this.value)">
        </div>
        <div class="ev-entity-list">
          ${entityFilterHtml || '<div class="ev-panel-empty">暂无实体</div>'}
        </div>
      </div>
      <div class="ev-filter-section">
        <div class="ev-filter-label">事件类型</div>
        <div class="ev-type-tags">
          ${eventTypeTagsHtml()}
        </div>
      </div>
      <div class="ev-filter-section">
        <div class="ev-filter-label">关键词</div>
        <div class="ev-filter-search">
          ${icon('search', 'ev-filter-search-icon')}
          <input type="text" class="ev-filter-input" placeholder="搜索事件内容..." value="${escapeHtml(eventState('eventKeyword', '') || '')}" oninput="eventKeywordInput(this.value)">
        </div>
      </div>
      <button class="ev-btn-reset" onclick="eventResetFilters()">${icon('rotate-ccw', 'w-3.5 h-3.5')} 重置筛选</button>
    </aside>

    <main class="ev-timeline-container">
      <header class="ev-timeline-header">
        <div>
          <h1 class="ev-timeline-title">事件链</h1>
          <div class="ev-timeline-subtitle">${eventTimelineSubtitleHtml()}</div>
        </div>
        <button class="ev-filter-toggle-btn" onclick="eventToggleFilterPanel()">${icon('sliders-horizontal', 'w-4 h-4')} 筛选</button>
      </header>
      <div class="ev-timeline-list">
        ${eventTimelineInnerHtml()}
      </div>
    </main>

    ${selectedEvent ? eventCausalPanelHtml(selectedEvent) : '<aside class="ev-causal-panel"><div class="ev-panel-empty">选择事件查看因果追溯</div></aside>'}
  </div>`;
};

ViewAfterRender.events = () => {
  // 事件链视图无额外 DOM 副作用；占位以确保覆盖
};

// ==================== 交互 ====================

async function eventSelectEvent(eventId) {
  setEventState('selectedEventId', eventId);
  const expanded = (eventState('eventExpanded', []) || []).slice();
  if (!expanded.includes(eventId)) {
    expanded.push(eventId);
    setEventState('eventExpanded', expanded);
  }
  render();
  try {
    const chain = await apiCall('getChain', eventId);
    if (eventState('selectedEventId', null) !== eventId) return; // 已被后续点击覆盖，丢弃过期结果
    setEventState('chain', chain);
    const selected = (eventState('eventList', []) || []).find(e => e.eventId === eventId);
    const panel = $('.ev-causal-panel');
    if (panel && selected) panel.innerHTML = eventCausalPanelHtml(selected);
  } catch (err) {
    console.error('[events] 加载因果链失败:', err);
    toast('加载因果链失败');
  }
}

function eventToggleExpand(eventId) {
  const arr = (eventState('eventExpanded', []) || []).slice();
  const i = arr.indexOf(eventId);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(eventId);
  setEventState('eventExpanded', arr);
  const card = $('.ev-event-card[data-event-id="' + eventId + '"]');
  if (card) {
    card.classList.toggle('expanded');
    const t = card.querySelector('.ev-event-expand-text');
    if (t) t.textContent = card.classList.contains('expanded') ? '收起详情' : '展开详情';
  }
}

function eventToggleEntity(entityId) {
  const arr = (eventState('eventEntityFilter', []) || []).slice();
  const i = arr.indexOf(entityId);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(entityId);
  setEventState('eventEntityFilter', arr);
  eventRefreshTimeline();
  const row = $('.ev-entity-item[data-entity-filter-id="' + entityId + '"]');
  if (row) row.classList.toggle('checked');
}

function eventSelectType(type) {
  const arr = type === 'all' ? [] : [type];
  setEventState('eventTypeFilter', arr);
  eventRefreshTimeline();
  document.querySelectorAll('.ev-type-tag').forEach(t => {
    t.classList.toggle('active', t.dataset.type === type);
  });
}

function eventKeywordInput(value) {
  setEventState('eventKeyword', value || '');
  eventRefreshTimeline();
}

function eventSearchEntityInput(value) {
  const kw = String(value || '').trim().toLowerCase();
  document.querySelectorAll('.ev-entity-item[data-entity-filter-id]').forEach(el => {
    const name = String(el.querySelector('.ev-entity-name') && el.querySelector('.ev-entity-name').textContent || '').toLowerCase();
    el.style.display = (!kw || name.includes(kw)) ? '' : 'none';
  });
}

function eventResetFilters() {
  setEventState('eventEntityFilter', []);
  setEventState('eventTypeFilter', []);
  setEventState('eventKeyword', '');
  render();
}

function eventToggleFilterPanel() {
  const panel = $('.ev-filter-panel');
  if (panel) panel.classList.toggle('collapsed');
}

function eventRefreshTimeline() {
  const list = $('.ev-timeline-list');
  const sub = $('.ev-timeline-subtitle');
  if (list) list.innerHTML = eventTimelineInnerHtml();
  if (sub) sub.innerHTML = eventTimelineSubtitleHtml();
}

// ==================== 跨页跳转（StoryTime 同步） ====================

function eventJumpToGraph(storyTime) {
  // 语义与顶部 StoryTime 选择器一致：用户明确切换全局当前时刻后跳转。
  // 不再写 App.viewState.storyTime 这类世界图不读的平面垃圾字段（旧代码缺陷）。
  if (storyTime) App.storyTime = storyTime;
  navigate('#/graph');
}

function eventJumpToEntity(entityId) {
  navigate('#/graph', {
    viewState: { ...App.viewState, selectedEntityId: entityId, inspectorEntityId: entityId }
  });
}
