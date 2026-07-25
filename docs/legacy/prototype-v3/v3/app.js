/* World Graph V3 原型 — 只读展示：时间轴 + 实体列表 + 3D 全景 + 详情 */
(function () {
  "use strict";
  var DATA = window.PROTO_DATA;
  var TYPE_COLOR = { character: "#4A90E2", location: "#7ED321", item: "#F5A623", concept: "#9013FE" };
  var TYPE_NAME = { character: "角色", location: "地点", item: "物品", concept: "概念" };
  var MOD_NAME = { fact: "事实", belief: "信念", hypothesis: "推测" };

  var state = { storyTime: null, selected: null, types: { character: 1, location: 1, item: 1, concept: 1 }, q: "" };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function displayName(ent) {
    var p = (ent.properties || []).find(function (f) { return f.property === "姓名" || f.property === "名称" || f.property === "name"; });
    return p ? String(p.value) : ent.entityId;
  }
  function snap() { return DATA.snapshots[state.storyTime] || { entities: [], relations: [] }; }

  /* ---------- 时间轴 ---------- */
  function renderTimeline() {
    var track = $("timeline-track");
    track.querySelectorAll(".tick").forEach(function (t) { t.remove(); });
    var times = DATA.storyTimes;
    var evtCount = {};
    DATA.events.forEach(function (e) { evtCount[e.storyTime] = (evtCount[e.storyTime] || 0) + 1; });
    times.forEach(function (t, i) {
      var el = document.createElement("div");
      el.className = "tick" + (t === state.storyTime ? " active" : "");
      el.style.left = (times.length === 1 ? 50 : (i / (times.length - 1)) * 96 + 2) + "%";
      el.innerHTML = '<div class="dot"></div><div class="lbl">' + esc(t) + '</div>' +
        (evtCount[t] ? '<div class="evt">' + evtCount[t] + " 事件</div>" : "");
      el.onclick = function () { state.storyTime = t; state.selected = null; refresh(); };
      track.appendChild(el);
    });
    $("now-label").textContent = "当前：" + state.storyTime;
  }

  /* ---------- 左栏 ---------- */
  function renderList() {
    var list = $("entity-list");
    var entities = snap().entities.filter(function (e) {
      if (!state.types[e.type]) return false;
      if (state.q) {
        var hay = (e.entityId + " " + (e.summary || "") + " " +
          (e.properties || []).map(function (f) { return f.property + " " + f.value; }).join(" ")).toLowerCase();
        if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
    list.innerHTML = entities.map(function (e) {
      return '<div class="ent' + (state.selected === e.entityId ? " sel" : "") + '" data-id="' + esc(e.entityId) + '">' +
        '<div class="n"><i class="dot" style="background:' + TYPE_COLOR[e.type] + '"></i>' +
        esc(displayName(e)) + '<span style="color:#a0aec0;font-weight:400;font-size:11px">' + esc(e.entityId) + "</span></div>" +
        '<div class="s">' + esc(e.summary || "（无摘要）") + "</div></div>";
    }).join("") || '<div style="padding:20px;color:#8492a6;font-size:12px;text-align:center">无匹配实体</div>';
    list.querySelectorAll(".ent").forEach(function (el) {
      el.onclick = function () { select(el.getAttribute("data-id")); };
    });
    $("count").textContent = entities.length + " / " + snap().entities.length + " 个实体 · " +
      snap().relations.length + " 条关系";
  }

  /* ---------- 3D 图 ---------- */
  var Graph = null;
  function initGraph() {
    Graph = ForceGraph3D()($("graph3d"))
      .backgroundColor("#14171d")
      .nodeColor(function (n) { return state.selected === n.id ? "#e74c3c" : TYPE_COLOR[n.type]; })
      .nodeOpacity(0.92)
      .nodeResolution(24)
      .nodeLabel(function (n) { return n.name + "（" + TYPE_NAME[n.type] + "）" + (n.summary ? "<br>" + esc(n.summary) : ""); })
      .linkColor(function () { return "#3d4656"; })
      .linkWidth(1.2)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .linkLabel(function (l) { return esc(l.label); })
      .nodeThreeObject(function (n) {
        var sprite = new SpriteText(n.name);
        sprite.color = "#dfe4ec";
        sprite.textHeight = 5;
        sprite.position.y = 10;
        return sprite;
      })
      .nodeThreeObjectExtend(true)
      .onNodeClick(function (n) { select(n.id); })
      .onNodeHover(function (n) { $("graph3d").style.cursor = n ? "pointer" : "default"; });
  }

  function graphData() {
    var s = snap();
    var nodes = s.entities.map(function (e) {
      return { id: e.entityId, name: displayName(e), type: e.type, summary: e.summary || "" };
    });
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = 1; });
    var links = s.relations.filter(function (r) { return ids[r.sourceId] && ids[r.targetId]; })
      .map(function (r) { return { source: r.sourceId, target: r.targetId, label: r.label }; });
    return { nodes: nodes, links: links };
  }

  function renderGraph() {
    Graph.graphData(graphData());
    var s = snap();
    $("view-title").textContent = "全景图 · " + state.storyTime + " · " +
      s.entities.length + " 实体 / " + s.relations.length + " 关系";
  }

  /* ---------- 右栏详情 ---------- */
  function renderDetail() {
    var ent = snap().entities.find(function (e) { return e.entityId === state.selected; });
    $("right-empty").style.display = ent ? "none" : "";
    $("right-body").style.display = ent ? "" : "none";
    if (!ent) return;
    var dead = ent.validTo !== "Infinity";
    $("sec-basic").innerHTML =
      '<div class="kv"><span class="k">名称</span><span class="v"><b>' + esc(displayName(ent)) + "</b></span></div>" +
      '<div class="kv"><span class="k">实体 ID</span><span class="v">' + esc(ent.entityId) + "</span></div>" +
      '<div class="kv"><span class="k">类型</span><span class="v" style="color:' + TYPE_COLOR[ent.type] + '">' + TYPE_NAME[ent.type] + "</span></div>" +
      '<div class="kv"><span class="k">摘要</span><span class="v">' + esc(ent.summary || "（无）") + "</span></div>" +
      '<div class="kv"><span class="k">诞生</span><span class="v">' + esc(ent.validFrom) + "</span></div>" +
      '<div class="kv"><span class="k">消亡</span><span class="v">' + (dead ? esc(ent.validTo) : "至今") + "</span></div>";
    $("sec-props").innerHTML = (ent.properties || []).length
      ? '<table class="props"><tr><th>属性</th><th>值</th><th>模态</th></tr>' +
        ent.properties.map(function (f) {
          return "<tr><td>" + esc(f.property) + "</td><td>" + esc(typeof f.value === "object" ? JSON.stringify(f.value) : f.value) +
            '</td><td><span class="mod ' + esc(f.modality) + '">' + (MOD_NAME[f.modality] || f.modality) + "</span></td></tr>";
        }).join("") + "</table>"
      : '<div style="font-size:12px;color:#8492a6">该实体在此刻没有属性</div>';
    var rels = snap().relations.filter(function (r) { return r.sourceId === ent.entityId || r.targetId === ent.entityId; });
    $("sec-rels").innerHTML = rels.length
      ? rels.map(function (r) {
          var out = r.sourceId === ent.entityId;
          return '<div class="rel-row">' + (out ? esc(displayName(ent)) : esc(r.sourceId)) +
            '<span class="arrow">—' + esc(r.label) + "→</span>" +
            (out ? esc(r.targetId) : esc(displayName(ent))) + "</div>";
        }).join("")
      : '<div style="font-size:12px;color:#8492a6">此刻没有关系</div>';
  }

  /* ---------- 交互 ---------- */
  function select(id) {
    state.selected = id;
    renderList(); renderDetail(); renderGraph();
    // 相机聚焦（布局完成后节点才有坐标）
    var n = Graph.graphData().nodes.find(function (x) { return x.id === id; });
    if (n && n.x !== undefined) {
      var dist = 90;
      var ratio = 1 + dist / Math.hypot(n.x, n.y, n.z || 1);
      Graph.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: (n.z || 1) * ratio }, n, 900);
    }
  }

  function refresh() { renderTimeline(); renderList(); renderGraph(); renderDetail(); }

  $("search").addEventListener("input", function (e) { state.q = e.target.value; renderList(); });
  document.querySelectorAll(".chip").forEach(function (c) {
    c.onclick = function () {
      var t = c.getAttribute("data-type");
      state.types[t] = !state.types[t];
      c.classList.toggle("on", !!state.types[t]);
      renderList();
    };
  });
  window.addEventListener("resize", function () { Graph.width($("center").clientWidth).height($("center").clientHeight); });

  /* ---------- 启动 ---------- */
  state.storyTime = DATA.storyTimes[DATA.storyTimes.length - 1];
  initGraph();
  Graph.width($("center").clientWidth).height($("center").clientHeight);
  refresh();
})();
