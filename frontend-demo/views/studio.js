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
 *   getChatSessions / getChatMessages / getSchedulerStatus / sendChatMessage /
 *   setSchedulerMode / dispatch / commitPlan / discardPlan
 * 复用 demo-utils.js：DemoUtils.groupSessionsByTime
 *
 * 确定性模拟（无真实随机，无外部流）：
 *   - Agent 四阶段状态机：stSimAdvance(stages) 纯函数步进（waiting→running→done），stSimFail 显式失败，
 *     由编排脚本 stOrchestrationScript() + stOrchStep() 以可控 setTimeout 驱动（测试可手动单步推进）
 *   - 流式文本：stStreamStep() 每次追加固定字符数（ST_STREAM_CHUNK），由 stStartStreaming 驱动
 *
 * 注入安全：onclick 内联参数一律单引号 + escapeHtml（禁止裸 JSON.stringify 双引号注入）
 */

// ==================== 常量 ====================

const ST_STAGE_DEFS = [
  { stage: 'planner', name: '规划', agent: '策划代理', icon: 'list' },
  { stage: 'role', name: '角色', agent: '角色代理', icon: 'users' },
  { stage: 'reasoner', name: '推理', agent: '推理代理', icon: 'brain' },
  { stage: 'renderer', name: '渲染', agent: '渲染代理', icon: 'pen-line' }
];

const ST_STAGE_STATUS_LABEL = { waiting: '等待', running: '执行中', done: '完成', failed: '失败' };

// 可控模拟节奏（ms）：浏览器中驱动编排脚本与流式输出；测试可整体调小/手动单步
const ST_SIM_TICK_MS = 620;     // 编排脚本相邻事件间隔
const ST_STREAM_CHUNK = 2;      // 每次流式追加字符数
const ST_STREAM_TICK_MS = 28;   // 流式相邻 tick 间隔

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

async function stLoadData() {
  const sessions = await apiCall('getChatSessions');
  setStState('studioSessions', sessions || []);

  let currentId = stState('currentSessionId', null);
  if (!currentId) {
    const live = (sessions || []).find((s) => s.live);
    currentId = (live && live.id) || ((sessions && sessions[0]) ? sessions[0].id : null);
    setStState('currentSessionId', currentId);
  }

  if (currentId) {
    const msgs = await apiCall('getChatMessages', currentId);
    setStState('studioMessages', msgs || []);
  } else {
    setStState('studioMessages', []);
  }

  const status = await apiCall('getSchedulerStatus');
  setStState('schedulerStatus', status);

  if (stState('stMode', null) === null) {
    setStState('stMode', (status && status.defaultMode) || 'plan');
  }

  // 阶段状态机初始：优先取当前 plan 的 stages 快照（贴合设计稿默认态）
  const plans = (status && status.plans) || [];
  if (!stState('stages', null) && plans.length && plans[0].stages && plans[0].stages.length) {
    setStState('stages', plans[0].stages.map((s) => ({ ...s })));
  }
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
  const plans = (status.plans || []);

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
};

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
  <div class="st-session-item${active ? ' active' : ''}" onclick="stSwitchSession('${escapeHtml(s.id)}')">
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
  if (m.role === 'character') {
    const letter = m.name ? m.name.charAt(0) : '角';
    return `
    <div class="st-msg st-msg-character">
      <div class="st-msg-avatar st-avatar-character">${escapeHtml(letter)}</div>
      <div class="st-msg-body">
        <div class="st-msg-meta">
          <span class="st-msg-name">${escapeHtml(m.name || '角色')}</span>
          <span class="st-msg-roletag">${escapeHtml(m.roleTag || '')}</span>
          <span class="st-msg-time">${ts}</span>
        </div>
        <div class="st-msg-bubble st-bubble-character">${stTextHtml(m.text)}</div>
      </div>
    </div>`;
  }
  // assistant
  const toolCalls = (m.toolCalls || []).map((tc) => stToolCardHtml(tc)).join('');
  return `
  <div class="st-msg st-msg-ai">
    <div class="st-msg-avatar st-avatar-ai">${escapeHtml((m.name || '策划 AI').charAt(0))}</div>
    <div class="st-msg-body">
      <div class="st-msg-meta">
        <span class="st-msg-name">${escapeHtml(m.name || '策划 AI')}</span>
        <span class="st-msg-time">${ts}</span>
      </div>
      <div class="st-msg-bubble st-bubble-ai">${stTextHtml(m.text)}</div>
      ${toolCalls ? `<div class="st-tool-list">${toolCalls}</div>` : ''}
    </div>
  </div>`;
}

function stToolCardHtml(tc) {
  const status = tc.status || 'done';
  const statusLabel = { done: '完成', running: '执行中', failed: '失败' }[status] || status;
  const resultHtml = tc.result
    ? (status === 'failed'
        ? `<div class="st-tool-result st-tool-result-error">${escapeHtml(tc.result)}</div>`
        : `<div class="st-tool-result">${escapeHtml(tc.result)}</div>`)
    : (status === 'running' ? `<div class="st-tool-progress"><span class="st-tool-progress-fill"></span></div>` : '');
  return `
  <div class="st-tool-card st-tool-${status}">
    <div class="st-tool-header">
      <span class="st-tool-icon">${icon(tc.icon || 'wrench', 'w-3.5 h-3.5')}</span>
      <span class="st-tool-name">${escapeHtml(tc.name || '工具')}</span>
      ${status === 'running' ? '<span class="st-tool-spinner"></span>' : ''}
      <span class="st-tool-status">${statusLabel}</span>
      <span class="st-tool-duration">${escapeHtml(tc.duration || '')}</span>
    </div>
    ${resultHtml}
  </div>`;
}

// ==================== Plan 卡片 ====================

function stPlanCardHtml(p) {
  const collapsed = stState('planCollapsed', {}) || {};
  const stageDone = (p.stages || []).filter((s) => s.status === 'done').length;
  const stageTotal = (p.stages || []).length;
  const sections = (p.sections && p.sections.length) ? p.sections : stPlanDefaultSections();
  const chips = (p.characterIds || []).map((id) => `<span class="st-plan-chip">${escapeHtml(stEntityName(id))}</span>`).join('');
  const sectionHtml = sections.map((sec) => {
    const key = p.planId + ':' + sec.id;
    const isCollapsed = !!collapsed[key];
    return `
    <div class="st-plan-section${isCollapsed ? ' collapsed' : ''}" data-sec-key="${escapeHtml(key)}">
      <div class="st-plan-section-head" onclick="stTogglePlanSection('${escapeHtml(p.planId)}','${escapeHtml(sec.id)}')">
        <span class="st-plan-section-icon">${icon(sec.icon || 'list', 'w-4 h-4')}</span>
        <span class="st-plan-section-title">${escapeHtml(sec.title)}</span>
        <span class="st-plan-section-chevron">${icon(isCollapsed ? 'chevron-right' : 'chevron-down', 'w-4 h-4')}</span>
      </div>
      ${isCollapsed ? '' : stPlanSectionBody(sec)}
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
    <div class="st-plan-body">${sectionHtml}</div>
    <div class="st-plan-foot">
      <div class="st-plan-chips">${chips}</div>
      <div class="st-plan-actions">
        <button type="button" class="st-btn st-btn-ghost" onclick="stDiscardPlan('${escapeHtml(p.planId)}')">丢弃</button>
        <button type="button" class="st-btn st-btn-primary" onclick="stCommitPlan('${escapeHtml(p.planId)}')">提交</button>
      </div>
    </div>
  </div>`;
}

function stPlanSectionBody(sec) {
  if (sec.snippets && sec.snippets.length) {
    return `
    <div class="st-plan-snippets">
      ${sec.snippets.map((s) => `<div class="st-plan-snippet"><span class="st-plan-speaker">${escapeHtml(s.speaker)}</span>：${escapeHtml(s.text)}</div>`).join('')}
    </div>`;
  }
  const bullets = sec.bullets || [];
  return `
  <ul class="st-plan-bullets">
    ${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('') || '<li class="st-plan-bullet-empty">暂无内容</li>'}
  </ul>`;
}

// dispatch 生成的 plan 缺少详情时使用默认模板（确定性内容）
function stPlanDefaultSections() {
  return [
    {
      id: 'planning',
      title: '策划阶段结果',
      icon: 'list',
      bullets: [
        '规划新剧情事件，推进当前主线',
        '检查角色动机与因果一致性',
        '生成可执行的三阶段任务'
      ]
    },
    {
      id: 'characters',
      title: '角色演绎片段预览',
      icon: 'users',
      snippets: [
        { speaker: '角色 A', text: '角色演绎片段预览将在确认后生成。' }
      ]
    }
  ];
}

function stEntityName(entityId) {
  const e = (MOCK_ENTITIES || []).find((x) => x.entityId === entityId);
  return e ? ((e.properties && e.properties.name) || entityId) : entityId;
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
      <button type="button" class="st-mention-tag-x" title="移除" onclick="stRemoveMention('${escapeHtml(m.id)}')">${icon('x', 'w-3 h-3')}</button>
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
  const stages = stState('stages', stInitialStages());
  return stages.map((s) => stStageItemHtml(s)).join('');
}

function stStageItemHtml(s) {
  const status = s.status || 'waiting';
  const label = ST_STAGE_STATUS_LABEL[status] || status;
  const pct = status === 'done' ? 100 : status === 'running' ? 60 : status === 'failed' ? 100 : 0;
  return `
  <div class="st-stage-item st-stage-${status}" data-stage="${escapeHtml(s.stage)}">
    <span class="st-stage-icon">${icon(s.icon || 'circle', 'w-4 h-4')}</span>
    <div class="st-stage-main">
      <div class="st-stage-name">${escapeHtml(s.name)}<span class="st-stage-agent">${escapeHtml(s.agent || '')}</span></div>
      <div class="st-stage-bar"><span class="st-stage-fill" style="width:${pct}%"></span></div>
    </div>
    <div class="st-stage-right">
      <span class="st-stage-status">${label}</span>
      <span class="st-stage-duration">${escapeHtml(s.duration || '')}</span>
    </div>
  </div>`;
}

function stChangesHtml() {
  const changes = [
    { icon: 'user-plus', type: 'entity', text: '新增实体：神秘商人' },
    { icon: 'edit-3', type: 'attr', text: '修改属性：艾莉亚 · 身世线索' },
    { icon: 'link-2', type: 'rel', text: '新增关系：艾莉亚 ↔ 共鸣水晶' },
    { icon: 'sparkles', type: 'event', text: '新增事件：星港集市相遇' }
  ];
  return changes.map((c) => `
    <div class="st-change-item">
      <span class="st-change-icon st-change-${c.type}">${icon(c.icon, 'w-3.5 h-3.5')}</span>
      <span class="st-change-text">${escapeHtml(c.text)}</span>
    </div>`).join('');
}

function stChapterCardHtml() {
  return `
  <div class="st-chapter-card">
    <div class="st-chapter-info">
      <div class="st-chapter-title">第六章 星门遗迹</div>
      <div class="st-chapter-meta">约 1800 字 · 最近生成</div>
    </div>
    <button type="button" class="st-icon-btn" title="查看章节" onclick="navigate('#/files')">${icon('arrow-right', 'w-4 h-4')}</button>
  </div>`;
}

// ==================== 四阶段状态机（确定性纯函数） ====================

function stInitialStages() {
  return ST_STAGE_DEFS.map((s) => ({ ...s, status: 'waiting', duration: null }));
}

/**
 * 状态机单步推进（确定性，无随机）：
 *  - 无运行中阶段 → 启动第一个 waiting 为 running
 *  - 有运行中阶段 → 将其置为 done（补固定耗时），并把下一个 waiting 置为 running
 * @param {Array} stages
 * @returns {Array} 推进后的阶段数组副本（不修改入参）
 */
function stSimAdvance(stages) {
  const next = (stages || []).map((s) => ({ ...s }));
  if (!next.length) return next;
  const runningIdx = next.findIndex((s) => s.status === 'running');
  if (runningIdx === -1) {
    const firstWaiting = next.findIndex((s) => s.status === 'waiting');
    if (firstWaiting === -1) return next; // 全部结束
    next[firstWaiting].status = 'running';
    return next;
  }
  next[runningIdx].status = 'done';
  if (next[runningIdx].duration == null) next[runningIdx].duration = '2.4s';
  const nextWaiting = next.findIndex((s) => s.status === 'waiting');
  if (nextWaiting !== -1) next[nextWaiting].status = 'running';
  return next;
}

/** 显式失败：当前 running 阶段置为 failed（其余保持不变） */
function stSimFail(stages) {
  const next = (stages || []).map((s) => ({ ...s }));
  const runningIdx = next.findIndex((s) => s.status === 'running');
  if (runningIdx !== -1) next[runningIdx].status = 'failed';
  return next;
}

// ==================== @ 提及面板 ====================

function stMentionOptions() {
  return (MOCK_ENTITIES || []).map((e) => ({
    id: e.entityId,
    name: (e.properties && e.properties.name) || e.entityId,
    type: e.entityType,
    typeLabel: (ENTITY_TYPES && ENTITY_TYPES[e.entityType] && ENTITY_TYPES[e.entityType].label) || e.entityType || '',
    desc: e.summary || '',
    letter: ((e.properties && e.properties.name) || e.entityId).charAt(0)
  }));
}

function stMentionFiltered(filter) {
  const kw = String(filter || '').toLowerCase();
  const opts = stMentionOptions();
  if (!kw) return opts;
  return opts.filter((o) => o.name.toLowerCase().includes(kw) || o.desc.toLowerCase().includes(kw) || o.typeLabel.toLowerCase().includes(kw));
}

function stMentionPanelHtml(filter, selected) {
  const items = stMentionFiltered(filter);
  if (!items.length) return '<div class="st-mention-empty">没有匹配的实体</div>';
  return items.map((o, i) => `
    <div class="st-mention-item${i === selected ? ' active' : ''}" onclick="stSelectMention('${escapeHtml(o.id)}','${escapeHtml(o.type)}')" onmouseenter="stMentionHover(${i})">
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

function stShowMentionPanel(source, filter) {
  setStState('mentionSel', 0);
  const el = $(source === 'dispatch' ? '#st-dispatch-mention-panel' : '#st-chat-mention-panel');
  if (!el) return;
  el.innerHTML = stMentionPanelHtml(filter, 0);
  el.style.display = 'block';
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
  setStState('studioBusy', false);
  try {
    const msgs = await apiCall('getChatMessages', id);
    setStState('studioMessages', msgs || []);
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
  try {
    await apiCall('sendChatMessage', text);
  } catch (e) {
    handleApiError(e);
  }
  stRunOrchestration(text);
}

/** 确定性编排脚本：Agent 四阶段 + Tool Call + 系统消息 + 流式回复 + 收尾 */
function stOrchestrationScript() {
  return [
    { action: 'stage', stage: 'planner', status: 'running' },
    { action: 'stage', stage: 'planner', status: 'done', duration: '3.2s' },
    { action: 'tool', tool: { name: '检索世界图', icon: 'search', status: 'done', duration: '1.2s', result: '找到 3 个相关实体：艾莉亚（角色）、第七星港（地点）、破碎星图（物品）' } },
    { action: 'stage', stage: 'role', status: 'running' },
    { action: 'stage', stage: 'role', status: 'done', duration: '2.8s' },
    { action: 'tool', tool: { name: '调用编排器', icon: 'git-branch', status: 'done', duration: '2.4s', result: '编排规划完成，生成 3 个阶段任务' } },
    { action: 'system', text: 'AI 触发编排 · 多代理协作中' },
    { action: 'stage', stage: 'reasoner', status: 'running' },
    { action: 'stage', stage: 'reasoner', status: 'done', duration: '1.9s' },
    { action: 'stream', text: '已生成编排计划，等待你的确认。我可以继续细化角色演绎片段，或直接提交执行。' },
    { action: 'stage', stage: 'renderer', status: 'running' },
    { action: 'stage', stage: 'renderer', status: 'done', duration: '2.1s' },
    { action: 'finish' }
  ];
}

function stRunOrchestration(instruction) {
  setStState('studioBusy', true);
  setStState('stages', stInitialStages());
  setStState('orch', { items: stOrchestrationScript(), idx: 0, live: null, instruction: instruction || '' });
  stRenderStages();
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
  if (ev.action === 'stage') {
    const stages = stState('stages', stInitialStages()).map((s) => ({ ...s }));
    const idx = stages.findIndex((s) => s.stage === ev.stage);
    if (idx >= 0) {
      stages[idx].status = ev.status;
      if (ev.duration) stages[idx].duration = ev.duration;
    }
    setStState('stages', stages);
    stRenderStages();
  } else if (ev.action === 'tool') {
    if (!orch.live) orch.live = { role: 'assistant', name: '策划 AI', text: '', ts: new Date().toISOString(), toolCalls: [] };
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
    if (!orch.live) orch.live = { role: 'assistant', name: '策划 AI', text: '', ts: new Date().toISOString(), toolCalls: [] };
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
    <div class="st-msg-avatar st-avatar-ai">${escapeHtml((live.name || '策划 AI').charAt(0))}</div>
    <div class="st-msg-body">
      <div class="st-msg-meta">
        <span class="st-msg-name">${escapeHtml(live.name || '策划 AI')}</span>
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
    stRenderPlanCards();
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
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    stRenderPlanCards();
    stRenderQueueStatus();
    toast(`计划已提交，生成 ${(res && res.chapterPath) || '章节'}`, 'success');
  });
}

async function stDiscardPlan(planId) {
  await withLoading(async () => {
    await apiCall('discardPlan', planId);
    const status = await apiCall('getSchedulerStatus');
    setStState('schedulerStatus', status);
    stRenderPlanCards();
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
  el.innerHTML = (status.plans || []).map((p) => stPlanCardHtml(p)).join('');
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