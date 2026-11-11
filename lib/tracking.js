// ======================================================
// RASTREAMENTO DA JORNADA (eventos do fluxo de troca/devolução)
// ======================================================
// Um evento por linha, em JSON. O sink inicial grava no stdout (os logs do
// Render guardam) e pode ser trocado por outro (Postgres, dreno de logs) com
// setSink(), sem mudar quem chama track().
//
// Privacidade: nunca gravar CPF, e-mail, telefone, endereço, chave PIX, dados
// bancários, nome ou comentário. O meta passa por uma lista de bloqueio e só
// aceita valores simples e curtos. O número do pedido entra apenas como hash.

const crypto = require("crypto");
const { normalizeBrandKey } = require("./brands");
const { parseFlowSessionId } = require("./session");

const EVENTS = new Set([
  "webview_opened",
  "step_viewed",
  "step_completed",
  "step_back",
  "validation_error",
  "api_call",
  "photo_added",
  "photo_removed",
  "ticket_created",
  "reverse_created",
  "completed",
  "handoff_requested",
  "abandoned",
  "error_shown",
]);

// Chaves de meta recusadas por poderem carregar dado pessoal
const FORBIDDEN_META_KEY = /cpf|cnpj|document|email|mail|phone|telefone|celular|name|nome|address|endereco|street|rua|zip|cep|pix|bank|banco|agency|agencia|account|conta|identifier|comment|comentario|token|secret|password|senha/i;

const MAX_META_KEYS = 20;
const MAX_STRING = 120;
const MAX_CLIENT_EVENTS = 50;
const TOKEN_LIKE = /^[A-Za-z0-9_-]{2,40}$/;

function defaultSink(record) {
  console.log(JSON.stringify(record));
}

let sink = defaultSink;

function setSink(fn) {
  sink = typeof fn === "function" ? fn : defaultSink;
}

function cleanToken(value) {
  return typeof value === "string" && TOKEN_LIKE.test(value) ? value : null;
}

function cleanNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

// Mantém só chaves permitidas e valores primitivos curtos
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;

  const result = {};
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (count >= MAX_META_KEYS) break;
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key) || FORBIDDEN_META_KEY.test(key)) continue;

    if (typeof value === "string") {
      result[key] = value.slice(0, MAX_STRING);
    } else if (typeof value === "boolean" || value === null || (typeof value === "number" && Number.isFinite(value))) {
      result[key] = value;
    } else {
      continue;
    }
    count += 1;
  }

  return count > 0 ? result : undefined;
}

// Monta o registro padronizado; devolve null se o evento não for reconhecido
function buildRecord(event, { now = new Date() } = {}) {
  if (!event || !EVENTS.has(event.event)) return null;

  const record = {
    kind: "flow_event",
    ts: now.toISOString(),
    source: event.source === "client" ? "client" : "server",
    session_id: parseFlowSessionId(event.session_id),
    conversation_id: cleanToken(event.conversation_id),
    brand: normalizeBrandKey(event.brand),
    seq: cleanNumber(event.seq),
    step: cleanToken(event.step),
    event: event.event,
    duration_ms: cleanNumber(event.duration_ms),
    error_code: cleanToken(event.error_code),
  };

  const meta = sanitizeMeta(event.meta);
  if (meta) record.meta = meta;

  return record;
}

// Registra um evento. Nunca lança: falha de rastreamento não pode quebrar o fluxo.
function track(event) {
  try {
    const record = buildRecord(event);
    if (!record) return false;
    sink(record);
    return true;
  } catch (error) {
    console.error("Rastreamento: falha ao registrar evento -", error.message);
    return false;
  }
}

// Recebe o lote enviado pelo navegador. A conversa e a marca vêm sempre da
// sessão assinada, nunca do corpo da requisição.
function ingestClientEvents(events, flow) {
  if (!Array.isArray(events)) return { accepted: 0, rejected: 0 };

  let accepted = 0;
  let rejected = 0;
  for (const event of events.slice(0, MAX_CLIENT_EVENTS)) {
    const ok =
      event &&
      typeof event === "object" &&
      track({
        event: event.event,
        step: event.step,
        seq: event.seq,
        duration_ms: event.duration_ms,
        error_code: event.error_code,
        meta: event.meta,
        source: "client",
        session_id: flow.sessionId,
        conversation_id: flow.conversationId,
        brand: flow.store,
      });
    if (ok) accepted += 1;
    else rejected += 1;
  }
  rejected += Math.max(0, events.length - MAX_CLIENT_EVENTS);

  return { accepted, rejected };
}

// Hash do número do pedido (HMAC-SHA256 com sal do servidor). Sem sal, não grava nada.
function hashOrderNumber(orderNumber) {
  const salt = process.env.FLOW_HASH_SALT;
  if (!salt || typeof orderNumber !== "string" || !orderNumber) return null;
  return crypto.createHmac("sha256", salt).update(orderNumber).digest("hex").slice(0, 32);
}

module.exports = {
  EVENTS,
  setSink,
  sanitizeMeta,
  buildRecord,
  track,
  ingestClientEvents,
  hashOrderNumber,
};
