/* detail-panel.js — 右侧详情抽屉（基本/属性/关系/可见性/历史） */
(function () {
  "use strict";
  window.Viz = window.Viz || {};

  var dp = {
    entityId: null,
    snapshot: null,   // EntitySnapshot
    workingFacts: [], // 属性页签工作副本 [{declarationId, property, valueRaw, modality, deleted, isNew}]
    visDeclId: null
  };
  Viz.detail = dp;

  var TYPE_CN = { character: "角色", location: "地点", item: "物品", concept: "概念" };
  var MODALITY_CN = { fact: "事实", belief: "信念", hypothesis: "推测" };
  function typeCn(t) { return TYPE_CN[t] || t || "—"; }
  function modalityCn(m) { return MODALITY_CN[m] || m || "—"; }
  function timeCn(t) { return (!t || t === "Infinity") ? "至今" : t; }

  function $(s, root) { return (root || document).querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function pane(name) { return $('.dpane[data-dpane="' + name + '"]'); }

  dp.init = function () {
    document.getElementById("drawer-close").addEventListener("click", dp.close);
    document.querySelectorAll(".dtab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".dtab").forEach(function (t) { t.classList.toggle("active", t === tab); });
        var name = tab.getAttribute("data-dtab");
        document.querySelectorAll(".dpane").forEach(function (p) {
          p.classList.toggle("active", p.getAttribute("data-dpane") === name);
        });
        dp.renderTab(name);
      });
    });
  };

  dp.open = function (entityId) {
    dp.entityId = entityId;
    document.getElementById("detail-drawer").classList.remove("hidden");
    document.getElementById("drawer-title").textContent = entityId;
    dp.reload();
  };

  dp.close = function () {
    dp.entityId = null;
    dp.snapshot = null;
    document.getElementById("detail-drawer").classList.add("hidden");
  };

  dp.reload = function () {
    if (!dp.entityId) return Promise.resolve();
    return Viz.api.entity(dp.entityId, Viz.app.state.storyTime).then(function (snap) {
      dp.snapshot = snap;
      dp.workingFacts = (snap.properties || []).map(function (f) {
        return {
          declarationId: f.declarationId,
          property: f.property,
          valueRaw: f.valueText !== undefined && f.valueText !== null ? String(f.valueText) : String(f.value),
          modality: f.modality || "fact",
          deleted: false,
          isNew: false
        };
      });
      var active = $(".dtab.active");
      dp.renderTab(active ? active.getAttribute("data-dtab") : "basic");
    }).catch(function (err) {
      Viz.app.showError(err);
    });
  };

  dp.renderTab = function (name) {
    if (!dp.snapshot) return;
    if (name === "basic") renderBasic();
    else if (name === "props") renderProps();
    else if (name === "rels") renderRels();
    else if (name === "vis") renderVis();
    else if (name === "history") renderHistory();
  };

  /* ---------- 基本 ---------- */
  function renderBasic() {
    var p = pane("basic");
    p.innerHTML = "";
    var s = dp.snapshot;

    function kv(label, value) {
      var row = el("div", "kv-row");
      row.appendChild(el("label", null, label));
      row.appendChild(el("span", "val", value === undefined || value === null || value === "" ? "—" : String(value)));
      p.appendChild(row);
    }
    kv("实体 ID", s.entityId);
    kv("类型", typeCn(s.type));
    kv("诞生时间", s.validFrom);
    kv("消亡时间", timeCn(s.validTo));

    var row = el("div", "kv-row");
    row.appendChild(el("label", null, "摘要"));
    var ta = document.createElement("textarea");
    ta.value = s.summary || "";
    ta.addEventListener("blur", function () {
      var v = ta.value;
      if (v === (s.summary || "")) return;
      Viz.api.updateSummary(dp.entityId, v).then(function () {
        s.summary = v;
        Viz.app.toast("summary 已保存", true);
        return Viz.app.refreshGraph();
      }).catch(Viz.app.showError);
    });
    row.appendChild(ta);
    p.appendChild(row);
    p.appendChild(el("div", "pane-note", "摘要失焦自动保存，仅作者可见、不影响剧情逻辑"));
  }

  /* ---------- 属性 ---------- */
  function renderProps() {
    var p = pane("props");
    p.innerHTML = "";
    p.appendChild(el("div", "pane-note", "事实=客观真实；信念=角色主观认为；推测=假设"));

    dp.workingFacts.forEach(function (f) {
      p.appendChild(factRow(f));
    });

    var addBtn = el("button", "tb-btn small", "+ 添加属性");
    addBtn.addEventListener("click", function () {
      dp.workingFacts.push({
        declarationId: null,
        property: "",
        valueRaw: "",
        modality: "fact",
        deleted: false,
        isNew: true
      });
      renderProps();
    });
    var actions = el("div", "pane-actions");
    actions.appendChild(addBtn);

    var saveBtn = el("button", "tb-btn primary", "保存修改");
    saveBtn.addEventListener("click", saveProps);
    actions.appendChild(saveBtn);
    p.appendChild(actions);
  }

  function factRow(f) {
    var row = el("div", "fact-row" + (f.deleted ? " deleted" : ""));

    var prop;
    if (f.isNew) {
      prop = document.createElement("input");
      prop.className = "f-val";
      prop.style.width = "80px";
      prop.style.flex = "none";
      prop.placeholder = "property";
      prop.value = f.property;
      prop.addEventListener("input", function () { f.property = prop.value; });
    } else {
      prop = el("span", "f-prop", f.property);
      prop.title = f.property;
    }
    row.appendChild(prop);

    var val = document.createElement("input");
    val.className = "f-val";
    val.value = f.valueRaw;
    if (f.deleted) val.disabled = true;
    val.addEventListener("input", function () { f.valueRaw = val.value; });
    row.appendChild(val);

    var mod = document.createElement("select");
    mod.className = "f-mod";
    ["fact", "belief", "hypothesis"].forEach(function (m) {
      var o = document.createElement("option");
      o.value = m; o.textContent = MODALITY_CN[m];
      if (f.modality === m) o.selected = true;
      mod.appendChild(o);
    });
    if (f.deleted) mod.disabled = true;
    mod.addEventListener("change", function () { f.modality = mod.value; });
    row.appendChild(mod);

    var del = el("span", "f-del", "×");
    del.title = f.isNew ? "移除该行" : "删除该属性";
    del.addEventListener("click", function () {
      if (f.isNew) {
        dp.workingFacts.splice(dp.workingFacts.indexOf(f), 1);
      } else {
        f.deleted = !f.deleted;
      }
      renderProps();
    });
    row.appendChild(del);
    return row;
  }

  function saveProps() {
    var original = {};
    (dp.snapshot.properties || []).forEach(function (f) { original[f.declarationId] = f; });

    var invalidated = [];
    var newFacts = [];

    dp.workingFacts.forEach(function (f) {
      if (f.isNew) {
        if (!f.property.trim()) return;
        newFacts.push({
          entityId: dp.entityId,
          property: f.property.trim(),
          value: Viz.app.parseValue(f.valueRaw),
          modality: f.modality
        });
        return;
      }
      var orig = original[f.declarationId];
      if (!orig) return;
      if (f.deleted) {
        invalidated.push({ declarationId: f.declarationId, property: f.property });
        return;
      }
      var origVal = orig.valueText !== undefined && orig.valueText !== null ? String(orig.valueText) : String(orig.value);
      var changed = (f.valueRaw !== origVal) || (f.modality !== (orig.modality || "fact"));
      if (changed) {
        invalidated.push({ declarationId: f.declarationId, property: f.property });
        newFacts.push({
          entityId: dp.entityId,
          property: f.property,
          value: Viz.app.parseValue(f.valueRaw),
          modality: f.modality
        });
      }
    });

    if (!invalidated.length && !newFacts.length) {
      Viz.app.toast("没有需要保存的修改", true);
      return;
    }

    var ev = {
      eventId: "evt-" + Date.now() + "-" + Math.floor(Math.random() * 10000),
      type: "change",
      storyTime: Viz.app.state.storyTime || "genesis",
      entityId: dp.entityId,
      newFacts: newFacts,
      invalidated: invalidated
    };
    Viz.api.postEvent(ev).then(function () {
      Viz.app.toast("属性已保存", true);
      return Viz.app.refreshGraph();
    }).then(function () {
      return dp.reload();
    }).catch(Viz.app.showError);
  }

  /* ---------- 关系 ---------- */
  function renderRels() {
    var p = pane("rels");
    p.innerHTML = "";
    var id = dp.entityId;
    var rels = (Viz.app.state.relations || []).filter(function (r) {
      return r.sourceId === id || r.targetId === id;
    });
    if (!rels.length) {
      p.appendChild(el("div", "pane-note", "当前条件下无关系"));
      return;
    }
    rels.forEach(function (r) {
      var closed = r.validTo && r.validTo !== "Infinity";
      var row = el("div", "rel-row" + (closed ? " closed" : ""));
      var outgoing = r.sourceId === id;
      row.appendChild(el("span", "rel-dir", outgoing ? "→" : "←"));
      row.appendChild(el("span", null, outgoing ? r.targetId : r.sourceId));
      row.appendChild(el("span", "rel-label", r.label || ""));
      row.appendChild(el("span", "rel-time", r.validFrom || ""));
      if (!closed) {
        var btn = el("button", "tb-btn small", "闭合");
        btn.addEventListener("click", function () {
          Viz.app.confirm("闭合关系",
            "确定闭合关系「" + r.sourceId + " → " + r.targetId + "（" + (r.label || "") + "）」？",
            function () {
              Viz.api.closeRelation(r.sourceId, r.targetId, r.label, Viz.app.state.storyTime)
                .then(function () {
                  Viz.app.toast("关系已闭合", true);
                  return Viz.app.refreshGraph();
                }).then(function () { renderRels(); })
                .catch(Viz.app.showError);
            });
        });
        row.appendChild(btn);
      }
      p.appendChild(row);
    });
  }

  /* ---------- 可见性 ---------- */
  function renderVis() {
    var p = pane("vis");
    p.innerHTML = "";
    var facts = dp.snapshot.properties || [];
    if (!facts.length) {
      p.appendChild(el("div", "pane-note", "当前无属性声明"));
      return;
    }

    var row = el("div", "kv-row");
    row.appendChild(el("label", null, "选择声明"));
    var sel = document.createElement("select");
    facts.forEach(function (f) {
      var o = document.createElement("option");
      o.value = f.declarationId;
      o.textContent = f.property;
      sel.appendChild(o);
    });
    if (dp.visDeclId) sel.value = dp.visDeclId;
    if (sel.value !== dp.visDeclId) dp.visDeclId = sel.value;
    sel.addEventListener("change", function () {
      dp.visDeclId = sel.value;
      renderVisList(p, listWrap);
    });
    row.appendChild(sel);
    p.appendChild(row);

    var listWrap = el("div");
    p.appendChild(listWrap);
    renderVisList(p, listWrap);
  }

  function renderVisList(p, wrap) {
    wrap.innerHTML = "";
    var declId = dp.visDeclId;
    if (!declId) return;
    Viz.api.declarationVisibility(declId, Viz.app.state.storyTime).then(function (visList) {
      wrap.innerHTML = "";
      if (!visList || !visList.length) {
        wrap.appendChild(el("div", "pane-note", "暂无可见性记录"));
      }
      (visList || []).forEach(function (v) {
        var closed = v.validTo && v.validTo !== "Infinity";
        var row = el("div", "vis-row" + (closed ? " closed" : ""));
        row.appendChild(el("span", "v-char", v.characterId));
        row.appendChild(el("span", "v-conf", "置信度 " + v.confidence));
        row.appendChild(el("span", "v-src", "来源 " + (v.source || "—")));
        if (v.isExplicit) row.appendChild(el("span", "v-src", "显式设置"));
        if (!closed) {
          var revoke = el("span", "v-revoke", "撤销");
          revoke.addEventListener("click", function () {
            Viz.api.closeVisibility(v.characterId, declId, Viz.app.state.storyTime)
              .then(function () {
                Viz.app.toast("可见性已撤销", true);
                renderVisList(p, wrap);
                return Viz.app.refreshGraph();
              }).catch(Viz.app.showError);
          });
          row.appendChild(revoke);
        }
        wrap.appendChild(row);
      });

      // 新增表单
      var form = el("div", "fact-row");
      var charInput = document.createElement("input");
      charInput.className = "f-val";
      charInput.placeholder = "角色 ID";
      var confInput = document.createElement("input");
      confInput.className = "f-val";
      confInput.style.width = "60px";
      confInput.style.flex = "none";
      confInput.placeholder = "置信度 0-1";
      var srcInput = document.createElement("input");
      srcInput.className = "f-val";
      srcInput.placeholder = "来源（如 目击）";
      var addBtn = el("button", "tb-btn small", "添加");
      addBtn.addEventListener("click", function () {
        var cid = charInput.value.trim();
        var conf = parseFloat(confInput.value);
        if (!cid) { Viz.app.toast("请填写角色 ID"); return; }
        if (isNaN(conf) || conf < 0 || conf > 1) { Viz.app.toast("置信度需为 0-1 的数字"); return; }
        Viz.api.createVisibility(cid, declId, conf, srcInput.value.trim() || "manual", Viz.app.state.storyTime)
          .then(function () {
            Viz.app.toast("可见性已添加", true);
            renderVisList(p, wrap);
            return Viz.app.refreshGraph();
          }).catch(Viz.app.showError);
      });
      form.appendChild(charInput);
      form.appendChild(confInput);
      form.appendChild(srcInput);
      form.appendChild(addBtn);
      wrap.appendChild(form);
    }).catch(Viz.app.showError);
  }

  /* ---------- 历史 ---------- */
  function renderHistory() {
    var p = pane("history");
    p.innerHTML = "";
    p.appendChild(el("div", "pane-note", "加载中…"));
    Viz.api.entityHistory(dp.entityId).then(function (data) {
      p.innerHTML = "";
      var entities = (data && data.entities) || [];
      var facts = (data && data.facts) || [];
      var relations = (data && data.relations) || [];

      // 版本时间线：实体版本 + 全部 Fact + 关系历史，统一按 validFrom 字典序
      var items = [];
      entities.forEach(function (e) {
        items.push({ from: e.validFrom || "", kind: "entity", obj: e });
      });
      facts.forEach(function (f) {
        items.push({ from: f.validFrom || "", kind: "fact", obj: f });
      });
      relations.forEach(function (r) {
        items.push({ from: r.validFrom || "", kind: "rel", obj: r });
      });
      items.sort(function (a, b) { return a.from < b.from ? -1 : (a.from > b.from ? 1 : 0); });

      if (!items.length) {
        p.appendChild(el("div", "pane-note", "无历史记录"));
        return;
      }
      items.forEach(function (it) {
        var closed = it.obj.validTo && it.obj.validTo !== "Infinity";
        var item = el("div", "hist-item");
        item.appendChild(el("div", "h-time",
          (it.from || "?") + " → " + (closed ? it.obj.validTo : "至今")));
        var line;
        if (it.kind === "entity") {
          line = el("div", "h-line" + (closed ? " closed" : ""),
            "【实体版本】摘要: " + (it.obj.summary || ""));
        } else if (it.kind === "fact") {
          var val = it.obj.valueText !== undefined && it.obj.valueText !== null
            ? it.obj.valueText : JSON.stringify(it.obj.value);
          line = el("div", "h-line" + (closed ? " closed" : ""),
            "【" + modalityCn(it.obj.modality) + "】" + it.obj.property + " = " + val);
        } else {
          line = el("div", "h-line" + (closed ? " closed" : ""),
            "【关系】" + it.obj.sourceId + " → " + it.obj.targetId + "（" + (it.obj.label || "") + "）");
        }
        item.appendChild(line);
        p.appendChild(item);
      });
    }).catch(function (err) {
      p.innerHTML = "";
      p.appendChild(el("div", "pane-note", "历史加载失败"));
      Viz.app.showError(err);
    });
  }
})();
