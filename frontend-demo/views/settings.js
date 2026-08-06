/**
 * frontend-demo/views/settings.js — 设置视图（高保真重构，Task 10）
 *
 * 设计基准：narrative-engine-design/pages/settings.html
 * （左侧二级导航：应用配置[模型配置/厂商管理/向量模型/应用偏好/关于] + 项目配置[规则集/项目信息/环境变量]；
 *   模型配置（可用模型卡片[仅展示启用模型，默认空] + Slot 表：统一「模型」下拉按厂商分组，直接选择后保存/清除）；
 *   增加配置弹窗（选厂商[内置/自定义/新建] → 填密钥自动拉取模型 → 勾选启用 → 保存；移除=弹窗内取消勾选）；
 *   厂商管理（默认空，仅列已配置厂商：有启用模型或有密钥的内置/自定义；软移除=清启用+清密钥，可经弹窗配回）；
 *   密钥统一在厂商配置弹窗中管理（无独立密钥管理面板）；
 *   向量模型（状态卡、Warmup、清缓存、改模型）；
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
 *   - 数据键用 setActivePanel / setAppConfig / setLlmStatus / setEmbedder / setVersion /
 *     setDoctor / setRulesets / setRulesetTab / setNovelJson / setEnvConfig / setAutosave / setPiDebug
 *     等，避免与命名空间 routeId 'settings' 同名（防止双写把命名空间覆盖成标量）
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
  { id: 'providers',    group: 'app',     label: '厂商管理', icon: 'globe' },
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

// ==================== 数据加载（覆盖 viewLoaders.settings） ====================

async function settingsLoad() {
  // 快组：并行拉取与项目无关的配置（首屏渲染依赖）
  const [appConfig, llmData, provData] = await Promise.all([
    apiCall('getAppConfig'),
    apiCall('getLlmStatus'),
    apiCall('getLlmProviders'),
  ]);
  setSettingsState('setAppConfig', appConfig);
  settingsApplyScale(appConfig && appConfig.uiScale);

  const llm = llmData.slots || {};
  setSettingsState('setLlmStatus', llm);
  setSettingsState('setProviders', (provData && provData.providers) || []);

  // 项目级数据：并行（仅在激活项目时拉取，getRulesets/getNovelJson/getEnvConfig 内部 requireActiveProject）
  const projPromise = (async () => {
    if (!App.activeProject) return;
    const [rulesetData, novelData, env] = await Promise.allSettled([
      apiCall('getRulesets'),
      apiCall('getNovelJson'),
      apiCall('getEnvConfig'),
    ]);
    if (rulesetData.status === 'fulfilled') {
      setSettingsState('setRulesets', Object.fromEntries((rulesetData.value.rulesets || []).map((item) => [item.name, item.content])));
    }
    if (novelData.status === 'fulfilled') {
      setSettingsState('setNovelJson', novelData.value.data || {});
    }
    if (env.status === 'fulfilled') {
      setSettingsState('setEnvConfig', env.value.values || {});
      if (settingsState('setPiDebug', null) === null) {
        setSettingsState('setPiDebug', env.value.values.PI_DEBUG === 'on' || env.value.values.PI_DEBUG === 'true');
      }
    }
  })();

  // 本地 UI 状态惰性初始化
  if (settingsState('setActivePanel', null) === null) setSettingsState('setActivePanel', 'models');
  if (settingsState('setRulesetTab', null) === null) setSettingsState('setRulesetTab', 'render');
  if (settingsState('setAutosave', null) === null) setSettingsState('setAutosave', appConfig.autosave !== false);

  // 应用级数据：embedder 快，等它；version/doctor 慢（git），后台拉取不阻塞首屏
  try { setSettingsState('setEmbedder', await apiCall('getEmbedderStatus')); } catch (e) {}
  settingsLoadLazy();
  await projPromise;
}

// 慢组（version 走 git ls-remote 网络可达 10s+，doctor spawn git）：后台拉取，
// 到达后仅当仍在设置页且正查看 about 面板时刷新（不打断其他面板的编辑）
async function settingsLoadLazy() {
  const [v, d] = await Promise.allSettled([
    apiCall('getVersion'),
    apiCall('getDoctor'),
  ]);
  if (v.status === 'fulfilled') setSettingsState('setVersion', v.value);
  if (d.status === 'fulfilled') setSettingsState('setDoctor', d.value);
  if (routeId() === 'settings' && settingsState('setActivePanel', 'models') === 'about') {
    renderView();
  }
}

viewLoaders.settings = settingsLoad;

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
    case 'providers':     return settingsPanelProviders();
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
// 可用模型（仅展示）+ Slot 统一模型下拉；可用模型的增删统一在「厂商管理」面板的「增加配置」弹窗维护

// 全部可用模型：仅含用户显式启用的模型（默认空）
// 内置厂商 = enabledModelIds（弹窗勾选启用子集，存 llm.providerModels）；自定义厂商 = modelIds（勾选即启用）
function settingsAvailableModels() {
  const providers = settingsState('setProviders', []) || [];
  const out = [];
  providers.forEach((p) => {
    const ids = p.builtin ? (p.enabledModelIds || []) : (p.modelIds || []);
    ids.forEach((m) => {
      out.push({ providerId: p.id, providerName: p.name || p.id, modelId: m, builtin: !!p.builtin });
    });
  });
  return out;
}

// 模型编码：providerId + '::' + modelId（option value）
function settingsModelKey(providerId, modelId) {
  return providerId + '::' + modelId;
}

function settingsPanelModels() {
  const llm = settingsState('setLlmStatus', {}) || {};
  const models = settingsAvailableModels();
  return `
    <div>
      <h1 class="set-page-title">模型配置</h1>
      <p class="set-page-desc">为不同用途配置模型，未配置的 slot 会使用默认模型；可用模型在「厂商管理」中维护</p>

      <div class="set-card">
        <div class="set-card-header">
          <div class="set-card-title">${icon('list-checks', 'w-4 h-4')} 可用模型</div>
          <span class="set-muted">${models.length} 个</span>
        </div>
        <div class="set-card-body">
          ${models.length
            ? `<div class="set-avail-list">${models.map((m) => settingsAvailModelTagHtml(m)).join('')}</div>`
            : `<div class="set-empty set-empty-inline"><div class="set-empty-icon">${icon('globe', 'w-6 h-6')}</div><div class="set-empty-desc">暂无可用模型，请到「厂商管理」点击「增加配置」添加</div></div>`}
        </div>
      </div>

      <div class="set-model-table">
        <div class="set-model-header">
          <div>用途</div>
          <div>来源</div>
          <div>模型</div>
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

// 可用模型标签（厂商名 · 模型名，纯展示）
// 本页不提供移除：移除统一在「增加配置」弹窗中取消勾选（内置写启用子集、自定义写 modelIds），口径单一
function settingsAvailModelTagHtml(m) {
  return `
    <span class="set-avail-tag" title="${escapeHtml(m.providerId)} / ${escapeHtml(m.modelId)}">
      <span class="set-avail-provider">${escapeHtml(m.providerName)}</span>
      <span class="set-avail-model">${escapeHtml(m.modelId)}</span>
    </span>`;
}

function settingsSlotRowHtml(slot, status) {
  status = status || {};
  const meta = SET_SLOT_META[slot] || { name: slot, desc: '' };
  const configured = status.source === 'slot';
  const provider = (status.configured && status.configured.provider) || (status.resolved && status.resolved.provider) || '';
  const model = (status.configured && status.configured.model) || (status.resolved && status.resolved.model) || '';
  const hasKey = !!status.hasKey;
  const isDefault = slot === 'default';

  return `
    <div class="set-model-row${configured ? '' : ' set-model-row-inherited'}">
      <div class="set-slot-purpose">
        <div class="set-slot-name">${escapeHtml(meta.name)}</div>
        <div class="set-slot-desc">${escapeHtml(meta.desc)}</div>
      </div>
      <div class="set-slot-source">${settingsSourceBadge(status.source)}</div>
      <div class="set-slot-field">
        <select class="set-select" id="set-model-${escapeHtml(slot)}">${settingsModelOptions(provider, model)}</select>
      </div>
      <div class="set-key-status ${hasKey ? 'set-key-status-has' : 'set-key-status-none'}">
        ${icon(hasKey ? 'check' : 'x', 'w-3.5 h-3.5')}
        ${hasKey ? '已配置' : '未配置'}
      </div>
      <div class="set-slot-actions">
        <button class="set-btn set-btn-primary set-btn-sm" onclick="settingsSaveSlot(${settingsJs(slot)})">${icon('save', 'w-3.5 h-3.5')} 保存</button>
        ${isDefault || !configured ? '' : `<button class="set-btn set-btn-ghost set-btn-sm" onclick="settingsClearSlot(${settingsJs(slot)})">清除</button>`}
      </div>
    </div>`;
}

// 统一下拉：可用模型按厂商分组（optgroup）；当前值不在列表时保留占位项避免丢选择
function settingsModelOptions(actualProvider, actualModel) {
  const models = settingsAvailableModels();
  if (!models.length) return '<option value="">暂无可用模型，请先到「厂商管理」添加</option>';
  const actualKey = settingsModelKey(actualProvider, actualModel);
  const groups = {};
  models.forEach((m) => {
    (groups[m.providerName] = groups[m.providerName] || []).push(m);
  });
  let html = '';
  Object.keys(groups).forEach((name) => {
    html += `<optgroup label="${escapeHtml(name)}">` + groups[name].map((m) => {
      const key = settingsModelKey(m.providerId, m.modelId);
      return `<option value="${escapeHtml(key)}" ${key === actualKey ? 'selected' : ''}>${escapeHtml(m.modelId)}</option>`;
    }).join('') + '</optgroup>';
  });
  // 当前选中值若已不在可用列表（如被移除/厂商删除），保留占位项
  if (actualProvider && actualModel && !models.some((m) => settingsModelKey(m.providerId, m.modelId) === actualKey)) {
    html = `<option value="${escapeHtml(actualKey)}" selected>${escapeHtml(actualProvider)} / ${escapeHtml(actualModel)}</option>` + html;
  }
  return html;
}

function settingsSourceBadge(source) {
  if (source === 'slot') return `<span class="set-badge set-badge-configured">slot 已配</span>`;
  if (source === 'default') return `<span class="set-badge set-badge-default">跟随默认</span>`;
  if (source === 'env') return `<span class="set-badge set-badge-env">环境变量</span>`;
  return `<span class="set-badge set-badge-none">未配置</span>`;
}

// 保存 slot：从统一下拉值 'provider::model' 拆出两者
async function settingsSaveSlot(slot) {
  const modelEl = $('#set-model-' + slot);
  const key = modelEl ? modelEl.value : '';
  const sep = key.indexOf('::');
  if (sep <= 0) { toast('请选择可用模型', 'error'); return; }
  const provider = key.slice(0, sep);
  const model = key.slice(sep + 2);
  try {
    await apiCall('setLlmSlot', slot, provider, model);
  } catch (e) { handleApiError(e); return; }
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
  await settingsLoad();
  toast('已恢复跟随默认', 'info');
  renderView();
}

// ==================== 面板：厂商管理 ====================

// 已配置厂商：有启用模型或有密钥的（内置/自定义统一口径；面板默认空，不展示未配置厂商）
function settingsConfiguredProviders() {
  const providers = settingsState('setProviders', []) || [];
  return providers.filter((p) =>
    (p.enabledModelIds || []).length > 0 || settingsProviderHasKey(p));
}

function settingsPanelProviders() {
  const providers = settingsConfiguredProviders();
  return `
    <div>
      <div class="set-page-head">
        <div>
          <h1 class="set-page-title">厂商管理</h1>
          <p class="set-page-desc">选厂商 → 填密钥 → 自动拉取模型 → 勾选启用，启用后即可在「模型配置」中选用</p>
        </div>
        <button class="set-btn set-btn-primary" onclick="settingsOpenProviderForm()">${icon('plus', 'w-3.5 h-3.5')} 增加配置</button>
      </div>

      <div class="set-card">
        <div class="set-card-header"><div class="set-card-title">已配置厂商</div><span class="set-muted">${providers.length} 个</span></div>
        <div class="set-card-body">
          ${providers.length
            ? `<div class="set-provider-list">${providers.map((p) => settingsProviderRowHtml(p)).join('')}</div>`
            : `<div class="set-empty set-empty-inline"><div class="set-empty-icon">${icon('globe', 'w-6 h-6')}</div><div class="set-empty-desc">尚未配置任何厂商，点击右上角「增加配置」添加</div></div>`}
        </div>
      </div>
    </div>`;
}

// 统一厂商行：内置（只读）+ 自定义（可删除）共享卡片；模型标签只显示「启用模型」（内置=enabledModelIds，自定义=modelIds）
function settingsProviderRowHtml(p) {
  const hasKey = settingsProviderHasKey(p);
  const typeTag = p.builtin
    ? '<span class="set-provider-tag">内置</span>'
    : '<span class="set-provider-tag set-provider-tag-custom">自定义</span>';
  const models = p.builtin ? (p.enabledModelIds || []) : (p.modelIds || []);
  return `
    <div class="set-provider-card">
      <div class="set-provider-card-main">
        <div class="set-provider-card-title">${escapeHtml(p.name)} ${typeTag}</div>
        <div class="set-provider-card-desc">
          ${p.builtin ? '' : `<span class="set-mono">${escapeHtml(p.baseURL || '')}</span>`}
          <span class="set-provider-tag">${escapeHtml(p.apiKind || 'openai-completions')}</span>
        </div>
        <div class="set-provider-card-models">
          ${models.map((m) => `<span class="set-provider-model-tag">${escapeHtml(m)}</span>`).join('') || '<span class="set-muted">暂无启用模型，点击「配置」勾选</span>'}
        </div>
        <div class="set-key-status-row ${hasKey ? 'set-key-status-has' : 'set-key-status-none'}">${icon(hasKey ? 'check' : 'x', 'w-3.5 h-3.5')} ${hasKey ? '已配置密钥' : '未配置密钥'}</div>
      </div>
      <div class="set-key-actions">
        <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsOpenProviderForm(${settingsJs(p.id)})">${icon('sliders-horizontal', 'w-3.5 h-3.5')} 配置</button>
        ${p.builtin ? '' : `
        <button class="set-btn set-btn-secondary set-btn-sm" onclick="settingsTestProvider(${settingsJs(p.id)})">${icon('zap', 'w-3.5 h-3.5')} 测试连通</button>`}
        <button class="set-btn set-btn-danger set-btn-sm" onclick="settingsRemoveProvider(${settingsJs(p.id)})">移除</button>
      </div>
    </div>`;
}

// 密钥状态：优先后端 ProviderView.hasKey（内置/自定义均带）；缺省时从 llm slot 状态派生（兼容旧后端）
function settingsProviderHasKey(p) {
  if (p && p.hasKey !== undefined) return !!p.hasKey;
  const llm = settingsState('setLlmStatus', {}) || {};
  const id = p && p.id;
  return Object.keys(llm).some((slot) => {
    const s = llm[slot];
    if (!s || !s.hasKey) return false;
    const pid = (s.configured && s.configured.provider) || (s.resolved && s.resolved.provider) || '';
    return pid === id;
  });
}

// 统一配置弹窗：选厂商（内置/自定义/新建）→ 填密钥自动拉取模型 → 勾选启用 → 保存
function settingsOpenProviderForm(id) {
  const providers = settingsState('setProviders', []) || [];
  const prov = id ? providers.find((p) => p.id === id) : null;
  const builtinOpts = providers.filter((p) => p.builtin).map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  const customOpts = providers.filter((p) => !p.builtin).map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  openModal(prov ? `配置厂商 · ${prov.name}` : '增加配置',
    `<div class="set-form-modal">
      <div class="set-field">
        <label>厂商</label>
        <select class="set-select" id="set-provider-form-select" onchange="settingsOnProviderSelect()">
          ${builtinOpts ? `<optgroup label="内置厂商">${builtinOpts}</optgroup>` : ''}
          ${customOpts ? `<optgroup label="自定义厂商">${customOpts}</optgroup>` : ''}
          <option value="__new__" ${!prov ? 'selected' : ''}>＋ 新建自定义厂商</option>
        </select>
      </div>
      <div id="set-provider-form-fields">${settingsProviderFormFields(prov)}</div>
      <div class="set-field">
        <label>API Key</label>
        <div class="set-pw-wrap">
          <input type="password" class="set-input" id="set-provider-form-key" placeholder="sk-...（输入后自动拉取模型）" spellcheck="false" autocomplete="off" oninput="settingsOnProvKeyInput()">
          <button class="set-pw-toggle" title="显示/隐藏" onclick="settingsToggleProvKey()">${icon('eye', 'w-3.5 h-3.5')}</button>
        </div>
      </div>
      <div class="set-field">
        <div class="set-models-head">
          <label>启用模型</label>
          <span class="set-models-tools">
            <button type="button" class="set-btn set-btn-secondary set-btn-sm" onclick="settingsDetectModels()">${icon('search', 'w-3 h-3')} 检测模型</button>
            <button type="button" class="set-link-btn" onclick="settingsCheckAllModels(true)">全选</button>
            <button type="button" class="set-link-btn" onclick="settingsCheckAllModels(false)">清空</button>
          </span>
        </div>
        <div class="set-provider-models-box" id="set-provider-models-box">
          ${settingsProviderFormModelsHtml(prov)}
        </div>
        <span class="set-field-hint" id="set-provider-detect-hint">勾选加入可用列表，保存后生效</span>
      </div>
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-primary" onclick="settingsSaveProvider()">保存</button>`);
}

// 弹窗模型区初始内容：未选厂商给提示；内置给静态列表（预勾已启用子集）；自定义给已启用列表（预勾）
function settingsProviderFormModelsHtml(prov) {
  if (!prov) return '<span class="set-muted">选择厂商并填入 API Key 后自动拉取模型列表</span>';
  if (prov.builtin) return settingsProviderModelChecks(prov.modelIds || [], prov.enabledModelIds || []);
  return settingsProviderModelChecks(prov.modelIds || [], prov.modelIds || []);
}

// 根据当前选中厂商渲染字段区：内置为提示条（系统预置无需填连接信息）；自定义/新建为 ID/名称/BaseURL
function settingsProviderFormFields(prov) {
  if (prov && prov.builtin) {
    return `<div class="set-form-hint">${icon('info', 'w-3.5 h-3.5')} 内置厂商由系统预置，配置密钥并勾选启用模型即可</div>`;
  }
  const idVal = prov && prov.id ? prov.id : '';
  const nameVal = prov && prov.name ? prov.name : '';
  const urlVal = prov && prov.baseURL ? prov.baseURL : '';
  return `
    <div class="set-form-row">
      <div class="set-field"><label>ID</label><input type="text" class="set-input set-mono" id="set-provider-form-id" value="${escapeHtml(idVal)}" ${prov ? 'readonly' : ''} placeholder="如 my-groq（唯一，不可与内置冲突）"></div>
      <div class="set-field"><label>名称</label><input type="text" class="set-input" id="set-provider-form-name" value="${escapeHtml(nameVal)}" placeholder="如 My Groq"></div>
    </div>
    <div class="set-field"><label>Base URL</label><input type="text" class="set-input set-mono" id="set-provider-form-url" value="${escapeHtml(urlVal)}" placeholder="https://api.example.com/v1"></div>`;
}

// 厂商下拉切换：重渲染字段区与模型区（内置立即展示静态模型列表 = 自动匹配；自定义/新建等待密钥自动拉取）
function settingsOnProviderSelect() {
  const sel = $('#set-provider-form-select');
  const id = sel ? sel.value : '';
  const providers = settingsState('setProviders', []) || [];
  const prov = id === '__new__' ? null : providers.find((p) => p.id === id);
  const fields = $('#set-provider-form-fields');
  if (fields) fields.innerHTML = settingsProviderFormFields(prov);
  const box = $('#set-provider-models-box');
  const hint = $('#set-provider-detect-hint');
  if (id === '__new__') {
    if (box) box.innerHTML = '<span class="set-muted">填写信息并输入 API Key 后自动拉取模型列表</span>';
    if (hint) hint.textContent = '';
  } else if (prov && prov.builtin) {
    if (box) box.innerHTML = settingsProviderModelChecks(prov.modelIds || [], prov.enabledModelIds || []);
    if (hint) hint.textContent = `内置静态模型 ${(prov.modelIds || []).length} 个，勾选启用`;
  } else {
    if (box) box.innerHTML = settingsProviderModelChecks(prov ? prov.modelIds : [], prov ? prov.modelIds : []);
    if (hint) hint.textContent = '';
  }
}

// 模型复选框区：checkedIds 中的预勾，其余不勾（用户自由勾选启用；全选/清空见 settingsCheckAllModels）
function settingsProviderModelChecks(models, checkedIds) {
  const list = models || [];
  const checked = new Set(checkedIds || []);
  if (!list.length) return '<span class="set-muted">暂无模型，输入 API Key 后自动拉取，或点击「检测模型」</span>';
  return `<div class="set-model-check-grid">${
    list.map((m) => `
      <label class="set-model-check">
        <input type="checkbox" value="${escapeHtml(m)}" ${checked.has(m) ? 'checked' : ''}>
        <span class="set-mono">${escapeHtml(m)}</span>
      </label>`).join('')
  }</div>`;
}

// 全选/清空启用模型勾选
function settingsCheckAllModels(on) {
  const box = $('#set-provider-models-box');
  if (!box) return;
  box.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = !!on; });
}

// 密钥输入防抖自动拉取（自定义/新建：密钥 + 基础信息齐备即自动检测；内置为静态列表无需网络）
let settingsProvKeyTimer = null;
function settingsOnProvKeyInput() {
  clearTimeout(settingsProvKeyTimer);
  settingsProvKeyTimer = setTimeout(() => { settingsAutoDetect(); }, 800);
}

async function settingsAutoDetect() {
  const sel = $('#set-provider-form-select');
  const id = sel ? sel.value : '';
  if (!id || id === '__new__') {
    // 新建：需 ID/名称/BaseURL + Key 齐备
    const pid = ($('#set-provider-form-id') ? $('#set-provider-form-id').value.trim() : '');
    const name = ($('#set-provider-form-name') ? $('#set-provider-form-name').value.trim() : '');
    const baseURL = ($('#set-provider-form-url') ? $('#set-provider-form-url').value.trim() : '');
    const key = ($('#set-provider-form-key') ? $('#set-provider-form-key').value.trim() : '');
    if (pid && name && baseURL && key) await settingsDetectModels(true);
    return;
  }
  const providers = settingsState('setProviders', []) || [];
  const prov = providers.find((p) => p.id === id);
  if (!prov || prov.builtin) return; // 内置：选择时已展示静态列表
  const key = ($('#set-provider-form-key') ? $('#set-provider-form-key').value.trim() : '');
  if (key || prov.hasKey) await settingsDetectModels(true);
}

// 检测模型：内置直接渲染静态列表（预勾已启用子集）；自定义/新建先按表单值落库再强制打 /models 拉取
// auto=true 为密钥输入防抖触发的自动拉取：失败只在 hint 区提示，不弹 toast 打断输入
async function settingsDetectModels(auto) {
  const sel = $('#set-provider-form-select');
  const id = sel ? sel.value : '';
  const providers = settingsState('setProviders', []) || [];
  const prov = providers.find((p) => p.id === id);
  const key = ($('#set-provider-form-key') ? $('#set-provider-form-key').value : '').trim();
  const hint = $('#set-provider-detect-hint');
  if (id !== '__new__' && prov && prov.builtin) {
    // 内置：静态模型，无需打端点；保留用户当前勾选，再并入已启用子集
    try {
      if (hint) hint.textContent = '检测中…';
      const res = await apiCall('getLlmProviderModels', id);
      const preChecked = Array.from(new Set([...settingsCollectedModels(), ...(prov.enabledModelIds || [])]));
      const box = $('#set-provider-models-box');
      if (box) box.innerHTML = settingsProviderModelChecks((res && res.modelIds) || [], preChecked);
      if (hint) hint.textContent = `内置静态模型 ${((res && res.modelIds) || []).length} 个，勾选启用`;
    } catch (e) { if (!auto) handleApiError(e); }
    return;
  }
  // 新建/自定义：先按表单当前值落库（含密钥），再强制打 /models 拉取
  const pid = id === '__new__' ? ($('#set-provider-form-id') ? $('#set-provider-form-id').value.trim() : '') : id;
  const name = ($('#set-provider-form-name') ? $('#set-provider-form-name').value.trim() : '') || (prov && prov.name) || '';
  const baseURL = ($('#set-provider-form-url') ? $('#set-provider-form-url').value.trim() : '') || (prov && prov.baseURL) || '';
  if (!pid || !name || !baseURL) {
    if (!auto) toast('请先填写 ID、名称与 Base URL 再检测', 'error');
    return;
  }
  try {
    if (hint) hint.textContent = '拉取模型列表中…';
    // 已存在的自定义厂商可直接检测；新建需先落库基础信息（后端要求厂商存在才能 test）
    if (id === '__new__' || !prov) {
      await apiCall('saveLlmProvider',
        { id: pid, name, baseURL, apiKind: 'openai-completions', modelIds: settingsCollectedModels(), fetchModels: false },
        key || undefined);
    } else if (key) {
      await apiCall('setLlmKey', pid, key);
    }
    const res = await apiCall('testLlmProvider', pid);
    if (!res || !res.ok) {
      if (hint) hint.textContent = (res && res.error) || '拉取失败，请检查 Base URL 与 API Key';
      if (!auto) toast((res && res.error) || '连通测试失败，请检查 Base URL 与 API Key', 'error');
      return;
    }
    // 拉取成功：保留当前勾选，并预勾已启用模型（编辑场景不打断用户选择）
    const preChecked = Array.from(new Set([...settingsCollectedModels(), ...((prov && prov.modelIds) || [])]));
    const box = $('#set-provider-models-box');
    if (box) box.innerHTML = settingsProviderModelChecks((res && res.modelIds) || [], preChecked);
    if (hint) hint.textContent = `已拉取 ${((res && res.modelIds) || []).length} 个模型，勾选后保存启用`;
  } catch (e) { if (!auto) handleApiError(e); }
}

// 收集当前勾选的模型
function settingsCollectedModels() {
  const box = $('#set-provider-models-box');
  if (!box) return [];
  return Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
}

async function settingsSaveProvider() {
  const sel = $('#set-provider-form-select');
  const id = sel ? sel.value : '';
  const providers = settingsState('setProviders', []) || [];
  const prov = providers.find((p) => p.id === id);
  const key = ($('#set-provider-form-key') ? $('#set-provider-form-key').value : '').trim();
  const modelIds = settingsCollectedModels();
  try {
    if (id === '__new__') {
      const pid = ($('#set-provider-form-id') ? $('#set-provider-form-id').value : '').trim();
      const name = ($('#set-provider-form-name') ? $('#set-provider-form-name').value : '').trim();
      const baseURL = ($('#set-provider-form-url') ? $('#set-provider-form-url').value : '').trim();
      if (!pid || !name || !baseURL) { toast('请填写 ID、名称与 Base URL', 'error'); return; }
      await apiCall('saveLlmProvider', { id: pid, name, baseURL, apiKind: 'openai-completions', modelIds, fetchModels: false }, key || undefined);
    } else if (prov && prov.builtin) {
      if (key) await apiCall('setLlmKey', id, key);
      // 内置厂商：勾选集合 = 启用子集，持久化到 llm.providerModels
      await apiCall('saveLlmProviderModels', id, modelIds);
    } else if (prov) {
      const name = ($('#set-provider-form-name') ? $('#set-provider-form-name').value.trim() : '') || prov.name;
      const baseURL = ($('#set-provider-form-url') ? $('#set-provider-form-url').value.trim() : '') || prov.baseURL;
      await apiCall('saveLlmProvider', { id, name, baseURL, apiKind: prov.apiKind || 'openai-completions', modelIds, fetchModels: prov.fetchModels === true }, key || undefined);
    } else {
      toast('请先选择或新建厂商', 'error'); return;
    }
  } catch (e) { handleApiError(e); return; }
  closeModal();
  toast(`已保存，启用 ${modelIds.length} 个模型`, 'success');
  await settingsLoad();
  renderView();
}

// 弹窗内密钥显示/隐藏
function settingsToggleProvKey() {
  const el = $('#set-provider-form-key');
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

// 测试连通：只验证可用性并提示，不再把完整模型列表写回（避免覆盖用户勾选的启用子集）
async function settingsTestProvider(id) {
  try {
    const res = await apiCall('testLlmProvider', id);
    if (!res || !res.ok) {
      toast((res && res.error) || '连通测试失败', 'error');
      return;
    }
    const n = (res.modelIds || []).length;
    toast(n ? `连通测试成功，端点共 ${n} 个模型` : '连通测试成功', 'success');
  } catch (e) { handleApiError(e); }
}

// 移除厂商（软移除，内置/自定义统一）：清除启用模型与密钥使其从列表消失；
// 厂商定义本身不删除——内置为 pi-ai 静态表、自定义保留在 app-config，
// 之后随时可通过「增加配置」弹窗选中同一厂商重新配置回来
function settingsRemoveProvider(id) {
  const providers = settingsState('setProviders', []) || [];
  const prov = providers.find((p) => p.id === id);
  const name = prov ? (prov.name || id) : id;
  openModal('移除厂商',
    `<p>确定要移除「<strong>${escapeHtml(name)}</strong>」吗？其启用模型与 API Key 将被清除。</p>
     <p class="text-xs text-muted">厂商本身不会被删除，之后可通过「增加配置」重新配置回来。</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">取消</button>
     <button class="btn btn-destructive" onclick="settingsConfirmRemoveProvider(${settingsJs(id)})">移除</button>`);
}

async function settingsConfirmRemoveProvider(id) {
  closeModal();
  const providers = settingsState('setProviders', []) || [];
  const prov = providers.find((p) => p.id === id);
  try {
    await apiCall('saveLlmProviderModels', id, []);
    if (prov && settingsProviderHasKey(prov)) await apiCall('deleteLlmKey', id);
  } catch (e) { handleApiError(e); return; }
  await settingsLoad();
  toast('已移除，可通过「增加配置」重新添加', 'info');
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
  const uiScale = cfg.uiScale || 100;
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
          <div class="set-slider-row">
            <div class="set-slider-info">
              <div class="set-slider-label">页面缩放</div>
              <div class="set-slider-desc">全局界面缩放（所有页面生效）</div>
            </div>
            <div class="set-slider-ctl">
              <input type="range" class="set-slider-input" min="80" max="150" step="10" value="${uiScale}" id="set-scale-slider" oninput="settingsOnScaleSlider(this.value)">
              <span class="set-slider-value" id="set-scale-value">${uiScale}%</span>
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
  const scaleEl = $('#set-scale-slider');
  const intervalEl = $('#set-autosave-interval');
  const rootEl = $('#set-root-dir');
  const patch = {
    editorFontSize: fontEl ? parseInt(fontEl.value, 10) || 16 : 16,
    uiScale: scaleEl ? parseInt(scaleEl.value, 10) || 100 : 100,
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
  settingsApplyScale(patch.uiScale); // BUG-018：保存后应用缩放
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

// BUG-018：全局页面缩放。缩放百分比写入 html 根 font-size，所有视图继承缩放。
// 100% 时置空（用浏览器默认），避免累积缩放。
function settingsApplyScale(scale) {
  const pct = Number(scale);
  const valid = Number.isFinite(pct) && pct >= 80 && pct <= 150;
  document.documentElement.style.fontSize = valid && pct !== 100 ? pct + '%' : '';
}

// BUG-018：应用偏好面板「页面缩放」slider 的 oninput 实时预览
function settingsOnScaleSlider(v) {
  settingsApplyScale(v);
  const el = $('#set-scale-value');
  if (el) el.textContent = v + '%';
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
