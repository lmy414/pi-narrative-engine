/** Real HTTP client for frontend-demo. Keeps the server envelope intact. */
(function (root, factory) {
  var client = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = client;
  root.ApiClient = client;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var API_ROOT = '/api';
  var UI_PREFS_KEY = 'ne-frontend-ui-prefs';
  var UI_PREF_KEYS = ['theme', 'fontSize', 'autoSave'];

  function unsupported(message) {
    return Promise.resolve({
      ok: false,
      data: null,
      error: { code: 'UNSUPPORTED_OPERATION', message: message },
      _status: 501
    });
  }

  function query(path, values) {
    var params = new URLSearchParams();
    Object.keys(values || {}).forEach(function (key) {
      if (values[key] !== undefined && values[key] !== null) params.set(key, String(values[key]));
    });
    var suffix = params.toString();
    return API_ROOT + path + (suffix ? '?' + suffix : '');
  }

  async function request(method, path, body, transform) {
    var options = { method: method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json; charset=utf-8' };
      options.body = JSON.stringify(body);
    }
    var response = await root.fetch(API_ROOT + path, options);
    var envelope = await response.json();
    if (transform && envelope && envelope.ok) envelope.data = transform(envelope.data);
    if (!response.ok && envelope && envelope._status === undefined) envelope._status = response.status;
    return envelope;
  }

  function get(path, values, transform) {
    var url = query(path, values).slice(API_ROOT.length);
    return request('GET', url, undefined, transform);
  }

  function post(path, body, transform) { return request('POST', path, body, transform); }
  function put(path, body, transform) { return request('PUT', path, body, transform); }
  function del(path, transform) { return request('DELETE', path, undefined, transform); }
  function part(value) { return encodeURIComponent(String(value)); }

  function declarationsToProperties(declarations) {
    var properties = {};
    (declarations || []).forEach(function (declaration) {
      properties[declaration.property] = declaration.value;
    });
    return properties;
  }

  function normalizeEntity(entity) {
    if (!entity || typeof entity !== 'object') return entity;
    var declarations = Array.isArray(entity.properties) ? entity.properties : (entity.declarations || []);
    return Object.assign({}, entity, {
      entityType: entity.entityType || entity.type,
      properties: Array.isArray(entity.properties) ? declarationsToProperties(declarations) : (entity.properties || {}),
      declarations: declarations
    });
  }

  function normalizeGraph(data) {
    return Object.assign({}, data, {
      entities: (data.entities || []).map(normalizeEntity),
      relations: (data.relations || []).map(normalizeRelation)
    });
  }

  function normalizeRelation(relation) {
    var normalized = Object.assign({}, relation);
    if (normalized.storyTime === undefined && relation.validFrom !== undefined) normalized.storyTime = relation.validFrom;
    if (normalized.closed === undefined && relation.validTo !== undefined) normalized.closed = relation.validTo !== 'Infinity';
    if (normalized.closedAt === undefined && relation.validTo !== undefined && relation.validTo !== 'Infinity') normalized.closedAt = relation.validTo;
    return normalized;
  }

  function normalizeSearch(data) {
    return Object.assign({}, data, {
      results: (data.results || []).map(function (result) {
        var entity = normalizeEntity(result.snapshot || {});
        return {
          id: result.entityId,
          type: 'entity',
          entityType: result.type || entity.entityType,
          name: entity.properties.name || result.entityId,
          summary: entity.summary || ''
        };
      })
    });
  }

  function normalizeHistory(data) {
    var entities = Array.isArray(data.entities) ? data.entities : [];
    var declarations = Array.isArray(data.facts) ? data.facts : (data.declarations || []);
    var currentDeclarations = declarations.filter(function (item) { return item.validTo === 'Infinity'; });
    var currentEntity = entities.find(function (item) { return item.validTo === 'Infinity'; }) || entities[entities.length - 1] || data.entity || {};
    return Object.assign({}, data, {
      entity: normalizeEntity(Object.assign({}, currentEntity, { properties: currentDeclarations })),
      declarations: declarations,
      relations: (data.relations || []).map(normalizeRelation)
    });
  }

  function readUiPrefs() {
    try {
      var value = root.localStorage && root.localStorage.getItem(UI_PREFS_KEY);
      var parsed = value ? JSON.parse(value) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function writeUiPrefs(patch) {
    var prefs = Object.assign({}, readUiPrefs(), patch);
    try {
      if (root.localStorage) root.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch (_) { /* Storage can be unavailable in private/sandboxed contexts. */ }
    return prefs;
  }

  function splitAppConfig(config) {
    var ui = {};
    var remote = {};
    Object.keys(config || {}).forEach(function (key) {
      if (UI_PREF_KEYS.indexOf(key) !== -1) ui[key] = config[key];
      else if (['launcher', 'embedder'].indexOf(key) !== -1) remote[key] = config[key];
    });
    return { ui: ui, remote: remote };
  }

  var ApiClient = {
    getActiveProject: function () { return get('/projects/active'); },
    scanProjects: function (rootDir, maxDepth) { return get('/projects/scan', { root: rootDir, maxDepth: maxDepth === undefined ? 3 : maxDepth }); },
    activateProject: function (dir) { return post('/projects/activate', { dir: dir }); },
    createProject: function (dir, name) { return post('/projects/create', { dir: dir, name: name }); },
    migrateProject: function (dir) { return post('/projects/migrate', { dir: dir }); },
    openFolder: function (dir) { return post('/projects/open-folder', { dir: dir }); },
    closeProject: function (dir) { return post('/projects/close', { dir: dir }); },

    getStatus: function () { return get('/status'); },
    getGraph: function (storyTime, includeClosed) { return get('/graph', { storyTime: storyTime, includeClosed: includeClosed }, normalizeGraph); },
    search: function (q, storyTime, type) { return get('/search', { q: q, storyTime: storyTime, type: type }, normalizeSearch); },
    getEntity: function (id, storyTime) { return get('/entities/' + part(id), { storyTime: storyTime }, normalizeEntity); },
    getEntityHistory: function (id) { return get('/entities/' + part(id) + '/history', undefined, normalizeHistory); },
    updateSummary: function (id, summary) { return post('/entities/' + part(id) + '/summary', { summary: summary }); },
    addProperty: function (id, property, value, storyTime, modality) { return post('/entities/' + part(id) + '/props', { property: property, value: value, storyTime: storyTime, modality: modality === undefined ? 'fact' : modality }); },
    closeDeclaration: function (declarationId, entityId, storyTime) { return post('/declarations/close', { declarationId: declarationId, entityId: entityId, storyTime: storyTime }); },
    addRelation: function (sourceId, targetId, label, storyTime) { return post('/relations', { sourceId: sourceId, targetId: targetId, label: label, storyTime: storyTime }); },
    closeRelation: function (sourceId, targetId, label, storyTime) { return post('/relations/close', { sourceId: sourceId, targetId: targetId, label: label, storyTime: storyTime }); },
    killEntity: function (id, storyTime) { return post('/entities/' + part(id) + '/kill', { storyTime: storyTime }); },
    getVisibility: function (declId, storyTime) { return get('/declarations/' + part(declId) + '/visibility', { storyTime: storyTime }); },
    setVisibility: function (characterId, declarationId, confidence, source, storyTime) { return post('/visibility', { characterId: characterId, declarationId: declarationId, confidence: confidence, source: source, storyTime: storyTime }); },
    closeVisibility: function (characterId, declarationId, storyTime) { return post('/visibility/close', { characterId: characterId, declarationId: declarationId, storyTime: storyTime }); },
    getEvents: function () { return get('/events'); },
    addEvent: function (body) { return post('/events', body); },
    getChain: function (eventId) { return get('/events/' + part(eventId) + '/chain'); },

    getChatSessions: function () { return get('/chat/sessions'); },
    getChatMessages: function (sessionId) { return get('/chat/sessions/' + part(sessionId) + '/messages'); },
    sendChatMessage: function (text) { return post('/chat/message', { text: text }); },
    getSchedulerStatus: function () { return get('/scheduler/status'); },
    getSchedulerPlan: function (planId) { return get('/scheduler/plans/' + part(planId)); },
    setSchedulerMode: function (mode) { return put('/scheduler/mode', { mode: mode }); },
    dispatch: function (body) { return post('/scheduler/dispatch', body); },
    commitPlan: function (planId) { return post('/scheduler/commit', { planId: planId }); },
    discardPlan: function (planId) { return post('/scheduler/discard', { planId: planId }); },

    getDebugEvents: function () { return get('/debug/events'); },
    clearDebugEvents: function () { return post('/debug/clear'); },
    getFileTree: function () { return get('/files/tree'); },
    readFile: function (path) { return get('/files/read', { path: path }); },
    writeFile: function (path, content, baseMtime) { return put('/files/write', { path: path, content: content, baseMtime: baseMtime }); },
    createFile: function (path) { return post('/files/create', { path: path }); },
    renameFile: function (path, newPath) { return post('/files/rename', { path: path, newPath: newPath }); },
    deleteFile: function (path) { return post('/files/delete', { path: path }); },
    createFolder: function (path) { return unsupported('后端不支持创建目录: ' + String(path || '')); },
    renameNode: function (path, newPath) { return String(path).toLowerCase().endsWith('.md') && String(newPath).toLowerCase().endsWith('.md') ? ApiClient.renameFile(path, newPath) : unsupported('后端不支持重命名目录'); },
    deleteNode: function (path) { return String(path).toLowerCase().endsWith('.md') ? ApiClient.deleteFile(path) : unsupported('后端不支持删除目录'); },

    getLlmStatus: function () { return get('/admin/llm'); },
    setLlmSlot: function (slot, provider, model) { return put('/admin/llm/slot', { slot: slot, provider: provider, model: model }); },
    clearLlmSlot: function (slot) { return del('/admin/llm/slot/' + part(slot)); },
    setLlmKey: function (provider, apiKey) { return put('/admin/llm/key', { provider: provider, apiKey: apiKey }); },
    deleteLlmKey: function (provider) { return del('/admin/llm/key/' + part(provider)); },
    getEmbedderStatus: function () { return get('/admin/embedder/status'); },
    warmupEmbedder: function () { return post('/admin/embedder/warmup'); },
    clearEmbedderCache: function () { return post('/admin/embedder/cache/clear'); },
    getAppConfig: async function () {
      var envelope = await get('/admin/app-config');
      if (envelope && envelope.ok) envelope.data = Object.assign({}, envelope.data || {}, readUiPrefs());
      return envelope;
    },
    setAppConfig: function (config) {
      var parts = splitAppConfig(config);
      writeUiPrefs(parts.ui);
      return Object.keys(parts.remote).length ? put('/admin/app-config', parts.remote) : Promise.resolve({ ok: true, data: { saved: true }, error: null });
    },
    getVersion: function () { return get('/admin/version'); },
    getDoctor: function () { return get('/admin/doctor'); },
    getRulesets: function () { return get('/admin/rulesets'); },
    setRuleset: function (name, content) { return put('/admin/rulesets/' + part(name), { content: content }); },
    resetRuleset: function (name) { return post('/admin/rulesets/' + part(name) + '/reset'); },
    getNovelJson: function () { return get('/admin/novel-json'); },
    setNovelJson: function (data) { return put('/admin/novel-json', data); },
    getEnvConfig: function () { return get('/admin/config'); },
    setEnvConfig: function (data) { return put('/admin/config', data); }
  };

  // M-Logic-12 修复：EventSource 指数退避重连。
  // 旧实现依赖浏览器内置重连（固定 ~3s、无上限），且每次 onerror 都回调 onError
  // （后端宕机时前端反复弹 toast）。现在：
  // - onerror 后主动 close 并按指数延迟重建（1s→2s→4s…上限 30s），收到消息/连接成功即复位
  // - onError 仅在断开首次通知一次，不再每 3s 轰炸调用方
  function subscribe(path, onEvent, onError) {
    var closed = false;
    var attempt = 0;
    var notified = false;
    var timer = null;
    var source = null;

    function connect() {
      if (closed) return;
      source = new root.EventSource(API_ROOT + path);
      source.onopen = function () { attempt = 0; };
      source.onmessage = function (message) {
        attempt = 0;
        notified = false;
        try { onEvent(JSON.parse(message.data)); }
        catch (error) { if (onError) onError(error); }
      };
      source.onerror = function () {
        if (closed || !source) return;
        source.close();
        source = null;
        if (!notified) {
          notified = true;
          if (onError) {
            var error = new Error('实时连接中断，将自动重连');
            error.code = 'SSE_DISCONNECTED';
            onError(error);
          }
        }
        var delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    }
    connect();
    return function () {
      closed = true;
      clearTimeout(timer);
      if (source) source.close();
      source = null;
    };
  }

  ApiClient.subscribeChat = function (onEvent, onError) {
    return subscribe('/chat/events', onEvent, onError);
  };
  ApiClient.subscribeDebug = function (onEvent, onError) {
    return subscribe('/debug/stream', onEvent, onError);
  };

  return ApiClient;
}));
