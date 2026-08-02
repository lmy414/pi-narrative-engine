/** 调试视图：只消费真实 DebugEvent 字段。 */

const DBG_STATUSES = ['all', 'start', 'end', 'error'];
const DBG_SIM_SCRIPT = [
  { traceId: 'trace-sim-01', stage: 'planner', status: 'start', input: { storyTime: 'ch008.ev002' } },
  { traceId: 'trace-sim-01', stage: 'planner', status: 'end', output: { candidateCount: 3 }, durationMs: 1300 },
  { traceId: 'trace-sim-01', stage: 'role', status: 'end', output: { outputCount: 2 }, durationMs: 2200 },
  { traceId: 'trace-sim-02', stage: 'renderer', status: 'error', input: { chapterPath: '正文/ch008.md' }, durationMs: 30000, error: '模型响应超时' }
];

let dbgStreamClose = null;

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

async function dbgLoadData() {
  const data = await apiCall('getDebugEvents');
  const local = (dbgState('dbgLogs', []) || []).filter((event) => String(event.id || '').startsWith('sim-'));
  setDbgState('dbgLogs', (data.events || []).concat(local));
}

function dbgFilteredLogs() {
  const status = dbgState('dbgStatus', 'all');
  const stage = dbgState('dbgStage', '');
  const keyword = String(dbgState('dbgKeyword', '') || '').trim().toLowerCase();
  return (dbgState('dbgLogs', []) || []).filter((event) => {
    if (status !== 'all' && event.status !== status) return false;
    if (stage && event.stage !== stage) return false;
    if (!keyword) return true;
    const searchable = [event.status, event.stage, event.error, event.input, event.output]
      .map((value) => typeof value === 'object' ? JSON.stringify(value) : String(value || ''))
      .join(' ')
      .toLowerCase();
    return searchable.includes(keyword);
  });
}

ViewRender.debug = () => {
  const logs = dbgState('dbgLogs', []) || [];
  const status = dbgState('dbgStatus', 'all');
  const stage = dbgState('dbgStage', '');
  const keyword = dbgState('dbgKeyword', '') || '';
  const density = dbgState('dbgDensity', 'detailed');
  const autoScroll = dbgState('dbgAutoScroll', true);
  const stages = [...new Set(logs.map((event) => event.stage).filter(Boolean))].sort();
  const filtered = dbgFilteredLogs();
  return `
    <div class="dbg-workspace">
      <div class="dbg-filter-bar">
        <div class="dbg-level-filter">${DBG_STATUSES.map((item) => dbgStatusBtnHtml(item, status)).join('')}</div>
        <select class="dbg-module-select" onchange="dbgSelectStage(this.value)">
          <option value="">全部阶段</option>
          ${stages.map((item) => `<option value="${escapeHtml(item)}" ${item === stage ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
        </select>
        <div class="dbg-keyword-search">
          ${icon('search', 'dbg-search-icon')}
          <input class="dbg-search-input" placeholder="搜索状态、阶段、输入、输出或错误…" value="${escapeHtml(keyword)}" oninput="dbgKeywordInput(this.value)">
          ${keyword ? `<button class="dbg-search-clear" onclick="dbgClearKeyword()" title="清除搜索">${icon('x', 'w-3.5 h-3.5')}</button>` : ''}
        </div>
        <div class="dbg-filter-spacer"></div>
        <div class="dbg-density-toggle">
          <button class="dbg-density-btn ${density === 'detailed' ? 'dbg-active' : ''}" onclick="dbgSetDensity('detailed')">详细</button>
          <button class="dbg-density-btn ${density === 'compact' ? 'dbg-active' : ''}" onclick="dbgSetDensity('compact')">紧凑</button>
        </div>
        <span class="dbg-buffer-count">缓冲 <strong id="dbg-buffer-count">${logs.length}</strong> 条</span>
        ${ApiRuntime.isMock ? `<button class="dbg-btn-tool" onclick="dbgSimulateLog()" title="模拟一条新的调试事件">${icon('plus', 'w-3.5 h-3.5')} 模拟</button>` : ''}
        <button class="dbg-btn-tool dbg-btn-danger" onclick="dbgOpenClearConfirm()" title="清空内存缓冲">${icon('trash-2', 'w-3.5 h-3.5')} 清空</button>
      </div>
      <div class="dbg-log-container ${density === 'compact' ? 'dbg-compact' : ''}" id="dbg-log-container">
        <div class="dbg-log-list" id="dbg-log-list">${filtered.length ? filtered.map((event) => dbgLogItemHtml(event, density)).join('') : dbgEmptyHtml()}</div>
      </div>
      <div class="dbg-autoscroll-toggle ${autoScroll ? '' : 'dbg-off'}" onclick="dbgToggleAutoScroll()">
        ${icon('arrow-down-to-line', 'dbg-autoscroll-icon')}<span class="dbg-autoscroll-label">${autoScroll ? '自动滚动' : '已暂停'}</span>
      </div>
    </div>`;
};

function dbgStatusBtnHtml(status, active) {
  return `<button class="dbg-level-btn dbg-lv-${status} ${status === active ? 'dbg-active' : ''}" onclick="dbgSelectStatus(${q(status)})">${status.toUpperCase()}</button>`;
}

function dbgLogItemHtml(event, density) {
  const expanded = (dbgState('dbgExpanded', []) || []).includes(event.id);
  const summary = event.error || dbgEventSummary(event.output) || dbgEventSummary(event.input) || event.status;
  return `
    <div class="dbg-log-item dbg-lv-${event.status}${event.status === 'error' ? ' dbg-error-row' : ''}${expanded ? ' dbg-expanded' : ''}" data-id="${escapeHtml(event.id)}" onclick="dbgToggleExpand(${q(event.id)})">
      <div class="dbg-log-meta"><span class="dbg-log-timestamp">${dbgFormatTime(event.ts)}</span>${density === 'detailed' ? `<span class="dbg-log-trace"><span class="dbg-trace-id">${escapeHtml(event.traceId || '')}</span></span>` : ''}</div>
      <span class="dbg-span-mark dbg-span-${event.status || 'start'}"></span>
      <span class="dbg-log-level dbg-lv-${event.status}" title="${escapeHtml(event.status || '')}"></span>
      <span class="dbg-log-module">${escapeHtml(event.stage || '')}</span>
      <span class="dbg-log-message">${event.status === 'error' ? icon('circle-alert', 'dbg-error-icon') : ''}${escapeHtml(summary)}</span>
      <span class="dbg-log-expand">${icon('chevron-down', 'dbg-chevron')}</span>
      ${dbgLogDetailHtml(event)}
    </div>`;
}

function dbgEventSummary(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function dbgLogDetailHtml(event) {
  const rows = ['traceId', 'parentId', 'stage', 'status', 'input', 'output', 'durationMs', 'error']
    .filter((key) => event[key] !== undefined)
    .map((key) => dbgDetailRowHtml(key, event[key]));
  return rows.length ? `<div class="dbg-log-stack"><div class="dbg-span-payload">${rows.join('')}</div></div>` : '';
}

function dbgDetailRowHtml(key, value) {
  const text = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<div class="dbg-payload-row"><span class="dbg-payload-key">${escapeHtml(key)}</span><span class="dbg-payload-val">${escapeHtml(text)}</span></div>`;
}

function dbgEmptyHtml() {
  return `<div class="dbg-empty">${icon('terminal', 'dbg-empty-icon')}<div class="dbg-empty-title">暂无调试事件</div><div class="dbg-empty-desc">当前筛选条件下没有事件，发起一次编排即可看到流水线</div><button class="btn btn-primary btn-sm" onclick="navigate('#/studio')">去创作编排</button></div>`;
}

function dbgFormatTime(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return escapeHtml(String(iso || '—'));
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

function dbgSelectStatus(value) { setDbgState('dbgStatus', value); renderView(); }
function dbgSelectStage(value) { setDbgState('dbgStage', value); renderView(); }
function dbgKeywordInput(value) { setDbgState('dbgKeyword', value); dbgRenderLogList(); }
function dbgClearKeyword() { setDbgState('dbgKeyword', ''); renderView(); }
function dbgSetDensity(value) { setDbgState('dbgDensity', value); renderView(); }
function dbgToggleAutoScroll() { setDbgState('dbgAutoScroll', !dbgState('dbgAutoScroll', true)); renderView(); }

function dbgToggleExpand(id) {
  const list = dbgState('dbgExpanded', []) || [];
  setDbgState('dbgExpanded', list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const row = document.querySelector(`.dbg-log-item[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.toggle('dbg-expanded');
}

function dbgSimulateLog() {
  if (!ApiRuntime.isMock) return;
  const cursor = dbgState('dbgSimCursor', 0) || 0;
  const template = DBG_SIM_SCRIPT[cursor % DBG_SIM_SCRIPT.length];
  const event = { id: `sim-${String(cursor + 1).padStart(3, '0')}`, ts: Date.now(), ...template };
  setDbgState('dbgSimCursor', cursor + 1);
  setDbgState('dbgLogs', (dbgState('dbgLogs', []) || []).concat(event));
  dbgRenderLogList();
  dbgUpdateBuffer();
  if (dbgState('dbgAutoScroll', true)) dbgScrollToBottom();
}

function dbgRenderLogList() {
  const element = $('#dbg-log-list');
  if (!element) return;
  const logs = dbgFilteredLogs();
  element.innerHTML = logs.length ? logs.map((event) => dbgLogItemHtml(event, dbgState('dbgDensity', 'detailed'))).join('') : dbgEmptyHtml();
  refreshIcons();
}

function dbgUpdateBuffer() { const element = $('#dbg-buffer-count'); if (element) element.textContent = String((dbgState('dbgLogs', []) || []).length); }
function dbgScrollToBottom() { const element = $('#dbg-log-container'); if (element) element.scrollTop = element.scrollHeight; }

function dbgOpenClearConfirm() {
  openModal('清空调试事件', '<p class="text-sm text-muted">确认清空当前进程的内存缓冲？磁盘日志不受影响。</p>', `<button class="btn btn-ghost" onclick="closeModal()">取消</button><button class="btn btn-destructive" onclick="dbgConfirmClearLogs()">清空</button>`);
}

async function dbgConfirmClearLogs() {
  closeModal();
  await withLoading(async () => {
    await apiCall('clearDebugEvents');
    setDbgState('dbgLogs', []);
    renderView();
    toast('内存缓冲已清空', 'info');
  });
}

function dbgHandleStreamEvent(event) {
  if (!event || typeof event !== 'object' || !event.id) return;
  const logs = dbgState('dbgLogs', []) || [];
  if (logs.some((item) => item.id === event.id)) return;
  setDbgState('dbgLogs', logs.concat(event));
  dbgRenderLogList();
  dbgUpdateBuffer();
  if (dbgState('dbgAutoScroll', true)) dbgScrollToBottom();
}

function cleanupDebugView() {
  if (dbgStreamClose) dbgStreamClose();
  dbgStreamClose = null;
}

ViewAfterRender.debug = () => {
  if (dbgState('dbgAutoScroll', true)) dbgScrollToBottom();
  if (!ApiRuntime.isMock && !dbgStreamClose) {
    dbgStreamClose = ApiRuntime.subscribeDebug(dbgHandleStreamEvent, (error) => handleApiError(error));
  }
};
viewLoaders.debug = dbgLoadData;
