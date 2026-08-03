/**
 * frontend-demo/views/studio.js — 创作编排视图（高保真重构，Task 7）
 *
 * 设计基准：narrative-engine-design/pages/orchestration.html
 * （三栏工作台：分组会话列表 / 聊天区 + Tool Call 卡片 + Plan 卡片 / Agent 状态栏 + 派发面板）
 *
 * 覆盖约定（模式同 views/graph.js / views/events.js）：
 *   - ViewRender.studio / ViewAfterRender.studio（views.js 中旧 ViewRender.studio 赋值会被本文件后加载覆盖）
 *   - viewLoaders.studio → stLoadData（views.js 中旧 loadStudio 函数声明保留，不修改）
 *
 * 状态读写约定（viewState('studio') 命名空间 + 平面双写，参考 events.js）：
 *   - stState(key, fallback) / setStState(key, value)
 *   - 数据键用 studioSessions / studioMessages / schedulerStatus / currentSessionId 等，
 *     避免与命名空间 routeId 'studio' 同名（参考 events.js eventList 的教训，防止双写把命名空间覆盖成数组）
 *
 * 数据获取与写操作走 apiMock 闭环（api-mock.js 实际暴露方法）：
 *   getChatSessions / getChatMessages / getSchedulerStatus / getSchedulerPlan /
 *   sendChatMessage / setSchedulerMode / dispatch / commitPlan / discardPlan / search
 * 复用 demo-utils.js：DemoUtils.groupSessionsByTime
 *
 * 流式文本使用固定步长模拟；计划产出和阶段始终来自 plan detail。
 *
 * 注入安全：onclick 内联参数一律单引号 + escapeHtml（禁止裸 JSON.stringify 双引号注入）
 */

// ==================== 常量 ====================

const ST_STAGE_DEFS = [
  { stage: 'planner', name: '规划', agent: '策划代理', icon: 'list' },
  { stage: 'role', name: '角色', agent: '角色代理', icon: 'users' }
];

const ST_STAGE_STATUS_LABEL = { done: '完成', error: '失败' };

// 可控模拟节奏（ms）：浏览器中驱动编排脚本与流式输出；测试可整体调小/手动单步
const ST_SIM_TICK_MS = 620;     // 编排脚本相邻事件间隔
const ST_STREAM_CHUNK = 2;      // 每次流式追加字符数
const ST_STREAM_TICK_MS = 28;   // 流式相邻 tick 间隔

let stChatClose = null;
let stSchedulerTimer = null;
let stRuntimeGeneration = 0;

// ==================== 状态访问器 ====================

function stState(key, fallback) {
  const ns = viewState('studio');
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setStState(key, value) {
  viewState('studio')[key] = value;
  App.viewState[key] = value;
}

// ==================== 数据加载（覆盖 viewLoaders.studio） ====================

/** 当前会话解析：优先后端 live 会话（主会话实际写入目标），其次保留现有，最后回退列表首条。 */
function stResolveSessionId(sessions, currentId) {
  const list = sessions || [];
  const live = list.find((s) => s.live);
  if (live) return live.id;
  if (currentId && list.some((s) => s.id === currentId)) return currentId;
  return list[0] ? list[0].id : null;
}

async function stLoadData() {
  const sessionData = await apiCall('getChatSessions');
  const sessions = sessionData.sessions || [];
  setStState('studioSessions', sessions || []);

  const currentId = stResolveSessionId(sessions, stState('currentSessionId', null));
  setStState('currentSessionId', currentId);

  if (currentId) {
    const messageData = await apiCall('getChatMessages', currentId);
    setStState('studioMessages', messageData.messages || []);
  } else {
    setStState('studioMessages', []);
  }

  const status = await apiCall('getSchedulerStatus');
  setStState('schedulerStatus', status);
  await stLoadPlanDetails(status);

  if (stState('stMode', null) === null) {
    setStState('stMode', (status && status.defaultMode) || 'plan');
  }

}

async function stLoadPlanDetails(status) {
  const summaries = (status && status.plans) || [];
  const details = await Promise.all(summaries.map((plan) => apiCall('getSchedulerPlan', plan.planId)));
  setStState('planDetails', Object.fromEntries(details.map((plan) => [plan.planId, plan])));
}

viewLoaders.studio = stLoadData;

// ==================== 渲染 ====================

ViewRender.studio = () => {
  const sessions = stState('studioSessions', []);
  const currentId = stState('currentSessionId', null);
  const messages = stState('studioMessages', []);
  const status = stState('schedulerStatus', { queue: { length: 0, items: [] }, plans: [], defaultMode: 'plan' });
  const mode = stState('stMode', status.defaultMode || 'plan');
  const busy = stState('studioBusy', false);
  const details = stState('planDetails', {});
  const plans = (status.plans || []).map((plan) => details[plan.planId] || plan);

  return `
  <div class="st-workspace">
    <aside class="st-sessions">
      ${stSessionsHtml(sessions, currentId)}
    </aside>

    <main class="st-chat">
      ${stControlBarHtml(mode, status, busy)}
      <div class="st-chat-messages" id="st-chat-messages">
        ${messages.length ? messages.map((m) => stMessageHtml(m)).join('') : stEmptyChatHtml()}
        <div id="st-plan-cards" class="st-plan-cards">${plans.map((p) => stPlanCardHtml(p)).join('')}</div>
      </div>
      ${stDispatchFormHtml(mode)}
      ${stInputAreaHtml(busy)}
    </main>

    <aside class="st-sidebar">
      <div class="st-side-section">
        <div class="st-side-title">${icon('activity', 'w-3.5 h-3.5')} 执行状态</div>
        <div class="st-stage-list" id="st-stage-list">${stStagesHtml()}</div>
      </div>
      <div class="st-side-section">
        <div class="st-side-title">${icon('git-commit', 'w-3.5 h-3.5')} 世界图变更摘要</div>
        <div class="st-change-list">${stChangesHtml()}</div>
      </div>
      <div class="st-side-section">
        <div class="st-side-title">${icon('file-text', 'w-3.5 h-3.5')} 生成章节</div>
        ${stChapterCardHtml()}
      </div>
    </aside>
  </div>`;
};

ViewAfterRender.studio = () => {
  stScrollChatToBottom();
  refreshIcons();
  if (!ApiRuntime.isMock) stStartRealRuntime();
};

function stStartRealRuntime() {
  stEnsureChatSubscription();
  if (stSchedulerTimer) return;
  const generation = stRuntimeGeneration;
  const poll = async () => {
    try {
      const status = await apiCall('getSchedulerStatus');
      if (generation !== stRuntimeGeneration) return;
      setStState('schedulerStatus', status);
      await stLoadPlanDetails(status);
      if (generation !== stRuntimeGeneration) return;
      stRenderPlanCards();
      stRenderStages();
      stRenderQueueStatus();
    } catch (error) {
      if (generation === stRuntimeGeneration) handleApiError(error);
    }
  };
  stSchedulerTimer = setInterval(poll, 2000);
}

function stEnsureChatSubscription() {
  if (ApiRuntime.isMock || stChatClose) return;
  stChatClose = ApiRuntime.subscribeChat(stHandleChatEvent, (error) => handleApiError(error));
}

function stCloseRealRuntime() {
  stRuntimeGeneration += 1;
  if (stChatClose) stChatClose();
  if (stSchedulerTimer) clearInterval(stSchedulerTimer);
  stChatClose = null;
  stSchedulerTimer = null;
}

function cleanupStudioView() {
  stCloseRealRuntime();
  stAbortLiveSimulation();
  setStState('studioBusy', false);
  setStState('realLiveMessage', null);
}

// ==================== 左栏：会话列表 ====================

function stSessionsHtml(sessions, currentId, nowIso) {
  const sorted = (sessions || []).slice().sort((a, b) => String(b.modified || b.created || '').localeCompare(String(a.modified || a.created || '')));
  const groups = DemoUtils.groupSessionsByTime(sorted, nowIso);
  const groupDefs = [
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: 'earlier', label: '更早' }
  ];
  const items = groupDefs.map((g) => {
    const list = groups[g.key] || [];
    if (!list.length) return '';
    return `
    <div class="st-session-group">
      <div class="st-session-group-title">${escapeHtml(g.label)}</div>
      ${list.map((s) => stSessionItemHtml(s, s.id === currentId)).join('')}
    </div>`;
  }).join('');

  return `
  <div class="st-sessions-head">
    <h2 class="st-sessions-title">会话</h2>
    <button type="button" class="st-new-session" onclick="stNewSession()">${icon('plus', 'w-3.5 h-3.5')} 新建议程</button>
  </div>
  <div class="st-sessions-list">${items || '<div class="st-sessions-empty">暂无会话</div>'}</div>`;
}

function stSessionItemHtml(s, active) {
  return `
  <div class="st-session-item${active ? ' active' : ''}" onclick="stSwitchSession(${q(s.id)})">
    <span class="st-session-icon">${icon('message-square', 'w-3.5 h-3.5')}</span>
    <div class="st-session-main">
      <div class="st-session-name">${escapeHtml(s.name)}${s.live ? '<span class="st-live-dot"></span>' : ''}</div>
      <div class="st-session-first">${escapeHtml(s.firstMessage || '')}</div>
    </div>
    <span class="st-session-time">${escapeHtml(stSessionTime(s.modified || s.created))}</span>
  </div>`;
}

function stSessionTime(iso, now) {
  if (!iso) return '';
  const n = now instanceof Date ? now : new Date();
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = n.getTime() - d.getTime();
  if (diff >= 0 && diff < 60 * 1000) return '刚刚';
  if (diff >= 0 && diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + '分钟前';
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayOf = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (dayOf(d) === dayOf(n)) return hm;
  const yesterday = new Date(n);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayOf(d) === dayOf(yesterday)) return '昨天 ' + hm;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function stMsgTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stTextHtml(text) {
  return escapeHtml(text == null ? '' : String(text)).replace(/\n/g, '<br>');
}

// ==================== 中栏：控制条 / 消息 / 输入区 ====================

function stControlBarHtml(mode, status, busy) {
  const queueLen = status.queue && status.queue.length ? status.queue.length : 0;
  const planCount = (status.plans || []).length;
  const statusText = busy ? '编排中…' : planCount > 0 ? `等待确认 · ${planCount} 个计划待审核` : queueLen > 0 ? `${queueLen} 个任务执行中` : '空闲';
  const dotClass = busy ? 'running' : planCount > 0 ? 'waiting' : queueLen > 0 ? 'running' : 'idle';
  return `
  <div class="st-control-bar" id="st-control-bar">
    <div class="st-mode-toggle" id="st-mode-toggle">${stModeToggleHtml(mode)}</div>
    <div class="st-queue-status">
      <span class="st-queue-dot st-queue-${dotClass}"></span>
      <span class="st-queue-text" id="st-queue-text">${escapeHtml(statusText)}</span>
    </div>
    <div class="st-control-spacer"></div>
    <button type="button" class="st-btn-open-dispatch" onclick="stOpenDispatchForm()">${icon('send', 'w-3.5 h-3.5')} 发起编排</button>
  </div>`;
}

function stModeToggleHtml(mode) {
  return `
    <button type="button" class="st-mode-btn${mode === 'plan' ? ' active' : ''}" onclick="stSetMode('plan')">plan</button>
    <button type="button" class="st-mode-btn${mode === 'yolo' ? ' active' : ''}" onclick="stSetMode('yolo')">yolo</button>`;
}

function stEmptyChatHtml() {
  return `
  <div class="st-chat-empty">
    <div class="st-chat-empty-icon">${icon('message-square', 'w-6 h-6')}</div>
    <div class="st-chat-empty-text">开始你的第一段剧情</div>
    <div class="st-chat-empty-hint">输入消息与 AI 协作编排，输入 @ 可提及世界图实体</div>
  </div>`;
}

function stMessageHtml(m) {
  const ts = stMsgTime(m.ts);
  if (m.role === 'system') {
    return `<div class="st-msg-system">${icon('sparkles', 'w-3.5 h-3.5')} ${escapeHtml(m.text)}</div>`;
  }
  if (m.role === 'user') {
    return `
    <div class="st-msg st-msg-user">
      <div class="st-msg-bubble st-bubble-user">${stTextHtml(m.text)}</div>
      <span class="st-msg-time">${ts}</span>
    </div>`;
  }
  // assistant
  const toolCalls = (m.toolCalls || []).map((tc) => stToolCardHtml(tc)).join('');
  return `
  <div class="st-msg st-msg-ai">
    <div class="st-msg-avatar st-avatar-ai">AI</div>
    <div class="st-msg-body">
      <div class="st-msg-meta">
        <span class="st-msg-name">AI 助手</span>
        <span class="st-msg-time">${ts}</span>
      </div>
      <div class="st-msg-bubble st-bubble-ai">${stTextHtml(m.text)}</div>
      ${toolCalls ? `<div class="st-tool-list">${toolCalls}</div>` : ''}
    </div>
  </div>`;
}

function stToolCardHtml(tc) {
  const status = tc.status || 'done';
  const statusLabel = { running: '执行中', done: '完成', error: '失败' }[status] || status;
  return `
  <div class="st-tool-card st-tool-${status}" data-tool-call-id="${escapeHtml(tc.id || '')}">
    <div class="st-tool-header">
      <span class="st-tool-name">${escapeHtml(tc.name || '工具')}</span>
      <span class="st-tool-status">${statusLabel}</span>
    </div>
  </div>`;
}

// ==================== Plan 卡片 ====================

function stPlanCardHtml(p) {
  const collapsed = stState('planCollapsed', {}) || {};
  const stageDone = (p.stages || []).filter((s) => s.status === 'done').length;
  const stageTotal = (p.stages || []).length;
  const castNames = Object.fromEntries((p.cast || []).map((item) => [item.characterId, item.name]));
  const chips = (p.characterIds || []).map((id) => `<span class="st-plan-chip">${escapeHtml(castNames[id] || id)}</span>`).join('');
  const outputHtml = (p.outputs || []).map((output, index) => {
    const key = p.planId + ':output-' + index;
    const isCollapsed = !!collapsed[key];
    return `
    <div class="st-plan-section${isCollapsed ? ' collapsed' : ''}" data-sec-key="${escapeHtml(key)}">
      <div class="st-plan-section-head" onclick="stTogglePlanSection(${q(p.planId)},'output-${index}')">
        <span class="st-plan-section-icon">${icon('user-round', 'w-4 h-4')}</span>
        <span class="st-plan-section-title">${escapeHtml(output.actor || '角色产出')}</span>
        <span class="st-plan-section-chevron">${icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'w-4 h-4')}</span>
      </div>
      ${isCollapsed ? '' : stPlanOutputBody(output)}
    </div>`;
  }).join('');

  return `
  <div class="st-plan-card" data-plan-id="${escapeHtml(p.planId)}">
    <div class="st-plan-head">
      <div class="st-plan-icon">${icon('list-todo', 'w-4 h-4')}</div>
      <div class="st-plan-title-wrap">
        <div class="st-plan-title">编排计划 <span class="st-plan-id">${escapeHtml(p.planId)}</span></div>
        <div class="st-plan-meta">${escapeHtml(p.storyTime || '—')} · ${escapeHtml(p.mode || 'plan')} 模式${stageTotal ? ` · ${stageDone}/${stageTotal} 阶段完成` : ''}</div>
      </div>
      <span class="st-plan-badge">待审核</span>
    </div>
    <div class="st-plan-body">${outputHtml || '<div class="st-plan-bullet-empty">暂无角色产出</div>'}</div>
    <div class="st-plan-foot">
      <div class="st-plan-chips">${chips}</div>
      <div class="st-plan-actions">
        <button type="button" class="st-btn st-btn-ghost" onclick="stDiscardPlan(${q(p.planId)})">丢弃</button>
        <button type="button" class="st-btn st-btn-primary" onclick="stCommitPlan(${q(p.planId)})">提交</button>
      </div>
    </div>
  </div>`;
}

function stPlanOutputBody(output) {
  const rows = [
    ['行动', output.action], ['想法', output.thought], ['情绪', output.emotion],
    ['状态变化', output.state_changes], ['获得信息', output.knowledge_gained]
  ];
  return `
  <ul class="st-plan-bullets">
    ${rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => `<li><strong>${escapeHtml(label)}：</strong>${escapeHtml(Array.isArray(value) ? value.join('、') : String(value))}</li>`).join('') || '<li class="st-plan-bullet-empty">暂无内容</li>'}
  </ul>`;
}

// ==================== 派发面板 ====================

function stDispatchFormHtml(mode) {
  return `
  <div class="st-dispatch-form" id="st-dispatch-form" style="display:none">
    <div class="st-dispatch-head">
      <span class="st-dispatch-title">发起编排</span>
      <button type="button" class="st-icon-btn" title="收起" onclick="stCloseDispatchForm()">${icon('x', 'w-4 h-4')}</button>
    </div>
    <div class="st-dispatch-body">
      <div class="st-dispatch-mode-btns" id="st-dispatch-mode-btns">${stDispatchModeBtnsHtml(mode)}</div>
      <textarea id="st-dispatch-instruction" class="st-dispatch-input" rows="2" placeholder="指令：接下来让 @艾莉亚 在第七星港…" spellcheck="false">继续推进剧情：让艾莉亚在第七星港触发身世线索</textarea>
      <div class="st-dispatch-mention-tags" id="st-dispatch-tags"></div>
      <div class="st-dispatch-controls">
        <div class="st-dispatch-mention">
          <span class="st-mention-label">@ 提及</span>
          <div class="st-mention-relative">
            <input id="st-dispatch-mention" class="st-mention-input" placeholder="输入 @ 提及角色 / 地点 / 物品…" autocomplete="off" spellcheck="false" oninput="stDispatchMentionInput(this.value)" onkeydown="stMentionKeydown(event,'dispatch')">
            <div class="st-mention-panel" id="st-dispatch-mention-panel"></div>
          </div>
        </div>
        <div class="st-dispatch-row">
          <label class="st-st-label">StoryTime
            <input id="st-dispatch-st" class="st-st-input" value="${escapeHtml(App.storyTime || 'ch006.ev008')}" spellcheck="false">
          </label>
          <button type="button" class="st-btn st-btn-primary" onclick="stSubmitDispatch()">${icon('send', 'w-3.5 h-3.5')} 派发</button>
        </div>
      </div>
    </div>
  </div>`;
}

function stDispatchModeBtnsHtml(mode) {
  return `
    <button type="button" class="st-dispatch-mode-btn${mode === 'plan' ? ' active' : ''}" onclick="stSetMode('plan')">${icon('list-todo', 'w-3.5 h-3.5')} plan 计划模式</button>
    <button type="button" class="st-dispatch-mode-btn${mode === 'yolo' ? ' active' : ''}" onclick="stSetMode('yolo')">${icon('zap', 'w-3.5 h-3.5')} yolo 直出模式</button>`;
}

function stRenderDispatchTags() {
  const el = $('#st-dispatch-tags');
  if (!el) return;
  const mentions = stState('dispatchMentions', []);
  el.innerHTML = mentions.map((m) => `
    <span class="st-mention-tag">
      <span class="st-mention-tag-name">@${escapeHtml(m.name)}</span>
      <button type="button" class="st-mention-tag-x" title="移除" onclick="stRemoveMention(${q(m.id)})">${icon('x', 'w-3 h-3')}</button>
    </span>`).join('');
  refreshIcons();
}

// ==================== 聊天输入区 ====================

function stInputAreaHtml(busy) {
  return `
  <div class="st-input-area">
    <div class="st-input-toolbar">
      <button type="button" class="st-tool-btn" title="附件" onclick="stToolAction('attach')">${icon('paperclip', 'w-3.5 h-3.5')}</button>
      <button type="button" class="st-tool-btn" title="加粗" onclick="stToolAction('bold')">${icon('bold', 'w-3.5 h-3.5')}</button>
      <button type="button" class="st-tool-btn" title="斜体" onclick="stToolAction('italic')">${icon('italic', 'w-3.5 h-3.5')}</button>
      <button type="button" class="st-tool-btn" title="列表" onclick="stToolAction('list')">${icon('list', 'w-3.5 h-3.5')}</button>
      <div class="st-tool-spacer"></div>
      <span class="st-input-hint">Enter 发送 · Shift+Enter 换行 · @ 提及实体</span>
    </div>
    <div class="st-input-main">
      <div class="st-input-relative">
        <textarea id="st-chat-textarea" class="st-chat-textarea" rows="2" placeholder="输入消息，输入 @ 提及实体…" oninput="stChatInput(this.value)" onkeydown="stChatKeydown(event)" spellcheck="false"></textarea>
        <div class="st-mention-panel" id="st-chat-mention-panel"></div>
      </div>
      <button type="button" class="st-send-btn" onclick="stSendChat()" ${busy ? 'disabled' : ''}>${icon('send', 'w-4 h-4')}</button>
    </div>
  </div>`;
}

// ==================== 右栏：执行状态 / 变更 / 章节 ====================

function stStagesHtml() {
  const details = stState('planDetails', {});
  const firstPlan = Object.values(details)[0];
  const stages = firstPlan ? (firstPlan.stages || []) : [];
  return stages.length ? stages.map((s) => stStageItemHtml(s)).join('') : '<div class="st-plan-bullet-empty">暂无计划阶段</div>';
}

function stStageItemHtml(s) {
  const def = ST_STAGE_DEFS.find((item) => item.stage === s.stage) || {};
  const status = s.status || 'error';
  const label = ST_STAGE_STATUS_LABEL[status] || status;
  const duration = Number.isFinite(s.durationMs) ? `${s.durationMs}ms` : '';
  return `
  <div class="st-stage-item st-stage-${status}" data-stage="${escapeHtml(s.stage)}">
    <span class="st-stage-icon">${icon(def.icon || 'circle', 'w-4 h-4')}</span>
    <div class="st-stage-main">
      <div class="st-stage-name">${escapeHtml(def.name || s.stage)}<span class="st-stage-agent">${escapeHtml(s.agent || '')}</span></div>
      <div class="st-stage-bar"><span class="st-stage-fill" style="width:100%"></span></div>
      ${s.error ? `<div class="st-tool-result-error">${escapeHtml(s.error)}</div>` : ''}
    </div>
    <div class="st-stage-right">
      <span class="st-stage-status">${label}</span>
      <span class="st-stage-duration">${escapeHtml(duration)}</span>
    </div>
  </div>`;
}

function stChangesHtml() {
  const result = stState('commitResult', null);
  if (!result) return '<div class="st-plan-bullet-empty">提交计划后显示变更摘要</div>';
  return (result.appliedEventIds || []).map((eventId) => `
    <div class="st-change-item">
      <span class="st-change-icon st-change-event">${icon('sparkles', 'w-3.5 h-3.5')}</span>
      <span class="st-change-text">已应用事件：${escapeHtml(eventId)}</span>
    </div>`).join('') || '<div class="st-plan-bullet-empty">未应用世界图事件</div>';
}

function stChapterCardHtml() {
  const result = stState('commitResult', null);
  if (!result || !result.chapterPath) return '<div class="st-plan-bullet-empty">提交计划后显示生成章节</div>';
  const title = String(result.chapterPath).split('/').pop() || result.chapterPath;
  const chars = String(result.writtenText || '').replace(/\s/g, '').length;
  return `
  <div class="st-chapter-card">
    <div class="st-chapter-info">
      <div class="st-chapter-title">${escapeHtml(title)}</div>
      <div class="st-chapter-meta">${chars} 字 · ${escapeHtml(result.chapterPath)}</div>
    </div>
    <button type="button" class="st-icon-btn" title="查看章节" onclick="navigate('#/files')">${icon('arrow-right', 'w-4 h-4')}</button>
  </div>`;
}

// ==================== @ 提及面板 ====================

function stMentionOptions() {
  return stState('mentionOptions', []);
}

function stMentionFiltered(filter) {
  return stMentionOptions();
}

function stMentionPanelHtml(filter, selected) {
  const items = stMentionFiltered(filter);
  if (!items.length) return '<div class="st-mention-empty">没有匹配的实体</div>';
  return items.map((o, i) => `
    <div class="st-mention-item${i === selected ? ' active' : ''}" onclick="stSelectMention(${q(o.id)},${q(stState('mentionSource', 'chat'))})" onmouseenter="stMentionHover(${i})">
      <span class="st-mention-avatar">${escapeHtml(o.letter)}</span>
      <div class="st-mention-info">
        <div class="st-mention-name">${escapeHtml(o.name)}<span class="st-mention-type st-mt-${escapeHtml(o.type)}">${escapeHtml(o.typeLabel)}</span></div>
        <div class="st-mention-desc">${escapeHtml(o.desc)}</div>
      </div>
    </div>`).join('');
}

function stMentionPanelOpen(source) {
  const el = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  return !!(el && el.style.display !== 'none');
}

async function stShowMentionPanel(source, filter) {
  const requestId = (stState('mentionRequestId', 0) || 0) + 1;
  setStState('mentionRequestId', requestId);
  setStState('mentionSource', source);
  setStState('mentionSel', 0);
  const el = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  if (!el) return;
  el.innerHTML = '<div class="st-mention-empty">搜索中…</div>';
  el.style.display = 'block';
  try {
    const data = await apiCall('search', filter, App.storyTime);
    if (requestId !== stState('mentionRequestId', 0)) return;
    const labels = { character: '角色', location: '地点', item: '物品', concept: '概念' };
    setStState('mentionOptions', (data.results || []).filter((item) => item.type === 'entity').map((item) => ({
      id: item.id, name: item.name || item.id, type: item.entityType, typeLabel: labels[item.entityType] || item.entityType || '',
      desc: item.summary || '', letter: String(item.name || item.id).charAt(0)
    })));
  } catch (error) {
    setStState('mentionOptions', []);
    handleApiError(error);
  }
  el.innerHTML = stMentionPanelHtml(filter, 0);
}

function stCloseMentionPanel(source) {
  const el = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  if (el) el.style.display = 'none';
}

function stMentionHover(idx) {
  setStState('mentionSel', idx);
  const source = stState('mentionSource', 'chat');
  const panel = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  if (panel) {
    const items = panel.querySelectorAll('.st-mention-item');
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
  }
}

function stMentionMove(dir) {
  const filter = stState('mentionFilter', '');
  const count = stMentionFiltered(filter).length;
  if (!count) return;
  let sel = (stState('mentionSel', 0) + dir + count) % count;
  setStState('mentionSel', sel);
  const source = stState('mentionSource', 'chat');
  const panel = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  if (panel) {
    const items = panel.querySelectorAll('.st-mention-item');
    items.forEach((el, i) => el.classList.toggle('active', i === sel));
    const activeEl = items[sel];
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

function stMentionPickActive(source) {
  const filter = stState('mentionFilter', '');
  const items = stMentionFiltered(filter);
  const sel = stState('mentionSel', 0);
  const opt = items[sel];
  if (opt) stSelectMention(opt.id, source);
  else stCloseMentionPanel(source);
}

function stMentionKeydown(event, source) {
  setStState('mentionSource', source);
  if (!stMentionPanelOpen(source)) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); stMentionMove(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); stMentionMove(-1); }
  else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); stMentionPickActive(source); }
  else if (event.key === 'Escape') { event.preventDefault(); stCloseMentionPanel(source); }
}

function stSelectMention(id, source) {
  const opt = stMentionOptions().find((o) => o.id === id);
  if (!opt) return;
  if (source === 'dispatch') {
    const mentions = stState('dispatchMentions', []).slice();
    if (!mentions.some((m) => m.id === id)) mentions.push(opt);
    setStState('dispatchMentions', mentions);
    stRenderDispatchTags();
    const input = $('#st-dispatch-mention');
    if (input) { input.value = ''; input.focus(); }
  } else {
    const ta = $('#st-chat-textarea');
    if (ta) stInsertMentionText(ta, opt.name);
  }
  stCloseMentionPanel(source);
}

function stRemoveMention(id) {
  const mentions = stState('dispatchMentions', []).filter((m) => m.id !== id);
  setStState('dispatchMentions', mentions);
  stRenderDispatchTags();
}

function stInsertMentionText(ta, name) {
  const v = ta.value;
  const atIdx = v.lastIndexOf('@');
  const insert = '@' + name + ' ';
  if (atIdx >= 0 && (atIdx === v.length - 1 || !/\s/.test(v.slice(atIdx + 1)))) {
    ta.value = v.slice(0, atIdx) + insert;
  } else {
    ta.value = v + insert;
  }
  const pos = ta.value.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
}

function stChatInput(value) {
  const atIdx = value.lastIndexOf('@');
  if (atIdx >= 0) {
    const after = value.slice(atIdx + 1);
    if (!/\s/.test(after)) {
      setStState('mentionFilter', after);
      stShowMentionPanel('chat', after);
      return;
    }
  }
  stCloseMentionPanel('chat');
}

function stChatKeydown(event) {
  if (stMentionPanelOpen('chat')) {
    stMentionKeydown(event, 'chat');
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    stSendChat();
  }
}

function stDispatchMentionInput(value) {
  const atIdx = value.lastIndexOf('@');
  if (atIdx >= 0) {
    const after = value.slice(atIdx + 1);
    if (!/\s/.test(after)) {
      setStState('mentionFilter', after);
      stShowMentionPanel('dispatch', after);
      return;
    }
  }
  stCloseMentionPanel('dispatch');
}

// ==================== 会话交互 ====================

async function stSwitchSession(id) {
  stAbortLiveSimulation();
  setStState('currentSessionId', id);
  if (ApiRuntime.isMock) setStState('studioBusy', false);
  try {
    const data = await apiCall('getChatMessages', id);
    setStState('studioMessages', data.messages || []);
  } catch (e) {
    setStState('studioMessages', []);
    handleApiError(e);
  }
  renderView();
}

function stNewSession() {
  if (stState('studioBusy', false)) return;
  const id = 'session-' + Date.now();
  const now = new Date().toISOString();
  const session = { id, name: '新会话', created: now, modified: now, messageCount: 0, firstMessage: '' };
  setStState('studioSessions', [session].concat(stState('studioSessions', [])));
  setStState('currentSessionId', id);
  setStState('studioMessages', []);
  renderView();
}

// ==================== 发送与编排模拟 ====================

async function stSendChat() {
  const ta = $('#st-chat-textarea');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text || stState('studioBusy', false)) return;
  ta.value = '';
  stCloseMentionPanel('chat');
  const msg = { role: 'user', text, ts: new Date().toISOString() };
  setStState('studioMessages', stState('studioMessages', []).concat([msg]));
  stAppendMessageEl(stMessageHtml(msg));
  if (ApiRuntime.isMock) {
    try {
      await apiCall('sendChatMessage', text);
    } catch (e) {
      handleApiError(e);
    }
    stRunOrchestration(text);
    return;
  }

  stEnsureChatSubscription();
  setStState('studioBusy', true);
  setStState('realLiveMessage', null);
  stRenderQueueStatus();
  try {
    await apiCall('sendChatMessage', text);
  } catch (e) {
    setStState('studioBusy', false);
    stRenderQueueStatus();
    handleApiError(e);
  }
}

function stHandleChatEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'message_start' && event.message && event.message.role === 'assistant') {
    const previous = stState('realLiveMessage', null);
    if (previous) {
      setStState('studioMessages', stState('studioMessages', []).concat(previous));
      const liveEl = $('#st-live-msg');
      if (liveEl) liveEl.outerHTML = stMessageHtml(previous);
    }
    setStState('realLiveMessage', null);
  } else if (event.type === 'message_update' && event.message) {
    stApplyMessageSnapshot(event.message);
  } else if (event.type === 'tool_execution_start') {
    stApplyToolEvent(event, 'running');
  } else if (event.type === 'tool_execution_update') {
    stApplyToolEvent(event, 'running');
  } else if (event.type === 'tool_execution_end') {
    stApplyToolEvent(event, event.isError ? 'error' : 'done');
  } else if (event.type === 'agent_end') {
    setStState('studioBusy', false);
    stRenderQueueStatus();
    void stRefreshChatHistory();
  }
}

function stApplyMessageSnapshot(message) {
  if (message.role !== 'assistant') return;
  const current = stState('realLiveMessage', null);
  const existingTools = Object.fromEntries(((current && current.toolCalls) || []).map((tool) => [tool.id, tool]));
  const content = Array.isArray(message.content) ? message.content : [];
  const toolCalls = content.filter((block) => block && block.type === 'toolCall').map((block) => ({
    ...existingTools[block.id],
    id: block.id,
    name: block.name,
    args: block.arguments,
    status: (existingTools[block.id] && existingTools[block.id].status) || 'running'
  }));
  for (const tool of Object.values(existingTools)) {
    if (!toolCalls.some((item) => item.id === tool.id)) toolCalls.push(tool);
  }
  const live = {
    role: 'assistant',
    text: content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join(''),
    ts: message.timestamp || (current && current.ts) || Date.now(),
    toolCalls
  };
  setStState('realLiveMessage', live);
  stRenderRealLiveMessage(live);
}

function stApplyToolEvent(event, status) {
  if (!event.toolCallId) return;
  const live = stState('realLiveMessage', null) || { role: 'assistant', text: '', ts: Date.now(), toolCalls: [] };
  const tools = (live.toolCalls || []).slice();
  const index = tools.findIndex((tool) => tool.id === event.toolCallId);
  const previous = index >= 0 ? tools[index] : {};
  const tool = {
    ...previous,
    id: event.toolCallId,
    name: event.toolName || previous.name,
    args: event.args === undefined ? previous.args : event.args,
    status
  };
  if (event.partialResult !== undefined) tool.partialResult = event.partialResult;
  if (event.result !== undefined) tool.result = event.result;
  if (index >= 0) tools[index] = tool;
  else tools.push(tool);
  live.toolCalls = tools;
  setStState('realLiveMessage', live);
  stRenderRealLiveMessage(live);
}

function stRenderRealLiveMessage(live) {
  const existing = $('#st-live-msg');
  const html = stLiveMessageHtml(live);
  if (existing) existing.outerHTML = html;
  else {
    const plans = $('#st-plan-cards');
    if (plans) plans.insertAdjacentHTML('beforebegin', html);
  }
  refreshIcons();
  stScrollChatToBottom();
}

function stLiveMessageHtml(live) {
  return `
  <div class="st-msg st-msg-ai" id="st-live-msg">
    <div class="st-msg-avatar st-avatar-ai">AI</div>
    <div class="st-msg-body">
      <div class="st-msg-meta"><span class="st-msg-name">AI 助手</span><span class="st-msg-time">${stMsgTime(live.ts)}</span></div>
      <div class="st-msg-bubble st-bubble-ai">${stTextHtml(live.text)}</div>
      ${(live.toolCalls || []).length ? `<div class="st-tool-list">${live.toolCalls.map((tool) => stToolCardHtml(tool)).join('')}</div>` : ''}
    </div>
  </div>`;
}

async function stRefreshChatHistory() {
  try {
    const sessionData = await apiCall('getChatSessions');
    const sessions = sessionData.sessions || [];
    setStState('studioSessions', sessions);
    const currentId = stResolveSessionId(sessions, stState('currentSessionId', null));
    setStState('currentSessionId', currentId);
    if (currentId) {
      const messageData = await apiCall('getChatMessages', currentId);
      setStState('studioMessages', messageData.messages || []);
    }
    setStState('realLiveMessage', null);
    if (routeId() === 'studio') await renderView();
  } catch (error) {
    handleApiError(error);
  }
}

/** 确定性聊天脚本；plan 阶段不在客户端模拟。 */
function stOrchestrationScript() {
  return [
    { action: 'tool', tool: { id: 'live-tool-search', name: '检索世界图', status: 'done', isError: false } },
    { action: 'tool', tool: { id: 'live-tool-dispatch', name: '调用编排器', status: 'done', isError: false } },
    { action: 'system', text: 'AI 触发编排 · 多代理协作中' },
    { action: 'stream', text: '已生成编排计划，等待你的确认。' },
    { action: 'finish' }
  ];
}

function stRunOrchestration(instruction) {
  setStState('studioBusy', true);
  setStState('orch', { items: stOrchestrationScript(), idx: 0, live: null, instruction: instruction || '' });
  stRenderQueueStatus();
  stScheduleOrchStep();
}

function stScheduleOrchStep() {
  const orch = stState('orch', null);
  if (!orch || orch.idx >= orch.items.length) return;
  if (orch.timer) clearTimeout(orch.timer);
  orch.timer = setTimeout(stOrchStep, ST_SIM_TICK_MS);
  setStState('orch', orch);
}

/** 编排脚本单步（确定性）：测试可直接循环调用直至 idx 耗尽 */
function stOrchStep() {
  const orch = stState('orch', null);
  if (!orch || orch.idx >= orch.items.length) return;
  const ev = orch.items[orch.idx];
  orch.idx += 1;
  setStState('orch', orch);
  stApplyOrchEvent(ev, orch);
  stScheduleOrchStep();
}

function stApplyOrchEvent(ev, orch) {
  if (ev.action === 'tool') {
    if (!orch.live) orch.live = { role: 'assistant', text: '', ts: new Date().toISOString(), toolCalls: [] };
    orch.live.toolCalls.push(ev.tool);
    stEnsureLiveMessage(orch.live);
    const toolsEl = $('#st-live-tools');
    if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', stToolCardHtml(ev.tool));
    refreshIcons();
    stScrollChatToBottom();
  } else if (ev.action === 'system') {
    const m = { role: 'system', text: ev.text, ts: new Date().toISOString() };
    setStState('studioMessages', stState('studioMessages', []).concat([m]));
    stAppendMessageEl(stMessageHtml(m));
  } else if (ev.action === 'stream') {
    if (!orch.live) orch.live = { role: 'assistant', text: '', ts: new Date().toISOString(), toolCalls: [] };
    orch.live.text = ev.text;
    stEnsureLiveMessage(orch.live);
    stStartStreaming(ev.text);
  } else if (ev.action === 'finish') {
    stFinalizeOrchestration(orch);
  }
}

function stEnsureLiveMessage(live) {
  if ($('#st-live-msg')) return;
  const container = $('#st-plan-cards');
  const html = `
  <div class="st-msg st-msg-ai" id="st-live-msg">
    <div class="st-msg-avatar st-avatar-ai">AI</div>
    <div class="st-msg-body">
      <div class="st-msg-meta">
        <span class="st-msg-name">AI 助手</span>
        <span class="st-msg-time">${stMsgTime(live.ts)}</span>
      </div>
      <div class="st-msg-bubble st-bubble-ai"><span class="st-stream-text" id="st-stream-text"></span><span class="st-stream-caret" id="st-stream-caret"></span></div>
      <div class="st-tool-list" id="st-live-tools"></div>
    </div>
  </div>`;
  if (container) container.insertAdjacentHTML('beforebegin', html);
  else {
    const msgsEl = $('#st-chat-messages');
    if (msgsEl) msgsEl.insertAdjacentHTML('beforeend', html);
  }
  refreshIcons();
  stScrollChatToBottom();
}

function stFinalizeOrchestration(orch) {
  // 流式若未完成（如测试直接单步推进到 finish），一次性补全文本
  const stream = stState('stream', null);
  if (stream && !stream.done) {
    const el = $('#st-stream-text');
    if (el) el.textContent = stream.text;
    const caret = $('#st-stream-caret');
    if (caret) caret.style.display = 'none';
    stream.pos = stream.text.length;
    stream.done = true;
    if (stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
    setStState('stream', stream);
  }
  if (orch.live) {
    const msgs = stState('studioMessages', []).concat([{ ...orch.live }]);
    setStState('studioMessages', msgs);
  }
  orch.live = null;
  if (orch.timer) { clearTimeout(orch.timer); orch.timer = null; }
  setStState('orch', orch);
  setStState('studioBusy', false);
  stRenderQueueStatus();
  stDispatchAfterOrchestration(orch.instruction);
}

/** 编排收尾后的派发闭环：plan 模式进入待审计划，yolo 模式直接入队执行 */
async function stDispatchAfterOrchestration(instruction) {
  const mode = stState('stMode', 'plan');
  try {
    await apiCall('dispatch', {
      instruction: instruction || '继续推进剧情',
      characterIds: [],
      storyTime: App.storyTime,
      mode
    });
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    await stLoadPlanDetails(status);
    stRenderPlanCards();
    stRenderStages();
    stRenderQueueStatus();
  } catch (e) {
    handleApiError(e);
  }
}

function stAbortLiveSimulation() {
  const orch = stState('orch', null);
  if (orch) {
    if (orch.timer) clearTimeout(orch.timer);
    orch.timer = null;
    setStState('orch', orch);
  }
  const stream = stState('stream', null);
  if (stream) {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    setStState('stream', stream);
  }
}

// ==================== 流式输出（确定性） ====================

function stStartStreaming(text) {
  setStState('stream', { text: String(text || ''), pos: 0, done: false, timer: null });
  stStreamStep();
}

/** 流式单步：每次追加固定字符数（ST_STREAM_CHUNK），done 后隐藏光标并落盘消息 */
function stStreamStep() {
  const st = stState('stream', null);
  if (!st || st.done) return;
  const el = $('#st-stream-text');
  if (!el) {
    st.done = true;
    setStState('stream', st);
    return;
  }
  st.pos = Math.min(st.text.length, st.pos + ST_STREAM_CHUNK);
  el.textContent = st.text.slice(0, st.pos);
  stScrollChatToBottom();
  if (st.pos >= st.text.length) {
    st.done = true;
    const caret = $('#st-stream-caret');
    if (caret) caret.style.display = 'none';
  } else {
    st.timer = setTimeout(stStreamStep, ST_STREAM_TICK_MS);
  }
  setStState('stream', st);
}

// ==================== 模式 / 派发 / 计划操作 ====================

async function stSetMode(mode) {
  if (mode !== 'plan' && mode !== 'yolo') return;
  setStState('stMode', mode);
  try {
    await apiCall('setSchedulerMode', mode);
  } catch (e) {
    handleApiError(e);
  }
  stRenderModeControls();
  stRenderQueueStatus();
}

function stOpenDispatchForm() {
  const el = $('#st-dispatch-form');
  if (el) el.style.display = 'block';
}

function stCloseDispatchForm() {
  const el = $('#st-dispatch-form');
  if (el) el.style.display = 'none';
}

async function stSubmitDispatch() {
  const instructionEl = $('#st-dispatch-instruction');
  const stEl = $('#st-dispatch-st');
  const instruction = instructionEl ? instructionEl.value : '';
  const storyTime = stEl ? stEl.value : App.storyTime;
  const characterIds = stState('dispatchMentions', []).map((m) => m.id);
  await withLoading(async () => {
    await apiCall('dispatch', { instruction, characterIds, storyTime, mode: stState('stMode', 'plan') });
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    await stLoadPlanDetails(status);
    setStState('dispatchMentions', []);
    stRenderPlanCards();
    stRenderQueueStatus();
    stCloseDispatchForm();
    toast('编排已派发', 'success');
  });
}

async function stCommitPlan(planId) {
  await withLoading(async () => {
    const res = await apiCall('commitPlan', planId);
    setStState('commitResult', res);
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    await stLoadPlanDetails(status);
    stRenderPlanCards();
    stRenderStages();
    stRenderQueueStatus();
    toast(`计划已提交，生成 ${(res && res.chapterPath) || '章节'}`, 'success');
  });
}

async function stDiscardPlan(planId) {
  await withLoading(async () => {
    await apiCall('discardPlan', planId);
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    await stLoadPlanDetails(status);
    stRenderPlanCards();
    stRenderStages();
    stRenderQueueStatus();
    toast('计划已丢弃', 'info');
  });
}

function stTogglePlanSection(planId, sectionId) {
  const collapsed = Object.assign({}, stState('planCollapsed', {}) || {});
  const key = planId + ':' + sectionId;
  collapsed[key] = !collapsed[key];
  setStState('planCollapsed', collapsed);
  stRenderPlanCards();
}

function stToolAction(name) {
  toast(`「${name}」为演示占位功能`, 'info');
}

// ==================== DOM 工具 ====================

function stScrollChatToBottom() {
  const el = $('#st-chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function stAppendMessageEl(html) {
  const container = $('#st-plan-cards');
  const target = container ? container : $('#st-chat-messages');
  if (!target) return;
  target.insertAdjacentHTML('beforebegin', html);
  refreshIcons();
  stScrollChatToBottom();
}

function stRenderStages() {
  const el = $('#st-stage-list');
  if (el) {
    el.innerHTML = stStagesHtml();
    refreshIcons();
  }
}

function stRenderPlanCards() {
  const el = $('#st-plan-cards');
  if (!el) return;
  const status = stState('schedulerStatus', { queue: { length: 0, items: [] }, plans: [], defaultMode: 'plan' });
  const details = stState('planDetails', {});
  el.innerHTML = (status.plans || []).map((p) => stPlanCardHtml(details[p.planId] || p)).join('');
  refreshIcons();
  stScrollChatToBottom();
}

function stRenderModeControls() {
  const mode = stState('stMode', 'plan');
  const toggle = $('#st-mode-toggle');
  if (toggle) toggle.innerHTML = stModeToggleHtml(mode);
  const dbtns = $('#st-dispatch-mode-btns');
  if (dbtns) dbtns.innerHTML = stDispatchModeBtnsHtml(mode);
  refreshIcons();
}

function stRenderQueueStatus() {
  const el = $('#st-queue-text');
  if (!el) return;
  const status = stState('schedulerStatus', { queue: { length: 0, items: [] }, plans: [], defaultMode: 'plan' });
  const busy = stState('studioBusy', false);
  const queueLen = status.queue && status.queue.length ? status.queue.length : 0;
  const planCount = (status.plans || []).length;
  el.textContent = busy ? '编排中…' : planCount > 0 ? `等待确认 · ${planCount} 个计划待审核` : queueLen > 0 ? `${queueLen} 个任务执行中` : '空闲';
  const dot = $('#st-control-bar') ? $('#st-control-bar').querySelector('.st-queue-dot') : null;
  if (dot) {
    dot.className = 'st-queue-dot st-queue-' + (busy ? 'running' : planCount > 0 ? 'waiting' : queueLen > 0 ? 'running' : 'idle');
  }
}
