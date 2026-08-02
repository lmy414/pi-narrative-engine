/**
 * frontend-demo/views/settings.js — 设置视图（高保真重构，Task 10）
 *
 * 设计基准：narrative-engine-design/pages/settings.html
 * （左侧二级导航：应用配置[模型配置/密钥管理/向量模型/应用偏好/关于] + 项目配置[规则集/项目信息/环境变量]；
 *   模型 Slot 表（default/planner/role/reasoning/renderer，inherited 跟随默认 / slot 已配，Provider/Model 选择与保存/清除/自定义）；
 *   密钥管理（脱敏 ••••、添加、显示/隐藏、删除，纯前端 Demo）；向量模型（状态卡、Warmup、清缓存、改模型）；
 *   应用偏好（主题卡 light/dark/system、字号 slider、自动保存开关+间隔、默认扫描根目录）；
 *   关于（版本、Doctor 自检）；规则集（Tab render/role/planner、恢复模板、保存、字数）；
 *   项目信息（novel.json：名称/章节目录/故事时间格式）；环境变量（HF_ENDPOINT/PI_DEBUG/PI_EMBEDDER_MODEL））
 *
 * 覆盖约定（模式同 views/graph.js / views/events.js / views/files.js）：
 *   - ViewRender.settings / ViewAfterRender.settings（views.js 中旧 ViewRender.settings 赋值会被本文件后加载覆盖）
 *   - viewLoaders.settings → settingsLoad（views.js 中旧 loadSettings 函数声明保留，不修改）
 *   - 本文件不依赖 views.js 的 q()（Task 11 将删除 views.js）；
 *     onclick 内联参数一律经本文件内定义的 settingsJs()（JS 字面量转义）包裹。
 *
 * 主题保存修复（Task 10 关键修复）：
 *   旧 views.js saveAppConfig 中 `if (patch.theme) toggleTheme();` 为取反逻辑——
 *   当用户选择与当前相同的主题时会误切换（toggleTheme 是 negate 而非 set）。
 *   本文件 settingsApplyTheme/settingsSetTheme 改为显式赋值：
 *   `App.theme = resolved; document.documentElement.className = resolved;`
 *
 * 状态读写约定（viewState('settings') 命名空间 + 平面双写，参考 events.js / files.js）：
 *   - settingsState(key, fallback) / setSettingsState(key, value)
 *   - 数据键用 setActivePanel / setAppConfig / setLlmStatus / setKeys / setEmbedder / setVersion /
 *     setDoctor / setRulesets / setRulesetTab / setNovelJson / setEnvConfig / setAutosave / setPiDebug /
 *     setCustomizing 等，避免与命名空间 routeId 'settings' 同名（防止双写把命名空间覆盖成标量）
 *
 * 数据获取与写操作走 apiMock 闭环（api-mock.js 实际暴露方法，不臆造）：
 *   getAppConfig/setAppConfig · getLlmStatus/setLlmSlot/clearLlmSlot/setLlmKey/deleteLlmKey ·
 *   getEmbedderStatus/warmupEmbedder/clearEmbedderCache · getRulesets/setRuleset/resetRuleset ·
 *   getNovelJson/setNovelJson · getEnvConfig/setEnvConfig · getVersion · getDoctor
 * 复用 app.js：escapeHtml / icon / $ / toast / openModal / closeModal / apiCall / handleApiError /
 *   render / routeId / viewState / navigate / formatTime / refreshIcons；复用 demo-utils.js：DemoUtils.countWords
 */

// ==================== 常量 ====================

const SETTINGS_PANELS = [
  { id: 'models',       group: 'app',     label: '模型配置', icon: 'smile' },
  { id: 'keys',         group: 'app',     label: '密钥管理', icon: 'key' },
  { id: 'embedder',     group: 'app',     label: '向量模型', icon: 'layers' },
  { id: 'app-prefs',    group: 'app',     label: '应用偏好', icon: 'settings' },
  { id: 'about',        group: 'app',     label: '关于',     icon: 'info' },
  { id: 'rulesets',     group: 'project', label: '规则集',   icon: 'file-text' },
  { id: 'project-info', group: 'project', label: '项目信息', icon: 'folder' },
  { id: 'env',          group: 'project', label: '环境变量', icon: 'terminal' },
];

const SET_SLOT_META = {
  default:   { name: '默认',     desc: '所有未单独配置的请求使用' },
  planner:   { name: '策划',     desc: '剧情策划与方案生成' },
  role:      { name: '角色演绎', desc: '角色对话与扮演' },
  reasoning: { name: '推理',     desc: '世界图推理与可见性' },
  renderer:  { name: '渲染',     desc: '章节正文渲染' },
};
const SET_SLOT_ORDER = ['default', 'planner', 'role', 'reasoning', 'renderer'];

const SET_PROVIDERS = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', '自定义'];

const SET_RULESET_TABS = [
  { id: 'render',  label: '渲染', file: 'render.md' },
  { id: 'role',    label: '角色', file: 'role.md' },
  { id: 'planner', label: '规划', file: 'planner.md' },
];

// ==================== 状态访问器（命名空间 + 平面双写） ====================

function settingsState(key, fallback) {
  const ns = viewState('settings');
  if (ns[key] !== undefined) return ns[key];
  if (App.viewState[key] !== undefined) return App.viewState[key];
  return fallback;
}

function setSettingsState(key, value) {
  viewState('settings')[key] = value;
  App.viewState[key] = value;
}

// ==================== 转义（onclick 内联参数，本地定义不依赖 views.js q()） ====================

// JS 字面量转义：转义反斜杠/单引号/换行，使 slot id、provider 名等可安全内联到 onclick 单引号串中
function settingsJs(str) {
  return "'" + String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r') + "'";
}

function settingsCountWords(text) {
  if (typeof DemoUtils !== 'undefined' && DemoUtils.countWords) return DemoUtils.countWords(text || '');
  return String(text || '').replace(/\s/g, '').length;
}

function settingsMaskKey(value) {
  if (!value) return '••••••••';
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

// ==================== 数据加载（覆盖 viewLoaders.settings） ====================

async function settingsLoad() {
  const appConfig = await apiCall('getAppConfig');
  setSettingsState('setAppConfig', appConfig);

  const llmData = await apiCall('getLlmStatus');
  const llm = llmData.slots || {};
  setSettingsState('setLlmStatus', llm);

  // 本地密钥列表：首次从 llm 状态派生（哪些 provider 有密钥），后续保留用户增删
  if (settingsState('setKeys', null) === null) {
    setSettingsState('setKeys', settingsDeriveKeys(llm));
  }

  // 项目级数据：仅在激活项目时拉取（getRulesets/getNovelJson/getEnvConfig 内部 requireActiveProject）
  if (App.activeProject) {
    try {
      const rulesetData = await apiCall('getRulesets');
      setSettingsState('setRulesets', Object.fromEntries((rulesetData.rulesets || []).map((item) => [item.name, item.content])));
    } catch (e) { /* 无项目则保留空 */ }
    try {
      const novelData = await apiCall('getNovelJson');
      setSettingsState('setNovelJson', novelData.data || {});
    } catch (e) {}
    try {
      const env = await apiCall('getEnvConfig');
      setSettingsState('setEnvConfig', env.values || {});
      if (settingsState('setPiDebug', null) === null) {
        setSettingsState('setPiDebug', env.values.PI_DEBUG === 'on' || env.values.PI_DEBUG === 'true');
      }
    } catch (e) {}
  }

  // 应用级数据
  try { setSettingsState('setEmbedder', await apiCall('getEmbedderStatus')); } catch (e) {}
  try { setSettingsState('setVersion', await apiCall('getVersion')); } catch (e) {}
  try { setSettingsState('setDoctor', await apiCall('getDoctor')); } catch (e) {}

  // 本地 UI 状态惰性初始化
  if (settingsState('setActivePanel', null) === null) setSettingsState('setActivePanel', 'models');
  if (settingsState('setRulesetTab', null) === null) setSettingsState('setRulesetTab', 'render');
  if (settingsState('setAutosave', null) === null) setSettingsState('setAutosave', appConfig.autosave !== false);
  if (settingsState('setCustomizing', null) === null) setSettingsState('setCustomizing', []);
}

viewLoaders.settings = settingsLoad;

function settingsDeriveKeys(llm) {
  const map = {};
  (Object.keys(llm || {})).forEach((slot) => {
    const s = llm[slot];
    if (s && s.hasKey) {
      const p = (s.configured && s.configured.provider) || (s.resolved && s.resolved.provider);
      if (p && !map[p]) map[p] = { provider: p, value: '', visible: false };
    }
  });
  return Object.keys(map).map((p) => map[p]);
}

// ==================== 渲染入口 ====================

ViewRender.settings = () => settingsLayoutHtml();

ViewAfterRender.settings = () => {
  refreshIcons();
};

function settingsLayoutHtml() {
  const activePanel = settingsState('setActivePanel', 'models');
  return `
    <div class="set-container">
      <aside class="set-sidebar">
        ${settingsSidebarHtml()}
      </aside>
      <main class="set-main">
        ${settingsPanelHtml(activePanel)}
      </main>
    </div>`;
}

// ---------- 左侧二级导航 ----------

function settingsSidebarHtml() {
  const active = settingsState('setActivePanel', 'models');
  const appPanels = SETTINGS_PANELS.filter((p) => p.group === 'app');
  const projPanels = SETTINGS_PANELS.filter((p) => p.group === 'project');
  return `
    <div class="set-section">
      <div class="set-section-title">应用配置</div>
      ${appPanels.map((p) => settingsNavItemHtml(p, active)).join('')}
    </div>
    <div class="set-section">
      <div class="set-section-title">项目配置</div>
      ${projPanels.map((p) => settingsNavItemHtml(p, active)).join('')}
    </div>`;
}

function settingsNavItemHtml(p, active) {
  return `
    <div class="set-nav-item ${p.id === active ? 'set-nav-item-active' : ''}" onclick="settingsSwitchPanel(${settingsJs(p.id)})">
      ${icon(p.icon, 'w-4 h-4')}
      <span>${escapeHtml(p.label)}</span>
    </div>`;
}

function settingsSwitchPanel(panelId) {
  setSettingsState('setActivePanel', panelId);
  renderView();
}

function settingsPanelHtml(panelId) {
  switch (panelId) {
    case 'models':        return settingsPanelModels();
    case 'keys':          return settingsPanelKeys();
    case 'embedder':      return settingsPanelEmbedder();
    case 'app-prefs':     return settingsPanelAppPrefs();
    case 'about':         return settingsPanelAbout();
    case 'rulesets':      return settingsPanelRulesets();
    case 'project-info':  return settingsPanelProjectInfo();
    case 'env':           return settingsPanelEnv();
    default:              return settingsPanelModels();
  }
}

// ==================== 面板：模型配置 ====================

function settingsPanelModels() {
  const llm = settingsState('setLlmStatus', {}) || {};
  return `
    <div>
      <h1 class="set-page-title">模型配置</h1>
      <p class="set-page-desc">为不同用途配置模型，未配置的 slot 会使用默认模型</p>

      <div class="set-model-table">
        <div class="set-model-header">
          <div>用途</div>
          <div>来源</div>
          <div>Provider</div>
          <div>Model</div>
          <div>密钥状态</div>
          <div>操作</div>
        </div>
        ${SET_SLOT_ORDER.map((slot) => settingsSlotRowHtml(slot, llm[slot])).join('')}
      </div>

      <p class="set-badge-legend">
        <strong>提示：</strong>来源徽章说明 —
        <span class="set-badge set-badge-configured">slot 已配</span> 该 slot 有独立配置；
        <span class="set-badge set-badge-default">跟随默认</span> 继承默认模型；
        <span class="set-badge set-badge-env">环境变量</span> 由环境变量覆盖；
        <span class="set-badge set-badge-none">未配置</span> 未配置任何模型。
      </p>
    </div>`;
}

function settingsSlotRowHtml(slot, status) {
  status = status || {};
  const meta = SET_SLOT_META[slot] || { name: slot, desc: '' };
  const customizing = settingsIsCustomizing(slot);
  const inherited = status.source !== 'slot' && !customizing;
  const provider = inherited
    ? (status.resolved && status.resolved.provider) || ''
    : (status.configured && status.configured.provider) || (status.resolved && status.resolved.provider) || '';
  const model = inherited
    ? (status.resolved && status.resolved.model) || ''
    : (status.configured && status.configured.model) || (status.resolved && status.resolved.model) || '';
  const hasKey = !!status.hasKey;
  const isDefault = slot === 'default';

  const actions = inherited
    ? `<button class="set-btn set-btn-ghost set-btn-sm set-btn-primary-text" onclick="settingsCustomizeSlot(${settingsJs(slot)})">${icon('pencil', 'w-3.5 h-3.5')} 自定义</button>`
    : `<button class="set-btn set-btn-primary set-btn-sm" onclick="settingsSaveSlot(${settingsJs(slot)})">${icon('save', 'w-3.5 h-3.5')} 保存</button>
       ${isDefault ? '' : `<button class="set-btn set-btn-ghost set-btn-sm" onclick="settingsClearSlot(${settingsJs(slot)})">清除</button>`}`;

  return `
    <div class="set-model-row${inherited ? ' set-model-row-inherited' : ''}">
      <div class="set-slot-purpose">
        <div class="set-slot-name">${escapeHtml(meta.name)}</div>
        <div class="set-slot-desc">${escapeHtml(meta.desc)}</div>
      </div>
      <div class="set-slot-source">${settingsSourceBadge(status.source, customizing)}</div>
      <div class="set-slot-field">
        <select class="set-select" ${inherited ? 'disabled' : ''} id="set-provider-${escapeHtml(slot)}">${settingsProviderOptions(provider)}</select>
      </div>
      <div class="set-slot-field">
        <input type="text" class="set-input" value="${escapeHtml(model)}" ${inherited ? 'disabled' : ''} id="set-model-${escapeHtml(slot)}">
      </div>
      <div class="set-key-status ${hasKey ? 'set-key-status-has' : 'set-key-status-none'}">
        ${icon(hasKey ? 'check' : 'x', 'w-3.5 h-3.5')}
        ${hasKey ? '已配置' : '未配置'}
      </div>
      <div class="set-slot-actions">${actions}</div>
    </div>`;
}

function settingsSourceBadge(source, customizing) {
  if (customizing || source === 'slot') return `<span class="set-badge set-badge-configured">slot 已配</span>`;
  if (source === 'default') return `<span class="set-badge set-badge-default">跟随默认</span>`;
  if (source === 'env') return `<span class="set-badge set-badge-env">环境变量</span>`;
  return `<span class="set-badge set-badge-none">未配置</span>`;
}

function settingsProviderOptions(actual) {
  const opts = SET_PROVIDERS.slice();
  if (actual && opts.indexOf(actual) < 0) opts.push(actual);
  return opts.map((p) => `<option ${p === actual ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
}

function settingsIsCustomizing(slot) {
  const list = settingsState('setCustomizing', []) || [];
  return list.indexOf(slot) >= 0;
}

function settingsCustomizeSlot(slot) {
  const list = (settingsState('setCustomizing', []) || []).slice();
  if (list.indexOf(slot) < 0) list.push(slot);
  setSettingsState('setCustomizing', list);
  renderView();
}

async function settingsSaveSlot(slot) {
  const providerEl = $('#set-provider-' + slot);
  const modelEl = $('#set-model-' + slot);
  const provider = providerEl ? providerEl.value : '';
  const model = modelEl ? modelEl.value : '';
  try {
    await apiCall('setLlmSlot', slot, provider, model);
  } catch (e) { handleApiError(e); return; }
  const list = (settingsState('setCustomizing', []) || []).filter((s) => s !== slot);
  setSettingsState('setCustomizing', list);
  await settingsLoad();
  toast('模型配置已保存', 'success');
  renderView();
}

async function settingsClearSlot(slot) {
  if (slot === 'default') { toast('默认 slot 不能清除', 'info'); return; }
  openModal('清除模型配置',
    `<p>确定要清除「<strong>${escapeHtml(SET_SLOT_META[slot]?.name || slot)}</strong>」的独立配置吗？</p>
     <p class="text-xs text-muted">清除后将跟随默认模型。</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-primary" onclick="settingsConfirmClearSlot(${settingsJs(slot)})">清除</button>`);
}

async function settingsConfirmClearSlot(slot) {
  closeModal();
  try {
    await apiCall('clearLlmSlot', slot);
  } catch (e) { handleApiError(e); return; }
  const list = (settingsState('setCustomizing', []) || []).filter((s) => s !== slot);
  setSettingsState('setCustomizing', list);
  await settingsLoad();
  toast('已恢复跟随默认', 'info');
  renderView();
}

// ==================== 面板：密钥管理 ====================

function settingsPanelKeys() {
  const keys = settingsState('setKeys', []) || [];
  return `
    <div>
      <h1 class="set-page-title">密钥管理</h1>
      <p class="set-page-desc">API Key 仅本地存储，服务端不回显明文</p>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">已配置密钥</div></div>
        <div class="set-card-body">
          ${keys.length
            ? `<div class="set-key-list">${keys.map((k, i) => settingsKeyItemHtml(k, i)).join('')}</div>`
            : `<div class="set-empty set-empty-inline"><div class="set-empty-icon">${icon('key', 'w-6 h-6')}</div><div class="set-empty-desc">尚未配置任何 API Key</div></div>`}
        </div>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">添加密钥</div></div>
        <div class="set-card-body">
          <div class="set-form-row">
            <div class="set-field">
              <label>Provider</label>
              <select class="set-select" id="set-key-provider">${settingsProviderOptions(SET_PROVIDERS[0])}</select>
            </div>
            <div class="set-field">
              <label>API Key</label>
              <div class="set-pw-wrap">
                <input type="password" class="set-input" placeholder="sk-..." id="set-key-value" spellcheck="false" autocomplete="off">
                <button class="set-pw-toggle" title="显示/隐藏" onclick="settingsToggleKeyInput()">${icon('eye', 'w-3.5 h-3.5')}</button>
              </div>
            </div>
          </div>
          <div class="set-form-actions">
            <button class="set-btn set-btn-primary" onclick="settingsSaveKey()">${icon('save', 'w-3.5 h-3.5')} 保存密钥</button>
          </div>
        </div>
      </div>
    </div>`;
}

function settingsKeyItemHtml(k, i) {
  const display = k.visible ? (k.value || '（已加密，未回显）') : settingsMaskKey(k.value);
  return `
    <div class="set-key-item">
      <div class="set-key-info">
        <span class="set-key-name">${escapeHtml(k.provider)}</span>
        <span class="set-key-value">${escapeHtml(display)}</span>
        <span class="set-key-status-row">${icon('check', 'w-3.5 h-3.5')} 已配置</span>
      </div>
      <div class="set-key-actions">
        <button class="set-btn set-btn-ghost set-btn-sm" title="显示/隐藏" onclick="settingsToggleKeyVisible(${i})">${icon(k.visible ? 'eye-off' : 'eye', 'w-3.5 h-3.5')}</button>
        <button class="set-btn set-btn-danger set-btn-sm" onclick="settingsDeleteKey(${i})">删除</button>
      </div>
    </div>`;
}

function settingsToggleKeyInput() {
  const el = $('#set-key-value');
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

function settingsToggleKeyVisible(i) {
  const keys = (settingsState('setKeys', []) || []).slice();
  if (!keys[i]) return;
  keys[i] = { provider: keys[i].provider, value: keys[i].value, visible: !keys[i].visible };
  setSettingsState('setKeys', keys);
  renderView();
}

async function settingsSaveKey() {
  const providerEl = $('#set-key-provider');
  const valueEl = $('#set-key-value');
  const provider = providerEl ? providerEl.value : '';
  const value = valueEl ? valueEl.value : '';
  if (!provider) { toast('请选择 Provider', 'error'); return; }
  if (!value) { toast('请输入 API Key', 'error'); return; }
  try {
    await apiCall('setLlmKey', provider, value);
  } catch (e) { handleApiError(e); return; }
  const keys = (settingsState('setKeys', []) || []).slice();
  const idx = keys.findIndex((k) => k.provider === provider);
  if (idx >= 0) keys[idx] = { provider, value, visible: false };
  else keys.push({ provider, value, visible: false });
  setSettingsState('setKeys', keys);
  await settingsLoad(); // 同步 llmStatus 的 hasKey 显示
  toast('密钥已保存', 'success');
  renderView();
}

function settingsDeleteKey(i) {
  const keys = (settingsState('setKeys', []) || []).slice();
  const k = keys[i];
  if (!k) return;
  openModal('删除密钥',
    `<p>确定要删除「<strong>${escapeHtml(k.provider)}</strong>」的 API Key 吗？此操作不可撤销。</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-destructive" onclick="settingsConfirmDeleteKey(${i})">删除</button>`);
}

async function settingsConfirmDeleteKey(i) {
  const keys = (settingsState('setKeys', []) || []).slice();
  const k = keys[i];
  if (!k) { closeModal(); return; }
  closeModal();
  try {
    await apiCall('deleteLlmKey', k.provider);
  } catch (e) { handleApiError(e); return; }
  keys.splice(i, 1);
  setSettingsState('setKeys', keys);
  await settingsLoad();
  toast('密钥已删除', 'info');
  renderView();
}

// ==================== 面板：向量模型 ====================

function settingsPanelEmbedder() {
  const st = settingsState('setEmbedder', {}) || {};
  const model = st.model || '—';
  const dims = st.dim != null ? st.dim : '—';
  const cache = st.cacheSizeBytes != null ? `${Math.round(st.cacheSizeBytes / 1024)} KB` : '—';
  const warmed = !!st.cachePresent;
  return `
    <div>
      <h1 class="set-page-title">向量模型</h1>
      <p class="set-page-desc">配置嵌入模型，用于语义检索与世界图推理</p>

      <div class="set-embedder-status">
        <div class="set-embedder-stat">
          <div class="set-embedder-label">模型</div>
          <div class="set-embedder-value set-mono">${escapeHtml(String(model))}</div>
        </div>
        <div class="set-embedder-stat">
          <div class="set-embedder-label">维度</div>
          <div class="set-embedder-value">${escapeHtml(String(dims))}</div>
        </div>
        <div class="set-embedder-stat">
          <div class="set-embedder-label">缓存状态</div>
          <div class="set-embedder-value set-embedder-cache">${warmed ? '已缓存' : '无缓存'} · ${cache}</div>
        </div>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">操作</div></div>
        <div class="set-card-body">
          <div class="set-btn-row">
            <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsWarmupEmbedder()">${icon('play', 'w-3 h-3')} 预热模型</button>
            <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsClearEmbedderCache()">${icon('trash-2', 'w-3 h-3')} 清除缓存</button>
          </div>
        </div>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">修改模型</div></div>
        <div class="set-card-body">
          <div class="set-field">
            <label>嵌入模型名称</label>
            <input type="text" class="set-input set-mono" value="${escapeHtml(String(model))}" id="set-embedder-model-input">
            <span class="set-field-hint">修改后将写入项目 .env 或应用全局配置</span>
          </div>
          <div class="set-form-actions">
            <button class="set-btn set-btn-primary set-btn-sm" onclick="settingsSaveEmbedderModel()">${icon('save', 'w-3.5 h-3.5')} 保存模型配置</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function settingsWarmupEmbedder() {
  try { await apiCall('warmupEmbedder'); } catch (e) { handleApiError(e); return; }
  const st = settingsState('setEmbedder', {}) || {};
  setSettingsState('setEmbedder', { ...st, cachePresent: true });
  toast('预热请求已发送', 'success');
  renderView();
}

function settingsClearEmbedderCache() {
  openModal('清除向量缓存',
    `<p>确定要清除向量缓存吗？下次查询将重新计算嵌入。</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-destructive" onclick="settingsConfirmClearCache()">清除</button>`);
}

async function settingsConfirmClearCache() {
  closeModal();
  try { await apiCall('clearEmbedderCache'); } catch (e) { handleApiError(e); return; }
  const st = settingsState('setEmbedder', {}) || {};
  setSettingsState('setEmbedder', { ...st, cachePresent: false, cacheSizeBytes: 0 });
  toast('向量缓存已清除', 'info');
  renderView();
}

async function settingsSaveEmbedderModel() {
  const el = $('#set-embedder-model-input');
  const value = el ? el.value.trim() : '';
  if (!value) { toast('模型名称不能为空', 'error'); return; }
  try {
    await apiCall('setAppConfig', { embedder: { model: value } });
    if (App.activeProject) { try { await apiCall('setEnvConfig', { PI_EMBEDDER_MODEL: value }); } catch (e) { /* 项目级失败不阻塞 */ } }
  } catch (e) { handleApiError(e); return; }
  const st = settingsState('setEmbedder', {}) || {};
  setSettingsState('setEmbedder', { ...st, model: value });
  toast('嵌入模型已保存', 'success');
  renderView();
}

// ==================== 面板：应用偏好 ====================

function settingsPanelAppPrefs() {
  const cfg = settingsState('setAppConfig', {}) || {};
  const theme = cfg.theme || 'light';
  const fontSize = cfg.editorFontSize || 16;
  const autosave = settingsState('setAutosave', cfg.autosave !== false);
  const interval = cfg.autosaveInterval || 30;
  const rootDir = (cfg.launcher && cfg.launcher.defaultScanRoots && cfg.launcher.defaultScanRoots[0]) || '';
  return `
    <div>
      <h1 class="set-page-title">应用偏好</h1>
      <p class="set-page-desc">自定义应用外观与行为偏好</p>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">主题</div></div>
        <div class="set-card-body">
          <div class="set-theme-options">
            ${settingsThemeOptionHtml('light', theme, '浅色', 'linear-gradient(135deg,#faf9f5 50%,#f5f4ef 50%)')}
            ${settingsThemeOptionHtml('dark', theme, '深色', 'linear-gradient(135deg,#262624 50%,#2c2c2b 50%)')}
            ${settingsThemeOptionHtml('system', theme, '跟随系统', 'linear-gradient(135deg,#faf9f5 50%,#262624 50%)')}
          </div>
        </div>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">编辑器</div></div>
        <div class="set-card-body">
          <div class="set-slider-row">
            <div class="set-slider-info">
              <div class="set-slider-label">编辑器字号</div>
              <div class="set-slider-desc">正文与代码编辑器的基础字号</div>
            </div>
            <div class="set-slider-ctl">
              <input type="range" class="set-slider-input" min="12" max="24" value="${fontSize}" id="set-font-slider" oninput="settingsOnFontSlider(this.value)">
              <span class="set-slider-value" id="set-font-value">${fontSize} px</span>
            </div>
          </div>
          <div class="set-toggle-row">
            <div>
              <div class="set-toggle-label">自动保存</div>
              <div class="set-toggle-desc">每隔指定间隔自动保存修改</div>
            </div>
            <div class="set-toggle-inline">
              <div class="set-switch ${autosave ? 'set-switch-on' : ''}" id="set-autosave-switch" onclick="settingsToggleLocal('setAutosave', this)"></div>
              <div class="set-interval-ctl">
                <input type="number" class="set-input set-interval-input" value="${interval}" id="set-autosave-interval">
                <span class="set-interval-suffix">秒</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">文件</div></div>
        <div class="set-card-body">
          <div class="set-field">
            <label>默认扫描根目录</label>
            <div class="set-dir-row">
              <input type="text" class="set-input set-mono set-dir-input" value="${escapeHtml(rootDir)}" id="set-root-dir">
              <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsBrowseRoot()">${icon('folder-open', 'w-3.5 h-3.5')} 浏览</button>
            </div>
          </div>
          <div class="set-form-actions">
            <button class="set-btn set-btn-primary set-btn-sm" onclick="settingsSaveAppPrefs()">${icon('save', 'w-3.5 h-3.5')} 保存偏好</button>
          </div>
        </div>
      </div>
    </div>`;
}

function settingsThemeOptionHtml(value, current, label, gradient) {
  return `
    <div class="set-theme-option ${value === current ? 'set-theme-option-active' : ''}" onclick="settingsSetTheme(${settingsJs(value)})">
      <div class="set-theme-preview" style="background:${gradient};"></div>
      <div class="set-theme-name">${escapeHtml(label)}</div>
    </div>`;
}

function settingsOnFontSlider(v) {
  const el = $('#set-font-value');
  if (el) el.textContent = v + ' px';
}

function settingsToggleLocal(stateKey, el) {
  const cur = settingsState(stateKey, false);
  setSettingsState(stateKey, !cur);
  if (el) el.classList.toggle('set-switch-on', !cur);
}

function settingsBrowseRoot() {
  toast('文件浏览器为演示环境不可用，请手动输入路径', 'info');
}

async function settingsSaveAppPrefs() {
  const fontEl = $('#set-font-slider');
  const intervalEl = $('#set-autosave-interval');
  const rootEl = $('#set-root-dir');
  const patch = {
    editorFontSize: fontEl ? parseInt(fontEl.value, 10) || 16 : 16,
    autosave: !!settingsState('setAutosave', true),
    autosaveInterval: intervalEl ? parseInt(intervalEl.value, 10) || 30 : 30,
  };
  if (rootEl && rootEl.value.trim()) {
    patch.launcher = { defaultScanRoots: [rootEl.value.trim()] };
  }
  try {
    await apiCall('setAppConfig', patch);
  } catch (e) { handleApiError(e); return; }
  const cfg = settingsState('setAppConfig', {}) || {};
  setSettingsState('setAppConfig', { ...cfg, ...patch });
  toast('应用偏好已保存', 'success');
  renderView();
}

// ---------- 主题：显式赋值（修复旧 views.js toggleTheme 取反 bug） ----------

async function settingsSetTheme(themeChoice) {
  settingsApplyTheme(themeChoice); // 显式赋值 App.theme + className，非取反
  try {
    await apiCall('setAppConfig', { theme: themeChoice });
  } catch (e) { handleApiError(e); return; }
  const cfg = settingsState('setAppConfig', {}) || {};
  setSettingsState('setAppConfig', { ...cfg, theme: themeChoice });
  const label = themeChoice === 'system' ? '跟随系统' : (themeChoice === 'dark' ? '深色' : '浅色');
  toast('主题已切换为' + label, 'success');
  render();
}

// 关键修复：显式赋值，而非取反（旧 views.js saveAppConfig 用 toggleTheme() 取反，
// 当用户选择与当前相同的主题时会误切换）
function settingsApplyTheme(themeChoice) {
  let resolved = themeChoice;
  if (themeChoice === 'system') {
    const mm = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    resolved = (mm && mm.matches) ? 'dark' : 'light';
  }
  App.theme = resolved;                       // 显式赋值
  document.documentElement.className = resolved; // 显式赋值
}

// ==================== 面板：关于 ====================

function settingsPanelAbout() {
  const ver = settingsState('setVersion', {}) || {};
  const doctor = settingsState('setDoctor', {}) || {};
  const local = ver.local || '—';
  return `
    <div>
      <h1 class="set-page-title">关于</h1>
      <p class="set-page-desc">应用信息与环境检查</p>

      <div class="set-about">
        <div class="set-about-logo">N</div>
        <div class="set-about-name">Narrative Engine</div>
        <div class="set-about-version">v${escapeHtml(String(local))}</div>
        <button class="set-btn set-btn-secondary" onclick="settingsCheckUpdate()">${icon('refresh-cw', 'w-3.5 h-3.5')} 检查更新</button>
      </div>

      <div class="set-doctor">
        <div class="set-doctor-header">
          <div class="set-doctor-title">${icon('activity', 'w-4 h-4')} 环境自检 (Doctor)</div>
          <button class="set-btn set-btn-primary set-btn-sm" onclick="settingsRunDoctor()">${icon('play', 'w-3 h-3')} 运行检查</button>
        </div>
        <div class="set-doctor-list">
          ${(doctor.checks || []).map((c) => settingsDoctorItemHtml(c)).join('')}
        </div>
      </div>
    </div>`;
}

function settingsDoctorItemHtml(c) {
  const status = c.status || 'ok';
  const isWarn = status === 'warn' || status === 'warning';
  const cls = status === 'ok' ? 'set-doctor-icon-success' : (isWarn ? 'set-doctor-icon-warning' : 'set-doctor-icon-error');
  const ic = status === 'ok' ? 'check' : (isWarn ? 'triangle-alert' : 'x');
  const desc = c.desc || (status === 'ok' ? '正常' : (isWarn ? '有警告' : '异常'));
  return `
    <div class="set-doctor-item">
      <div class="set-doctor-icon ${cls}">${icon(ic, 'w-3.5 h-3.5')}</div>
      <div class="set-doctor-info">
        <div class="set-doctor-name">${escapeHtml(c.name)}</div>
        <div class="set-doctor-desc">${escapeHtml(desc)}</div>
      </div>
    </div>`;
}

async function settingsCheckUpdate() {
  try {
    const v = await apiCall('getVersion');
    setSettingsState('setVersion', v);
    if (v.updateAvailable) toast('发现新版本 v' + v.remote, 'success');
    else toast('已是最新版本', 'info');
    renderView();
  } catch (e) { handleApiError(e); }
}

async function settingsRunDoctor() {
  try {
    const d = await apiCall('getDoctor');
    setSettingsState('setDoctor', d);
    toast('环境自检完成：' + d.passed + ' 项通过 / ' + d.warnings + ' 警告 / ' + d.failures + ' 失败', d.ok ? 'success' : 'error');
    renderView();
  } catch (e) { handleApiError(e); }
}

// ==================== 面板：规则集 ====================

function settingsPanelRulesets() {
  if (!App.activeProject) return settingsNeedProjectHtml('规则集');
  const rulesets = settingsState('setRulesets', {}) || {};
  const tab = settingsState('setRulesetTab', 'render');
  const meta = SET_RULESET_TABS.find((t) => t.id === tab) || SET_RULESET_TABS[0];
  const content = rulesets[tab] || '';
  const count = settingsCountWords(content);
  return `
    <div>
      <h1 class="set-page-title">规则集</h1>
      <p class="set-page-desc">管理各模块的系统提示与推理规则</p>

      <div class="set-rules-tabs">
        ${SET_RULESET_TABS.map((t) => `<div class="set-rules-tab ${t.id === tab ? 'set-rules-tab-active' : ''}" onclick="settingsSwitchRuleset(${settingsJs(t.id)})">${escapeHtml(t.label)}</div>`).join('')}
      </div>

      <div class="set-rule-editor">
        <div class="set-rule-header">
          <span class="set-rule-title">${escapeHtml(meta.label)}规则</span>
          <div class="set-rule-actions">
            <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsResetRuleset(${settingsJs(tab)})">${icon('rotate-ccw', 'w-3 h-3')} 恢复模板</button>
            <button class="set-btn set-btn-primary set-btn-sm" onclick="settingsSaveRuleset(${settingsJs(tab)})">${icon('save', 'w-3 h-3')} 保存</button>
          </div>
        </div>
        <textarea class="set-rule-textarea" id="set-ruleset-textarea" oninput="settingsOnRulesetInput(this.value)" spellcheck="false">${escapeHtml(content)}</textarea>
        <div class="set-rule-footer">
          <span class="set-word-count" id="set-word-count">${count} 字</span>
          <span class="set-rule-file">${escapeHtml(meta.file)}</span>
        </div>
      </div>
    </div>`;
}

function settingsSwitchRuleset(tab) {
  setSettingsState('setRulesetTab', tab);
  renderView();
}

function settingsOnRulesetInput(value) {
  const wc = $('#set-word-count');
  if (wc) wc.textContent = settingsCountWords(value) + ' 字';
}

async function settingsSaveRuleset(tab) {
  const el = $('#set-ruleset-textarea');
  const content = el ? el.value : '';
  try {
    await apiCall('setRuleset', tab, content);
  } catch (e) { handleApiError(e); return; }
  const rulesets = settingsState('setRulesets', {}) || {};
  setSettingsState('setRulesets', { ...rulesets, [tab]: content });
  toast('规则集已保存', 'success');
  renderView();
}

function settingsResetRuleset(tab) {
  const meta = SET_RULESET_TABS.find((t) => t.id === tab);
  openModal('恢复模板',
    `<p>确定要将「<strong>${escapeHtml(meta ? meta.label : tab)}</strong>规则」恢复为默认模板吗？当前修改将被覆盖。</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-primary" onclick="settingsConfirmResetRuleset(${settingsJs(tab)})">恢复</button>`);
}

async function settingsConfirmResetRuleset(tab) {
  closeModal();
  try {
    await apiCall('resetRuleset', tab);
  } catch (e) { handleApiError(e); return; }
  await settingsLoad();
  toast('已恢复默认模板', 'info');
  renderView();
}

// ==================== 面板：项目信息 ====================

function settingsPanelProjectInfo() {
  if (!App.activeProject) return settingsNeedProjectHtml('项目信息');
  const novel = settingsState('setNovelJson', {}) || {};
  const proj = App.activeProject;
  const meta = proj.meta || {};
  const created = meta.createdAt || proj.createdAt || '';
  const updated = meta.updatedAt || proj.updatedAt || '';
  return `
    <div>
      <h1 class="set-page-title">项目信息</h1>
      <p class="set-page-desc">当前项目的基础信息配置（novel.json）</p>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">${icon('file-text', 'w-4 h-4')} novel.json</div></div>
        <div class="set-card-body">
          <div class="set-field">
            <label>项目名称</label>
            <input type="text" class="set-input" value="${escapeHtml(novel.name || '')}" id="set-novel-name">
          </div>
          <div class="set-form-row">
            <div class="set-field">
              <label>章节目录</label>
              <input type="text" class="set-input" value="${escapeHtml(novel.chaptersDir || '')}" id="set-novel-chapters">
            </div>
            <div class="set-field">
              <label>故事时间格式</label>
              <input type="text" class="set-input set-mono" value="${escapeHtml(novel.storyTimeFormat || '')}" id="set-novel-storytime">
            </div>
          </div>
          <div class="set-meta-grid">
            <div class="set-meta-item"><span class="set-meta-label">项目路径</span><span class="set-meta-value set-mono">${escapeHtml(proj.relativePath || proj.dir || '')}</span></div>
            <div class="set-meta-item"><span class="set-meta-label">创建时间</span><span class="set-meta-value">${escapeHtml(formatTime(created))}</span></div>
            <div class="set-meta-item"><span class="set-meta-label">最后修改</span><span class="set-meta-value">${escapeHtml(formatTime(updated))}</span></div>
          </div>
          <div class="set-form-actions">
            <button class="set-btn set-btn-primary" onclick="settingsSaveNovelJson()">${icon('save', 'w-3.5 h-3.5')} 保存</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function settingsSaveNovelJson() {
  const nameEl = $('#set-novel-name');
  const chEl = $('#set-novel-chapters');
  const stEl = $('#set-novel-storytime');
  const patch = {
    name: nameEl ? nameEl.value : '',
    chaptersDir: chEl ? chEl.value : '',
    storyTimeFormat: stEl ? stEl.value : '',
  };
  try {
    await apiCall('setNovelJson', patch);
  } catch (e) { handleApiError(e); return; }
  const novel = settingsState('setNovelJson', {}) || {};
  setSettingsState('setNovelJson', { ...novel, ...patch });
  toast('novel.json 已保存', 'success');
  renderView();
}

// ==================== 面板：环境变量 ====================

function settingsPanelEnv() {
  if (!App.activeProject) return settingsNeedProjectHtml('环境变量');
  const env = settingsState('setEnvConfig', {}) || {};
  const piDebug = !!settingsState('setPiDebug', env.PI_DEBUG === 'on' || env.PI_DEBUG === 'true');
  return `
    <div>
      <h1 class="set-page-title">环境变量</h1>
      <p class="set-page-desc">项目级环境变量配置（白名单，不支持自定义键）</p>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">${icon('terminal', 'w-4 h-4')} 项目环境变量 (.env)</div></div>
        <div class="set-card-body">
          <div class="set-field">
            <label>HF_ENDPOINT</label>
            <input type="text" class="set-input set-mono" placeholder="留空则使用默认" value="${escapeHtml(env.HF_ENDPOINT || '')}" id="set-env-hf">
            <span class="set-field-hint">HuggingFace 镜像端点，留空则使用默认</span>
          </div>
          <div class="set-toggle-row">
            <div>
              <div class="set-toggle-label">PI_DEBUG</div>
              <div class="set-toggle-desc">启用详细调试日志输出</div>
            </div>
            <div class="set-switch ${piDebug ? 'set-switch-on' : ''}" id="set-pidebug-switch" onclick="settingsToggleLocal('setPiDebug', this)"></div>
          </div>
          <div class="set-field">
            <label>PI_EMBEDDER_MODEL</label>
            <input type="text" class="set-input set-mono" value="${escapeHtml(env.PI_EMBEDDER_MODEL || '')}" id="set-env-embedder">
            <span class="set-field-hint">覆盖默认嵌入模型名称</span>
          </div>
          <div class="set-form-actions">
            <button class="set-btn set-btn-primary" onclick="settingsSaveEnv()">${icon('save', 'w-3.5 h-3.5')} 保存环境变量</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function settingsSaveEnv() {
  const hfEl = $('#set-env-hf');
  const embEl = $('#set-env-embedder');
  const piDebug = !!settingsState('setPiDebug', false);
  const patch = {
    HF_ENDPOINT: hfEl && hfEl.value ? hfEl.value : null,
    PI_DEBUG: piDebug ? 'on' : 'off',
    PI_EMBEDDER_MODEL: embEl && embEl.value ? embEl.value : null,
  };
  try {
    await apiCall('setEnvConfig', patch);
  } catch (e) { handleApiError(e); return; }
  const env = settingsState('setEnvConfig', {}) || {};
  setSettingsState('setEnvConfig', Object.fromEntries(Object.entries({ ...env, ...patch }).filter(([, value]) => value !== null)));
  toast('环境变量已保存', 'success');
  renderView();
}

// ==================== 共用：无项目空状态 ====================

function settingsNeedProjectHtml(label) {
  return `
    <div>
      <h1 class="set-page-title">${escapeHtml(label)}</h1>
      <p class="set-page-desc">项目级配置</p>
      <div class="set-empty">
        <div class="set-empty-icon">${icon('folder-open', 'w-8 h-8')}</div>
        <div class="set-empty-title">需要先激活项目</div>
        <div class="set-empty-desc">该面板属于项目级配置，请先在项目管理中激活一个项目。</div>
        <button class="set-btn set-btn-primary set-btn-sm" onclick="navigate('#/projects')">${icon('folder-open', 'w-3.5 h-3.5')} 前往项目管理</button>
      </div>
    </div>`;
}
