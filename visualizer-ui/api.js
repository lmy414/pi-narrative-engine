/* api.js — Viz.api：fetch 封装，统一 envelope 解包 */
(function () {
  "use strict";
  window.Viz = window.Viz || {};

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

  function request(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts).then(function (resp) {
      // 检索不可用等 HTTP 层错误：尝试读 envelope，否则按状态码报错
      if (resp.status === 501) {
        return resp.json().catch(function () { return null; }).then(function (json) {
          var code = (json && json.error && json.error.code) || "SEARCH_UNAVAILABLE";
          var msg = (json && json.error && json.error.message) || "检索不可用";
          throw ApiError(code, msg, 501);
        });
      }
      return resp.json().catch(function () {
        throw ApiError("BAD_RESPONSE", "服务返回了非 JSON 响应（HTTP " + resp.status + "）", resp.status);
      }).then(function (json) {
        if (!resp.ok) {
          var c = (json && json.error && json.error.code) || "HTTP_" + resp.status;
          var m = (json && json.error && json.error.message) || ("请求失败（HTTP " + resp.status + "）");
          throw ApiError(c, m, resp.status);
        }
        if (!json || json.ok !== true) {
          var ec = (json && json.error && json.error.code) || "UNKNOWN";
          var em = (json && json.error && json.error.message) || "未知错误";
          throw ApiError(ec, em, resp.status);
        }
        return json.data;
      });
    }).catch(function (err) {
      if (err && err.code) throw err;
      throw ApiError("NETWORK", "网络错误：" + (err && err.message ? err.message : "无法连接服务"), 0);
    });
  }

  Viz.api = {
    status: function () {
      return request("GET", "/status");
    },
    graph: function (storyTime, includeClosed) {
      return request("GET", "/graph" + buildQuery({ storyTime: storyTime, includeClosed: includeClosed ? "true" : "" }));
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
})();
