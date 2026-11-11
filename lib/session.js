// ======================================================
// SESSÃO ASSINADA DO FLUXO DE TROCA/DEVOLUÇÃO
// ======================================================
// O POST /api/send-webview gera um token assinado (HMAC-SHA256) com o
// conversationId, a marca e a expiração. A webview recebe o token na URL e o
// envia em todas as chamadas. Sem token válido, nenhum endpoint do fluxo
// responde: isso impede criar tickets ou reversas fora de uma conversa real.
//
// Formato: base64url(JSON do payload) + "." + base64url(HMAC)

const crypto = require("crypto");
const { normalizeBrandKey, getBrand } = require("./brands");

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 1024;
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TTL_MINUTES = 60;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SessionConfigError extends Error {}

function getSecret() {
  const secret = process.env.FLOW_SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new SessionConfigError(`FLOW_SESSION_SECRET ausente ou com menos de ${MIN_SECRET_LENGTH} caracteres`);
  }
  return secret;
}

function isSessionConfigured() {
  try {
    getSecret();
    return true;
  } catch {
    return false;
  }
}

function getTtlSeconds() {
  const minutes = Number(process.env.FLOW_SESSION_TTL_MINUTES);
  const valid = Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60;
  return Math.round((valid ? minutes : DEFAULT_TTL_MINUTES) * 60);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmac(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

function isValidConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

// Gera o token da sessão; lança erro se os dados forem inválidos
function createSessionToken({ conversationId, store }, nowMs = Date.now()) {
  if (!isValidConversationId(conversationId)) throw new Error("conversationId inválido");
  const brandKey = normalizeBrandKey(store);
  if (!brandKey) throw new Error("store inválido");

  const iat = Math.floor(nowMs / 1000);
  const payload = {
    v: TOKEN_VERSION,
    c: conversationId,
    s: brandKey,
    iat,
    exp: iat + getTtlSeconds(),
    n: crypto.randomBytes(6).toString("hex"),
  };

  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(body, getSecret())}`;
}

// Valida o token; devolve { ok: true, session } ou { ok: false, reason }
function verifySessionToken(token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "missing" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  const [body, signature] = parts;
  const expected = Buffer.from(hmac(body, getSecret()));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!payload || payload.v !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  if (!isValidConversationId(payload.c) || !normalizeBrandKey(payload.s)) return { ok: false, reason: "malformed" };
  if (!Number.isInteger(payload.exp) || payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };

  return {
    ok: true,
    session: {
      conversationId: payload.c,
      store: payload.s,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    },
  };
}

// Dado assinado de uso interno (ex.: a opção de envio escolhida na cotação).
// A assinatura usa o prefixo "kind:" para nunca ser aceita como token de sessão.
function signData(kind, data, ttlSeconds, nowMs = Date.now()) {
  const payload = { k: kind, d: data, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(`${kind}:${body}`, getSecret())}`;
}

// Devolve o dado ou null (assinatura inválida, tipo errado ou expirado)
function verifyData(kind, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expected = Buffer.from(hmac(`${kind}:${parts[0]}`, getSecret()));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload || payload.k !== kind || !Number.isInteger(payload.exp) || payload.exp * 1000 <= nowMs) return null;
    return payload.d;
  } catch {
    return null;
  }
}

// session_id gerado pelo navegador (UUID por abertura da webview); inválido vira null
function parseFlowSessionId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

// Middleware: exige sessão válida. O token vem no header X-Flow-Token ou, para
// navigator.sendBeacon (que não envia headers), no campo "_token" do corpo.
function requireSession(req, res, next) {
  let result;
  try {
    const token = req.get("X-Flow-Token") || (req.body && typeof req.body._token === "string" ? req.body._token : null);
    result = verifySessionToken(token);
  } catch (error) {
    console.error("Sessão do fluxo: configuração inválida -", error.message);
    return res.status(503).json({
      success: false,
      code: "SERVICE_UNAVAILABLE",
      error: "O serviço está indisponível no momento. Tente novamente mais tarde.",
    });
  }

  if (!result.ok) {
    return res.status(401).json({
      success: false,
      code: result.reason === "expired" ? "SESSION_EXPIRED" : "SESSION_INVALID",
      error: "Sua sessão expirou. Volte ao chat e abra a opção de troca e devolução novamente.",
    });
  }

  const brand = getBrand(result.session.store);
  const flowSessionId = req.get("X-Flow-Session") || (req.body && req.body._session);

  req.flow = {
    ...result.session,
    brand,
    sessionId: parseFlowSessionId(flowSessionId),
  };

  next();
}

module.exports = {
  SessionConfigError,
  isSessionConfigured,
  isValidConversationId,
  createSessionToken,
  verifySessionToken,
  signData,
  verifyData,
  parseFlowSessionId,
  requireSession,
};
