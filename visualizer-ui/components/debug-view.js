/* debug-view.js — 调试日志监控（DAG 可视化 + SSE 实时推送 + 节点抽屉）
 *
 * 数据流：
 *   后端 DebugBus → /api/debug/stream (SSE) → 本组件 → DAG 节点图 + 事件列表
 *
 * DAG 构建：
 *   - 按 traceId 聚合事件，每个 traceId 一张 DAG
 *   - 节点 = stage（同 stage 多次执行按 (traceId, stage, startEventId) 去重为单个节点）
 *   - 边 = parentId（子阶段 → 父阶段）
 *   - 节点状态：start 进行中 / end 成功 / error 失败
 *
 * 布局：纵向树形，根节点（dispatch/commit）在顶部，子节点向下展开。
 * 使用简易层级算法（按 parentId 链计算 depth），SVG 绘制节点+连线。
 */
(function () {
  "use strict";

  var STAGE_COLOR = {
    dispatch: "#4A90E2",
    commit: "#7ED321",
    "plan.llm": "#F5A623",
    "retrieve.item": "#9013FE",
    "role.interact": "#E261A8",
    "role.turn": "#F08CBB",
    "commit.step.4": "#5BC0EB",
    "commit.step.4.4": "#9BC53D",
    "commit.step.5": "#FA7268",
    "commit.step.7": "#C7B6FF"
  };
  var STATUS_COLOR = {
    start: "#6ea8fe",     // 进行中（蓝）
    end: "#4caf7d",       // 成功（绿）
    error: "#e05555"      // 失败（红）
  };

  /* 计算节点的层级（深度）。根节点 depth=0。 */
  function computeDepth(node, nodesById, cache) {
    if (cache[node.id] !== undefined) return cache[node.id];
    if (!node.parentId || !nodesById[node.parentId]) {
      cache[node.id] = 0;
      return 0;
    }
    var parent = nodesById[node.parentId];
    var d = computeDepth(parent, nodesById, cache) + 1;
    cache[node.id] = d;
    return d;
  }

  /* 按 traceId 聚合事件 → DAG 节点 + 边 */
  function buildDag(events) {
    // 1. 配对 start/end/error 事件 → 节点
    //    节点 id = start 事件 id（同 stage 多次执行各成一个节点）
    var nodesById = {};
    var pendingSpans = {}; // key: traceId + "|" + stage → startEvent
    var edges = [];

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.status === "start") {
        var node = {
          id: ev.id,
          traceId: ev.traceId,
          stage: ev.stage,
          status: "start",
          input: ev.input,
          output: undefined,
          error: undefined,
          durationMs: undefined,
          startTs: ev.ts,
          endTs: undefined,
          parentId: ev.parentId
        };
        nodesById[ev.id] = node;
        pendingSpans[ev.traceId + "|" + ev.stage + "|" + ev.id] = node;
      }
    }

    // 2. 配对 end/error（按 traceId + stage 匹配最近的 pending start）
    //    注意：同一 stage 可能多次执行，按 parentId 进一步精确匹配
    for (var j = 0; j < events.length; j++) {
      var ev2 = events[j];
      if (ev2.status === "end" || ev2.status === "error") {
        // 找到匹配的 start 节点：traceId + stage + parentId 一致
        var matched = null;
        var matchedKey = null;
        for (var key in pendingSpans) {
          var n = pendingSpans[key];
          if (n.traceId === ev2.traceId && n.stage === ev2.stage) {
            // parentId 匹配优先；若只有一个候选则直接用
            if (ev2.parentId === n.parentId) {
              matched = n;
              matchedKey = key;
              break;
            }
            if (!matched) { matched = n; matchedKey = key; }
          }
        }
        if (matched) {
          matched.status = ev2.status;
          matched.output = ev2.output;
          matched.error = ev2.error;
          matched.durationMs = ev2.durationMs;
          matched.endTs = ev2.ts;
          delete pendingSpans[matchedKey];
        }
      }
    }

    // 3. 构建边（parentId 指向的节点存在时）
    var nodes = Object.values(nodesById);
    for (var k = 0; k < nodes.length; k++) {
      var nd = nodes[k];
      if (nd.parentId && nodesById[nd.parentId]) {
        edges.push({ from: nd.parentId, to: nd.id });
      }
    }

    return { nodes: nodes, nodesById: nodesById, edges: edges };
  }

  /* 按 traceId 分组并按开始时间排序 */
  function groupByTrace(events) {
    var map = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!map[ev.traceId]) map[ev.traceId] = [];
      map[ev.traceId].push(ev);
    }
    // 每个 trace 内按 ts 排序
    var traces = [];
    for (var tid in map) {
      map[tid].sort(function (a, b) { return a.ts - b.ts; });
      traces.push({ traceId: tid, events: map[tid], startTs: map[tid][0].ts });
    }
    traces.sort(function (a, b) { return b.startTs - a.startTs; }); // 最近的在前
    return traces;
  }

  /* 简易纵向树形布局：每层节点水平居中；同层超过 MAX_PER_ROW 个时换行（避免 viewBox 过宽被缩得过小） */
  var MAX_PER_ROW = 6;
  function layoutTree(nodes, nodesById) {
    var depthCache = {};
    var layers = {}; // depth → [node]
    for (var i = 0; i < nodes.length; i++) {
      var d = computeDepth(nodes[i], nodesById, depthCache);
      if (!layers[d]) layers[d] = [];
      layers[d].push(nodes[i]);
    }
    var maxDepth = 0;
    for (var k in layers) { if (Number(k) > maxDepth) maxDepth = Number(k); }

    var NODE_W = 190, NODE_H = 64, GAP_X = 20, GAP_Y = 70, SUB_GAP_Y = 26;
    var positions = {};
    var yOffset = 0;
    for (var depth = 0; depth <= maxDepth; depth++) {
      var layer = layers[depth] || [];
      for (var r = 0; r * MAX_PER_ROW < layer.length; r++) {
        var row = layer.slice(r * MAX_PER_ROW, (r + 1) * MAX_PER_ROW);
        var totalW = row.length * NODE_W + (row.length - 1) * GAP_X;
        var startX = -totalW / 2;
        for (var i2 = 0; i2 < row.length; i2++) {
          positions[row[i2].id] = {
            x: startX + i2 * (NODE_W + GAP_X),
            y: yOffset,
            w: NODE_W,
            h: NODE_H
          };
        }
        var isLastRow = (r + 1) * MAX_PER_ROW >= layer.length;
        yOffset += NODE_H + (isLastRow ? GAP_Y : SUB_GAP_Y);
      }
    }
    return { positions: positions, maxDepth: maxDepth, nodeW: NODE_W, nodeH: NODE_H };
  }

  /* 格式化耗时 */
  function fmtDuration(ms) {
    if (ms === undefined) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(2) + "s";
  }

  /* 格式化时间戳 */
  function fmtTs(ts) {
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    var ms = String(d.getMilliseconds()).padStart(3, "0");
    return hh + ":" + mm + ":" + ss + "." + ms;
  }

  /* JSON 美化（含错误处理） */
  function fmtJson(obj) {
    if (obj === undefined) return "";
    try {
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return String(obj);
    }
  }

  /* 节点状态徽标 */
  function statusLabel(s) {
    return s === "start" ? "运行中" : s === "end" ? "成功" : "失败";
  }

  window.V3.components.DebugView = {
    name: "DebugView",
    props: {},
    data: function () {
      return {
        events: [],              // 全部事件（按时间顺序）
        traces: [],              // 按 traceId 聚合的 trace 列表
        selectedNodeId: "",      // 抽屉中显示的节点
        paused: false,           // 暂停推送
        filterText: "",          // 关键词过滤（按 stage/traceId）
        connected: false,        // SSE 连接状态
        sseError: "",            // SSE 错误信息（空=无错误）
        reconnectTimer: null,
        eventSource: null,
        maxEvents: 2000,         // 前端最多保留事件数（防止内存膨胀）
        zoom: 1,                 // DAG 缩放倍数
        panX: 0,                 // DAG 平移（viewBox 坐标单位）
        panY: 0,
        dragMoved: false         // 拖拽中/刚结束时抑制节点点击
      };
    },
    computed: {
      /* 按 traceId 聚合，过滤后（基于已构建的 traces，避免丢失 dag/layout） */
      filteredTraces: function () {
        if (!this.filterText) return this.traces;
        var q = this.filterText.toLowerCase();
        return this.traces.filter(function (tr) {
          // traceId 匹配
          if (tr.traceId.toLowerCase().indexOf(q) >= 0) return true;
          // 任一事件的 stage 匹配
          for (var i = 0; i < tr.events.length; i++) {
            if (tr.events[i].stage && tr.events[i].stage.toLowerCase().indexOf(q) >= 0) return true;
          }
          return false;
        });
      },
      /* 当前选中的节点对象 */
      selectedNode: function () {
        if (!this.selectedNodeId) return null;
        for (var i = 0; i < this.traces.length; i++) {
          var dag = this.traces[i].dag;
          if (dag && dag.nodesById[this.selectedNodeId]) {
            return dag.nodesById[this.selectedNodeId];
          }
        }
        return null;
      },
      /* 当前选中节点所属 trace 的事件列表 */
      selectedTraceEvents: function () {
        if (!this.selectedNode) return [];
        for (var i = 0; i < this.traces.length; i++) {
          if (this.traces[i].traceId === this.selectedNode.traceId) {
            return this.traces[i].events;
          }
        }
        return [];
      },
      /* SVG 缩放+平移变换（作用于内容 g） */
      svgTransform: function () {
        return "translate(" + this.panX + " " + this.panY + ") scale(" + this.zoom + ")";
      },
      /* 统计信息 */
      stats: function () {
        var running = 0, success = 0, failed = 0;
        for (var i = 0; i < this.traces.length; i++) {
          var nodes = this.traces[i].dag.nodes;
          for (var j = 0; j < nodes.length; j++) {
            if (nodes[j].status === "start") running++;
            else if (nodes[j].status === "end") success++;
            else if (nodes[j].status === "error") failed++;
          }
        }
        return { traces: this.traces.length, running: running, success: success, failed: failed };
      }
    },
    watch: {
      paused: function (v) {
        if (v && this.eventSource) {
          // 暂停：断开 SSE，保留已接收事件
          this.closeStream();
        } else if (!v && !this.eventSource) {
          // 恢复：重新连接
          this.connectStream();
        }
      }
    },
    mounted: function () {
      this.connectStream();
    },
    beforeUnmount: function () {
      this.closeStream();
    },
    methods: {
      /* 模板工具函数（IIFE 内部函数模板访问不到，必须挂到 methods） */
      fmtTs: fmtTs,
      fmtDuration: fmtDuration,
      fmtJson: fmtJson,
      statusLabel: statusLabel,
      /* 连接 SSE */
      connectStream: function () {
        var self = this;
        this.closeStream();
        this.sseError = "";
        // L-FE-4：探测请求挂 AbortController（组件卸载后中止回调）+ 走 api.js 封装
        var ctrl = new AbortController();
        this._probeAbort = ctrl;
        V3.api.debugEvents(ctrl.signal).then(function (r) {
          if (r.status === 503) {
            // debugBus 未注入 → 端点存在但调试总线未启用
            return r.json().then(function (body) {
              self.sseError = "调试总线未启用（503）。请确认：① pi 已重启加载新代码；② visualizer_start 在本会话重新调用过；③ 未设置 PI_DEBUG=off。";
              self.connected = false;
            }).catch(function () {
              self.sseError = "调试总线未启用（503）。";
              self.connected = false;
            });
          } else if (r.status === 404) {
            self.sseError = "调试端点不存在（404）。请确认可视化服务已加载最新代码。";
            self.connected = false;
          } else if (r.ok) {
            // 端点正常，建立 SSE 长连接
            self.openEventSource();
          } else {
            self.sseError = "调试端点异常（HTTP " + r.status + "）";
            self.connected = false;
          }
        }).catch(function (err) {
          self.sseError = "无法连接可视化服务：" + err.message + "（请确认 visualizer_start 已启动）";
          self.connected = false;
        });
      },
      /* 真正建立 SSE 长连接 */
      openEventSource: function () {
        var self = this;
        try {
          var ES = window.EventSource;
          if (!ES) {
            this.sseError = "浏览器不支持 SSE";
            return;
          }
          var es = new ES(V3.api.debugStreamUrl);
          this.eventSource = es;
          es.onopen = function () {
            self.connected = true;
            self.sseError = "";
            self._sseRetryCount = 0;  // M-Logic-13：连接成功复位退避
          };
          es.onmessage = function (msg) {
            if (!msg || !msg.data) return;
            if (msg.data.charAt(0) === ":") return;  // 心跳注释
            self._sseRetryCount = 0;  // M-Logic-13：收到消息复位退避
            try {
              var ev = JSON.parse(msg.data);
              console.debug("[debug-view] SSE event:", ev && ev.stage, ev && ev.status);
              self.appendEvent(ev);
            } catch (e) {
              console.warn("[debug-view] SSE parse error:", e, msg.data.slice(0, 200));
            }
          };
          es.onerror = function () {
            self.connected = false;
            if (!self.paused) {
              self.clearReconnectTimer();
              // M-Logic-13 修复：指数退避重连（1s→2s→4s…→30s 上限），
              // 旧实现固定 3s 重连——后端不可达时持续高频打挂
              var attempt = self._sseRetryCount || 0;
              var delay = Math.min(1000 * Math.pow(2, attempt), 30000);
              self._sseRetryCount = attempt + 1;
              self.reconnectTimer = setTimeout(function () {
                self.connectStream();
              }, delay);
            }
          };
        } catch (e) {
          this.sseError = "SSE 建立失败：" + e.message;
        }
      },
      /* 手动拉取历史事件并填充到前端（诊断 + 补救 SSE 时序问题） */
      sendTestEvent: function () {
        var self = this;
        V3.api.debugEvents().then(function (r) {
          if (!r.ok) {
            window.ElementPlus.ElMessage({ message: "调试端点不可用（HTTP " + r.status + "）", type: "error" });
            return;
          }
          return r.json().then(function (body) {
            var events = (body && body.data && body.data.events) || [];
            // 主动填充：把缓冲区事件合并到前端（去重）
            var added = 0;
            for (var i = 0; i < events.length; i++) {
              var ev = events[i];
              var exists = false;
              for (var j = self.events.length - 1; j >= 0 && j >= self.events.length - 200; j--) {
                if (self.events[j].id === ev.id) { exists = true; break; }
              }
              if (!exists) { self.events.push(ev); added++; }
            }
            if (added > 0) self.rebuildTraces();
            window.ElementPlus.ElMessage({
              message: "端点可用，缓冲区 " + events.length + " 条事件，本次新增 " + added + " 条到前端" +
                       (events.length === 0 ? "（调度器尚未发射事件，请触发 scheduler_dispatch 后再查看）" : ""),
              type: events.length > 0 ? "success" : "info",
              duration: 4000
            });
          });
        }).catch(function (err) {
          window.ElementPlus.ElMessage({ message: "请求失败：" + err.message, type: "error" });
        });
      },
      closeStream: function () {
        // L-FE-4：中止未完成的探测请求（组件卸载后不再执行回调）
        if (this._probeAbort) {
          try { this._probeAbort.abort(); } catch (e) {}
          this._probeAbort = null;
        }
        if (this.eventSource) {
          try { this.eventSource.close(); } catch (e) {}
          this.eventSource = null;
        }
        this.connected = false;
        this.clearReconnectTimer();
      },
      clearReconnectTimer: function () {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      },
      /* 追加事件（去重 + 容量限制 + 立即重建 DAG） */
      appendEvent: function (ev) {
        if (this.paused) return; // 暂停期间丢弃（保持简单）
        // 去重：按 id
        for (var i = this.events.length - 1; i >= 0 && i >= this.events.length - 50; i--) {
          if (this.events[i].id === ev.id) return;
        }
        this.events.push(ev);
        // 容量限制：FIFO 淘汰
        if (this.events.length > this.maxEvents) {
          this.events.splice(0, this.events.length - this.maxEvents);
        }
        // 立即重建 traces（不依赖 watch 异步触发，避免渲染滞后）
        this.rebuildTraces();
      },
      /* 重建 traces + DAG（增量重建，简单实现） */
      rebuildTraces: function () {
        var grouped = groupByTrace(this.events);
        for (var i = 0; i < grouped.length; i++) {
          grouped[i].dag = buildDag(grouped[i].events);
          grouped[i].layout = layoutTree(grouped[i].dag.nodes, grouped[i].dag.nodesById);
        }
        this.traces = grouped;
      },
      /* 清空事件（调用后端 clear + 前端清空） */
      clearEvents: function () {
        var self = this;
        V3.api.debugClear()
        .then(function () {
            self.events = [];
            self.traces = [];
            self.selectedNodeId = "";
            window.ElementPlus.ElMessage({ message: "已清空", type: "success", duration: 1500 });
          })
          .catch(function (err) {
            window.ElementPlus.ElMessage({ message: "清空失败：" + err.message, type: "error" });
          });
      },
      /* 选中节点（拖拽平移后忽略误触点击） */
      selectNode: function (id) {
        if (this.dragMoved) return;
        this.selectedNodeId = id;
      },
      /* 滚轮缩放：以光标位置为锚点（考虑 preserveAspectRatio=meet 的居中信箱） */
      onSvgWheel: function (e) {
        var svg = e.currentTarget;
        var rect = svg.getBoundingClientRect();
        var vb = svg.viewBox.baseVal;
        var scale = Math.min(rect.width / vb.width, rect.height / vb.height);
        var offX = (rect.width - vb.width * scale) / 2;
        var offY = (rect.height - vb.height * scale) / 2;
        // 光标对应的 viewBox 坐标
        var sx = vb.x + (e.clientX - rect.left - offX) / scale;
        var sy = vb.y + (e.clientY - rect.top - offY) / scale;
        var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        var z2 = Math.min(6, Math.max(0.15, this.zoom * factor));
        // 保持光标下的内容点不动：pan' = s - (s - pan) / zoom * zoom'
        this.panX = sx - (sx - this.panX) / this.zoom * z2;
        this.panY = sy - (sy - this.panY) / this.zoom * z2;
        this.zoom = z2;
      },
      /* 左键拖拽平移 */
      onSvgMouseDown: function (e) {
        if (e.button !== 0) return;
        var self = this;
        var svg = e.currentTarget;
        var rect = svg.getBoundingClientRect();
        var vb = svg.viewBox.baseVal;
        var scale = Math.min(rect.width / vb.width, rect.height / vb.height);
        var startX = e.clientX, startY = e.clientY;
        var origX = this.panX, origY = this.panY;
        this.dragMoved = false;
        function move(ev) {
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) {
            self.dragMoved = true;
          }
          self.panX = origX + (ev.clientX - startX) / scale;
          self.panY = origY + (ev.clientY - startY) / scale;
        }
        function up() {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          // click 在 mouseup 之后触发，延迟清除标记以抑制误选
          setTimeout(function () { self.dragMoved = false; }, 0);
        }
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      },
      /* 重置缩放与平移（双击 SVG 或点击工具栏按钮） */
      resetZoom: function () {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
      },
      /* 阶段名过长时截断（悬停 title 显示全名） */
      shortStage: function (s) {
        return s && s.length > 22 ? s.slice(0, 21) + "…" : s;
      },
      /* 节点颜色：按状态优先，其次按 stage */
      nodeFill: function (node) {
        if (node.status === "error") return STATUS_COLOR.error;
        if (node.status === "start") return STATUS_COLOR.start;
        // end 状态用 stage 颜色（淡）
        return STAGE_COLOR[node.stage] || "#6c757d";
      },
      /* SVG 路径：从父节点底部到子节点顶部（直角折线） */
      edgePath: function (fromPos, toPos) {
        var x1 = fromPos.x + fromPos.w / 2;
        var y1 = fromPos.y + fromPos.h;
        var x2 = toPos.x + toPos.w / 2;
        var y2 = toPos.y;
        var midY = (y1 + y2) / 2;
        return "M " + x1 + " " + y1 + " V " + midY + " H " + x2 + " V " + y2;
      },
      /* 计算 SVG 视图区域 */
      svgViewBox: function (layout) {
        if (!layout || !layout.positions) return "0 0 0 0";
        var minX = 0, maxX = 0, maxY = 0;
        for (var id in layout.positions) {
          var p = layout.positions[id];
          if (p.x < minX) minX = p.x;
          if (p.x + p.w > maxX) maxX = p.x + p.w;
          if (p.y + p.h > maxY) maxY = p.y + p.h;
        }
        var pad = 20;
        return (minX - pad) + " " + (-pad) + " " + (maxX - minX + pad * 2) + " " + (maxY + pad * 2);
      }
    },
    template: `
      <div class="debug-view">
        <!-- 顶部工具栏 -->
        <div class="dbg-toolbar">
          <div class="dbg-stats">
            <span class="dbg-stat" :class="{on: connected}">{{ connected ? '● 已连接' : '○ 未连接' }}</span>
            <span class="dbg-stat">追踪 {{ stats.traces }}</span>
            <span class="dbg-stat" style="color:#6ea8fe">运行中 {{ stats.running }}</span>
            <span class="dbg-stat" style="color:#4caf7d">成功 {{ stats.success }}</span>
            <span class="dbg-stat" style="color:#e05555">失败 {{ stats.failed }}</span>
          </div>
          <div class="dbg-spacer"></div>
          <el-input v-model="filterText" size="small" style="width:200px"
                    placeholder="按 stage / traceId 过滤" clearable></el-input>
          <el-button size="small" @click="sendTestEvent">诊断</el-button>
          <el-button size="small" :type="paused ? 'warning' : 'default'" @click="paused = !paused">
            {{ paused ? '恢复' : '暂停' }}
          </el-button>
          <el-button size="small" @click="resetZoom">重置视图</el-button>
          <el-button size="small" @click="clearEvents">清空</el-button>
          <el-button size="small" @click="connectStream" :disabled="!paused && connected">重连</el-button>
        </div>

        <!-- 错误提示条 -->
        <div v-if="sseError" class="dbg-error-bar">
          <span class="dbg-error-icon">⚠</span>
          <span>{{ sseError }}</span>
        </div>

        <div class="dbg-body">
          <!-- 左侧：DAG 列表 -->
          <div class="dbg-traces">
            <div v-if="filteredTraces.length === 0" class="dbg-empty">
              暂无调试事件<br>
              <span class="text-2 small">触发调度器（scheduler_dispatch / scheduler_commit）后可见</span>
              <div class="dbg-empty-tip">
                <el-button size="small" type="primary" plain @click="sendTestEvent">点击诊断连接</el-button>
              </div>
            </div>
            <div v-for="tr in filteredTraces" :key="tr.traceId" class="dbg-trace">
              <div class="dbg-trace-head">
                <span class="dbg-trace-id" :title="tr.traceId">{{ tr.traceId }}</span>
                <span class="dbg-trace-time">{{ fmtTs(tr.startTs) }}</span>
                <span class="dbg-trace-count">{{ tr.events.length }} 事件</span>
              </div>
              <div class="dbg-dag">
                <svg :viewBox="svgViewBox(tr.layout)" preserveAspectRatio="xMidYMid meet" class="dbg-svg"
                     @wheel.prevent="onSvgWheel" @mousedown="onSvgMouseDown" @dblclick="resetZoom">
                  <g :transform="svgTransform">
                  <!-- 边 -->
                  <path v-for="(edge, idx) in tr.dag.edges" :key="'e'+idx"
                        :d="edgePath(tr.layout.positions[edge.from], tr.layout.positions[edge.to])"
                        class="dbg-edge"></path>
                  <!-- 节点 -->
                  <g v-for="node in tr.dag.nodes" :key="node.id"
                     :transform="'translate(' + tr.layout.positions[node.id].x + ',' + tr.layout.positions[node.id].y + ')'">
                    <title>{{ node.stage }} · {{ statusLabel(node.status) }}</title>
                    <rect :width="tr.layout.nodeW" :height="tr.layout.nodeH" rx="6"
                          :fill="nodeFill(node)" :class="['dbg-node', node.status, {sel: selectedNodeId === node.id}]"
                          @click="selectNode(node.id)"></rect>
                    <text :x="tr.layout.nodeW / 2" :y="23" text-anchor="middle" class="dbg-node-stage">{{ shortStage(node.stage) }}</text>
                    <text :x="tr.layout.nodeW / 2" :y="41" text-anchor="middle" class="dbg-node-status">
                      {{ statusLabel(node.status) }}<template v-if="node.durationMs"> · {{ fmtDuration(node.durationMs) }}</template>
                    </text>
                    <text :x="tr.layout.nodeW / 2" :y="56" text-anchor="middle" class="dbg-node-ts">{{ fmtTs(node.startTs) }}</text>
                  </g>
                  </g>
                </svg>
              </div>
            </div>
          </div>

          <!-- 右侧：节点详情抽屉 -->
          <div class="dbg-drawer" v-if="selectedNode">
            <div class="dbg-drawer-head">
              <span class="dbg-drawer-title">{{ selectedNode.stage }}</span>
              <span :class="['dbg-status-tag', selectedNode.status]">{{ statusLabel(selectedNode.status) }}</span>
              <span class="dbg-spacer"></span>
              <el-button size="small" text @click="selectedNodeId = ''">关闭</el-button>
            </div>
            <div class="dbg-drawer-body">
              <div class="dbg-kv">
                <div class="k">节点 ID</div><div class="v mono">{{ selectedNode.id }}</div>
              </div>
              <div class="dbg-kv">
                <div class="k">追踪 ID</div><div class="v mono">{{ selectedNode.traceId }}</div>
              </div>
              <div class="dbg-kv">
                <div class="k">父节点</div><div class="v mono">{{ selectedNode.parentId || '（根）' }}</div>
              </div>
              <div class="dbg-kv">
                <div class="k">开始</div><div class="v">{{ fmtTs(selectedNode.startTs) }}</div>
              </div>
              <div class="dbg-kv" v-if="selectedNode.endTs">
                <div class="k">结束</div><div class="v">{{ fmtTs(selectedNode.endTs) }}</div>
              </div>
              <div class="dbg-kv" v-if="selectedNode.durationMs !== undefined">
                <div class="k">耗时</div><div class="v">{{ fmtDuration(selectedNode.durationMs) }}</div>
              </div>

              <div class="dbg-section" v-if="selectedNode.input !== undefined">
                <div class="dbg-section-head">输入</div>
                <pre class="dbg-json">{{ fmtJson(selectedNode.input) }}</pre>
              </div>
              <div class="dbg-section" v-if="selectedNode.output !== undefined">
                <div class="dbg-section-head">输出</div>
                <pre class="dbg-json">{{ fmtJson(selectedNode.output) }}</pre>
              </div>
              <div class="dbg-section dbg-error" v-if="selectedNode.error">
                <div class="dbg-section-head">错误</div>
                <pre class="dbg-json">{{ selectedNode.error }}</pre>
              </div>
            </div>
          </div>
          <div class="dbg-drawer dbg-empty-drawer" v-else>
            <div class="dbg-empty">
              点击左侧节点<br>
              <span class="text-2 small">查看输入/输出详情</span>
            </div>
          </div>
        </div>
      </div>
    `
  };
})();
