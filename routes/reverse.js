// ======================================================
// ROTAS DO FLUXO DE TROCA E DEVOLUÇÃO (TroqueCommerce)
// ======================================================
// Todos os endpoints são POST, JSON, e exigem sessão assinada válida.
// O submit também aceita multipart, quando há fotos (lib/reverse/photos.js).

const express = require("express");
const { getBrand, toPublicBrand, BRAND_KEYS } = require("../lib/brands");
const { createSessionToken, isValidConversationId, requireSession } = require("../lib/session");
const { ingestClientEvents } = require("../lib/tracking");
const { createReverseService } = require("../lib/reverse/service");
const { describeError } = require("../lib/reverse/errors");
const { parseSubmitPayload } = require("../lib/reverse/photos");
const { rateLimit } = require("../lib/rateLimit");

const MINUTE = 60 * 1000;

// Limites por conversa (depois da sessão validada) e por IP
const byConversation = (req) => req.flow?.conversationId || null;
const byIp = (req) => req.ip || null;

function conversationLimits() {
  return {
    session: rateLimit({ name: "sessao", windowMs: 10 * MINUTE, max: 30, key: byConversation }),
    events: rateLimit({ name: "eventos", windowMs: 10 * MINUTE, max: 200, key: byConversation }),
    lookup: rateLimit({ name: "consulta", windowMs: 10 * MINUTE, max: 30, key: byConversation }),
    quote: rateLimit({ name: "cotacao", windowMs: 10 * MINUTE, max: 30, key: byConversation }),
    submit: rateLimit({ name: "envio", windowMs: 10 * MINUTE, max: 10, key: byConversation }),
    message: rateLimit({ name: "mensagem", windowMs: 10 * MINUTE, max: 10, key: byConversation }),
  };
}

// Parâmetro da URL que carrega o token assinado
const SESSION_QUERY_PARAM = "t";

// Monta a URI da webview e os textos da mensagem para type: "reverse".
// Devolve { ok: true, uri, label, text, buttonText } ou { ok: false, status, error }.
function buildReverseWebview({ baseUrl, conversationId, store, customText, buttonText }) {
  if (!isValidConversationId(conversationId)) {
    return { ok: false, status: 400, error: "conversationId inválido" };
  }

  const brand = getBrand(store);
  if (!brand) {
    return { ok: false, status: 400, error: `Loja "${store}" inválida. Opções: ${BRAND_KEYS.join(", ")}` };
  }

  if (!brand.troqueToken) {
    return { ok: false, status: 500, error: `Troca e devolução não configurada para a loja "${brand.key}"` };
  }

  let token;
  try {
    token = createSessionToken({ conversationId, store: brand.key });
  } catch (error) {
    console.error("Troca/Devolução: não foi possível gerar a sessão -", error.message);
    return { ok: false, status: 500, error: "Sessão do fluxo não configurada no servidor" };
  }

  const params = new URLSearchParams({ store: brand.key, [SESSION_QUERY_PARAM]: token });

  return {
    ok: true,
    uri: `${baseUrl}/reverse?${params.toString()}`,
    label: brand.label,
    text: customText || `Faça sua troca ou devolução ${brand.label} por aqui:`,
    buttonText: buttonText || "Trocar ou devolver",
  };
}

// Responde o erro com mensagem amigável; no log, só código e IDs técnicos.
// Nunca o objeto do erro: um erro do axios carrega headers (token) e corpo.
function sendError(res, error, flow, endpoint) {
  const { status, body, internalCode } = describeError(error);
  if (status >= 500 || body.code === "SERVICE_ERROR") {
    console.error(`Troca/Devolução: ${endpoint} falhou com ${internalCode} (conversa ${flow?.conversationId || "?"}, marca ${flow?.store || "?"})`);
    if (!error || !error.code) console.error(`Troca/Devolução: erro inesperado (${error?.name || "Error"}) em ${endpoint}`, error?.stack?.split("\n")[1]?.trim() || "");
  }
  res.status(status).json(body);
}

// Erros antes das rotas (ex.: JSON malformado no corpo) nos endpoints do fluxo:
// resposta curta, sem registrar o corpo, que pode ter dados do cliente
function reverseErrorHandler(error, req, res, next) {
  if (!/^\/api\/(reverse|flow)\//.test(req.path)) return next(error);
  if (res.headersSent) return next(error);
  const status = error.type === "entity.too.large" ? 413 : 400;
  return res.status(status).json({ success: false, code: "INVALID_INPUT", error: "Não foi possível ler os dados enviados. Tente novamente.", action: "retry" });
}

function createReverseRouter({ service = createReverseService() } = {}) {
  const router = express.Router();
  const limits = conversationLimits();

  // Teto por IP para todo o fluxo (protege também quem não tem sessão válida)
  router.use(["/api/reverse", "/api/flow"], rateLimit({ name: "ip", windowMs: 5 * MINUTE, max: 300, key: byIp }));

  // Confirma a sessão e devolve os dados mínimos para a webview montar a tela
  router.post("/api/reverse/session", requireSession, limits.session, (req, res) => {
    res.json({
      success: true,
      brand: toPublicBrand(req.flow.brand),
      expiresAt: req.flow.expiresAt,
      features: service.features(req.flow),
    });
  });

  // Lote de eventos de rastreamento vindos do navegador (fetch ou sendBeacon)
  router.post("/api/flow/events", requireSession, limits.events, (req, res) => {
    const result = ingestClientEvents(req.body?.events, req.flow);
    res.status(202).json({ success: true, ...result });
  });

  const endpoints = {
    "/api/reverse/prepare": [service.prepare, limits.lookup],
    "/api/reverse/retention": [service.retention, limits.quote],
    "/api/reverse/quote": [service.quote, limits.quote],
    "/api/reverse/track": [service.track, limits.lookup],
    "/api/reverse/finish": [service.finish, limits.message],
    "/api/reverse/handoff": [service.handoff, limits.message],
  };

  for (const [path, [handler, limit]] of Object.entries(endpoints)) {
    router.post(path, requireSession, limit, async (req, res) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const data = await handler(req.flow, body);
        res.json({ success: true, ...data });
      } catch (error) {
        sendError(res, error, req.flow, path);
      }
    });
  }

  // Submit: JSON ou multipart (payload + fotos)
  router.post("/api/reverse/submit", requireSession, limits.submit, parseSubmitPayload, async (req, res) => {
    try {
      if (req.uploadError) throw req.uploadError;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const data = await service.submit(req.flow, body, { photosByIndex: req.photosByIndex || {} });
      res.json({ success: true, ...data });
    } catch (error) {
      sendError(res, error, req.flow, "/api/reverse/submit");
    }
  });

  return router;
}

module.exports = {
  createReverseRouter,
  reverseErrorHandler,
  buildReverseWebview,
  SESSION_QUERY_PARAM,
};
