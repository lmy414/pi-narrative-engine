/**
 * 调试视图 —— 高保真重构（视觉基准：narrative-engine-design/pages/debug.html）
 *
 * 本文件直接覆盖 views.js 中的旧调试实现（模式同 views/graph.js / views/studio.js）：
 *   - ViewRender.debug / ViewAfterRender.debug
 *   - viewLoaders.debug → dbgLoadData（旧 loadDebug 每次覆盖本地状态，此处合并保留模拟追加）
 *
 * 状态读写约定（T1 命名空间 + 平面双写）：
 *   dbgState(key, fallback)   读取：优先 viewState('debug')[key]，回退 App.viewState[key]
 *   setDbgState(key, value)   写入：命名空间与平面字段同时写
 *   注意：数据键统一 dbg* 前缀命名，避免与路由命名空间键 'debug' 同名（views/events.js 教训）
 *
 * 模拟日志流：dbgSimulateLog() 从确定性脚本序列轮询取一条（无随机、无定时器、无需清理），
 * 仅用于演示「模拟新日志 + 自动滚动」行为；初始数据经 apiCall('getDebugEvents') 闭环获取。
 */

// ==================== 常量 ====================

const DBG_LEVELS = ['all', 'debug', 'info', 'warn', 'error'];

// 确定性模拟脚本：按游标轮询取一条，保证测试可复现
const DBG_SIM_SCRIPT = [
  { level: 'info', module: 'orchestrator', stage: 'orchestrator', traceId: 'trace-sim-01', spanId: 'span-root', type: 'start', message: '开始新一轮编排，目标：推进第三章至 ev002', payload: { round: 26, goal: 'ch003.ev002' } },
  { level: 'debug', module: 'planner', stage: 'planner', traceId: 'trace-sim-01', spanId: 'span-planner', type: 'log', message: '规划候选事件 3 个：集市冲突 / 旧友重逢 / 星图异动', payload: { candidates: 3 } },
  { level: 'warn', module: 'reasoner', stage: 'reasoner', traceId: 'trace-sim-01', spanId: 'span-reasoner', type: 'log', message: '因果一致性偏弱：事件 ev003 与既有设定存在张力', payload: { confidence: 0.63 } },
  { level: 'error', module: 'renderer', stage: 'renderer', traceId: 'trace-sim-01', spanId: 'span-renderer', type: 'end', message: '章节渲染失败 - 模型响应超时（30s）', payload: { chapterPath: '正文/ch008.md', durationMs: 30000, error: 'timeout' }, stack: ['RenderSession.renderChapter (renderer-agent.ts:155)', 'LLMProvider.stream (providers/anthropic.ts:92)', 'AbortError: The operation was aborted due to timeout'] },
  { level: 'info', module: 'role', stage: 'role', traceId: 'trace-sim-01', spanId: 'span-role', type: 'end', message: '角色演绎完成，新增 2 段对白片段', payload: { snippets: 2 } },
  { level: 'debug', module: 'world-graph', stage: 'world-graph', traceId: 'trace-sim-01', spanId: 'span-graph', type: 'log', message: '增量写入完成（+1 实体 / +2 关系）', payload: { entities: 1, relations: 2 } }
];

// ==================== 状态读写 ====================

function dbgState(key, fallback) {
  const ns = viewState('debug');
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setDbgState(key, value) {
  viewState('debug')[key] = value;
  App.viewState[key] = value;
}

// ==================== 数据加载 ====================

/**
 * 调试数据加载器（覆盖 viewLoaders.debug）。
 * 服务端数据 + 保留本地模拟追加（sim-*），避免切换筛选触发 render 时丢失演示日志。
 */
async function dbgLoadData() {
  const data = await apiCall('getDebugEvents');
  const serverLogs = data.events || [];
  const localSims = (dbgState('dbgLogs', []) || []).filter(e => String(e.id || '').startsWith('sim-'));
  setDbgState('dbgLogs', serverLogs.concat(localSims));
}

// ==================== 组合筛选 ====================

function dbgFilteredLogs() {
  const level = dbgState('dbgLevel', 'all');
  const module = dbgState('dbgModule', '');
  const keyword = (dbgState('dbgKeyword', '') || '').trim().toLowerCase();
  return (dbgState('dbgLogs', []) || []).filter(e => {
    if (level !== 'all' && e.level !== level) return false;
    if (module && e.module !== module) return false;
    if (keyword) {
      const hay = `${e.message || ''} ${e.module || ''} ${e.traceId || ''}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

// ==================== 渲染 ====================

ViewRender.debug = () => {
  const logs = dbgState('dbgLogs', []) || [];
  const level = dbgState('dbgLevel', 'all');
  const module = dbgState('dbgModule', '');
  const keyword = dbgState('dbgKeyword', '') || '';
  const density = dbgState('dbgDensity', 'detailed');
  const autoScroll = dbgState('dbgAutoScroll', true);
  const filtered = dbgFilteredLogs();
  const modules = [...new Set(logs.map(e => e.module))].sort();

  return `
    <div class="dbg-workspace">
      <div class="dbg-filter-bar">
        <div class="dbg-level-filter">
          ${DBG_LEVELS.map(l => dbgLevelBtnHtml(l, level)).join('')}
        </div>
        <select class="dbg-module-select" onchange="dbgSelectModule(this.value)">
          <option value="">全部模块</option>
          ${modules.map(m => `<option value="${escapeHtml(m)}" ${m === module ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
        </select>
        <div class="dbg-keyword-search">
          ${icon('search', 'dbg-search-icon')}
          <input class="dbg-search-input" placeholder="搜索日志消息…" value="${escapeHtml(keyword)}" oninput="dbgKeywordInput(this.value)">
          ${keyword ? `<button class="dbg-search-clear" onclick="dbgClearKeyword()" title="清除搜索">${icon('x', 'w-3.5 h-3.5')}</button>` : ''}
        </div>
        <div class="dbg-filter-spacer"></div>
        <div class="dbg-density-toggle">
          <button class="dbg-density-btn ${density === 'detailed' ? 'dbg-active' : ''}" onclick="dbgSetDensity('detailed')">详细</button>
          <button class="dbg-density-btn ${density === 'compact' ? 'dbg-active' : ''}" onclick="dbgSetDensity('compact')">紧凑</button>
        </div>
        <span class="dbg-buffer-count">缓冲 <strong id="dbg-buffer-count">${logs.length}</strong> 条</span>
        <button class="dbg-btn-tool" onclick="dbgSimulateLog()" title="模拟一条新的调试日志">${icon('plus', 'w-3.5 h-3.5')} 模拟</button>
        <button class="dbg-btn-tool dbg-btn-danger" onclick="dbgOpenClearConfirm()" title="清空全部日志">${icon('trash-2', 'w-3.5 h-3.5')} 清空</button>
      </div>
      <div class="dbg-log-container ${density === 'compact' ? 'dbg-compact' : ''}" id="dbg-log-container">
        <div class="dbg-log-list" id="dbg-log-list">
          ${filtered.length === 0 ? dbgEmptyHtml() : filtered.map(e => dbgLogItemHtml(e, density)).join('')}
        </div>
      </div>
      <div class="dbg-autoscroll-toggle ${autoScroll ? '' : 'dbg-off'}" onclick="dbgToggleAutoScroll()" title="${autoScroll ? '已开启自动滚动，点击暂停' : '已暂停自动滚动，点击开启'}">
        ${icon('arrow-down-to-line', 'dbg-autoscroll-icon')}
        <span class="dbg-autoscroll-label">${autoScroll ? '自动滚动' : '已暂停'}</span>
      </div>
    </div>
  `;
};

function dbgLevelBtnHtml(level, active) {
  return `
    <button class="dbg-level-btn dbg-lv-${level} ${level === active ? 'dbg-active' : ''}" onclick="dbgSelectLevel(${q(level)})">${level.toUpperCase()}</button>
  `;
}

function dbgLogItemHtml(e, density) {
  const expanded = (dbgState('dbgExpanded', []) || []).includes(e.id);
  const traceVisible = density === 'detailed';
  return `
    <div class="dbg-log-item dbg-lv-${e.level}${e.level === 'error' ? ' dbg-error-row' : ''}${expanded ? ' dbg-expanded' : ''}" data-id="${escapeHtml(e.id)}" onclick="dbgToggleExpand(${q(e.id)})">
      <div class="dbg-log-meta">
        <span class="dbg-log-timestamp">${dbgFormatTime(e.ts)}</span>
        ${traceVisible ? `<span class="dbg-log-trace"><span class="dbg-trace-id">${escapeHtml(e.traceId || '')}</span><span class="dbg-span-id">${escapeHtml(e.spanId || '')}</span></span>` : ''}
      </div>
      <span class="dbg-span-mark dbg-span-${e.type || 'log'}"></span>
      <span class="dbg-log-level dbg-lv-${e.level}" title="${escapeHtml(e.level)}"></span>
      <span class="dbg-log-module">${escapeHtml(e.module || '')}</span>
      <span class="dbg-log-message">${e.level === 'error' ? icon('circle-alert', 'dbg-error-icon') : ''}${escapeHtml(e.message || '')}</span>
      <span class="dbg-log-expand">${icon('chevron-down', 'dbg-chevron')}</span>
      ${dbgLogDetailHtml(e)}
    </div>
  `;
}

function dbgLogDetailHtml(e) {
  const rows = [];
  if (e.traceId !== undefined) rows.push(dbgPayloadRowHtml('traceId', e.traceId));
  if (e.spanId !== undefined) rows.push(dbgPayloadRowHtml('spanId', e.spanId));
  if (e.stage !== undefined) rows.push(dbgPayloadRowHtml('stage', e.stage));
  if (e.type !== undefined) rows.push(dbgPayloadRowHtml('type', e.type));
  if (e.payload && typeof e.payload === 'object' && Object.keys(e.payload).length) {
    for (const [k, v] of Object.entries(e.payload)) rows.push(dbgPayloadRowHtml(k, v));
  }
  const stackHtml = Array.isArray(e.stack) && e.stack.length
    ? `<div class="dbg-stack-divider"></div>${e.stack.map(line => `<div class="dbg-stack-line">${escapeHtml(line)}</div>`).join('')}`
    : '';
  if (!rows.length && !stackHtml) return '';
  return `
    <div class="dbg-log-stack">
      ${rows.length ? `<div class="dbg-span-payload">${rows.join('')}</div>` : ''}
      ${stackHtml}
    </div>
  `;
}

function dbgPayloadRowHtml(key, value) {
  return `<div class="dbg-payload-row"><span class="dbg-payload-key">${escapeHtml(key)}</span><span class="dbg-payload-val">${dbgPayloadValueHtml(value)}</span></div>`;
}

function dbgPayloadValueHtml(value) {
  if (value === null || value === undefined) return '<span class="dbg-payload-null">null</span>';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function dbgEmptyHtml() {
  return `
    <div class="dbg-empty">
      ${icon('terminal', 'dbg-empty-icon')}
      <div class="dbg-empty-title">暂无调试事件</div>
      <div class="dbg-empty-desc">当前筛选条件下没有日志，发起一次编排即可看到流水线</div>
      <button class="btn btn-primary btn-sm" onclick="navigate('#/studio')">去创作编排</button>
    </div>
  `;
}

function dbgFormatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

// ==================== 交互 ====================

function dbgSelectLevel(level) {
  setDbgState('dbgLevel', level);
  renderView();
}

function dbgSelectModule(value) {
  setDbgState('dbgModule', value);
  renderView();
}

function dbgKeywordInput(value) {
  setDbgState('dbgKeyword', value);
  dbgRenderLogList();
}

function dbgClearKeyword() {
  setDbgState('dbgKeyword', '');
  renderView();
}

function dbgSetDensity(density) {
  setDbgState('dbgDensity', density);
  renderView();
}

function dbgToggleAutoScroll() {
  setDbgState('dbgAutoScroll', !dbgState('dbgAutoScroll', true));
  renderView();
}

function dbgToggleExpand(id) {
  const list = dbgState('dbgExpanded', []) || [];
  const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
  setDbgState('dbgExpanded', next);
  const row = document.querySelector(`.dbg-log-item[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.toggle('dbg-expanded');
}

// 模拟一条新的调试日志（确定性脚本轮询，无随机 / 无定时器）
function dbgSimulateLog() {
  const cursor = dbgState('dbgSimCursor', 0) || 0;
  const tpl = DBG_SIM_SCRIPT[cursor % DBG_SIM_SCRIPT.length];
  setDbgState('dbgSimCursor', cursor + 1);
  const logs = (dbgState('dbgLogs', []) || []).slice();
  logs.push({
    id: 'sim-' + String(cursor + 1).padStart(3, '0'),
    level: tpl.level,
    module: tpl.module,
    stage: tpl.stage,
    traceId: tpl.traceId,
    spanId: tpl.spanId,
    type: tpl.type,
    message: tpl.message,
    payload: tpl.payload,
    stack: tpl.stack,
    ts: new Date().toISOString()
  });
  setDbgState('dbgLogs', logs);
  dbgRenderLogList();
  dbgUpdateBuffer();
  if (dbgState('dbgAutoScroll', true)) dbgScrollToBottom();
}

// 局部刷新日志列表（不整页 render，保持搜索框输入焦点）
function dbgRenderLogList() {
  const el = $('#dbg-log-list');
  if (!el) return;
  const filtered = dbgFilteredLogs();
  const density = dbgState('dbgDensity', 'detailed');
  el.innerHTML = filtered.length === 0 ? dbgEmptyHtml() : filtered.map(e => dbgLogItemHtml(e, density)).join('');
  refreshIcons();
}

function dbgUpdateBuffer() {
  const el = $('#dbg-buffer-count');
  if (el) el.textContent = String((dbgState('dbgLogs', []) || []).length);
}

function dbgScrollToBottom() {
  const el = $('#dbg-log-container');
  if (el) el.scrollTop = el.scrollHeight;
}

// ==================== 清空（带确认 modal） ====================

function dbgOpenClearConfirm() {
  openModal(
    '清空调试日志',
    '<p class="text-sm text-muted">确认清空全部调试日志？此操作不可恢复，后续模拟日志将从空缓冲继续追加。</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-destructive" onclick="dbgConfirmClearLogs()">清空</button>`
  );
}

async function dbgConfirmClearLogs() {
  closeModal();
  await withLoading(async () => {
    await apiCall('clearDebugEvents');
    setDbgState('dbgLogs', []);
    renderView();
    toast('已清空', 'info');
  });
}

// ==================== 渲染后副作用 ====================

ViewAfterRender.debug = () => {
  if (dbgState('dbgAutoScroll', true)) dbgScrollToBottom();
};

// 覆盖 viewLoaders.debug（旧 loadDebug）
viewLoaders.debug = dbgLoadData;
