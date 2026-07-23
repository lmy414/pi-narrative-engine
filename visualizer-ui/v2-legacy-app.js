/* app.js — 全局状态、初始化、视图切换、工具栏、modal/确认框/右键菜单 */
(function () {
  "use strict";
  window.Viz = window.Viz || {};

  var app = {};
  Viz.app = app;

  app.state = {
    storyTime: null,
    storyTimes: [],
    typeFilter: { character: true, location: true, item: true, concept: true },
    includeClosed: false,
    view: "graph",
    characterView: null, // { characterId, visible: Set<declarationId> }
    entities: [],        // 最近一次 /api/graph 的实体快照
    relations: []
  };

  /* ---------- 工具 ---------- */

  var toastTimer = null;
  app.toast = function (msg, isInfo) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast" + (isInfo ? " info" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 4000);
  };

  app.showError = function (err) {
    app.toast((err && err.message) || "操作失败", false);
  };

  function $(id) { return document.getElementById(id); }

  /* ---------- 通用确认框 ---------- */

  var confirmCb = null;
  app.confirm = function (title, text, cb) {
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    confirmCb = cb;
    $("modal-confirm").classList.remove("hidden");
  };
  $("confirm-ok").addEventListener("click", function () {
    $("modal-confirm").classList.add("hidden");
    if (confirmCb) { var cb = confirmCb; confirmCb = null; cb(); }
  });
  $("confirm-cancel").addEventListener("click", function () {
    confirmCb = null;
    $("modal-confirm").classList.add("hidden");
  });

  /* ---------- 右键菜单 ---------- */

  var ctxMenu = $("ctx-menu");
  app.showCtxMenu = function (x, y, items) {
    ctxMenu.innerHTML = "";
    items.forEach(function (it) {
      var div = document.createElement("div");
      div.className = "ctx-item" + (it.danger ? " danger" : "");
      div.textContent = it.label;
      div.addEventListener("click", function () {
        app.hideCtxMenu();
        it.onClick();
      });
      ctxMenu.appendChild(div);
    });
    ctxMenu.classList.remove("hidden");
    var mw = 160, mh = items.length * 32 + 10;
    ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
    ctxMenu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
  };
  app.hideCtxMenu = function () { ctxMenu.classList.add("hidden"); };
  document.addEventListener("click", function (e) {
    if (!ctxMenu.contains(e.target)) app.hideCtxMenu();
  });

  /* ---------- 新建实体 modal ---------- */

  function addNePropRow(key, val) {
    var wrap = $("ne-props");
    var row = document.createElement("div");
    row.className = "prop-line";
    row.innerHTML = '<input class="p-key" type="text" placeholder="属性名（如 性格）">' +
      '<input class="p-val" type="text" placeholder="值（如 沉默）">' +
      '<span class="p-del">&times;</span>';
    if (key !== undefined) row.querySelector(".p-key").value = key;
    if (val !== undefined) row.querySelector(".p-val").value = val;
    row.querySelector(".p-del").addEventListener("click", function () { row.remove(); });
    wrap.appendChild(row);
  }
  $("ne-add-prop").addEventListener("click", function () { addNePropRow(); });

  app.openNewEntityModal = function () {
    $("ne-id").value = "";
    $("ne-summary").value = "";
    $("ne-type").value = "character";
    $("ne-props").innerHTML = "";
    $("ne-error").classList.add("hidden");
    $("ne-storytime").textContent = "将在故事时间「" + (app.state.storyTime || "genesis") + "」诞生";
    addNePropRow();
    $("modal-new-entity").classList.remove("hidden");
    $("ne-id").focus();
  };
  $("ne-cancel").addEventListener("click", function () {
    $("modal-new-entity").classList.add("hidden");
  });
  $("ne-ok").addEventListener("click", function () {
    var errEl = $("ne-error");
    function fail(msg) {
      errEl.textContent = msg;
      errEl.classList.remove("hidden");
    }
    var entityId = $("ne-id").value.trim();
    if (!entityId) { fail("请填写实体 ID"); return; }
    if (!/^[a-z0-9][a-z0-9\-_]*$/.test(entityId)) {
      fail("实体 ID 只能由小写字母、数字、连字符、下划线组成，且必须以字母或数字开头");
      return;
    }
    var newFacts = [];
    var rows = $("ne-props").querySelectorAll(".prop-line");
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].querySelector(".p-key").value.trim();
      var v = rows[i].querySelector(".p-val").value;
      var hasVal = v.trim() !== "";
      if (!k && hasVal) { fail("第 " + (i + 1) + " 行属性填写了值但属性名为空"); return; }
      if (!k) continue;
      newFacts.push({ entityId: entityId, property: k, value: parseValue(v), modality: "fact" });
    }
    errEl.classList.add("hidden");
    var ev = {
      eventId: "evt-" + Date.now() + "-" + Math.floor(Math.random() * 10000),
      type: "birth",
      storyTime: app.state.storyTime || "genesis",
      entityId: entityId,
      entityType: $("ne-type").value,
      summary: $("ne-summary").value.trim(),
      newFacts: newFacts
    };
    Viz.api.postEvent(ev).then(function () {
      $("modal-new-entity").classList.add("hidden");
      app.toast("实体已创建", true);
      return app.refreshGraph();
    }).catch(app.showError);
  });

  function parseValue(v) {
    var t = (v === undefined || v === null) ? "" : String(v).trim();
    if (t !== "" && !isNaN(Number(t))) return Number(t);
    if (t === "true") return true;
    if (t === "false") return false;
    return v;
  }
  app.parseValue = parseValue;

  /* ---------- 新建关系 label modal ---------- */

  var relPending = null;
  app.openRelationModal = function (sourceId, targetId) {
    relPending = { sourceId: sourceId, targetId: targetId };
    $("rel-endpoints").textContent = sourceId + " → " + targetId;
    $("rel-label").value = "";
    $("modal-relation").classList.remove("hidden");
    $("rel-label").focus();
  };
  $("rel-cancel").addEventListener("click", function () {
    relPending = null;
    $("modal-relation").classList.add("hidden");
  });
  $("rel-ok").addEventListener("click", function () {
    if (!relPending) return;
    var label = $("rel-label").value.trim();
    if (!label) { app.toast("请填写关系名"); return; }
    var p = relPending;
    Viz.api.createRelation(p.sourceId, p.targetId, label, app.state.storyTime).then(function () {
      relPending = null;
      $("modal-relation").classList.add("hidden");
      app.toast("关系已创建", true);
      return app.refreshGraph();
    }).catch(app.showError);
  });

  /* ---------- 数据加载 ---------- */

  app.refreshStatus = function () {
    return Viz.api.status().then(function (data) {
      app.state.storyTimes = (data && data.storyTimes) || [];
      var sel = $("story-time-select");
      var prev = app.state.storyTime;
      sel.innerHTML = "";
      app.state.storyTimes.forEach(function (t) {
        var opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
      });
      if (prev && app.state.storyTimes.indexOf(prev) >= 0) {
        app.state.storyTime = prev;
      } else if (app.state.storyTimes.length) {
        app.state.storyTime = app.state.storyTimes[app.state.storyTimes.length - 1]; // 默认最新
      } else {
        app.state.storyTime = null;
      }
      sel.value = app.state.storyTime || "";
    });
  };

  app.refreshGraph = function () {
    var st = app.state.storyTime;
    if (!st) {
      app.state.entities = [];
      app.state.relations = [];
      Viz.graph.setData([], []);
      app.updateCharacterOptions([]);
      return Promise.resolve();
    }
    return Viz.api.graph(st, app.state.includeClosed).then(function (data) {
      app.state.entities = data.entities || [];
      app.state.relations = data.relations || [];
      Viz.graph.setData(app.state.entities, app.state.relations);
      app.updateCharacterOptions(app.state.entities);
      if (app.state.characterView) app.applyCharacterView();
    }).catch(function (err) {
      app.showError(err);
    });
  };

  app.updateCharacterOptions = function (entities) {
    var sel = $("character-view-select");
    var cur = app.state.characterView ? app.state.characterView.characterId : "";
    sel.innerHTML = '<option value="">无</option>';
    entities.forEach(function (e) {
      if (e.type !== "character") return;
      var opt = document.createElement("option");
      opt.value = e.entityId;
      opt.textContent = e.entityId;
      sel.appendChild(opt);
    });
    sel.value = cur;
    if (cur && sel.value !== cur) {
      // 该角色已不存在，退出视角
      app.state.characterView = null;
      sel.value = "";
    }
  };

  app.applyCharacterView = function () {
    var cv = app.state.characterView;
    if (!cv) return Promise.resolve();
    return Viz.api.characterView(cv.characterId, app.state.storyTime).then(function (facts) {
      cv.visible = {};
      (facts || []).forEach(function (f) { cv.visible[f.declarationId] = true; });
      Viz.graph.redraw();
    }).catch(function (err) {
      app.showError(err);
    });
  };

  app.isFactVisible = function (declarationId) {
    var cv = app.state.characterView;
    if (!cv) return true;
    return !!cv.visible[declarationId];
  };

  /* ---------- 搜索 ---------- */

  function doSearch() {
    var q = $("search-input").value.trim();
    if (!q) return;
    Viz.api.search(q, app.state.storyTime, "", "").then(function (results) {
      if (!results || !results.length) { app.toast("未找到匹配实体", true); return; }
      var r = results[0];
      Viz.graph.highlight(r.entityId);
    }).catch(function (err) {
      if (err && (err.code === "SEARCH_UNAVAILABLE" || err.status === 501)) {
        app.toast("检索不可用");
      } else {
        app.showError(err);
      }
    });
  }

  /* ---------- 事件绑定 ---------- */

  $("story-time-select").addEventListener("change", function () {
    app.state.storyTime = this.value || null;
    app.refreshGraph();
  });

  document.querySelectorAll("#type-chips .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var t = chip.getAttribute("data-type");
      app.state.typeFilter[t] = !app.state.typeFilter[t];
      chip.classList.toggle("active", app.state.typeFilter[t]);
      Viz.graph.applyFilter();
    });
  });

  $("search-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") doSearch();
  });

  $("include-closed").addEventListener("change", function () {
    app.state.includeClosed = this.checked;
    app.refreshGraph();
  });

  $("character-view-select").addEventListener("change", function () {
    var id = this.value;
    if (!id) {
      app.state.characterView = null;
      Viz.graph.redraw();
      return;
    }
    app.state.characterView = { characterId: id, visible: {} };
    app.applyCharacterView();
  });

  $("btn-refresh").addEventListener("click", function () {
    app.refreshStatus().then(function () {
      app.refreshGraph();
      if (app.state.view === "events") Viz.events.load();
    });
  });

  $("btn-new-relation").addEventListener("click", function () {
    var armed = Viz.graph.toggleRelationMode();
    this.classList.toggle("armed", armed);
    $("relation-mode-hint").classList.toggle("hidden", !armed);
  });
  app.onRelationModeDone = function () {
    $("btn-new-relation").classList.remove("armed");
    $("relation-mode-hint").classList.add("hidden");
  };

  $("btn-relayout").addEventListener("click", function () {
    Viz.graph.relayout();
  });

  $("btn-help").addEventListener("click", function () {
    $("modal-help").classList.remove("hidden");
  });
  $("help-close").addEventListener("click", function () {
    $("modal-help").classList.add("hidden");
  });

  /* ---------- 视图切换 ---------- */

  document.querySelectorAll(".tb-tabs .tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var v = tab.getAttribute("data-view");
      app.state.view = v;
      document.querySelectorAll(".tb-tabs .tab").forEach(function (t) {
        t.classList.toggle("active", t === tab);
      });
      $("view-graph").classList.toggle("active", v === "graph");
      $("view-events").classList.toggle("active", v === "events");
      if (v === "graph") {
        Viz.graph.resize();
      } else {
        Viz.events.load();
      }
    });
  });

  /* ---------- 启动 ---------- */

  window.addEventListener("DOMContentLoaded", function () {
    Viz.graph.init($("graph-canvas"));
    Viz.detail.init();
    app.refreshStatus().then(function () {
      return app.refreshGraph();
    }).catch(function (err) {
      app.showError(err);
    });
  });
})();
