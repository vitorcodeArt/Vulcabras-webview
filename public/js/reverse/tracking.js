// ============================================================
// RASTREAMENTO NO NAVEGADOR
// Agrupa eventos e envia a /api/flow/events. Na saída da página usa
// navigator.sendBeacon (que não envia headers: o token vai no corpo).
// Nunca enviar dados pessoais no meta.
// ============================================================

import { session, sessionHeaders } from "./session.js";

const ENDPOINT = "/api/flow/events";
const FLUSH_DELAY_MS = 2000;
const MAX_QUEUE = 20;

const queue = [];
let seq = 0;
let flushTimer = null;
let finished = false;

export function trackEvent(event, data = {}) {
  if (!session.token) return;

  queue.push({
    event,
    seq: (seq += 1),
    step: data.step,
    duration_ms: data.duration_ms,
    error_code: data.error_code,
    meta: data.meta,
  });

  if (queue.length >= MAX_QUEUE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
}

export function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (queue.length === 0) return;

  const events = queue.splice(0, queue.length);
  fetch(ENDPOINT, {
    method: "POST",
    headers: sessionHeaders(),
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {
    // Falha de rastreamento não interfere no fluxo
  });
}

// Marca o fluxo como encerrado (concluído ou transferido): sem evento "abandoned"
export function markFinished() {
  finished = true;
}

function flushWithBeacon() {
  if (!session.token) return;
  if (!finished) {
    queue.push({ event: "abandoned", seq: (seq += 1) });
  }
  if (queue.length === 0) return;

  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({ events, _token: session.token, _session: session.sessionId });

  const sent = navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
  if (!sent) {
    fetch(ENDPOINT, { method: "POST", headers: sessionHeaders(), body, keepalive: true }).catch(() => {});
  }
}

// pagehide cobre o fechamento da webview; visibilitychange cobre o app em segundo plano
window.addEventListener("pagehide", flushWithBeacon);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});
