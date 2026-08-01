/**
 * 项目管理视图（V3 高保真重构）
 * 视觉基准: narrative-engine-design/pages/project-management.html
 *
 * 与旧实现共存策略：
 * - 本文件在 views.js 之后加载（index.html: views.js → views/projects.js → app.js），
 *   通过重新赋值 `ViewRender.projects` / `ViewAfterRender.projects` 覆盖旧实现，
 *   app.js 的 `ViewRender[routeId]` 调度自动使用新实现，无需改动调度逻辑。
 * - 交互函数复用 views.js 全局实现：scanProjects / createProject / activateProject /
 *   migrateThenActivate / migrateProject / openFolder / closeProject / toggleProjectMenu。
 * - 仅新增本文件私有函数（函数名以项目页相关语义命名），避免全局重名冲突。
 *
 * 视图状态（兼容 T1 命名空间访问器与旧平面字段）：
 * - 读取时依次回退：viewState('projects').xxx → App.viewState.xxx → MOCK 默认值。
 * - 旧 scanProjects 写入的是平面字段 App.viewState.scanRoots / scannedProjects。
 */

// 覆盖 views.js 的旧项目管理渲染
ViewRender.projects = () => {
  const active = App.activeProject;
  const projects = projectsList();

  return `
    <div class="launcher-wrap">
      <header class="launcher-header">
        <h1 class="welcome-title">Narrative Engine</h1>
        <p class="welcome-subtitle">AI 驱动的小说创作工作台</p>
      </header>

      ${active ? currentProjectBarHtml(active) : ''}

      <section class="scan-section">
        <div class="scan-panel">
          <div class="flex items-end gap-3">
            <div class="flex-1 min-w-0">
              <label class="scan-label" for="scan-root">扫描项目</label>
              <input id="scan-root" class="input" placeholder="输入或粘贴项目根目录路径，多个用分号分隔" value="${escapeHtml(projectsScanRoots())}" spellcheck="false">
              <p class="scan-hint">默认扫描深度 3 级</p>
            </div>
            <div class="flex-shrink-0 pb-5">
              <button class="btn btn-secondary" onclick="scanProjects()">${icon('scan-search', 'w-3.5 h-3.5')} 扫描</button>
            </div>
          </div>
        </div>
      </section>

      <section class="projects-section">
        <div class="section-head">
          <h2 class="section-title">我的项目</h2>
          <button class="btn btn-primary" onclick="toggleNewProjectForm()">${icon('plus', 'w-4 h-4')} 新建项目</button>
        </div>

        ${newProjectFormHtml()}

        ${projects.length
          ? `<div class="project-grid">${projects.map(projectCardHtml).join('')}</div>`
          : projectsEmptyStateHtml()}
      </section>
    </div>
  `;
};

// 覆盖 views.js 的 AfterRender：下拉关闭由 app.js bindShellClickGuard 全局处理，无需重复绑定
ViewAfterRender.projects = () => {};

// =================== 状态读取（命名空间优先，兼容旧平面字段） ===================

function projectsList() {
  const ns = viewState('projects');
  return ns.scannedProjects || App.viewState.scannedProjects || MOCK_PROJECTS;
}

function projectsScanRoots() {
  const ns = viewState('projects');
  const roots = (ns.scanRoots && ns.scanRoots.length)
    ? ns.scanRoots
    : ((App.viewState.scanRoots && App.viewState.scanRoots.length)
        ? App.viewState.scanRoots
        : MOCK_APP_CONFIG.launcher.defaultScanRoots);
  return roots.join('; ');
}

// =================== 欢迎区 / 当前项目条 ===================

function currentProjectBarHtml(active) {
  const name = active.meta?.name || active.relativePath;
  return `
    <section class="current-project-bar">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <span class="current-project-check">${icon('check-circle', 'w-5 h-5')}</span>
          <span class="text-sm font-medium flex-shrink-0" style="color:var(--text-500)">当前项目</span>
          <h2 class="current-project-name">${escapeHtml(name)}</h2>
          <span class="status-pill status-active flex-shrink-0"><span class="status-dot"></span>已激活</span>
        </div>
        <div class="flex-shrink-0">
          <button class="btn btn-primary" onclick="navigate('#/graph')">进入 ${icon('arrow-right', 'w-3.5 h-3.5')}</button>
        </div>
      </div>
      <p class="current-project-path" title="${escapeHtml(active.dir)}">${escapeHtml(active.dir)}</p>
    </section>
  `;
}

// =================== 扫描区 ===================

// =================== 新建项目内嵌表单 ===================

function newProjectFormHtml() {
  return `
    <div class="form-panel" id="new-project-form">
      <div class="form-header" onclick="toggleNewProjectForm()">
        <div class="flex items-center gap-3">
          <div class="form-icon">${icon('file-plus-2', 'w-4 h-4')}</div>
          <span class="text-sm font-medium">创建新项目</span>
        </div>
        <i data-lucide="chevron-down" class="w-4 h-4 chevron" id="new-project-chevron"></i>
      </div>
      <div class="form-body" id="new-project-form-body">
        <div class="pt-4 space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1.5" style="color:var(--text-700)">目录路径 <span style="color:var(--error-500)">*</span><span class="text-xs font-normal ml-1" style="color:var(--text-400)">必填</span></label>
            <input id="new-project-dir" class="input" placeholder="D:\\novels\\new-project" spellcheck="false">
            <p class="text-xs mt-1.5" style="color:var(--text-400)">项目将在此目录下创建 .pi 文件夹用于存储引擎数据</p>
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5" style="color:var(--text-700)">项目名称<span class="text-xs font-normal ml-1" style="color:var(--text-400)">（选填，默认使用目录名）</span></label>
            <input id="new-project-name" class="input" placeholder="我的第一部小说">
          </div>
          <div class="flex items-center justify-end gap-3 pt-2">
            <button class="btn btn-ghost" onclick="toggleNewProjectForm()">取消</button>
            <button class="btn btn-primary" onclick="createProject()">创建并激活</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// 新建表单展开 / 收起（与 views.js 的 toggleCreateForm 区分，避免重名）
function toggleNewProjectForm() {
  const body = $('#new-project-form-body');
  const chevron = $('#new-project-chevron');
  if (body) body.classList.toggle('expanded');
  if (chevron) chevron.classList.toggle('rotated');
}

// =================== 项目卡片 ===================

function projectCardHtml(p) {
  const isActive = App.activeProject && App.activeProject.dir === p.dir;
  const name = p.meta?.name || p.relativePath;
  const menuId = 'menu-' + p.dir.replace(/[\\/:]/g, '-');
  const menuItems = [
    p.needsMigration ? `<div class="dropdown-item" onclick="migrateProject(${q(p.dir)})">${icon('archive-restore', 'w-4 h-4')} 迁移项目</div>` : '',
    `<div class="dropdown-item" onclick="openFolder(${q(p.dir)})">${icon('folder-open', 'w-4 h-4')} 打开所在文件夹</div>`,
    isActive ? `<div class="dropdown-item text-error" onclick="closeProject(${q(p.dir)})">${icon('x', 'w-4 h-4')} 关闭项目</div>` : '',
  ].join('');

  return `
    <article class="project-card p-5" onclick="activateProject(${q(p.dir)})">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="project-card-title">${escapeHtml(name)}</h3>
            ${p.needsMigration ? `<span class="migrate-badge">需迁移</span>` : ''}
          </div>
          <p class="project-card-path" title="${escapeHtml(p.dir)}">${escapeHtml(p.dir)}</p>
        </div>
        ${isActive ? `<span class="status-pill status-active flex-shrink-0"><span class="status-dot"></span>已激活</span>` : ''}
      </div>

      <div class="flex items-center gap-2 mb-3 flex-wrap">
        ${statBadge('stat-chapter', 'book-open', p.chapterCount + ' 章')}
        ${statBadge('stat-entity', 'users', (p.stats ? p.stats.entityCount : '—') + ' 实体')}
        ${statBadge('stat-event', 'zap', (p.stats ? p.stats.eventCount : '—') + ' 事件')}
      </div>

      <div class="text-xs mb-4" style="color:var(--text-400)">${relativeTimeText(p.lastModified)}</div>

      <div class="flex items-center gap-2 mt-auto">
        <button class="btn btn-primary launcher-enter-btn" onclick="event.stopPropagation();activateProject(${q(p.dir)})">进入 ${icon('arrow-right', 'w-3.5 h-3.5')}</button>
        <div class="dropdown" onclick="event.stopPropagation()">
          <button class="btn btn-secondary launcher-menu-btn" onclick="toggleProjectMenu(${q(p.dir)})" title="更多操作">${icon('more-vertical', 'w-4 h-4')}</button>
          <div id="${menuId}" class="dropdown-menu hidden">${menuItems}</div>
        </div>
      </div>
    </article>
  `;
}

function statBadge(cls, ic, text) {
  return `<span class="stat-badge ${cls}">${icon(ic, 'w-3 h-3')}${escapeHtml(text)}</span>`;
}

// =================== 空状态 ===================

function projectsEmptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon('file-plus-2', 'w-7 h-7')}</div>
      <h3 class="empty-title">还没有项目</h3>
      <p class="empty-desc">创建你的第一个项目，开始用 AI 驱动的叙事引擎创作你的故事</p>
      <button class="btn btn-primary" onclick="toggleNewProjectForm()">${icon('plus', 'w-4 h-4')} 创建第一个项目</button>
    </div>
  `;
}

// =================== 工具 ===================

// 相对时间文案（对齐设计稿 "2小时前更新 / 昨天更新 / 1周前更新"）
function relativeTimeText(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天更新';
  if (days < 7) return `${days} 天前更新`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} 周前更新`;
  return `${Math.floor(days / 30)} 个月前更新`;
}
