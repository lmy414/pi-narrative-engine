/* api.js — fetch 封装（统一 envelope 解包）+ V3 共享工具
 *
 * 同时暴露两套入口：
 *   window.Viz.api —— 与 V2 旧前端（v2-legacy.html）共用的接口，方法名/语义保持不变
 *   window.V3      —— V3 前端命名空间：api（同一对象）、util（纯函数工具）、components（组件注册表）
 */
(function () {
  "use strict";

  var BASE = "/api";

  function ApiError(code, message, status) {
    var err = new Error(message || "请求失败");
    err.code = code || "UNKNOWN";
    err.status = status || 0;
    return err;
  }

  function buildQuery(params) {
    var parts = [];
    for (var k in params) {
      if (params[k] === undefined || params[k] === null || params[k] === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  async function request(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var resp;
    try {
      resp = await fetch(BASE + path, opts);
    } catch (err) {
      throw ApiError("NETWORK", "网络错误：" + (err && err.message ? err.message : "无法连接服务"), 0);
    }
    var json = null;
    try { json = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!resp.ok) {
      var c = (json && json.error && json.error.code) || (resp.status === 501 ? "SEARCH_UNAVAILABLE" : "HTTP_" + resp.status);
      var m = (json && json.error && json.error.message) || ("请求失败（HTTP " + resp.status + "）");
      throw ApiError(c, m, resp.status);
    }
    if (!json || json.ok !== true) {
      throw ApiError((json && json.error && json.error.code) || "UNKNOWN",
        (json && json.error && json.error.message) || "未知错误", resp.status);
    }
    return json.data;
  }

  var api = {
    status: function () {
      return request("GET", "/status");
    },
    graph: function (storyTime, includeClosed) {
      return request("GET", "/graph" + buildQuery({ storyTime: storyTime, includeClosed: includeClosed ? "1" : "" }));
    },
    entity: function (id, storyTime) {
      return request("GET", "/entities/" + encodeURIComponent(id) + buildQuery({ storyTime: storyTime }));
    },
    entityHistory: function (id) {
      return request("GET", "/entities/" + encodeURIComponent(id) + "/history");
    },
    declarationVisibility: function (declId, storyTime) {
      return request("GET", "/declarations/" + encodeURIComponent(declId) + "/visibility" + buildQuery({ storyTime: storyTime }));
    },
    search: function (q, storyTime, type, mode) {
      return request("GET", "/search" + buildQuery({ q: q, storyTime: storyTime, type: type, mode: mode }));
    },
    events: function () {
      return request("GET", "/events");
    },
    eventChain: function (id) {
      return request("GET", "/events/" + encodeURIComponent(id) + "/chain");
    },
    characterView: function (characterId, storyTime) {
      return request("GET", "/character-view" + buildQuery({ characterId: characterId, storyTime: storyTime }));
    },
    postEvent: function (event) {
      return request("POST", "/events", event);
    },
    updateSummary: function (id, summary) {
      return request("POST", "/entities/" + encodeURIComponent(id) + "/summary", { summary: summary });
    },
    createRelation: function (sourceId, targetId, label, storyTime) {
      return request("POST", "/relations", { sourceId: sourceId, targetId: targetId, label: label, storyTime: storyTime });
    },
    closeRelation: function (sourceId, targetId, label, storyTime) {
      return request("POST", "/relations/close", { sourceId: sourceId, targetId: targetId, label: label, storyTime: storyTime });
    },
    createVisibility: function (characterId, declarationId, confidence, source, storyTime) {
      return request("POST", "/visibility", {
        characterId: characterId,
        declarationId: declarationId,
        confidence: confidence,
        source: source,
        storyTime: storyTime
      });
    },
    closeVisibility: function (characterId, declarationId, storyTime) {
      return request("POST", "/visibility/close", {
        characterId: characterId,
        declarationId: declarationId,
        storyTime: storyTime
      });
    }
  };

  /* ---------- V3 共享工具（纯函数，无依赖） ---------- */
  var TYPE_COLOR = { character: "#4A90E2", location: "#7ED321", item: "#F5A623", concept: "#9013FE" };
  var TYPE_NAME = { character: "角色", location: "地点", item: "物品", concept: "概念" };
  var TYPE_DESC = {
    character: "角色 character（有意志的人物）",
    location: "地点 location（场景/空间）",
    item: "物品 item（道具/物件）",
    concept: "概念 concept（世界观/组织/规则）"
  };
  var MOD_NAME = { fact: "事实", belief: "信念", hypothesis: "推测" };

  var util = {
    TYPE_COLOR: TYPE_COLOR,
    TYPE_NAME: TYPE_NAME,
    TYPE_DESC: TYPE_DESC,
    MOD_NAME: MOD_NAME,
    /* 显示名：取属性「姓名/名称/name」的值，缺省 entityId */
    displayName: function (ent) {
      if (!ent) return "";
      var props = ent.properties || [];
      for (var i = 0; i < props.length; i++) {
        var p = props[i].property;
        if (p === "姓名" || p === "名称" || p === "name") return String(props[i].value);
      }
      return ent.entityId;
    },
    isDead: function (ent) {
      return !!ent && ent.validTo !== "Infinity";
    },
    isClosed: function (rel) {
      return !!rel && rel.validTo !== "Infinity";
    },
    /* 值展示：对象 JSON 化，其余直接转字符串 */
    fmtValue: function (v) {
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    },
    /* 输入值自动解析：数字/布尔/JSON，否则原样字符串 */
    parseValue: function (s) {
      if (typeof s !== "string") return s;
      var t = s.trim();
      if (t === "") return s;
      if (t === "true") return true;
      if (t === "false") return false;
      if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
      if ((t[0] === "{" && t[t.length - 1] === "}") || (t[0] === "[" && t[t.length - 1] === "]")) {
        try { return JSON.parse(t); } catch (e) { /* 按字符串处理 */ }
      }
      return s;
    },
    newEventId: function () {
      return "evt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    },
    debounce: function (fn, ms) {
      var timer = null;
      return function () {
        var self = this, args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    }
  };

  window.Viz = window.Viz || {};
  window.Viz.api = api;
  window.V3 = { api: api, util: util, components: {} };
})();
