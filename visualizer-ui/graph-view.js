/* graph-view.js — LiteGraph 画布：实体卡片节点 + 自绘关系边 */
(function () {
  "use strict";
  window.Viz = window.Viz || {};

  var TYPE_COLORS = {
    character: "#4A90E2",
    location: "#7ED321",
    item: "#F5A623",
    concept: "#9013FE"
  };

  var NODE_W = 160, NODE_H = 72;
  var POS_PREFIX = "wg-pos-";

  var gv = {
    graph: null,
    canvas: null,
    nodeMap: {},          // entityId -> LGraphNode
    relations: [],        // 当前可见关系（两端均可见）
    selectedRelation: null,
    highlightId: null,    // 搜索高亮
    relationMode: { active: false, source: null }
  };
  Viz.graph = gv;

  /* ---------- 文本截断 ---------- */
  function truncate(ctx, text, maxWidth) {
    text = String(text === undefined || text === null ? "" : text);
    if (ctx.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  /* ---------- 自定义节点类 ---------- */
  function WorldEntityNode() {
    this.size = [NODE_W, NODE_H];
    this.entity = null; // EntitySnapshot
  }
  WorldEntityNode.title = "entity";
  WorldEntityNode.prototype.onDrawForeground = function (ctx) {
    if (this.flags && this.flags.collapsed) return;
    var e = this.entity;
    if (!e) return;
    var color = TYPE_COLORS[e.type] || "#888";

    // 类型色圆点（标题栏内）
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(12, 15, 4, 0, Math.PI * 2);
    ctx.fill();

    // summary 单行截断
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#aaa";
    ctx.fillText(truncate(ctx, e.summary || "", NODE_W - 14), 7, 42);

    // 前 2 条 Fact
    ctx.font = "11px sans-serif";
    var facts = (e.properties || []).slice(0, 2);
    for (var i = 0; i < facts.length; i++) {
      var f = facts[i];
      var visible = Viz.app.isFactVisible(f.declarationId);
      var val = f.valueText !== undefined && f.valueText !== null ? f.valueText : JSON.stringify(f.value);
      ctx.fillStyle = visible ? "#ccc" : "#555";
      ctx.fillText(
        truncate(ctx, f.property + ": " + val, NODE_W - 14),
        7, 55 + i * 13
      );
    }

    // 搜索高亮 / 关系模式源节点 描边
    if (gv.highlightId === e.entityId) {
      ctx.strokeStyle = "#F5A623";
      ctx.lineWidth = 3;
      ctx.strokeRect(-2, -2, NODE_W + 4, NODE_H + 4);
    } else if (gv.relationMode.active && gv.relationMode.source === e.entityId) {
      ctx.strokeStyle = "#4A90E2";
      ctx.lineWidth = 3;
      ctx.strokeRect(-2, -2, NODE_W + 4, NODE_H + 4);
    }
  };
  WorldEntityNode.prototype.onDblClick = function () {
    if (this.entity) Viz.detail.open(this.entity.entityId);
    return true;
  };
  WorldEntityNode.prototype.onMouseDown = function (e, pos, graphcanvas) {
    if (gv.relationMode.active && this.entity) {
      gv.handleRelationClick(this.entity.entityId);
      return true; // 消费事件，不进入拖拽
    }
    return false;
  };
  // 清掉 LiteGraph 内置的 200+ 节点类型（math/logic/audio 等），只保留我们的实体节点
  LiteGraph.clearRegisteredTypes();
  LiteGraph.registerNodeType("world/entity", WorldEntityNode);

  /* ---------- 位置持久化 ---------- */
  function savePos(entityId, pos) {
    try {
      localStorage.setItem(POS_PREFIX + entityId, JSON.stringify([Math.round(pos[0]), Math.round(pos[1])]));
    } catch (e) { /* ignore */ }
  }
  function loadPos(entityId) {
    try {
      var s = localStorage.getItem(POS_PREFIX + entityId);
      if (!s) return null;
      var p = JSON.parse(s);
      if (Array.isArray(p) && p.length === 2) return p;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveAllPositions() {
    for (var id in gv.nodeMap) {
      var n = gv.nodeMap[id];
      if (n && n.pos) savePos(id, n.pos);
    }
  }

  /* ---------- 布局 ---------- */
  function circleLayout(nodes) {
    var n = Math.max(nodes.length, 1);
    var radius = Math.max(180, 60 * n / Math.PI);
    var cx = 0, cy = 0;
    nodes.forEach(function (node, i) {
      var a = (2 * Math.PI * i) / n;
      node.pos = [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
    });
  }

  /* ---------- 初始化 ---------- */
  gv.init = function (canvasEl) {
    gv.graph = new LGraph();
    gv.canvas = new LGraphCanvas(canvasEl, gv.graph);
    gv.canvas.allow_reconnect_links = false;
    gv.graph.start();

    gv.resize();
    window.addEventListener("resize", gv.resize);

    // 拖拽结束 → 保存位置
    gv.canvas.onNodeMoved = function () { saveAllPositions(); };

    // 自绘关系边
    gv.canvas.onDrawForeground = function (ctx) { drawEdges(ctx); };

    // 右键：命中节点/边/空白 → 自定义菜单（捕获阶段拦截 LiteGraph 原生菜单）
    canvasEl.addEventListener("contextmenu", onContextMenu, true);

    // 左键：边的选中 / 取消
    canvasEl.addEventListener("mousedown", onMouseDown, true);

    // 禁用 LiteGraph 原生节点搜索框（双击空白 / Shift 释放连线等所有入口均由 allow_searchbox 控制）
    gv.canvas.allow_searchbox = false;

    // 双击空白 → 打开"新建实体" modal（双击节点仍由 node.onDblClick 打开详情抽屉）
    canvasEl.addEventListener("dblclick", function (e) {
      var pos = gv.canvas.convertEventToCanvasOffset(e);
      var node = gv.graph.getNodeOnPos(pos[0], pos[1], gv.canvas.visible_nodes, 5);
      if (!node) Viz.app.openNewEntityModal();
    }, true);

    // Delete 闭合选中边
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (gv.selectedRelation) {
        e.preventDefault();
        closeSelectedRelation();
      }
    });
  };

  gv.resize = function () {
    var el = document.getElementById("view-graph");
    if (!el || !gv.canvas) return;
    var w = el.clientWidth, h = el.clientHeight;
    if (w > 0 && h > 0) gv.canvas.resize(w, h);
  };

  gv.redraw = function () {
    if (gv.canvas) gv.canvas.setDirty(true, true);
  };

  /* ---------- 数据装载 ---------- */
  gv.setData = function (entities, relations) {
    var filter = Viz.app.state.typeFilter;
    var oldPos = {};
    for (var id in gv.nodeMap) oldPos[id] = gv.nodeMap[id].pos;

    gv.graph.clear();
    gv.nodeMap = {};
    gv.selectedRelation = null;

    var visibleIds = {};
    var newNodes = [];
    (entities || []).forEach(function (e) {
      if (!filter[e.type]) return;
      visibleIds[e.entityId] = true;
      var node = LiteGraph.createNode("world/entity");
      node.entity = e;
      node.title = e.entityId;
      node.color = TYPE_COLORS[e.type] || "#666";
      var saved = loadPos(e.entityId) || oldPos[e.entityId];
      if (saved) {
        node.pos = [saved[0], saved[1]];
      } else {
        newNodes.push(node);
      }
      gv.graph.add(node);
      gv.nodeMap[e.entityId] = node;
    });

    // 仅保留两端均可见的关系
    gv.relations = (relations || []).filter(function (r) {
      return visibleIds[r.sourceId] && visibleIds[r.targetId];
    });

    if (newNodes.length) {
      circleLayout(newNodes);
      saveAllPositions();
    }

    document.getElementById("graph-empty").classList.toggle(
      "hidden",
      (entities || []).length > 0 || Viz.app.state.storyTimes.length > 0
    );

    gv.redraw();
  };

  gv.applyFilter = function () {
    gv.setData(Viz.app.state.entities, Viz.app.state.relations);
  };

  gv.relayout = function () {
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(POS_PREFIX) === 0) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
    var nodes = [];
    for (var id in gv.nodeMap) nodes.push(gv.nodeMap[id]);
    circleLayout(nodes);
    saveAllPositions();
    gv.redraw();
  };

  /* ---------- 搜索高亮 ---------- */
  var highlightTimer = null;
  gv.highlight = function (entityId) {
    var node = gv.nodeMap[entityId];
    if (!node) {
      Viz.app.toast("实体在当前过滤条件下不可见");
      return;
    }
    gv.canvas.centerOnNode(node);
    gv.highlightId = entityId;
    gv.redraw();
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(function () {
      gv.highlightId = null;
      gv.redraw();
    }, 3000);
  };

  /* ---------- 新建关系（两点模式） ---------- */
  gv.toggleRelationMode = function () {
    gv.relationMode.active = !gv.relationMode.active;
    gv.relationMode.source = null;
    gv.redraw();
    return gv.relationMode.active;
  };

  gv.handleRelationClick = function (entityId) {
    if (!gv.relationMode.source) {
      gv.relationMode.source = entityId;
      gv.redraw();
      return;
    }
    var src = gv.relationMode.source;
    gv.relationMode.active = false;
    gv.relationMode.source = null;
    gv.redraw();
    Viz.app.onRelationModeDone();
    if (src === entityId) {
      Viz.app.toast("源与目标不能是同一实体");
      return;
    }
    Viz.app.openRelationModal(src, entityId);
  };

  /* ---------- 边绘制 ---------- */
  function nodeCenter(node) {
    return [node.pos[0] + node.size[0] / 2, node.pos[1] + node.size[1] / 2];
  }

  function drawEdges(ctx) {
    if (!gv.relations.length) return;
    ctx.save();
    for (var i = 0; i < gv.relations.length; i++) {
      var r = gv.relations[i];
      var a = gv.nodeMap[r.sourceId], b = gv.nodeMap[r.targetId];
      if (!a || !b) continue;
      var closed = r.validTo && r.validTo !== "Infinity";
      var pa = nodeCenter(a), pb = nodeCenter(b);
      var selected = gv.selectedRelation === r;

      ctx.strokeStyle = closed ? "#555" : (selected ? "#F5A623" : "#888");
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.setLineDash(closed ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      // 箭头
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      // 箭头位置：目标节点边缘附近
      var tx = pb[0] - ux * (b.size[0] / 2 + 6), ty = pb[1] - uy * (b.size[1] / 2 + 6);
      ctx.fillStyle = closed ? "#555" : (selected ? "#F5A623" : "#888");
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - ux * 10 - uy * 5, ty - uy * 10 + ux * 5);
      ctx.lineTo(tx - ux * 10 + uy * 5, ty - uy * 10 - ux * 5);
      ctx.closePath();
      ctx.fill();

      // label
      var mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
      ctx.font = "11px sans-serif";
      var label = truncate(ctx, r.label || "", 120);
      var tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(20,20,20,0.85)";
      ctx.fillRect(mx - tw / 2 - 3, my - 8, tw + 6, 14);
      ctx.fillStyle = closed ? "#777" : "#F5A623";
      ctx.fillText(label, mx - tw / 2, my + 3);
    }
    ctx.restore();
  }

  /* ---------- 边命中检测 ---------- */
  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    var t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  function hitEdge(canvasX, canvasY) {
    var best = null, bestDist = 10; // 10px 命中阈值
    for (var i = 0; i < gv.relations.length; i++) {
      var r = gv.relations[i];
      var a = gv.nodeMap[r.sourceId], b = gv.nodeMap[r.targetId];
      if (!a || !b) continue;
      var pa = nodeCenter(a), pb = nodeCenter(b);
      var d = distToSegment(canvasX, canvasY, pa[0], pa[1], pb[0], pb[1]);
      if (d < bestDist) { bestDist = d; best = r; }
    }
    return best;
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (gv.relationMode.active) return; // 由节点 onMouseDown 处理
    if (!gv.canvas) return;
    var pos = gv.canvas.convertEventToCanvasOffset(e);
    var node = gv.graph.getNodeOnPos(pos[0], pos[1], gv.canvas.visible_nodes, 5);
    if (node) {
      if (gv.selectedRelation) { gv.selectedRelation = null; gv.redraw(); }
      return;
    }
    var edge = hitEdge(pos[0], pos[1]);
    var changed = (edge || null) !== (gv.selectedRelation || null);
    gv.selectedRelation = edge;
    if (changed) gv.redraw();
  }

  function onContextMenu(e) {
    if (!gv.canvas) return;
    e.preventDefault();
    e.stopPropagation();
    var pos = gv.canvas.convertEventToCanvasOffset(e);
    var node = gv.graph.getNodeOnPos(pos[0], pos[1], gv.canvas.visible_nodes, 5);
    if (node && node.entity) {
      var entityId = node.entity.entityId;
      var relCount = gv.relations.filter(function (r) {
        return r.sourceId === entityId || r.targetId === entityId;
      }).length;
      Viz.app.showCtxMenu(e.clientX, e.clientY, [
        { label: "查看详情", onClick: function () { Viz.detail.open(entityId); } },
        {
          label: "消亡实体", danger: true, onClick: function () {
            Viz.app.confirm(
              "消亡实体",
              "确定消亡实体「" + entityId + "」？当前关联关系数：" + relCount + "。",
              function () {
                Viz.api.postEvent({
                  eventId: "evt-" + Date.now() + "-" + Math.floor(Math.random() * 10000),
                  type: "death",
                  storyTime: Viz.app.state.storyTime || "genesis",
                  entityId: entityId
                }).then(function () {
                  Viz.app.toast("实体已消亡", true);
                  Viz.detail.close();
                  return Viz.app.refreshGraph();
                }).catch(Viz.app.showError);
              }
            );
          }
        }
      ]);
      return;
    }
    var edge = hitEdge(pos[0], pos[1]);
    if (edge) {
      gv.selectedRelation = edge;
      gv.redraw();
      Viz.app.showCtxMenu(e.clientX, e.clientY, [
        {
          label: "闭合关系「" + (edge.label || "") + "」", danger: true,
          onClick: closeSelectedRelation
        }
      ]);
      return;
    }
    Viz.app.showCtxMenu(e.clientX, e.clientY, [
      { label: "新建实体", onClick: function () { Viz.app.openNewEntityModal(); } }
    ]);
  }

  function closeSelectedRelation() {
    var r = gv.selectedRelation;
    if (!r) return;
    Viz.app.confirm(
      "闭合关系",
      "确定闭合关系「" + r.sourceId + " → " + r.targetId + "（" + (r.label || "") + "）」？",
      function () {
        Viz.api.closeRelation(r.sourceId, r.targetId, r.label, Viz.app.state.storyTime)
          .then(function () {
            Viz.app.toast("关系已闭合", true);
            gv.selectedRelation = null;
            return Viz.app.refreshGraph();
          }).catch(Viz.app.showError);
      }
    );
  }
})();
