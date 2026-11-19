// ============================================================
// RASTREAMENTO NO NAVEGADOR (catálogo e rastreamento de pedido)
// Script comum (sem módulos): expõe window.FlowTracking.
// Agrupa eventos (2 s ou 20 eventos) e envia a /api/flow/events. Na saída da
// página usa navigator.sendBeacon (que não envia headers: o token vai no
// corpo). O token vem de ?t= e fica só em memória. Sem token (link antigo),
// nada é enviado. Nunca enviar dados pessoais no meta.
// ============================================================
(function (global) {
  "use strict";

  var EVENTS_ENDPOINT = "/api/flow/events";
  var CONFIG_ENDPOINT = "/api/flow/config";
  var FLUSH_DELAY_MS = 2000;
  var MAX_QUEUE = 20;

  var queue = [];
  var seq = 0;
  var flushTimer = null;
  var converted = false; // houve add_to_cart_clicked: não é abandono
  var abandonedSent = false;
  var searchTermsAllowed = false; // só vira true quando o servidor confirmar

  function readToken() {
    var params = new URLSearchParams(global.location.search);
    var token = params.get("t") || null;
    if (token) {
      // Tira o token da barra de endereço (conversationId e store ficam)
      params.delete("t");
      var query = params.toString();
      global.history.replaceState(null, "", global.location.pathname + (query ? "?" + query : ""));
    }
    return token;
  }

  function newSessionId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    var bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map
      .call(bytes, function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  var token = readToken();
  var sessionId = newSessionId();

  function headers() {
    return { "Content-Type": "application/json", "X-Flow-Token": token || "", "X-Flow-Session": sessionId };
  }

  function post(body) {
    return fetch(EVENTS_ENDPOINT, { method: "POST", headers: headers(), body: body, keepalive: true }).catch(function () {
      // Falha de rastreamento não interfere na página
    });
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (queue.length === 0) return;
    post(JSON.stringify({ events: queue.splice(0, queue.length) }));
  }

  function track(event, data) {
    if (!token) return;
    data = data || {};
    if (event === "add_to_cart_clicked") converted = true;

    queue.push({ event: event, seq: (seq += 1), step: data.step, duration_ms: data.duration_ms, error_code: data.error_code, meta: data.meta });

    if (queue.length >= MAX_QUEUE) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  // Saída da página: "abandoned" (uma vez) se não houve add_to_cart_clicked
  function flushOnExit() {
    if (!token) return;
    if (!converted && !abandonedSent) {
      abandonedSent = true;
      queue.push({ event: "abandoned", seq: (seq += 1) });
    }
    if (queue.length === 0) return;

    var body = JSON.stringify({ events: queue.splice(0, queue.length), _token: token, _session: sessionId });
    var sent = global.navigator.sendBeacon && global.navigator.sendBeacon(EVENTS_ENDPOINT, new Blob([body], { type: "application/json" }));
    if (!sent) post(body);
  }

  // O termo da busca só é enviado se o servidor disser que o registro está ligado
  function loadConfig() {
    if (!token) return;
    fetch(CONFIG_ENDPOINT)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (config) {
        searchTermsAllowed = Boolean(config && config.trackSearchTerms === true);
      })
      .catch(function () {});
  }

  // Meta da busca: termo em minúsculas (até 60 caracteres) só se permitido; sempre a contagem
  function searchMeta(term, resultsCount) {
    var meta = { results_count: resultsCount };
    if (searchTermsAllowed && typeof term === "string" && term.trim()) meta.query = term.trim().toLowerCase().slice(0, 60);
    return meta;
  }

  // pagehide cobre o fechamento da webview; visibilitychange cobre o app em segundo plano
  global.addEventListener("pagehide", flushOnExit);
  global.document.addEventListener("visibilitychange", function () {
    if (global.document.visibilityState === "hidden") flush();
  });
  loadConfig();

  global.FlowTracking = { track: track, flush: flush, searchMeta: searchMeta, sessionId: sessionId };
})(window);
