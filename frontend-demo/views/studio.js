/**
 * frontend-demo/views/studio.js — 创作编排视图
 *
 * 三栏工作台：分组会话列表 / 聊天区 + Tool Call 卡片 / 输入区
 *
 * 覆盖约定（模式同 views/graph.js / views/events.js）：
 *   - ViewRender.studio / ViewAfterRender.studio（views.js 中旧 ViewRender.studio 赋值会被本文件后加载覆盖）
 *   - viewLoaders.studio → stLoadData（views.js 中旧 loadStudio 函数声明保留，不修改）
 *
 * 状态读写约定（viewState('studio') 命名空间 + 平面双写，参考 events.js）：
 *   - stState(key, fallback) / setStState(key, value)
 *   - 数据键用 studioSessions / studioMessages / currentSessionId 等，
 *     避免与命名空间 routeId 'studio' 同名（参考 events.js eventList 的教训，防止双写把命名空间覆盖成数组）
 *
 * 数据获取与写操作走 apiMock 闭环（api-mock.js 实际暴露方法）：
 *   getChatSessions / getChatMessages / sendChatMessage / getChatStatus /
 *   activateChatSession / search
 * 复用 demo-utils.js：DemoUtils.groupSessionsByTime
 *
 * 流式文本使用固定步长模拟；真实模式走 SSE 订阅。
 *
 * 注入安全：onclick 内联参数一律单引号 + escapeHtml（禁止裸 JSON.stringify 双引号注入）
 *
 * 变更记录（2026-08-05）：移除「新建议程」按钮、派发表单、Plan 卡片、scheduler 状态轮询、
 * @提及功能、变更摘要/章节预览/执行状态栏。后端 scheduler 端点保留不动。统一到对话框内输入意图。
 */

// ==================== 常量 ====================

// 可控模拟节奏（ms）：浏览器中驱动编排脚本与流式输出；测试可整体调小/手动单步
const ST_SIM_TICK_MS = 620;     // 编排脚本相邻事件间隔
const ST_STREAM_CHUNK = 2;      // 每次流式追加字符数
const ST_STREAM_TICK_MS = 28;   // 流式相邻 tick 间隔

let stChatClose = null;
let stChatStatusTimer = null;
let stRuntimeGeneration = 0;

/**
 * 多会话状态表：{ [sessionId]: 'idle' | 'streaming' | 'error' }
 *
 * 后端 /api/chat/status 返回 sessions[] 与 backgroundStreaming[]，本表按 sessionId 维护
 * 各会话状态，用于会话列表项 spinner 显示与切换不阻塞。
 * 活跃会话额外叠加 studioBusy（防重入）——stIsStreamingBusy 两者取或。
 */
function stSessionStatusMap() {
  const m = stState('sessionStatus', null);
  if (m && typeof m === 'object') return m;
  const fresh = {};
  setStState('sessionStatus', fresh);
  return fresh;
}

function stSetSessionStatus(sessionId, status) {
  if (!sessionId) return;
  const map = stSessionStatusMap();
  map[sessionId] = status;
  setStState('sessionStatus', { ...map });
}

function stGetSessionStatus(sessionId) {
  const map = stState('sessionStatus', {});
  return map[sessionId] || 'idle';
}

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

  // 从会话列表同步 sessionStatus（后端 sessions[] 含 status 字段）
  const statusMap = {};
  for (const s of sessions) {
    if (s && s.id) statusMap[s.id] = s.status || 'idle';
  }
  setStState('sessionStatus', statusMap);

  const currentId = stResolveSessionId(sessions, stState('currentSessionId', null));
  setStState('currentSessionId', currentId);

  if (currentId) {
    const messageData = await apiCall('getChatMessages', currentId);
    setStState('studioMessages', messageData.messages || []);
  } else {
    setStState('studioMessages', []);
  }
}

viewLoaders.studio = stLoadData;

// ==================== 渲染 ====================

ViewRender.studio = () => {
  const sessions = stState('studioSessions', []);
  const currentId = stState('currentSessionId', null);
  const messages = stState('studioMessages', []);
  const busy = stState('studioBusy', false) || stState('chatStreaming', false);

  return `
  <div class="st-workspace">
    <aside class="st-sessions">
      ${stSessionsHtml(sessions, currentId)}
    </aside>

    <main class="st-chat">
      <div class="st-chat-messages" id="st-chat-messages" onscroll="stChatScrollCheck()">
        ${messages.length ? messages.map((m) => stMessageHtml(m)).join('') : stEmptyChatHtml()}
      </div>
      <button type="button" class="st-jump-to-latest" id="st-jump-to-latest" style="display:none" onclick="stJumpToLatest()">${icon('arrow-down', 'w-3.5 h-3.5')} 跳转到最新</button>
      ${stInputAreaHtml(busy)}
    </main>

    <aside class="st-orchestration-results">
      ${stOrPanelHtml()}
    </aside>
    <button class="st-or-toggle" onclick="stOrToggleDrawer()">编排结果 (${(stOrState('plans', []) || []).length})</button>
    <div class="st-or-drawer-overlay" onclick="stOrToggleDrawer()"></div>
    <aside class="st-or-drawer"></aside>
  </div>`;
};

ViewAfterRender.studio = () => {
  stScrollChatToBottom();
  stRenderJumpToLatest();
  refreshIcons();
  if (!ApiRuntime.isMock) {
    stStartRealRuntime();
  }
  stOrStartRuntime();
};

function stStartRealRuntime() {
  stEnsureChatSubscription();
  if (stChatStatusTimer) return;
  const generation = stRuntimeGeneration;
  // 轮询 /api/chat/status 同步多会话状态表（兜底 SSE 漏推送/重启场景）。
  // 用 setTimeout 链而非 setInterval（间隔随状态变化）。
  // 连续失败指数退避（2s→4s→…→30s 上限），后端宕机时不再固定 2s 打挂。
  let intervalMs = 2000;
  let consecutiveFailures = 0;
  const poll = async () => {
    try {
      const chatStatus = await apiCall('getChatStatus');
      if (generation !== stRuntimeGeneration) return;
      consecutiveFailures = 0;
      // 同步 sessionStatus map（按后端 sessions[] 与 backgroundStreaming[]）
      if (chatStatus && Array.isArray(chatStatus.sessions)) {
        const map = {};
        for (const s of chatStatus.sessions) {
          if (s && s.sessionId) map[s.sessionId] = s.status || 'idle';
        }
        setStState('sessionStatus', map);
      }
      // 保留 chatStreaming 兼容旧逻辑（活跃会话 streaming）
      setStState('chatStreaming', !!(chatStatus && chatStatus.isStreaming));
      if (generation !== stRuntimeGeneration) return;
      // 流式中热轮询 2s，空闲退避到 10s
      const hasStreaming = stState('chatStreaming', false) ||
        Object.values(stState('sessionStatus', {})).some((v) => v === 'streaming');
      intervalMs = hasStreaming ? 2000 : 10000;
    } catch (error) {
      consecutiveFailures += 1;
      intervalMs = Math.min(2000 * Math.pow(2, consecutiveFailures), 30000);
      if (generation === stRuntimeGeneration) {
        setStState('chatStreaming', false);
        handleApiError(error);
      }
    }
    if (generation === stRuntimeGeneration) stChatStatusTimer = setTimeout(poll, intervalMs);
  };
  stChatStatusTimer = setTimeout(poll, intervalMs);
}

function stEnsureChatSubscription() {
  if (ApiRuntime.isMock || stChatClose) return;
  stChatClose = ApiRuntime.subscribeChat(stHandleChatEvent, (error) => handleApiError(error));
}

function stCloseRealRuntime() {
  stRuntimeGeneration += 1;
  if (stChatClose) stChatClose();
  if (stChatStatusTimer) clearTimeout(stChatStatusTimer);
  stChatClose = null;
  stChatStatusTimer = null;
}

function cleanupStudioView() {
  stCloseRealRuntime();
  stOrCloseRuntime();
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
  </div>
  <div class="st-sessions-list">${items || '<div class="st-sessions-empty">暂无会话</div>'}</div>`;
}

function stSessionItemHtml(s, active) {
  // 按会话状态显示 spinner，不再统一禁用切换（多 session 并存：切换不影响后台生成）
  const status = stGetSessionStatus(s.id);
  const streaming = status === 'streaming';
  const error = status === 'error';
  const itemClass = 'st-session-item' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + (error ? ' errored' : '');
  const clickAttr = `onclick="stSwitchSession(${q(s.id)})" title="${error ? '生成失败，点击查看' : (streaming ? '生成中，点击切回查看' : '')}"`;
  const spinnerHtml = streaming ? `<span class="st-session-spinner">${icon('loader', 'w-3 h-3 spin')}</span>` : '';
  return `
  <div class="${itemClass}" ${clickAttr}>
    <span class="st-session-icon">${icon('message-square', 'w-3.5 h-3.5')}</span>
    <div class="st-session-main">
      <div class="st-session-name">${escapeHtml(s.name)}${s.live ? '<span class="st-live-dot"></span>' : ''}</div>
      <div class="st-session-first">${escapeHtml(s.firstMessage || '')}</div>
    </div>
    ${spinnerHtml}
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

// BUG-021：AI 消息走 Markdown 渲染（marked 解析 + DOMPurify 净化防 XSS）。
// 用户消息保持纯文本（escapeHtml），不解析 Markdown。
function stMarkdownHtml(text) {
  const raw = text == null ? '' : String(text);
  if (!window.marked || !window.DOMPurify) {
    // 库未加载时回退纯文本，保证不白屏
    return stTextHtml(text);
  }
  const rendered = window.marked.parse(raw, { breaks: true, async: false });
  return window.DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe'],
  });
}

// BUG-017：工具调用型 AI 消息（或用户纯工具消息）常出现 m.text=""，
// 气泡 div 里塞空字符串 → 视觉上是"空气泡"。给空内容渲染占位文本。
// BUG-021：isAi=true 时 AI 消息正文走 Markdown 渲染，用户消息保持纯文本。
function stBubbleContentHtml(text, hasTools, isAi) {
  const raw = (text == null ? '' : String(text)).trim();
  if (raw) return isAi ? stMarkdownHtml(text) : stTextHtml(text);
  if (hasTools) return `<span class="st-bubble-empty st-bubble-empty-tools">（调用了工具，无文本回复）</span>`;
  return `<span class="st-bubble-empty">…</span>`;
}

// ==================== 中栏：消息 / 输入区 ====================

function stEmptyChatHtml() {
  return `
  <div class="st-chat-empty">
    <div class="st-chat-empty-icon">${icon('message-square', 'w-6 h-6')}</div>
    <div class="st-chat-empty-text">开始你的第一段剧情</div>
    <div class="st-chat-empty-hint">输入消息与 AI 协作推进剧情</div>
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
      <div class="st-msg-bubble st-bubble-user">${stBubbleContentHtml(m.text, false, false)}</div>
      <span class="st-msg-time">${ts}</span>
    </div>`;
  }
  // assistant
  const tc = (m.toolCalls || []);
  const toolCalls = tc.map((tc) => stToolCardHtml(tc)).join('');
  // LLM 错误（如 402 余额不足）：错误气泡替代空文本气泡，避免「看不到回复也无提示」
  const errorBox = m.error
    ? `<div class="st-msg-error">${icon('circle-alert', 'w-3.5 h-3.5')}<span>${escapeHtml(m.error)}</span></div>`
    : '';
  const bubble = m.text || !m.error
    ? `<div class="st-msg-bubble st-bubble-ai">${stBubbleContentHtml(m.text, tc.length > 0, true)}</div>`
    : '';
  return `
  <div class="st-msg st-msg-ai">
    <div class="st-msg-avatar st-avatar-ai">AI</div>
    <div class="st-msg-body">
      <div class="st-msg-meta">
        <span class="st-msg-name">AI 助手</span>
        <span class="st-msg-time">${ts}</span>
      </div>
      ${bubble}
      ${errorBox}
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

// ==================== 聊天输入区 ====================

function stInputAreaHtml(busy) {
  return `
  <div class="st-input-area">
    <div class="st-input-toolbar">
      <span class="st-input-hint">${busy ? '生成中…可点击右侧按钮中断' : 'Enter 发送 · Shift+Enter 换行'}</span>
    </div>
    <div class="st-input-main">
      <textarea id="st-chat-textarea" class="st-chat-textarea" rows="2" placeholder="输入消息…" onkeydown="stChatKeydown(event)" spellcheck="false"></textarea>
      ${busy
        ? `<button type="button" class="st-send-btn st-stop-btn" title="中断生成" onclick="stAbortChat()">${icon('square', 'w-4 h-4')}</button>`
        : `<button type="button" class="st-send-btn" onclick="stSendChat()">${icon('send', 'w-4 h-4')}</button>`}
    </div>
  </div>`;
}

// 中断当前会话生成（活跃会话；后台会话的中断经 sessionId 参数由后端支持，当前 UI 只暴露活跃会话）
async function stAbortChat() {
  try {
    const res = await apiCall('abortChat');
    if (res && res.aborted === false) { toast('当前没有生成中的回复', 'info'); return; }
    toast('已请求中断生成', 'info');
    // busy 复位由 SSE agent_end 驱动（stHandlePiEvent），此处不手动清，避免与流式状态竞争
  } catch (e) { handleApiError(e); }
}

// ==================== 会话交互 ====================

async function stSwitchSession(id) {
  // 多 session 并存：切换不阻塞后台生成，仅切换活跃指针
  // 防重入——切换期间设 studioBusy（仅用于输入框禁用，不影响其他会话项可点击）
  if (stState('studioBusy', false)) return;
  setStState('studioBusy', true);
  stAbortLiveSimulation();
  setStState('currentSessionId', id);
  setStState('realLiveMessage', null);
  renderView();
  try {
    // 真实切换——调 activateChatSession 让后端切换活跃会话指针（不 dispose 旧 host）
    await apiCall('activateChatSession', id);
    const data = await apiCall('getChatMessages', id);
    setStState('studioMessages', data.messages || []);
  } catch (e) {
    setStState('studioMessages', []);
    handleApiError(e);
  } finally {
    // BUG-017：重新拉取会话列表，刷新每个会话的 live 字段（旧值在切换后仍指向旧会话）
    try {
      const sessionData = await apiCall('getChatSessions');
      const sessions = sessionData.sessions || [];
      setStState('studioSessions', sessions);
      const statusMap = {};
      for (const s of sessions) statusMap[s.id] = s.status || 'idle';
      setStState('sessionStatus', statusMap);
    } catch (e) {
      // 列表刷新失败不影响切换本身，保持现有数据
    }
    setStState('studioBusy', false);
    setStState('chatAutoScroll', true);
    renderView();
  }
}

/**
 * 判断指定会话是否处于 streaming 状态。
 * - 不传 sessionId：检查活跃会话（studioBusy 或 sessionStatus[active]=streaming）
 * - 传 sessionId：检查该会话 sessionStatus
 */
function stIsStreamingBusy(sessionId) {
  if (sessionId) {
    return stGetSessionStatus(sessionId) === 'streaming';
  }
  // 活跃会话：保留对旧 studioBusy/chatStreaming 的兼容（避免一次性删干净导致回归）
  if (stState('studioBusy', false)) return true;
  const currentId = stState('currentSessionId', null);
  if (currentId && stGetSessionStatus(currentId) === 'streaming') return true;
  return stState('chatStreaming', false);
}

/** streaming 中操作被拒绝时的提示（保留供其他位置调用，切换路径不再使用） */
function stNotifyStreamingBusy(action) {
  if (typeof toast === 'function') {
    toast(`${action}需要等待当前生成完成`, 'warn');
  }
}

// ==================== 发送与编排模拟 ====================

async function stSendChat() {
  const ta = $('#st-chat-textarea');
  if (!ta) return;
  const text = ta.value.trim();
  const currentId = stState('currentSessionId', null);
  if (!text || stIsStreamingBusy(currentId)) return;
  ta.value = '';
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
  if (currentId) stSetSessionStatus(currentId, 'streaming');
  try {
    await apiCall('sendChatMessage', text);
  } catch (e) {
    setStState('studioBusy', false);
    if (currentId) stSetSessionStatus(currentId, 'error');
    handleApiError(e);
  }
}

/**
 * 处理 SSE 多路复用事件。
 *
 * 后端 ChatContext.subscribe 推送两种事件：
 * - { type: 'pi', sessionId, event }   PI session 原始事件（带 sessionId 路由）
 * - { type: 'background_complete', sessionId }    后台会话生成完成
 * - { type: 'background_error', sessionId, error } 后台会话生成失败
 *
 * 当前会话事件照常渲染（解包 event 后按原逻辑处理）；
 * 非当前会话事件只更新 sessionStatus map（不渲染消息）。
 */
function stHandleChatEvent(envelope) {
  if (!envelope || typeof envelope !== 'object') return;
  const currentId = stState('currentSessionId', null);

  // 多路复用封装：{ type: 'pi', sessionId, event }
  if (envelope.type === 'pi' && envelope.sessionId) {
    const sid = envelope.sessionId;
    const innerEvent = envelope.event;
    if (!innerEvent || typeof innerEvent !== 'object') return;
    // 非当前会话的 PI 事件：仅更新状态（agent_end 时把会话标 idle，避免后台 spinner 卡住）
    if (sid !== currentId) {
      if (innerEvent.type === 'agent_end') {
        stSetSessionStatus(sid, 'idle');
      }
      return;
    }
    // 当前会话：按原逻辑处理
    stHandlePiEvent(innerEvent);
    return;
  }

  // 后台完成：状态置 idle + toast 通知
  if (envelope.type === 'background_complete' && envelope.sessionId) {
    const sid = envelope.sessionId;
    stSetSessionStatus(sid, 'idle');
    if (sid !== currentId) {
      stNotifyBackgroundComplete(sid);
    }
    return;
  }

  // 后台错误：状态置 error + toast 通知
  if (envelope.type === 'background_error' && envelope.sessionId) {
    const sid = envelope.sessionId;
    stSetSessionStatus(sid, 'error');
    if (sid !== currentId) {
      stNotifyBackgroundError(sid, envelope.error || '生成失败');
    }
    return;
  }

  // 兼容旧版直推（mock 模式或未封装事件）：作为当前会话事件处理
  stHandlePiEvent(envelope);
}

/** 处理当前会话的 PI 事件（原 stHandleChatEvent 主体） */
function stHandlePiEvent(event) {
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
  } else if (event.type === 'message_end') {
    // M-Collab-2：message_end 含错误语义（stopReason=error + errorMessage），
    // 错误结束时把 live 消息标红，避免"输入错误只 toast 气泡内无错误消息"
    const msg = event.message || {};
    if (msg.stopReason === 'error' || msg.errorMessage) {
      const live = stState('realLiveMessage', null);
      if (live) {
        live.error = msg.errorMessage || '生成失败';
        setStState('realLiveMessage', live);
        stRenderRealLiveMessage(live);
      }
    }
  } else if (event.type === 'agent_end') {
    setStState('studioBusy', false);
    const currentId = stState('currentSessionId', null);
    if (currentId) stSetSessionStatus(currentId, 'idle');
    void stRefreshChatHistory();
  }
}

/** 后台生成完成 toast 通知 */
function stNotifyBackgroundComplete(sessionId) {
  if (typeof toast !== 'function') return;
  const sessions = stState('studioSessions', []);
  const target = sessions.find((s) => s.id === sessionId);
  const name = (target && (target.name || target.firstMessage)) || sessionId.slice(0, 8);
  toast(`会话「${name}」生成完成`, 'success');
  // 刷新会话列表（让 spinner 消失）
  void stRefreshSessionsOnly();
}

/** 后台生成失败 toast 通知 */
function stNotifyBackgroundError(sessionId, error) {
  if (typeof toast !== 'function') return;
  const sessions = stState('studioSessions', []);
  const target = sessions.find((s) => s.id === sessionId);
  const name = (target && (target.name || target.firstMessage)) || sessionId.slice(0, 8);
  toast(`会话「${name}」生成失败：${error}`, 'error');
  void stRefreshSessionsOnly();
}

/** 仅刷新会话列表（不重拉消息，避免覆盖正在查看的历史） */
async function stRefreshSessionsOnly() {
  try {
    const sessionData = await apiCall('getChatSessions');
    setStState('studioSessions', sessionData.sessions || []);
    if (routeId() === 'studio') await renderView();
  } catch {
    // 静默失败：toast 通知失败不应阻塞 UI
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
    const msgsEl = $('#st-chat-messages');
    if (msgsEl) msgsEl.insertAdjacentHTML('beforeend', html);
  }
  refreshIcons();
  stScrollChatToBottom();
}

function stLiveMessageHtml(live) {
  const hasTools = Array.isArray(live.toolCalls) && live.toolCalls.length > 0;
  // 实时错误（message_end stopReason=error）：红条提示，与历史错误气泡同口径
  const errorBox = live.error
    ? `<div class="st-msg-error">${icon('circle-alert', 'w-3.5 h-3.5')}<span>${escapeHtml(live.error)}</span></div>`
    : '';
  const bubble = live.text || !live.error
    ? `<div class="st-msg-bubble st-bubble-ai">${stBubbleContentHtml(live.text, hasTools, true)}</div>`
    : '';
  return `
  <div class="st-msg st-msg-ai" id="st-live-msg">
    <div class="st-msg-avatar st-avatar-ai">AI</div>
    <div class="st-msg-body">
      <div class="st-msg-meta"><span class="st-msg-name">AI 助手</span><span class="st-msg-time">${stMsgTime(live.ts)}</span></div>
      ${bubble}
      ${errorBox}
      ${hasTools ? `<div class="st-tool-list">${live.toolCalls.map((tool) => stToolCardHtml(tool)).join('')}</div>` : ''}
    </div>
  </div>`;
}

async function stRefreshChatHistory() {
  try {
    const sessionData = await apiCall('getChatSessions');
    const sessions = sessionData.sessions || [];
    setStState('studioSessions', sessions);
    // 同步 sessionStatus（保留 SSE 已设置的 streaming 标记，列表刷新不覆盖）
    const existing = stState('sessionStatus', {});
    const map = {};
    for (const s of sessions) {
      if (s && s.id) map[s.id] = existing[s.id] || s.status || 'idle';
    }
    setStState('sessionStatus', map);
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

/** 确定性聊天脚本；模拟 AI 回复（工具调用 + 流式文本）。 */
function stOrchestrationScript() {
  return [
    { action: 'tool', tool: { id: 'live-tool-search', name: '检索世界图', status: 'done', isError: false } },
    { action: 'tool', tool: { id: 'live-tool-dispatch', name: '调用编排器', status: 'done', isError: false } },
    { action: 'system', text: 'AI 触发编排 · 多代理协作中' },
    { action: 'stream', text: '## 叙事指令\n\n基于当前剧情进展，编排计划如下：\n\n**目标**：推进星门遗迹探索主线，深化林远航与艾莉亚的互动。\n\n**角色**：\n- 林远航（舰长）——主动探索星门深处\n- 艾莉亚（导航员）——暗中协助，透露远古线索\n\n**节奏**：先展示星门遗迹的外景悬念，再切入角色对话揭示核心冲突。\n\n**关键事件**：星门能量波动异常，触发远古警报系统。\n\n已生成编排计划，等待你的确认。' },
    { action: 'finish' }
  ];
}

function stRunOrchestration(instruction) {
  setStState('studioBusy', true);
  setStState('orch', { items: stOrchestrationScript(), idx: 0, live: null, instruction: instruction || '' });
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
  const msgsEl = $('#st-chat-messages');
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
  if (msgsEl) msgsEl.insertAdjacentHTML('beforeend', html);
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
    // BUG-015：live 消息无文本且无工具调用时不保留空气泡——移除 DOM 且不入库
    const hasContent = (orch.live.text && orch.live.text.trim()) || (orch.live.toolCalls && orch.live.toolCalls.length);
    if (!hasContent) {
      const liveEl = $('#st-live-msg');
      if (liveEl) liveEl.remove();
    } else {
      const msgs = stState('studioMessages', []).concat([{ ...orch.live }]);
      setStState('studioMessages', msgs);
    }
  }
  orch.live = null;
  if (orch.timer) { clearTimeout(orch.timer); orch.timer = null; }
  setStState('orch', orch);
  setStState('studioBusy', false);

  // 设计文档 §10.1：mock 模式下编排完成后注入 Plan 到右侧面板
  if (ApiRuntime.isMock) {
    stOrInjectMockPlan();
  }
}

/** Mock 模式：编排完成后注入一个 confirmed Plan 到右侧面板 */
function stOrInjectMockPlan() {
  // 使用 MOCK_SCHEDULER_PLANS 中的 plan-mock-01（confirmed）作为模板
  if (typeof MOCK_SCHEDULER_PLANS === 'undefined') return;
  const template = MOCK_SCHEDULER_PLANS['plan-mock-01'];
  if (!template) return;
  const plan = JSON.parse(JSON.stringify(template));
  plan.planId = 'plan-injected-' + Date.now();
  plan.status = 'confirmed';
  delete plan.commitQueueId;
  // 注入到 mock 数据层
  apiCall('injectMockPlan', plan).then(() => {
    // 清除现有 timer 后强制立即轮询，避免重复 timer
    if (stOrTimer) { clearTimeout(stOrTimer); stOrTimer = null; }
    stOrPollStatus(stOrGeneration);
  }).catch(() => {});
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

// ==================== DOM 工具 ====================

// BUG-013：用户上滑查看历史时不强制拉回底部；仅 chatAutoScroll 开启时自动跟随，
// 并在非底部时显示「跳转到最新」按钮
function stIsChatNearBottom() {
  const el = $('#st-chat-messages');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function stChatScrollCheck() {
  setStState('chatAutoScroll', stIsChatNearBottom());
  stRenderJumpToLatest();
}

function stJumpToLatest() {
  setStState('chatAutoScroll', true);
  const el = $('#st-chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
  stRenderJumpToLatest();
}

function stRenderJumpToLatest() {
  const el = $('#st-jump-to-latest');
  if (!el) return;
  el.style.display = stState('chatAutoScroll', true) ? 'none' : '';
}

function stScrollChatToBottom() {
  const el = $('#st-chat-messages');
  if (!el) return;
  if (stState('chatAutoScroll', true)) el.scrollTop = el.scrollHeight;
}

function stAppendMessageEl(html) {
  const target = $('#st-chat-messages');
  if (!target) return;
  target.insertAdjacentHTML('beforeend', html);
  refreshIcons();
  stScrollChatToBottom();
}

function stChatKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    stSendChat();
  }
}

// ==================== 右侧编排结果面板 ====================

/** 编排结果面板状态访问器 */
function stOrState(key, fallback) { return stState('stOr_' + key, fallback); }
function setStOrState(key, value) { setStState('stOr_' + key, value); }

/** 面板主渲染：路由到空态 / 加载态 / 列表 */
function stOrPanelHtml() {
  const plans = stOrState('plans', null);
  const error = stOrState('pollError', null);
  const isLoading = plans === null && !error;
  if (isLoading) {
    return `
    <div class="st-or-panel">
      <div class="st-or-header">
        <h3>编排结果</h3>
      </div>
      <div class="st-or-loading">${icon('loader', 'w-4 h-4 spin')} 加载中…</div>
    </div>`;
  }
  if (!plans || !plans.length) {
    return `
    <div class="st-or-panel">
      <div class="st-or-header">
        <h3>编排结果</h3>
      </div>
      <div class="st-or-empty">
        <div class="st-or-empty-icon">${icon('file-text', 'w-5 h-5')}</div>
        <div class="st-or-empty-text">在聊天框描述创作意图，编排结果会显示在这里</div>
      </div>
      ${error ? `<div class="st-or-error-bar">${escapeHtml(error)}</div>` : ''}
    </div>`;
  }
  return `
  <div class="st-or-panel">
    <div class="st-or-header">
      <h3>编排结果</h3>
      <span class="st-or-count">${escapeHtml(String(plans.length))}</span>
    </div>
    ${stOrFilterHtml()}
    <div class="st-or-list" id="st-or-list">
      ${stOrFilteredPlansHtml(plans)}
    </div>
    <div class="st-or-detail" id="st-or-detail">
      ${stOrDetailHtml()}
    </div>
    ${error ? `<div class="st-or-error-bar">${escapeHtml(error)}</div>` : ''}
  </div>`;
}

/** 状态筛选栏 */
function stOrFilterHtml() {
  const filter = stOrState('filter', null);
  const plans = stOrState('plans', []);
  const counts = { confirmed: 0, committing: 0, committed: 0, error: 0 };
  for (const p of plans) {
    if (counts[p.status] !== undefined) counts[p.status] += 1;
  }
  const filters = [
    { key: null, label: '全部' },
    { key: 'confirmed', label: '待确认 (' + counts.confirmed + ')' },
    { key: 'committing', label: '处理中 (' + counts.committing + ')' },
    { key: 'committed', label: '已完成 (' + counts.committed + ')' },
    { key: 'error', label: '失败 (' + counts.error + ')' },
  ];
  return `
  <div class="st-or-filter">
    ${filters.map((f) => {
      const active = filter === f.key;
      return `<button type="button" class="st-or-filter-btn${active ? ' active' : ''}" onclick="stOrSetFilter(${q(f.key === null ? '' : f.key)})">${escapeHtml(f.label)}</button>`;
    }).join('')}
  </div>`;
}

/** 按筛选条件过滤后的 Plan 列表 */
function stOrFilteredPlansHtml(plans) {
  const filter = stOrState('filter', null);
  const filtered = filter ? plans.filter((p) => p.status === filter) : plans;
  const selectedId = stOrState('selectedPlanId', null);
  return filtered.map((p) => stOrPlanSummaryHtml(p, p.planId === selectedId)).join('');
}

/** 单条 Plan 摘要 */
function stOrPlanSummaryHtml(plan, isSelected) {
  const cls = 'st-or-item' + (isSelected ? ' active' : '') + (plan.status === 'committing' ? ' committing' : '');
  const badge = stOrStatusBadgeHtml(plan.status);
  return `
  <div class="${cls}" onclick="stOrSelectPlan(${q(plan.planId)})">
    <div class="st-or-item-header">
      <span class="st-or-item-time">${escapeHtml(plan.storyTime)}</span>
      ${badge}
    </div>
    <div class="st-or-item-meta">
      <span>${plan.characterIds.length} 角色</span>
      <span>${plan.outputCount} 产出</span>
      ${plan.errorCount ? `<span class="st-or-error-count">${plan.errorCount} 错误</span>` : ''}
    </div>
    ${plan.status === 'committing' ? `<div class="st-or-item-committing">${icon('loader', 'w-3 h-3 spin')} 提交处理中…</div>` : ''}
    ${plan.commitError ? `<div class="st-or-item-error">${escapeHtml(plan.commitError)}</div>` : ''}
  </div>`;
}

/** 状态徽章 */
function stOrStatusBadgeHtml(status) {
  const labels = { confirmed: '待确认', committing: '处理中', committed: '已完成', error: '失败' };
  return `<span class="st-or-badge st-or-badge-${status}">${escapeHtml(labels[status] || status)}</span>`;
}

/** 当前选中 Plan 的五阶段详情 */
function stOrDetailHtml() {
  const detail = stOrState('detail', null);
  const selectedId = stOrState('selectedPlanId', null);
  if (!selectedId) {
    return '<div class="st-or-detail-empty">选择一个 Plan 查看详情</div>';
  }
  if (!detail) {
    return `<div class="st-or-detail-loading">${icon('loader', 'w-4 h-4 spin')} 加载详情…</div>`;
  }
  const parts = [];
  // 阶段 1：检索计划
  parts.push(stOrStageRetrievalHtml(detail.retrievalPlan));
  // 阶段 2：角色演绎
  parts.push(stOrStageRoleHtml(detail.outputs, detail.cast));
  // 阶段 3-5：后半链路（committing 时显示统一占位，committed 时显示真实结果）
  if (detail.status === 'committed') {
    if (detail.diffusion) parts.push(stOrStageDiffusionHtml(detail.diffusion));
    if (detail.render) parts.push(stOrStageRenderHtml(detail.render));
    if (detail.commit) parts.push(stOrStageCommitHtml(detail.commit));
  } else if (detail.status === 'committing') {
    parts.push(stOrCommittingHtml(detail));
  } else if (detail.status === 'error') {
    // error 时保留前半链路，显示错误
    if (detail.commitError) {
      parts.push(`<div class="st-or-stage st-or-stage-error">
        <div class="st-or-stage-header">提交失败</div>
        <div class="st-or-stage-content">${escapeHtml(detail.commitError)}</div>
      </div>`);
    }
  }
  // 操作按钮
  parts.push(stOrActionsHtml(detail));
  return '<div class="st-or-detail-body">' + parts.join('') + '</div>';
}

/** 阶段 1：检索计划 */
function stOrStageRetrievalHtml(retrievalPlan) {
  if (!retrievalPlan || !retrievalPlan.items) return '';
  const items = retrievalPlan.items.map((item) => {
    const params = item.params || {};
    const paramStr = Object.keys(params).map((k) => `${k}=${escapeHtml(String(params[k]))}`).join(' ');
    return `<div class="st-or-retrieval-item">
      <span class="st-or-retrieval-type">${escapeHtml(item.type)}</span>
      <span class="st-or-retrieval-target">${escapeHtml(item.target)}</span>
      <span class="st-or-retrieval-assign">→ ${escapeHtml(item.assignTo)}</span>
      ${paramStr ? `<span class="st-or-retrieval-params">${escapeHtml(paramStr)}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">阶段 1：检索计划</div>
    <div class="st-or-stage-content">${items || '<span class="st-or-empty-inline">无检索项</span>'}</div>
  </div>`;
}

/** 阶段 2：角色演绎 */
function stOrStageRoleHtml(outputs, cast) {
  if (!outputs || !outputs.length) return '';
  const castMap = {};
  if (cast) for (const c of cast) castMap[c.characterId] = c;
  const outHtml = outputs.map((o) => {
    const c = castMap[o.characterId] || {};
    const name = o.characterName || c.name || o.characterId;
    const relUpdates = (o.relationUpdates || []).map((ru) => {
      const changeLabel = ru.change === 'positive' ? '↑' : (ru.change === 'negative' ? '↓' : '→');
      return `<span class="st-or-rel-update">${escapeHtml(ru.label)} ${changeLabel}</span>`;
    }).join(' ');
    const knowledge = (o.knowledgeGained || []).map((k) => `<li>${escapeHtml(k)}</li>`).join('');
    const stateChanges = (o.stateChanges || []).map((sc) =>
      `<li>${escapeHtml(sc.entityId)}.${escapeHtml(sc.property)} → ${escapeHtml(String(sc.value))}</li>`
    ).join('');
    return `<div class="st-or-role-output">
      <div class="st-or-role-name">${escapeHtml(name)}</div>
      <div class="st-or-role-detail">
        <div class="st-or-role-line"><span class="st-or-role-label">行动：</span>${escapeHtml(o.action || '')}</div>
        <div class="st-or-role-line"><span class="st-or-role-label">目标：</span>${escapeHtml(o.target || '')}</div>
        <div class="st-or-role-line"><span class="st-or-role-label">情绪：</span>${escapeHtml(o.emotion || '')}</div>
        ${relUpdates ? `<div class="st-or-role-line"><span class="st-or-role-label">关系：</span>${relUpdates}</div>` : ''}
        ${knowledge ? `<div class="st-or-role-line"><span class="st-or-role-label">新知：</span><ul class="st-or-role-list">${knowledge}</ul></div>` : ''}
        ${stateChanges ? `<div class="st-or-role-line"><span class="st-or-role-label">状态：</span><ul class="st-or-role-list">${stateChanges}</ul></div>` : ''}
        ${o.thought ? `<div class="st-or-role-thought">${stMarkdownHtml(o.thought)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">阶段 2：角色演绎</div>
    <div class="st-or-stage-content">${outHtml}</div>
  </div>`;
}

/** 阶段 3：可见推理（Diffusion） */
function stOrStageDiffusionHtml(diffusion) {
  if (!diffusion) return '';
  const evtCount = (diffusion.appliedEventIds || []).length;
  const changes = (diffusion.changes || []).map((c) =>
    `<li>${escapeHtml(c.entityId)}.${escapeHtml(c.property)} [${escapeHtml(c.modality)}] → ${escapeHtml(String(c.value))}</li>`
  ).join('');
  const visChanges = (diffusion.visibilityChanges || []).map((v) =>
    `<li>${escapeHtml(v.characterId)} 知晓 ${escapeHtml(v.declarationId)} (${escapeHtml(v.source)}, ${v.confidence})</li>`
  ).join('');
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">阶段 3：可见推理</div>
    <div class="st-or-stage-content">
      <div class="st-or-diff-line">已应用事件：${evtCount} 个</div>
      ${evtCount ? `<details class="st-or-details"><summary>事件列表</summary><ul class="st-or-list">${(diffusion.appliedEventIds || []).map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul></details>` : ''}
      ${changes ? `<div class="st-or-diff-line">状态变化：</div><ul class="st-or-list">${changes}</ul>` : ''}
      ${visChanges ? `<div class="st-or-diff-line">可见性变化：</div><ul class="st-or-list">${visChanges}</ul>` : ''}
    </div>
  </div>`;
}

/** 阶段 4：渲染正文 */
function stOrStageRenderHtml(render) {
  if (!render) return '';
  const wordCount = render.text ? render.text.length : 0;
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">阶段 4：渲染正文</div>
    <div class="st-or-stage-content">
      <div class="st-or-render-line">章节路径：${escapeHtml(render.chapterPath || '')}</div>
      <div class="st-or-render-line">状态：${render.ok ? '成功' : '失败'}</div>
      <div class="st-or-render-line">字数：${wordCount}</div>
      ${render.text ? `<div class="st-or-render-body">${stMarkdownHtml(render.text)}</div>` : ''}
    </div>
  </div>`;
}

/** 阶段 5：落地摘要 */
function stOrStageCommitHtml(commitData) {
  if (!commitData) return '';
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">阶段 5：落地摘要</div>
    <div class="st-or-stage-content">
      <div class="st-or-commit-line">状态：${commitData.ok ? '成功' : '失败'}</div>
      <div class="st-or-commit-line">已应用事件：${(commitData.appliedEventIds || []).length} 个</div>
      <div class="st-or-commit-line">章节路径：${escapeHtml(commitData.chapterPath || '')}</div>
      <div class="st-or-commit-line">正文长度：${commitData.writtenText ? commitData.writtenText.length : 0} 字符</div>
      ${commitData.visibilityChanges && commitData.visibilityChanges.length ? `<details class="st-or-details"><summary>可见性变更 (${commitData.visibilityChanges.length})</summary><ul class="st-or-list">${commitData.visibilityChanges.map((v) => `<li>${escapeHtml(v.characterId)} → ${escapeHtml(v.declarationId)} (${escapeHtml(v.source)}, ${v.confidence})</li>`).join('')}</ul></details>` : ''}
      ${commitData.errors && commitData.errors.length ? `<div class="st-or-commit-errors">${commitData.errors.map((e) => `<div>${escapeHtml(e)}</div>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

/** BUG-028：committing 占位（显示阶段 + 已耗时，消除"一直处理中"误判） */
function stOrCommittingHtml(detail) {
  const stage = detail && detail.commitStage;
  const startedAt = detail && detail.commitStartedAt;
  const stageLabel = stage === 'rendering' ? '渲染中' : '推理中';
  let elapsed = '';
  if (startedAt) {
    const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    elapsed = ` · 已进行 ${secs}s`;
  }
  return `<div class="st-or-stage">
    <div class="st-or-stage-header">后半链路</div>
    <div class="st-or-stage-content st-or-committing-placeholder">
      ${icon('loader', 'w-4 h-4 spin')} ${stageLabel}…${elapsed}
    </div>
  </div>`;
}

/** 操作按钮（基于 status 渲染） */
function stOrActionsHtml(detail) {
  if (!detail) return '';
  const busy = stOrState('commitBusy', false);
  if (detail.status === 'confirmed') {
    return `<div class="st-or-actions">
      <button type="button" class="st-or-btn st-or-btn-primary" onclick="stOrCommitPlan(${q(detail.planId)})" ${busy ? 'disabled' : ''}>${busy ? icon('loader', 'w-3.5 h-3.5 spin') + ' ' : ''}提交落地</button>
      <button type="button" class="st-or-btn st-or-btn-secondary" onclick="stOrDiscardPlan(${q(detail.planId)})" ${busy ? 'disabled' : ''}>丢弃</button>
    </div>`;
  }
  if (detail.status === 'committing') {
    return `<div class="st-or-actions">
      <button type="button" class="st-or-btn" disabled>${icon('loader', 'w-3.5 h-3.5 spin')} 提交中…</button>
    </div>`;
  }
  if (detail.status === 'error') {
    return `<div class="st-or-actions">
      <button type="button" class="st-or-btn st-or-btn-primary" onclick="stOrCommitPlan(${q(detail.planId)})" ${busy ? 'disabled' : ''}>${busy ? icon('loader', 'w-3.5 h-3.5 spin') + ' ' : ''}重试提交</button>
      <button type="button" class="st-or-btn st-or-btn-secondary" onclick="stOrDiscardPlan(${q(detail.planId)})" ${busy ? 'disabled' : ''}>丢弃</button>
    </div>`;
  }
  return '';
}

// ==================== 编排结果面板运行时 ====================

let stOrTimer = null;
let stOrGeneration = 0;
let stOrConsecutiveFailures = 0;

/** 启动编排结果轮询 */
function stOrStartRuntime() {
  stOrCloseRuntime();
  const gen = ++stOrGeneration;
  stOrConsecutiveFailures = 0;
  stOrPollStatus(gen);
}

/**
 * 局部刷新面板 DOM（不触发全量 renderView，避免循环）
 *
 * 设计文档 §8：轮询仅更新面板数据，不离场时不清空整个面板。
 * 使用此函数替代 renderView()，因为 renderView() 会重新执行
 * ViewAfterRender.studio → stOrStartRuntime() → 重置 stOrGeneration
 * → 旧 poll 的 gen 失效 → 新 poll 启动 → 完成后又 renderView → 死循环。
 */
function stOrRenderPanel() {
  const el = document.querySelector('.st-orchestration-results');
  if (!el) return;
  el.innerHTML = stOrPanelHtml();
  refreshIcons();
  // 更新窄屏 toggle 按钮计数
  const toggle = document.querySelector('.st-or-toggle');
  if (toggle) {
    const count = (stOrState('plans', []) || []).length;
    toggle.textContent = '编排结果 (' + count + ')';
  }
  // 抽屉打开时同步更新内容
  const drawer = document.querySelector('.st-or-drawer.active');
  if (drawer) {
    drawer.innerHTML = stOrPanelHtml();
    refreshIcons();
  }
}

/** 轮询 /api/scheduler/status（设计文档 §8.1） */
async function stOrPollStatus(gen) {
  if (gen !== stOrGeneration) return;
  try {
    const data = await apiCall('getSchedulerStatus');
    if (gen !== stOrGeneration) return;
    stOrConsecutiveFailures = 0;
    const plans = data.plans || [];
    setStOrState('plans', plans);
    setStOrState('pollError', null);
    // 默认选择（设计文档 §7.1 默认选中规则）
    const selectedId = stOrState('selectedPlanId', null);
    if (!selectedId || !plans.some((p) => p.planId === selectedId)) {
      const defaultId = stOrResolveDefaultPlan(plans);
      if (defaultId) {
        // BUG-028 附带：default 选择时需同步设 selectedPlanId（stOrFetchDetail 只拉 detail，
        // 不设 selectedPlanId，否则 stOrDetailHtml 因 selectedPlanId=null 显示空态）
        setStOrState('selectedPlanId', defaultId);
        stOrFetchDetail(defaultId, gen);
      }
    } else {
      // 检查选中 plan 是否需要刷新详情（设计文档 §8.2）
      const selected = plans.find((p) => p.planId === selectedId);
      if (selected) {
        const cached = stOrState('detail', null);
        if (cached && (cached.status !== selected.status || cached.commitQueueId !== selected.commitQueueId)) {
          stOrFetchDetail(selectedId, gen);
        } else if (cached && selected.status === 'committing') {
          // BUG-028：committing 期间实时同步阶段 + 开始时间到 detail 缓存
          //（detail 在 committing 期间不重拉，但 plans 列表每 2s 带 commitStage）
          cached.commitStage = selected.commitStage;
          cached.commitStartedAt = selected.commitStartedAt;
        }
      }
    }
    // 局部刷新面板（避免全量 renderView 循环）
    stOrRenderPanel();
    // 下次轮询间隔（设计文档 §8.1：有 committing → 2s，空闲 → 10s）
    const hasBusy = plans.some((p) => p.status === 'committing');
    scheduleNext(gen, hasBusy ? 2000 : 10000);
  } catch (error) {
    if (gen !== stOrGeneration) return;
    stOrConsecutiveFailures += 1;
    setStOrState('pollError', error.message || '状态暂不可用');
    // 设计文档 §8.1：连续失败指数退避，最大 30s
    const delay = Math.min(2000 * Math.pow(2, stOrConsecutiveFailures - 1), 30000);
    // 首次失败时刷新面板（显示错误状态）
    if (stOrConsecutiveFailures === 1) {
      stOrRenderPanel();
    }
    scheduleNext(gen, delay);
  }
}

function scheduleNext(gen, ms) {
  if (gen !== stOrGeneration) return;
  stOrTimer = setTimeout(() => stOrPollStatus(gen), ms);
}

/** 获取 Plan 详情（设计文档 §8.2：按需请求，不重复下载正文） */
async function stOrFetchDetail(planId, gen) {
  if (gen === undefined) gen = stOrGeneration;
  try {
    const data = await apiCall('getSchedulerPlan', planId);
    if (gen !== stOrGeneration) return;
    setStOrState('detail', data);
    setStOrState('detailCache', Object.assign(stOrState('detailCache', {}), { [planId]: data }));
    stOrRenderPanel();
  } catch (error) {
    if (gen !== stOrGeneration) return;
    // 设计文档 §9.1：PLAN_NOT_FOUND → 移除本地缓存
    if (error.code === 'PLAN_NOT_FOUND') {
      setStOrState('selectedPlanId', null);
      setStOrState('detail', null);
      const plans = (stOrState('plans', []) || []).filter((p) => p.planId !== planId);
      setStOrState('plans', plans);
      stOrRenderPanel();
    } else {
      setStOrState('pollError', error.message || '详情加载失败');
      stOrRenderPanel();
    }
  }
}

/** 默认 Plan 选择（设计文档 §7.1 优先级规则） */
function stOrResolveDefaultPlan(plans) {
  if (!plans || !plans.length) return null;
  // 1. 保留已有选中
  const selected = stOrState('selectedPlanId', null);
  if (selected && plans.some((p) => p.planId === selected)) return selected;
  // 2. 最新 confirmed
  const confirmed = plans.filter((p) => p.status === 'confirmed');
  if (confirmed.length) return confirmed[0].planId;
  // 3. 最新 committing
  const committing = plans.filter((p) => p.status === 'committing');
  if (committing.length) return committing[0].planId;
  // 4. 最新可用
  return plans[0].planId;
}

/** 设置筛选 */
function stOrSetFilter(filter) {
  setStOrState('filter', filter || null);
  stOrRenderPanel();
}

/** 选中 Plan */
function stOrSelectPlan(planId) {
  setStOrState('selectedPlanId', planId);
  // 先检查缓存（设计文档 §8.2：命中缓存不重复请求）
  const cache = stOrState('detailCache', {});
  if (cache[planId]) {
    setStOrState('detail', cache[planId]);
  } else {
    setStOrState('detail', null);
  }
  stOrFetchDetail(planId);
  stOrRenderPanel();
}

/** 提交 Plan（设计文档 §7.4：本地 busy 锁 + 后端并发保护） */
async function stOrCommitPlan(planId) {
  if (stOrState('commitBusy', false)) return;
  setStOrState('commitBusy', true);
  // 乐观更新状态为 committing
  const plans = stOrState('plans', []).map((p) => p.planId === planId ? { ...p, status: 'committing' } : p);
  setStOrState('plans', plans);
  const detail = stOrState('detail', null);
  if (detail && detail.planId === planId) {
    setStOrState('detail', { ...detail, status: 'committing' });
  }
  stOrRenderPanel();
  try {
    const result = await apiCall('commitPlan', planId);
    if (!result.ok) {
      throw new Error(result.error?.message || '提交失败');
    }
    // 提交成功：刷新详情以获取完整结果
    stOrFetchDetail(planId);
  } catch (error) {
    // 设计文档 §9.1：面板级错误显示，不清空前半结果
    setStOrState('pollError', error.message || '提交失败');
    // 回退：刷新状态（恢复乐观更新前的状态）
    stOrPollStatus(stOrGeneration);
  } finally {
    setStOrState('commitBusy', false);
  }
}

/** 丢弃 Plan（设计文档 §7.4：committing 中禁止丢弃） */
async function stOrDiscardPlan(planId) {
  if (stOrState('commitBusy', false)) return;
  setStOrState('commitBusy', true);
  try {
    const result = await apiCall('discardPlan', planId);
    if (!result.ok) {
      throw new Error(result.error?.message || '丢弃失败');
    }
    // 从列表中移除
    const plans = (stOrState('plans', []) || []).filter((p) => p.planId !== planId);
    setStOrState('plans', plans);
    if (stOrState('selectedPlanId', null) === planId) {
      setStOrState('selectedPlanId', null);
      setStOrState('detail', null);
    }
    stOrRenderPanel();
  } catch (error) {
    // 设计文档 §9.1：面板级错误显示
    setStOrState('pollError', error.message || '丢弃失败');
    stOrPollStatus(stOrGeneration);
  } finally {
    setStOrState('commitBusy', false);
  }
}

/** 切换窄屏抽屉（设计文档 §7.6） */
function stOrToggleDrawer() {
  const overlay = document.querySelector('.st-or-drawer-overlay');
  const drawer = document.querySelector('.st-or-drawer');
  if (!overlay || !drawer) return;
  const isOpen = drawer.classList.contains('active');
  if (isOpen) {
    overlay.classList.remove('active');
    drawer.classList.remove('active');
  } else {
    overlay.classList.add('active');
    drawer.classList.add('active');
    drawer.innerHTML = stOrPanelHtml();
    refreshIcons();
  }
}

/** 停止编排结果轮询（设计文档 §8.3：离场清理） */
function stOrCloseRuntime() {
  stOrGeneration += 1;
  stOrConsecutiveFailures = 0;
  if (stOrTimer) clearTimeout(stOrTimer);
  stOrTimer = null;
}
