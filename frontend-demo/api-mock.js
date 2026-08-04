/**
 * 模拟 API 客户端
 * 所有响应符合 envelope 格式 { ok, data, error }
 * 延迟模拟真实网络
 */

const API_DELAY = 180;

function ok(data) { return { ok: true, data, error: null }; }
function fail(code, message, status = 400) {
  return { ok: false, data: null, error: { code, message }, _status: status };
}

function delay(ms = API_DELAY) {
  return new Promise(r => setTimeout(r, ms));
}

function requireActiveProject() {
  if (!activeProject) return fail('NO_ACTIVE_PROJECT', '没有活跃项目，请先激活项目', 409);
  return null;
}

function getEntityAtStoryTime(entityId, storyTime) {
  const entity = MOCK_ENTITIES.find(e => e.entityId === entityId);
  if (!entity) return null;
  const snapshot = JSON.parse(JSON.stringify(entity));
  // 按 storyTime 过滤属性：只保留 validFrom <= storyTime 且 validTo > storyTime 的声明
  const relevant = MOCK_DECLARATIONS.filter(d => d.entityId === entityId && d.validFrom <= storyTime && (d.validTo === 'Infinity' || d.validTo > storyTime));
  snapshot.properties = {};
  for (const d of relevant) snapshot.properties[d.property] = d.value;
  snapshot.alive = !(relevant.some(d => d.property === 'alive' && d.value === false));
  return snapshot;
}

function getGraph(storyTime, includeClosed = false) {
  const entities = MOCK_ENTITIES.map(e => getEntityAtStoryTime(e.entityId, storyTime)).filter(Boolean);
  const relations = MOCK_RELATIONS.filter(r => {
    if (r.storyTime > storyTime) return false;
    if (!includeClosed && r.closed && r.closedAt <= storyTime) return false;
    return true;
  });
  return { entities, relations };
}

function getEvents(storyTime = null) {
  let events = MOCK_EVENTS.slice();
  if (storyTime) events = events.filter(e => e.storyTime <= storyTime);
  return events;
}

function getChain(eventId) {
  const target = MOCK_EVENTS.find(e => e.eventId === eventId);
  if (!target) return { events: [] };
  const events = [];
  // L-FE-5：环检测（causes 引用成环时旧实现递归无限下钻 → 栈溢出）
  const visited = new Set();
  function collect(e) {
    if (visited.has(e.eventId)) return;
    visited.add(e.eventId);
    events.push(e);
    if (e.causes) {
      for (const causeId of e.causes) {
        const cause = MOCK_EVENTS.find(x => x.eventId === causeId);
        if (cause) collect(cause);
      }
    }
  }
  collect(target);
  return { events };
}

const ApiMock = {
  // 项目
  async getActiveProject() {
    await delay();
    return ok({ active: activeProject ? { dir: activeProject.dir, name: activeProject.meta.name, forceFulltext: false } : null, open: [activeProject?.dir].filter(Boolean) });
  },

  async scanProjects(root, maxDepth = 3) {
    await delay();
    if (!root) return fail('MISSING_FIELD', '缺少 root 参数');
    return ok({ projects: MOCK_PROJECTS.map(p => ({ ...p })) });
  },

  async activateProject(dir) {
    await delay(300);
    const project = MOCK_PROJECTS.find(p => p.dir === dir);
    if (!project) return fail('ENTITY_NOT_FOUND', '项目不存在', 404);
    if (project.needsMigration) return fail('MIGRATION_REQUIRED', '项目需要迁移', 409);
    activeProject = project;
    return ok({ activated: dir });
  },

  async createProject(dir, name) {
    await delay(300);
    if (!dir) return fail('MISSING_FIELD', '缺少 dir 字段');
    const exists = MOCK_PROJECTS.some(p => p.dir === dir);
    if (exists) return fail('FILE_EXISTS', '项目已存在', 409);
    const newProject = {
      dir,
      relativePath: dir.split('\\').pop(),
      chapterCount: 0,
      lastModified: new Date().toISOString(),
      needsMigration: false,
      stats: null,
      meta: { name: name || dir.split('\\').pop(), worldGraphDir: '.pi/world-graph-v3', chaptersDir: '正文', storyTimeFormat: 'ch<NNN>.ev<NNN>' }
    };
    MOCK_PROJECTS.push(newProject);
    activeProject = newProject;
    return ok({ created: dir });
  },

  async migrateProject(dir) {
    await delay(500);
    const project = MOCK_PROJECTS.find(p => p.dir === dir);
    if (!project) return fail('ENTITY_NOT_FOUND', '项目不存在', 404);
    project.needsMigration = false;
    return ok({ migrated: dir });
  },

  async openFolder(dir) {
    await delay();
    return ok({ opened: dir });
  },

  async closeProject(dir) {
    await delay();
    if (activeProject && activeProject.dir === dir) activeProject = null;
    return ok({ closed: dir });
  },

  // 状态与世界图
  async getStatus() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({
      entityCount: MOCK_ENTITIES.length,
      eventCount: MOCK_EVENTS.length,
      storyTimes: storyTimes.slice()
    });
  },

  async getGraph(storyTime, includeClosed) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok(getGraph(storyTime || currentStoryTime, includeClosed === '1' || includeClosed === true));
  },

  async search(q, storyTime, type) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const graph = getGraph(storyTime || currentStoryTime, false);
    const term = (q || '').toLowerCase();
    const results = graph.entities.filter(e => {
      const name = (e.properties.name || '').toLowerCase();
      const summary = (e.summary || '').toLowerCase();
      return name.includes(term) || summary.includes(term);
    }).map(e => ({ id: e.entityId, type: 'entity', entityType: e.entityType, name: e.properties.name, summary: e.summary }));
    return ok({ results });
  },

  async getEntity(id, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const entity = getEntityAtStoryTime(id, storyTime || currentStoryTime);
    if (!entity) return fail('ENTITY_NOT_FOUND', '实体不存在', 404);
    return ok(entity);
  },

  async getEntityHistory(id) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const entity = MOCK_ENTITIES.find(e => e.entityId === id);
    if (!entity) return fail('ENTITY_NOT_FOUND', '实体不存在', 404);
    const declarations = MOCK_DECLARATIONS.filter(d => d.entityId === id);
    const relations = MOCK_RELATIONS.filter(r => r.sourceId === id || r.targetId === id);
    return ok({ entity, declarations, relations, events: MOCK_EVENTS.filter(e => e.entityId === id) });
  },

  async updateSummary(id, summary) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const entity = MOCK_ENTITIES.find(e => e.entityId === id);
    if (!entity) return fail('ENTITY_NOT_FOUND', '实体不存在', 404);
    entity.summary = summary;
    return ok({ updated: true });
  },

  async addProperty(id, property, value, storyTime, modality = 'fact') {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const entity = MOCK_ENTITIES.find(e => e.entityId === id);
    if (!entity) return fail('ENTITY_NOT_FOUND', '实体不存在', 404);
    // 闭合同 property 旧声明
    const old = MOCK_DECLARATIONS.find(d => d.entityId === id && d.property === property && d.validTo === 'Infinity');
    if (old) old.validTo = storyTime || currentStoryTime;
    const newDecl = {
      declarationId: `decl-${Date.now()}`,
      entityId: id,
      property,
      value,
      modality,
      validFrom: storyTime || currentStoryTime,
      validTo: 'Infinity'
    };
    MOCK_DECLARATIONS.push(newDecl);
    return ok({ closedDeclarationId: old?.declarationId || null, newDeclarationId: newDecl.declarationId });
  },

  async closeDeclaration(declarationId, entityId, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const decl = MOCK_DECLARATIONS.find(d => d.declarationId === declarationId);
    if (!decl) return fail('DECLARATION_NOT_FOUND', '声明不存在', 404);
    if (decl.validTo !== 'Infinity') return fail('DECLARATION_CLOSED', '声明已闭合', 409);
    decl.validTo = storyTime || currentStoryTime;
    return ok({ closed: true });
  },

  async addRelation(sourceId, targetId, label, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    MOCK_RELATIONS.push({ sourceId, targetId, label, storyTime: storyTime || currentStoryTime, closed: false });
    return ok({ created: true });
  },

  async closeRelation(sourceId, targetId, label, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const rel = MOCK_RELATIONS.find(r => r.sourceId === sourceId && r.targetId === targetId && r.label === label && !r.closed);
    if (!rel) return fail('ENTITY_NOT_FOUND', '关系不存在', 404);
    rel.closed = true;
    rel.closedAt = storyTime || currentStoryTime;
    return ok({ closed: true });
  },

  async killEntity(id, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const entity = MOCK_ENTITIES.find(e => e.entityId === id);
    if (!entity) return fail('ENTITY_NOT_FOUND', '实体不存在', 404);
    entity.alive = false;
    MOCK_EVENTS.push({
      eventId: `evt-${nextEventId++}`,
      type: 'death',
      storyTime: storyTime || currentStoryTime,
      entityId: id,
      entityType: entity.entityType,
      summary: `${entity.properties.name} 退场`,
      source: 'user',
      newFacts: [{ entityId: id, property: 'alive', value: false, modality: 'fact' }],
      causes: [],
      recordedAt: new Date().toISOString()
    });
    return ok({ killed: true });
  },

  async getVisibility(declId, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ visibility: MOCK_VISIBILITY.filter(v => v.declarationId === declId) });
  },

  async setVisibility(characterId, declarationId, confidence, source, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    // 事件溯源：先闭合该「角色 × 声明」现存生效的可见性记录，再写入新记录
    const existing = MOCK_VISIBILITY.find(v => v.characterId === characterId && v.declarationId === declarationId && v.validTo === 'Infinity');
    if (existing) existing.validTo = storyTime || currentStoryTime;
    MOCK_VISIBILITY.push({ characterId, declarationId, state: 'known', confidence, source, validFrom: storyTime || currentStoryTime, validTo: 'Infinity' });
    return ok({ set: true });
  },

  async closeVisibility(characterId, declarationId, storyTime) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const v = MOCK_VISIBILITY.find(x => x.characterId === characterId && x.declarationId === declarationId && x.validTo === 'Infinity');
    if (v) v.validTo = storyTime || currentStoryTime;
    return ok({ closed: true });
  },

  // 事件
  async getEvents() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ events: MOCK_EVENTS.slice() });
  },

  async addEvent(body) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!body.eventId || !body.type || !body.storyTime || !body.entityId) return fail('MISSING_FIELD', '缺少必填字段');
    body.source = 'user';
    body.recordedAt = new Date().toISOString();
    MOCK_EVENTS.push(body);
    return ok({ created: true });
  },

  async getChain(eventId) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok(getChain(eventId));
  },

  // 聊天
  async getChatSessions() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ sessions: chatSessions.map(s => ({ ...s })) });
  },

  async getChatMessages(sessionId) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!chatMessages[sessionId]) return fail('SESSION_NOT_FOUND', '会话不存在', 404);
    return ok({ id: sessionId, messages: chatMessages[sessionId].map(m => ({ ...m })) });
  },

  async sendChatMessage(text) {
    await delay(200);
    const err = requireActiveProject();
    if (err) return err;
    return ok({ received: true });
  },

  // 编排
  async getSchedulerStatus() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ ...schedulerStatus, queue: { ...schedulerStatus.queue } });
  },

  // G1-7：mock 模式下 chat status 永远不 streaming（mock 不走真实 LLM 流式）
  async getChatStatus() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ isStreaming: false });
  },

  async getSchedulerPlan(planId) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const plan = schedulerPlans[planId];
    if (!plan) return fail('PLAN_NOT_FOUND', '计划不存在', 404);
    return ok(JSON.parse(JSON.stringify(plan)));
  },

  async setSchedulerMode(mode) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!['plan', 'yolo'].includes(mode)) return fail('VALIDATION_ERROR', '模式无效');
    schedulerStatus.defaultMode = mode;
    return ok({ mode });
  },

  async dispatch(body) {
    await delay(400);
    const err = requireActiveProject();
    if (err) return err;
    const mode = body.mode || schedulerStatus.defaultMode;
    const planId = `plan-${Date.now()}`;
    if (mode === 'plan') {
      schedulerStatus.plans.push({
        planId,
        storyTime: body.storyTime || currentStoryTime,
        mode,
        characterIds: body.characterIds || [],
        outputCount: 0,
        errorCount: 0
      });
      schedulerPlans[planId] = {
        planId,
        storyTime: body.storyTime || currentStoryTime,
        mode,
        characterIds: body.characterIds || [],
        cast: [],
        outputs: [],
        retrievalPlan: null,
        errors: [],
        stages: [
          { stage: 'planner', agent: '策划代理', status: 'done', durationMs: 3200 },
          { stage: 'role', agent: '角色代理', status: 'done', durationMs: 2800 }
        ]
      };
    } else {
      schedulerStatus.queue.items.push({ queueId: planId, mode, status: 'running' });
      // G1-2：mock 同步维护 active = pending+running 数
      schedulerStatus.queue.length = schedulerStatus.queue.items.length;
      schedulerStatus.queue.active = schedulerStatus.queue.items.filter((i) => i.status === 'running' || i.status === 'pending').length;
      // G1-5：mock 模拟 yolo 异步完成——2s 后改 done + resultSummary（前端 stYoloResultCardHtml 据此渲染结果卡）
      setTimeout(() => {
        const item = schedulerStatus.queue.items.find((i) => i.queueId === planId);
        if (item) {
          item.status = 'done';
          item.resultSummary = {
            mode: 'yolo',
            outputCount: 2,
            errorCount: 0,
            chapterPath: '正文/ch007.md',
            appliedEventIds: [`evt-${nextEventId++}`],
            writtenTextLength: 1842,
          };
          schedulerStatus.queue.active = schedulerStatus.queue.items.filter((i) => i.status === 'running' || i.status === 'pending').length;
        }
      }, 2000);
    }
    return ok({ queueId: planId, mode });
  },

  async commitPlan(planId) {
    await delay(600);
    const err = requireActiveProject();
    if (err) return err;
    const idx = schedulerStatus.plans.findIndex(p => p.planId === planId);
    if (idx === -1) return fail('PLAN_NOT_FOUND', '计划不存在', 404);
    schedulerStatus.plans.splice(idx, 1);
    delete schedulerPlans[planId];
    return ok({ ok: true, planId, appliedEventIds: [`evt-${nextEventId++}`], writtenText: '第六章 星门遗迹\n\n迷雾星云深处...', chapterPath: '正文/ch006.md' });
  },

  async discardPlan(planId) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const idx = schedulerStatus.plans.findIndex(p => p.planId === planId);
    if (idx === -1) return fail('PLAN_NOT_FOUND', '计划不存在', 404);
    schedulerStatus.plans.splice(idx, 1);
    delete schedulerPlans[planId];
    return ok({ discarded: true });
  },

  // 调试
  async getDebugEvents() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ events: debugEvents.slice() });
  },

  async clearDebugEvents() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    debugEvents = [];
    return ok({ cleared: true });
  },

  // 文件
  async getFileTree() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const tree = JSON.parse(JSON.stringify(MOCK_FILES));
    const normalize = (nodes) => nodes.map((node) => {
      const copy = { ...node, kind: node.type };
      delete copy.type;
      delete copy.content;
      if (copy.children) copy.children = normalize(copy.children);
      return copy;
    });
    return ok({ tree: normalize(tree) });
  },

  async readFile(path) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!path.endsWith('.md') && !path.endsWith('.txt') && !path.endsWith('.json')) return fail('INVALID_EXT', '不支持的文件类型', 400);
    const content = fileContents[path];
    if (content === undefined) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    const node = findFileNode(MOCK_FILES, path);
    return ok({ path, content, mtime: node?.mtime || new Date().toISOString() });
  },

  async writeFile(path, content, baseMtime) {
    await delay(300);
    const err = requireActiveProject();
    if (err) return err;
    if (!path.endsWith('.md')) return fail('INVALID_EXT', '只允许写入 .md 文件', 400);
    const node = findFileNode(MOCK_FILES, path);
    if (!node) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    if (baseMtime && node.mtime !== baseMtime) return fail('MTIME_CONFLICT', '文件已被他人修改', 409);
    fileContents[path] = content;
    node.mtime = new Date().toISOString();
    return ok({ path, mtime: node.mtime });
  },

  async createFile(path) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!path.endsWith('.md')) return fail('INVALID_EXT', '只允许创建 .md 文件', 400);
    if (fileContents[path] !== undefined) return fail('FILE_EXISTS', '文件已存在', 409);
    const parts = path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parent = parentPath ? findFileNode(MOCK_FILES, parentPath) : null;
    if (parentPath && !parent) return fail('FILE_NOT_FOUND', '父目录不存在', 404);
    const newNode = { type: 'file', name: parts[parts.length - 1], path, mtime: new Date().toISOString(), content: '' };
    if (parent) parent.children.push(newNode);
    else MOCK_FILES.push(newNode);
    fileContents[path] = '';
    return ok({ created: path });
  },

  async renameFile(path, newPath) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!path.endsWith('.md') || !newPath.endsWith('.md')) return fail('INVALID_EXT', '只允许重命名 .md 文件', 400);
    const node = findFileNode(MOCK_FILES, path);
    if (!node) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    if (fileContents[newPath] !== undefined) return fail('FILE_EXISTS', '目标文件已存在', 409);
    node.path = newPath;
    node.name = newPath.split('/').pop();
    fileContents[newPath] = fileContents[path];
    delete fileContents[path];
    return ok({ renamed: newPath });
  },

  async deleteFile(path) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!path.endsWith('.md')) return fail('INVALID_EXT', '只允许删除 .md 文件', 400);
    if (!removeFileNode(MOCK_FILES, path)) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    delete fileContents[path];
    return ok({ deleted: path });
  },

  // —— 目录操作（frontend-demo 文件页高保真重构 Task 9 最小扩展） ——
  async createFolder(path) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!path || path.includes('..')) return fail('VALIDATION_ERROR', '路径无效', 400);
    if (findFileNode(MOCK_FILES, path)) return fail('FILE_EXISTS', '路径已存在', 409);
    const parts = path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parent = parentPath ? findFileNode(MOCK_FILES, parentPath) : null;
    if (parentPath && !parent) return fail('FILE_NOT_FOUND', '父目录不存在', 404);
    if (parent && parent.type !== 'dir') return fail('INVALID_PATH', '父路径不是目录', 400);
    const newNode = { type: 'dir', name: parts[parts.length - 1], path, children: [] };
    if (parent) parent.children.push(newNode);
    else MOCK_FILES.push(newNode);
    return ok({ created: path });
  },

  async renameNode(path, newPath) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const node = findFileNode(MOCK_FILES, path);
    if (!node) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    if (node.type === 'file' && !path.endsWith('.md')) return fail('INVALID_EXT', '只允许重命名目录或 .md 文件', 400);
    if (findFileNode(MOCK_FILES, newPath)) return fail('FILE_EXISTS', '目标路径已存在', 409);
    // 迁移扁平内容表（含子树内所有文件）
    const oldPrefix = path + '/';
    for (const key of Object.keys(fileContents)) {
      if (key === path) {
        fileContents[newPath] = fileContents[key];
        delete fileContents[key];
      } else if (key.startsWith(oldPrefix)) {
        fileContents[newPath + key.slice(path.length)] = fileContents[key];
        delete fileContents[key];
      }
    }
    renameNodePath(node, path, newPath);
    return ok({ renamed: newPath });
  },

  async deleteNode(path) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    const node = findFileNode(MOCK_FILES, path);
    if (!node) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    if (node.type === 'file' && !path.endsWith('.md')) return fail('INVALID_EXT', '只允许删除目录或 .md 文件', 400);
    collectFilePaths(node).forEach((p) => { delete fileContents[p]; });
    if (!removeFileNode(MOCK_FILES, path)) return fail('FILE_NOT_FOUND', '文件不存在', 404);
    return ok({ deleted: path });
  },

  // 管理
  async getLlmStatus() {
    await delay();
    return ok({ slots: JSON.parse(JSON.stringify(llmStatus)) });
  },

  async setLlmSlot(slot, provider, model) {
    await delay();
    llmStatus[slot] = { configured: { provider, model }, resolved: { provider, model }, source: 'slot', hasKey: llmStatus[slot].hasKey };
    return ok({ set: true });
  },

  async clearLlmSlot(slot) {
    await delay();
    llmStatus[slot] = { configured: null, resolved: { provider: 'pi', model: 'default' }, source: 'default', hasKey: llmStatus[slot].hasKey };
    return ok({ cleared: true });
  },

  async setLlmKey(provider, apiKey) {
    await delay();
    for (const slot of Object.keys(llmStatus)) {
      if (llmStatus[slot].configured?.provider === provider || llmStatus[slot].resolved?.provider === provider) {
        llmStatus[slot].hasKey = true;
      }
    }
    return ok({ set: true });
  },

  async deleteLlmKey(provider) {
    await delay();
    for (const slot of Object.keys(llmStatus)) {
      if (llmStatus[slot].configured?.provider === provider || llmStatus[slot].resolved?.provider === provider) {
        llmStatus[slot].hasKey = false;
      }
    }
    return ok({ deleted: true });
  },

  async getEmbedderStatus() {
    await delay();
    return ok({ ...MOCK_EMBEDDER_STATUS });
  },

  async warmupEmbedder() {
    await delay(800);
    MOCK_EMBEDDER_STATUS.cachePresent = true;
    return ok({ model: MOCK_EMBEDDER_STATUS.model, dim: MOCK_EMBEDDER_STATUS.dim });
  },

  async clearEmbedderCache() {
    await delay();
    MOCK_EMBEDDER_STATUS.cachePresent = false;
    MOCK_EMBEDDER_STATUS.cacheSizeBytes = 0;
    return ok({ cleared: true });
  },

  async getAppConfig() {
    await delay();
    return ok({ ...appConfig });
  },

  async setAppConfig(config) {
    await delay();
    Object.assign(appConfig, config);
    // 持久化到 localStorage，刷新后仍保留（见 mock-data.js appConfig 初始化）
    try { localStorage.setItem('ne-demo-app-config', JSON.stringify(appConfig)); } catch (e) { /* 存储不可用时忽略 */ }
    return ok({ saved: true });
  },

  async getVersion() {
    await delay();
    return ok({ ...MOCK_VERSION });
  },

  async getDoctor() {
    await delay();
    return ok({ ...MOCK_DOCTOR });
  },

  async getRulesets() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ rulesets: Object.entries(rulesets).map(([name, content]) => ({
      name,
      filename: name === 'render' ? '规则集.md' : `${name} 规则集.md`,
      path: name === 'render' ? '规则集.md' : `${name} 规则集.md`,
      exists: true,
      content,
      mtime: '2026-08-02T03:15:00Z',
      charCount: String(content).length
    })) });
  },

  async setRuleset(name, content) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!rulesets[name]) return fail('TEMPLATE_NOT_FOUND', '规则集不存在', 404);
    rulesets[name] = content;
    return ok({ saved: true });
  },

  async resetRuleset(name) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    if (!rulesets[name]) return fail('TEMPLATE_NOT_FOUND', '规则集不存在', 404);
    rulesets[name] = MOCK_RULESETS[name];
    return ok({ reset: true });
  },

  async getNovelJson() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ path: 'novel.json', exists: true, data: { ...novelJson } });
  },

  async setNovelJson(data) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    Object.assign(novelJson, data);
    return ok({ saved: true });
  },

  async getEnvConfig() {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    return ok({ path: '.env', exists: true, values: { ...envConfig }, lineCount: Object.keys(envConfig).length });
  },

  async setEnvConfig(data) {
    await delay();
    const err = requireActiveProject();
    if (err) return err;
    for (const key of Object.keys(data)) {
      if (data[key] === '' || data[key] === null) delete envConfig[key];
      else envConfig[key] = data[key];
    }
    return ok({ saved: true });
  }
};

function findFileNode(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findFileNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function removeFileNode(nodes, path) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].path === path) {
      nodes.splice(i, 1);
      return true;
    }
    if (nodes[i].children && removeFileNode(nodes[i].children, path)) return true;
  }
  return false;
}

// 重命名后递归更新节点自身的 path/name（含子树）
function renameNodePath(node, oldPath, newPath) {
  if (node.path === oldPath || node.path.startsWith(oldPath + '/')) {
    node.path = newPath + node.path.slice(oldPath.length);
    node.name = node.path.split('/').pop();
  }
  (node.children || []).forEach((c) => renameNodePath(c, oldPath, newPath));
}

// 收集节点子树内全部文件 path（用于删除时清理扁平内容表）
function collectFilePaths(node) {
  const paths = [];
  (function walk(n) {
    if (n.type === 'file') paths.push(n.path);
    (n.children || []).forEach(walk);
  })(node);
  return paths;
}
