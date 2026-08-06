/**
 * frontend-demo/views/entity-detail.js — 实体详情 Drawer（高保真重构，Task 5）
 *
 * 设计基准：narrative-engine-design/pages/world-graph-detail.html
 * 覆盖说明：本文件在全局作用域重新声明 `async function openEntityDetail`，
 *   与 views.js 的同名函数形成确定覆盖（函数声明提升 + 后加载覆盖先加载），
 *   从而在不修改 views.js 的前提下替换实体详情入口。其余新增函数全部使用
 *   detail* 前缀，避免与存量全局函数（switchDetailTab / killEntity 等）无意冲突。
 *   例外（无 detail* 前缀）：reloadDetail / refreshDetailVisibility / entityDetailDrawerHtml
 *   三个函数沿用旧实现的结构性命名，无同名存量冲突，保持现名。
 *
 * 数据模型（api-mock.js / mock-data.js）：
 *   - getEntityHistory(id) → { entity, declarations, relations, events }
 *   - getEntity(id, storyTime) → 指定时间点的实体快照（用于时间线预览）
 *   - setVisibility(characterId, declarationId, confidence, source, storyTime)
 */

// ---------- 常量 ----------

// 属性键 → 中文名（properties 与 declarations 共用同一映射）
const PROPERTY_LABELS = {
  name: '名称', age: '年龄', gender: '性别', faction: '阵营', role: '角色',
  location: '位置', hasItem: '持有物品', alive: '存活', owner: '拥有者',
  region: '区域', type: '类型', hasRuin: '遗迹发现'
};

const VIS_STATE_LABELS = { known: '已知', unknown: '未知' };

// 声明来源 → 展示标签/图标（engine=AI 推理，user=手动；与 MOCK_EVENTS.source 语义一致）
const DETAIL_SOURCES = {
  engine: { label: 'AI 推理', icon: 'brain' },
  user: { label: '手动', icon: 'user' }
};

const EVENT_TYPE_LABELS = {
  birth: 'birth · 实体诞生',
  change: 'change · 属性变更',
  death: 'death · 实体退场'
};

// BUG-016：真实 EventRecord 常缺 summary（world-graph 写入时 optional），
// 前端 event-title 渲染空字符串导致时间线条目像"空气泡"。
// 兜底：无 summary 时从 newFacts[] / invalidated[] / type 拼出可读摘要。
function summarizeEvent(ev) {
  if (ev && typeof ev.summary === 'string' && ev.summary.trim()) return ev.summary.trim();
  const parts = [];
  if (ev && Array.isArray(ev.newFacts) && ev.newFacts.length) {
    for (const f of ev.newFacts.slice(0, 2)) {
      const label = detailPropLabel(f && f.property);
      const v = (f && f.value == null) ? '∅' : (f && f.value);
      const txt = (typeof v === 'string' && v.length > 40) ? v.slice(0, 40) + '…' : v;
      parts.push(`${label} → ${txt}`);
    }
    if (ev.newFacts.length > 2) parts.push(`等 ${ev.newFacts.length} 项`);
  }
  if (!parts.length && ev && Array.isArray(ev.invalidated) && ev.invalidated.length) {
    const props = ev.invalidated.map(d => d && d.property).filter(Boolean);
    parts.push(`失效：${props.slice(0, 3).join('、')}${props.length > 3 ? ' 等' : ''}`);
  }
  if (!parts.length) {
    const t = (ev && ev.type) || 'event';
    parts.push(`【${EVENT_TYPE_LABELS[t] || t}】`);
  }
  return parts.join('；');
}

// ---------- 状态 ----------

const detailState = {
  id: null,        // 当前实体 id
  data: null,      // getEntityHistory 返回的数据
  snapshot: null,  // 时间线预览态快照（getEntity(id, previewAt)），null=跟随当前
  tab: 'properties',
  previewAt: null, // 预览时间点，null=全局当前
  visibility: {}   // declarationId → 可见性记录数组（getVisibility 缓存）
};

// ---------- 工具 ----------

function detailPropLabel(key) {
  return PROPERTY_LABELS[key] || key;
}

function detailEntityName(entity) {
  return entity?.properties?.name || entity?.entityId || '';
}

/** 获取生效 StoryTime：App.storyTime 为空时兜底取 storyTimes 最后一项。
 *  BUG-035：App.storyTime 在项目切换/壳层重渲等多处被设为 null，
 *  直接传 null 给后端 requireFields 会抛 400（MISSING_FIELD），
 *  导致可见性矩阵点击、声明/关系闭合、实体退场等操作静默失败。
 *  mock 模式有 `|| currentStoryTime` 兜底不暴露此问题，真实后端必现。 */
function detailEffectiveStoryTime() {
  return App.storyTime
    || (App.storyTimes && App.storyTimes.length ? App.storyTimes[App.storyTimes.length - 1] : null);
}

function detailOtherEntity(entityId) {
  return (App.viewState.entityIndex && App.viewState.entityIndex[entityId])
    || (ApiRuntime.isMock ? (MOCK_ENTITIES || []).find(e => e.entityId === entityId) : null)
    || null;
}

function detailEntityTypeColor(entityId) {
  const e = detailOtherEntity(entityId);
  return e ? ((ENTITY_TYPES[e.entityType] && ENTITY_TYPES[e.entityType].color) || '#888') : '#888';
}

// 当前展示的属性集：预览态用快照属性，否则用实体原始属性
function detailCurrentProps() {
  const src = detailState.snapshot || detailState.data?.entity;
  return (src && src.properties) || {};
}

// 声明 → "属性 = 值" 展示文本（可见性矩阵行名等）
function detailDeclText(decl) {
  const v = decl.value == null ? '∅' : decl.value;
  return `${detailPropLabel(decl.property)} = ${v}`;
}

// 可见性矩阵单元格状态（取该角色对该声明的生效记录，回退任意记录）
function detailVisFor(declId, characterId) {
  const recs = (detailState.visibility[declId] || []).filter(v => v.characterId === characterId);
  const T = detailState.previewAt;
  // BUG-011：预览历史时间点 T 时，只取 T 点生效的可见性记录（validFrom<=T<validTo）
  const atT = T
    ? recs.filter(v => DemoUtils.compareStoryTime(v.validFrom, T) <= 0 && (v.validTo === 'Infinity' || DemoUtils.compareStoryTime(v.validTo, T) > 0))
    : recs;
  return atT.find(v => v.validTo === 'Infinity') || atT[0] || null;
}

// ---------- 数据加载 ----------

async function refreshDetailVisibility() {
  const vis = {};
  const decls = (detailState.data && detailState.data.declarations) || [];
  await Promise.all(decls.map(async d => {
    const res = await apiCall('getVisibility', d.declarationId);
    vis[d.declarationId] = res.visibility || [];
  }));
  detailState.visibility = vis;
}

// 请求序号：reloadDetail / openEntityDetail 共用，过期响应直接丢弃（防快速连续操作竞态覆盖）
let detailReloadSeq = 0;

async function reloadDetail(opts) {
  // R1：snapshotAt 缺省时沿用 previewAt，保证保存类操作后仍按当前预览时间点重取
  const snapshotAt = (opts && opts.snapshotAt !== undefined) ? opts.snapshotAt : detailState.previewAt;
  const token = ++detailReloadSeq;
  const id = detailState.id;
  const data = await apiCall('getEntityHistory', id);
  if (token !== detailReloadSeq || detailState.id !== id) return;
  detailState.data = data;
  if (snapshotAt) {
    detailState.snapshot = await apiCall('getEntity', id, snapshotAt);
    if (token !== detailReloadSeq || detailState.id !== id) return;
  } else {
    detailState.snapshot = null;
  }
  await refreshDetailVisibility();
  if (token !== detailReloadSeq || detailState.id !== id) return;
  openDrawer(entityDetailDrawerHtml());
  refreshIcons();
}

// ---------- 渲染：Drawer 骨架 ----------

function entityDetailDrawerHtml() {
  const data = detailState.data;
  if (!data) return '';
  const e = data.entity;
  const type = ENTITY_TYPES[e.entityType] || { label: e.entityType, color: '#888' };
  const name = detailEntityName(e);
  const alive = e.alive !== false && !(e.declAlive === false);

  return `
    <div class="detail-drawer">
      <div class="drawer-header">
        <button class="drawer-close" title="关闭" onclick="closeDrawer()">${icon('x', 'w-4 h-4')}</button>
        <div class="entity-type-badge" style="background-color:${type.color}">
          ${icon(e.entityType === 'character' ? 'user' : e.entityType === 'location' ? 'map-pin' : e.entityType === 'item' ? 'package' : 'lightbulb', 'w-2.5 h-2.5')}
          ${type.label}
        </div>
        <h1 class="entity-name-display">${escapeHtml(name)}</h1>
        <div class="entity-id-display">${escapeHtml(e.entityId)}</div>
        <div class="entity-summary-section">
          <p class="entity-summary-text">${escapeHtml(e.summary || '暂无摘要')}</p>
          <button class="edit-summary-btn" title="编辑摘要" onclick="detailEditEntityModal()">${icon('pencil', 'w-3.5 h-3.5')}</button>
        </div>
        <div class="status-badge-row">
          <span class="status-pill ${alive ? 'alive' : 'retired'}">${alive ? '存活' : '已退场'}</span>
        </div>
      </div>

      ${detailTimelineHtml()}

      <div class="tab-nav">
        <button class="tab-btn ${detailState.tab === 'properties' ? 'active' : ''}" onclick="detailTabSwitch('properties')">属性</button>
        <button class="tab-btn ${detailState.tab === 'declarations' ? 'active' : ''}" onclick="detailTabSwitch('declarations')">声明</button>
        <button class="tab-btn ${detailState.tab === 'relations' ? 'active' : ''}" onclick="detailTabSwitch('relations')">关系</button>
        <button class="tab-btn ${detailState.tab === 'visibility' ? 'active' : ''}" onclick="detailTabSwitch('visibility')">可见性</button>
        <button class="tab-btn ${detailState.tab === 'events' ? 'active' : ''}" onclick="detailTabSwitch('events')">事件</button>
      </div>

      <div class="tab-content">
        ${detailPanelHtml(detailState.tab)}
      </div>

      <div class="drawer-footer">
        <div class="footer-left">
          <button class="btn-secondary" onclick="detailEditEntityModal()">${icon('pencil', 'w-3.5 h-3.5')} 编辑实体</button>
        </div>
        <div class="footer-right">
          <div class="retire-hint">退场后该实体将从后续快照中消失，历史记录保留</div>
          <button class="btn-danger-text" onclick="detailRetireEntity(${q(e.entityId)})">${icon('activity', 'w-3.5 h-3.5')} 退场实体</button>
        </div>
      </div>
    </div>
  `;
}

// ---------- 渲染：时间线 ----------

function detailTimelineHtml() {
  const times = App.storyTimes || [];
  if (!times.length) return '';
  const cur = detailState.previewAt || App.storyTime;
  let idx = times.indexOf(cur);
  if (idx < 0) idx = times.length - 1;
  const pct = times.length > 1 ? Math.round((idx / (times.length - 1)) * 100) : 0;
  const isPreview = !!detailState.previewAt;
  return `
    <div class="timeline-section">
      <div class="timeline-label">历史时间点${isPreview ? ' · 预览中' : ''}</div>
      <div class="timeline-slider-container">
        <input type="range" class="timeline-range" min="0" max="${times.length - 1}" value="${idx}"
          style="background:linear-gradient(to right, var(--brand-400) ${pct}%, var(--bg-300) ${pct}%)"
          oninput="detailTimelineLive(this.value)" onchange="detailTimelineJump(this.value)">
        <div class="timeline-markers">
          <span>${escapeHtml(times[0])}</span>
          <span class="current">${escapeHtml(cur)}</span>
          <span>${escapeHtml(times[times.length - 1])}</span>
        </div>
      </div>
      ${isPreview ? `<button class="timeline-reset" onclick="detailTimelineReset()">回到当前 ${escapeHtml(App.storyTime)}</button>` : ''}
    </div>
  `;
}

// 拖动过程中的轻量反馈（不重绘，避免打断拖动）
function detailTimelineLive(idx) {
  const times = App.storyTimes || [];
  const st = times[idx];
  if (!st) return;
  const marker = $('.detail-drawer .timeline-markers .current');
  if (marker) marker.textContent = st;
  const range = $('.detail-drawer .timeline-range');
  if (range && times.length > 1) {
    const pct = Math.round((idx / (times.length - 1)) * 100);
    range.style.background = `linear-gradient(to right, var(--brand-400) ${pct}%, var(--bg-300) ${pct}%)`;
  }
}

// 松开滑块：切换本地预览时间点并重绘（不影响全局 App.storyTime）
async function detailTimelineJump(idx) {
  const times = App.storyTimes || [];
  const st = times[idx];
  if (!st) return;
  detailState.previewAt = (st === App.storyTime) ? null : st;
  await withLoading(async () => {
    await reloadDetail({ snapshotAt: detailState.previewAt });
  });
}

async function detailTimelineReset() {
  detailState.previewAt = null;
  await withLoading(async () => {
    await reloadDetail({});
  });
}

// ---------- 渲染：Tab 面板 ----------

const DETAIL_PANELS = {
  properties: detailPropertiesPanel,
  declarations: detailDeclarationsPanel,
  relations: detailRelationsPanel,
  visibility: detailVisibilityPanel,
  events: detailEventsPanel
};

function detailPanelHtml(tab) {
  const fn = DETAIL_PANELS[tab] || DETAIL_PANELS.properties;
  return fn();
}

// ---- 属性 ----

function detailPropertiesPanel() {
  const props = detailCurrentProps();
  const entries = Object.entries(props);
  const rows = entries.map(([k, v]) => `
    <div class="property-row">
      <div class="property-name">${escapeHtml(detailPropLabel(k))}</div>
      <div class="property-value" title="${escapeHtml(v)}">${escapeHtml(v)}</div>
      <div class="property-actions">
        <button class="property-edit-btn" onclick="detailEditProperty(${q(k)}, ${q(String(v))})">${icon('pencil', 'w-3 h-3')} 编辑</button>
      </div>
    </div>`).join('');
  return `
    <div class="properties-header">
      <div class="section-label">当前属性${detailState.previewAt ? ` · ${escapeHtml(detailState.previewAt)}` : ''}</div>
      <button class="btn-add-property" onclick="detailAddProperty()">${icon('plus', 'w-3 h-3')} 添加属性</button>
    </div>
    ${rows || '<div class="detail-empty">暂无属性</div>'}
    <p class="properties-hint">修改属性 = 闭合旧声明 + 写新声明（事件溯源）</p>`;
}

// ---- 声明 ----

function detailDeclarationsPanel() {
  const T = detailState.previewAt;
  let decls = (detailState.data && detailState.data.declarations) || [];
  // BUG-011：预览历史时间点 T 时，只显示 T 点仍生效的声明（validFrom<=T<validTo）
  if (T) {
    decls = decls.filter(d => DemoUtils.compareStoryTime(d.validFrom, T) <= 0 && (d.validTo === 'Infinity' || DemoUtils.compareStoryTime(d.validTo, T) > 0));
  }
  decls = decls.slice()
    .sort((a, b) => DemoUtils.compareStoryTime(b.validFrom, a.validFrom));
  const cards = decls.map(d => {
    const closed = d.validTo !== 'Infinity';
    const src = DETAIL_SOURCES[d.source] || DETAIL_SOURCES.user;
    return `
    <div class="declaration-card ${closed ? 'closed' : ''}">
      <div class="declaration-header">
        <div class="declaration-attr-value">
          <span class="decl-attr-name">${escapeHtml(detailPropLabel(d.property))}</span>
          <span class="decl-attr-eq">=</span>
          <span class="decl-attr-val">${escapeHtml(d.value == null ? '∅' : d.value)}</span>
        </div>
        <span class="declaration-status ${closed ? 'closed' : 'active'}">${closed ? '已闭合' : '生效中'}</span>
      </div>
      <div class="declaration-meta">
        <span class="declaration-meta-item">${icon('clock', 'w-2.5 h-2.5')}<span class="font-mono">${escapeHtml(d.validFrom)} → ${closed ? escapeHtml(d.validTo) : '（未闭合）'}</span></span>
        <span class="declaration-meta-item">${icon(src.icon, 'w-2.5 h-2.5')}<span>${src.label}</span></span>
      </div>
      <div class="declaration-tags">
        <span class="modality-tag ${d.modality === 'belief' ? 'belief' : 'factive'}">${escapeHtml(d.modality || 'fact')}</span>
      </div>
      ${closed
        ? (d.closeReason ? `<div class="close-reason">闭合原因：${escapeHtml(d.closeReason)}</div>` : '')
        : `<div class="declaration-actions">
            <button class="decl-action-btn close" onclick="detailCloseDeclaration(${q(d.declarationId)})">闭合</button>
          </div>`}
    </div>`;
  }).join('');
  return `
    <div class="section-label">声明${T ? ' · 生效于 ' + escapeHtml(T) : '历史 · 时间倒序'}</div>
    ${cards || '<div class="detail-empty">暂无声明</div>'}`;
}

// ---- 关系 ----

function detailRelationsPanel() {
  const id = detailState.id;
  const T = detailState.previewAt;
  let rels = (detailState.data && detailState.data.relations) || [];
  // BUG-011：预览历史时间点 T 时，只显示 T 点仍生效的关系（storyTime<=T 且未在 T 前闭合）
  if (T) {
    rels = rels.filter(r => DemoUtils.compareStoryTime(r.storyTime, T) <= 0 && (!r.closed || !r.closedAt || DemoUtils.compareStoryTime(r.closedAt, T) > 0));
  }
  const out = rels.filter(r => r.sourceId === id);
  const inn = rels.filter(r => r.targetId === id);

  const card = (r, otherId) => {
    const closed = !!r.closed;
    const other = detailOtherEntity(otherId);
    return `
    <div class="relation-card ${closed ? 'closed' : ''}">
      <div class="relation-card-top">
        <div class="relation-card-info">
          <span class="relation-dot" style="background-color:${detailEntityTypeColor(otherId)}"></span>
          <span class="relation-entity-name">${escapeHtml(detailEntityName(other) || otherId)}</span>
        </div>
        <span class="relation-type-badge">${escapeHtml(r.label)}</span>
      </div>
      <div class="relation-card-meta">
        <span class="font-mono">${escapeHtml(r.storyTime)} → ${closed ? escapeHtml(r.closedAt) : '（未闭合）'}</span>
        <span class="declaration-status ${closed ? 'closed' : 'active'}">${closed ? '已闭合' : '生效中'}</span>
      </div>
      ${closed ? '' : `
      <div class="relation-card-actions">
        <button class="decl-action-btn close" onclick="detailCloseRelation(${q(r.sourceId)}, ${q(r.targetId)}, ${q(r.label)})">闭合</button>
      </div>`}
    </div>`;
  };

  return `
    <div class="section-label">出边关系</div>
    ${out.length ? out.map(r => card(r, r.targetId)).join('') : '<div class="detail-empty">暂无出边关系</div>'}
    <div class="section-label" style="margin-top: 20px;">入边关系</div>
    ${inn.length ? inn.map(r => card(r, r.sourceId)).join('') : '<div class="detail-empty">暂无入边关系</div>'}
    <button class="btn-new-relation" onclick="detailNewRelation()">${icon('plus', 'w-3.5 h-3.5')} 新建关系</button>`;
}

// ---- 可见性 ----

function detailVisibilityPanel() {
  const T = detailState.previewAt;
  let decls = (detailState.data && detailState.data.declarations) || [];
  // BUG-011：预览历史时间点 T 时，矩阵行只含 T 点生效的声明
  if (T) {
    decls = decls.filter(d => DemoUtils.compareStoryTime(d.validFrom, T) <= 0 && (d.validTo === 'Infinity' || DemoUtils.compareStoryTime(d.validTo, T) > 0));
  }
  const chars = Object.values(App.viewState.entityIndex || {}).filter(e => e.entityType === 'character');

  const cell = (decl, ch) => {
    const rec = detailVisFor(decl.declarationId, ch.entityId);
    const state = rec && rec.state === 'known' ? 'known' : 'unknown';
    const sym = state === 'known' ? '✓' : '?';
    const title = rec
      ? `${VIS_STATE_LABELS[state]} · 置信 ${Math.round((rec.confidence || 0) * 100)}% · ${rec.source}`
      : '未知 · 点击设置';
    return `<td title="${escapeHtml(title)}" onclick="detailVisibilityClick(${q(ch.entityId)}, ${q(decl.declarationId)})">
      <span class="visibility-cell ${state}">${sym}</span>
    </td>`;
  };

  const head = `<tr><th>声明</th>${chars.map(c => `<th>${escapeHtml(detailEntityName(c))}</th>`).join('')}</tr>`;
  const body = decls.map(d => `
    <tr>
      <td class="decl-row-name">${escapeHtml(detailDeclText(d))}</td>
      ${chars.map(c => cell(d, c)).join('')}
    </tr>`).join('');

  return `
    <div class="section-label">角色 × 声明 可见性矩阵</div>
    <div class="visibility-legend">
      <span class="legend-item"><span class="visibility-cell known">✓</span><span>已知</span></span>
      <span class="legend-item"><span class="visibility-cell unknown">?</span><span>未知</span></span>
    </div>
    ${decls.length ? `<table class="visibility-matrix"><thead>${head}</thead><tbody>${body}</tbody></table>` : '<div class="detail-empty">暂无声明可设置可见性</div>'}
    <p class="visibility-hint">点击单元格可设置可见性来源或撤销</p>`;
}

// ---- 事件 ----

function detailEventsPanel() {
  const T = detailState.previewAt;
  let events = (detailState.data && detailState.data.events) || [];
  // BUG-011：预览历史时间点 T 时，只显示 T 点及之前的事件
  if (T) {
    events = events.filter(ev => DemoUtils.compareStoryTime(ev.storyTime, T) <= 0);
  }
  events = events.slice()
    .sort((a, b) => DemoUtils.compareStoryTime(a.storyTime, b.storyTime));
  const rows = events.map(ev => {
    const src = ev.source === 'engine' ? { label: 'AI', cls: 'ai' } : { label: '手动', cls: 'manual' };
    const label = EVENT_TYPE_LABELS[ev.type] || ev.type;
    return `
    <div class="event-timeline-item" onclick="detailOpenEvent(${q(ev.eventId)})">
      <div class="event-type-dot ${escapeHtml(ev.type)}"></div>
      <div class="event-content">
        <div class="event-meta-row">
          <span class="event-time">${escapeHtml(ev.storyTime)}</span>
          <span class="event-source-badge ${src.cls}">${src.label}</span>
        </div>
        <div class="event-title">${escapeHtml(summarizeEvent(ev))}</div>
        <div class="event-type-label ${escapeHtml(ev.type)}-label">${escapeHtml(label)}</div>
      </div>
    </div>`;
  }).join('');
  return `
    <div class="section-label">参与的事件 · 时间线</div>
    ${rows || '<div class="detail-empty">暂无事件</div>'}`;
}

// ---------- 交互：Tab 切换 ----------

function detailTabSwitch(tab) {
  if (!DETAIL_PANELS[tab]) return;
  detailState.tab = tab;
  const drawer = document.querySelector('.detail-drawer');
  const nav = drawer && drawer.querySelector('.tab-nav');
  const content = drawer && drawer.querySelector('.tab-content');
  // 抽屉不在 DOM 时回退整体渲染
  if (!nav || !content) { openDrawer(entityDetailDrawerHtml()); refreshIcons(); return; }
  // 局部更新标签栏与面板：避免整体重渲触发 drawerIn 入场动画、重置滚动位置
  nav.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', (b.getAttribute('onclick') || '').includes(`detailTabSwitch('${tab}')`)));
  content.innerHTML = detailPanelHtml(tab);
  refreshIcons();
}

// ---------- 交互：属性 / 摘要 / 实体 ----------

function detailEditEntityModal() {
  const e = detailState.data.entity;
  openModal('编辑实体',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">名称（只读，由声明驱动）</label><input class="input" value="${escapeHtml(detailEntityName(e))}" disabled></div>
      <div><label class="text-sm text-muted">摘要</label><textarea id="det-summary" class="input w-full" rows="3">${escapeHtml(e.summary || '')}</textarea></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="detailSaveEntity()">保存</button>`);
}

async function detailSaveEntity() {
  const summary = $('#det-summary').value.trim();
  closeModal();
  await withLoading(async () => {
    await apiCall('updateSummary', detailState.id, summary);
    toast('实体摘要已更新', 'success');
    await reloadDetail({});
  });
}

function detailEditProperty(property, value) {
  openModal(`编辑属性 · ${detailPropLabel(property)}`,
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">属性名</label><input class="input" value="${escapeHtml(property)}" disabled></div>
      <div><label class="text-sm text-muted">新值</label><input id="det-prop-value" class="input" value="${escapeHtml(value)}"></div>
      <p class="text-xs text-muted">保存后旧声明将闭合，新声明在当前 StoryTime（${escapeHtml(App.storyTime)}）生效。</p>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="detailSaveProperty(${q(property)})">保存</button>`);
}

async function detailSaveProperty(property) {
  const value = $('#det-prop-value').value.trim();
  closeModal();
  if (!value) { toast('属性值不能为空', 'error'); return; }
  await withLoading(async () => {
    const res = await apiCall('addProperty', detailState.id, property, value, detailEffectiveStoryTime(), 'fact');
    toast(res.closedDeclarationId ? '属性已更新（旧声明已闭合）' : '属性已添加', 'success');
    await reloadDetail({});
  });
}

function detailAddProperty() {
  openModal('添加属性',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">属性名</label><input id="det-prop-name" class="input" placeholder="如：称号"></div>
      <div><label class="text-sm text-muted">值</label><input id="det-prop-value2" class="input" placeholder="如：星海旅人"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="detailSaveNewProperty()">添加</button>`);
}

async function detailSaveNewProperty() {
  const name = $('#det-prop-name').value.trim();
  const value = $('#det-prop-value2').value.trim();
  closeModal();
  if (!name || !value) { toast('属性名与值不能为空', 'error'); return; }
  await withLoading(async () => {
    const res = await apiCall('addProperty', detailState.id, name, value, detailEffectiveStoryTime(), 'fact');
    toast(res.closedDeclarationId ? '属性已更新（旧声明已闭合）' : '属性已添加', 'success');
    await reloadDetail({});
  });
}

// ---------- 交互：声明 / 关系 ----------

async function detailCloseDeclaration(declId) {
  if (!confirm('确认闭合该声明？闭合后该声明将不再生效。')) return;
  await withLoading(async () => {
    await apiCall('closeDeclaration', declId, detailState.id, detailEffectiveStoryTime());
    toast('声明已闭合', 'success');
    await reloadDetail({});
  });
}

async function detailCloseRelation(sourceId, targetId, label) {
  if (!confirm('确认闭合该关系？')) return;
  await withLoading(async () => {
    await apiCall('closeRelation', sourceId, targetId, label, detailEffectiveStoryTime());
    toast('关系已闭合', 'success');
    await reloadDetail({});
  });
}

function detailNewRelation() {
  openModal('新建关系',
    `<div class="space-y-3">
      <div><label class="text-sm text-muted">目标实体 ID</label><input id="det-rel-target" class="input" placeholder="如：item-01"></div>
      <div><label class="text-sm text-muted">关系标签</label><input id="det-rel-label" class="input" value="关联"></div>
      <div><label class="text-sm text-muted">故事时间</label><input id="det-rel-st" class="input" value="${escapeHtml(App.storyTime || '')}"></div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="detailSaveNewRelation()">创建</button>`);
}

async function detailSaveNewRelation() {
  const target = $('#det-rel-target').value.trim();
  const label = $('#det-rel-label').value.trim();
  const st = $('#det-rel-st').value.trim();
  closeModal();
  if (!target || !label) { toast('目标实体与关系标签不能为空', 'error'); return; }
  await withLoading(async () => {
    await apiCall('addRelation', detailState.id, target, label, st || detailEffectiveStoryTime());
    toast('关系已创建', 'success');
    await reloadDetail({});
  });
}

// ---------- 交互：可见性 ----------

async function detailVisibilityClick(characterId, declarationId) {
  const rec = detailVisFor(declarationId, characterId);
  const next = rec && rec.state === 'known' ? 'unknown' : 'known';
  await withLoading(async () => {
    if (next === 'unknown') {
      await apiCall('closeVisibility', characterId, declarationId, detailEffectiveStoryTime());
    } else {
      await apiCall('setVisibility', characterId, declarationId, 0.9, 'informed', detailEffectiveStoryTime());
    }
    toast(next === 'unknown' ? '可见性已撤销（未知）' : `可见性已设为「${VIS_STATE_LABELS[next]}」`, 'success');
    await reloadDetail({});
  });
}

// ---------- 交互：事件跳转 / 退场 ----------

function detailOpenEvent(eventId) {
  closeDrawer();
  navigate('#/events?event=' + encodeURIComponent(eventId));
}

async function detailRetireEntity(id) {
  if (!confirm('确认让该实体退场？此操作不可撤销。')) return;
  closeDrawer();
  await withLoading(async () => {
    await apiCall('killEntity', id, detailEffectiveStoryTime());
    toast('实体已退场', 'info');
    // 服务端数据已变更，重新拉取图数据
    renderView({ reload: true });
  });
}

// ---------- 入口（覆盖 views.js 的同名函数，见文件头注释） ----------

async function openEntityDetail(id) {
  await withLoading(async () => {
    const data = await apiCall('getEntityHistory', id);
    if (detailState.id !== null && detailState.id !== id) return; // 期间已切到别的实体，丢弃过期响应
    detailReloadSeq++; // 使进行中的 reloadDetail 失效
    detailState.id = id;
    detailState.data = data;
    detailState.snapshot = null;
    detailState.previewAt = null;
    detailState.tab = 'properties';
    await refreshDetailVisibility();
    openDrawer(entityDetailDrawerHtml());
    refreshIcons();
  });
}
