/* events-view.js — 事件链 Tab：按 storyTime 列布局的 DOM 卡片 + SVG 因果连线 */
(function () {
  "use strict";
  window.Viz = window.Viz || {};

  var ev = { events: [], selectedId: null };
  Viz.events = ev;

  var COL_W = 200, ROW_H = 96, PAD = 24;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  ev.load = function () {
    return Viz.api.events().then(function (events) {
      ev.events = events || [];
      ev.selectedId = null;
      document.getElementById("event-detail").classList.add("hidden");
      render();
    }).catch(function (err) {
      Viz.app.showError(err);
    });
  };

  function tail4(id) {
    id = String(id || "");
    return id.length > 4 ? id.slice(-4) : id;
  }

  function causedByList(event) {
    if (!event.causedBy) return [];
    return Array.isArray(event.causedBy) ? event.causedBy : [event.causedBy];
  }

  function render() {
    var cardsWrap = document.getElementById("events-cards");
    var svg = document.getElementById("events-links");
    var wrap = document.getElementById("events-canvas-wrap");
    cardsWrap.innerHTML = "";
    svg.innerHTML = "";

    if (!ev.events.length) {
      cardsWrap.appendChild(el("div", "pane-note", "暂无事件"));
      return;
    }

    // 按 storyTime 分列（字典序即时间序）
    var times = [];
    var byTime = {};
    ev.events.forEach(function (e) {
      var t = e.storyTime || "";
      if (!byTime[t]) { byTime[t] = []; times.push(t); }
      byTime[t].push(e);
    });
    times.sort();

    var positions = {}; // eventId -> {x, y}
    var maxRows = 0;
    times.forEach(function (t, col) {
      var list = byTime[t];
      maxRows = Math.max(maxRows, list.length);
      list.forEach(function (e, row) {
        positions[e.eventId] = { x: PAD + col * COL_W, y: PAD + row * ROW_H, event: e };
      });
    });

    var width = PAD * 2 + times.length * COL_W;
    var height = PAD * 2 + maxRows * ROW_H;
    wrap.style.width = width + "px";
    wrap.style.height = height + "px";
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);

    // 连线（causedBy）
    ev.events.forEach(function (e) {
      causedByList(e).forEach(function (srcId) {
        var a = positions[srcId], b = positions[e.eventId];
        if (!a || !b) return;
        var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", a.x + 150);
        line.setAttribute("y1", a.y + 36);
        line.setAttribute("x2", b.x);
        line.setAttribute("y2", b.y + 36);
        line.setAttribute("stroke", e.source === "user" ? "#4A90E2" : "#555");
        line.setAttribute("stroke-width", "1.5");
        svg.appendChild(line);
        // 箭头
        var marker = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        marker.setAttribute("points",
          (b.x) + "," + (b.y + 36) + " " +
          (b.x - 8) + "," + (b.y + 31) + " " +
          (b.x - 8) + "," + (b.y + 41));
        marker.setAttribute("fill", e.source === "user" ? "#4A90E2" : "#555");
        svg.appendChild(marker);
      });
    });

    // 卡片
    Object.keys(positions).forEach(function (id) {
      var pos = positions[id];
      var e = pos.event;
      var card = el("div", "event-card " + (e.source === "user" ? "user" : "engine"));
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";

      var head = el("div");
      head.appendChild(el("span", "ec-id", "…" + tail4(e.eventId)));
      head.appendChild(el("span", "ec-type " + (e.type || ""), e.type || "?"));
      card.appendChild(head);

      card.appendChild(el("div", "ec-time", e.storyTime || ""));

      var nf = (e.newFacts || []).length;
      var inv = (e.invalidated || []).length;
      var badges = el("div", "ec-badges");
      badges.appendChild(el("span", "badge", "+" + nf));
      badges.appendChild(el("span", "badge inv", "-" + inv));
      card.appendChild(badges);

      card.addEventListener("click", function () {
        ev.selectedId = e.eventId;
        cardsWrap.querySelectorAll(".event-card").forEach(function (c) { c.classList.remove("selected"); });
        card.classList.add("selected");
        showDetail(e);
      });
      cardsWrap.appendChild(card);
    });
  }

  function showDetail(e) {
    var panel = document.getElementById("event-detail");
    panel.classList.remove("hidden");
    var pretty = {
      eventId: e.eventId,
      type: e.type,
      storyTime: e.storyTime,
      entityId: e.entityId,
      source: e.source,
      summary: e.summary,
      causedBy: e.causedBy,
      newFacts: e.newFacts || [],
      invalidated: e.invalidated || []
    };
    panel.textContent = JSON.stringify(pretty, function (k, v) {
      return v === undefined ? undefined : v;
    }, 2);
  }
})();
