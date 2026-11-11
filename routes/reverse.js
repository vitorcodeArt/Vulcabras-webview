// ======================================================
// ROTAS DO FLUXO DE TROCA E DEVOLUÇÃO (TroqueCommerce)
// ======================================================
// Todos os endpoints são POST, JSON, e exigem sessão assinada válida.
// O upload de fotos (multipart) entra na Fase 3.

const express = require("express");
const { getBrand, toPublicBrand, BRAND_KEYS } = require("../lib/brands");
const { createSessionToken, isValidConversationId, requireSession } = require("../lib/session");
const { ingestClientEvents } = require("../lib/tracking");
const { createReverseService } = require("../lib/reverse/service");
const { describeError } = require("../lib/reverse/errors");

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

// Responde o erro com mensagem amigável; no log, só código e IDs técnicos
function sendError(res, error, flow, endpoint) {
  const { status, body, internalCode } = describeError(error);
  if (status >= 500 || body.code === "SERVICE_ERROR") {
    console.error(`Troca/Devolução: ${endpoint} falhou com ${internalCode} (conversa ${flow?.conversationId || "?"}, marca ${flow?.store || "?"})`);
    if (!error || !error.code) console.error(error);
  }
  res.status(status).json(body);
}

function createReverseRouter({ service = createReverseService() } = {}) {
  const router = express.Router();

  // Confirma a sessão e devolve os dados mínimos para a webview montar a tela
  router.post("/api/reverse/session", requireSession, (req, res) => {
    res.json({
      success: true,
      brand: toPublicBrand(req.flow.brand),
      expiresAt: req.flow.expiresAt,
    });
  });

  // Lote de eventos de rastreamento vindos do navegador (fetch ou sendBeacon)
  router.post("/api/flow/events", requireSession, (req, res) => {
    const result = ingestClientEvents(req.body?.events, req.flow);
    res.status(202).json({ success: true, ...result });
  });

  const endpoints = {
    "/api/reverse/prepare": service.prepare,
    "/api/reverse/retention": service.retention,
    "/api/reverse/quote": service.quote,
    "/api/reverse/track": service.track,
    "/api/reverse/submit": service.submit,
    "/api/reverse/finish": service.finish,
    "/api/reverse/handoff": service.handoff,
  };

  for (const [path, handler] of Object.entries(endpoints)) {
    router.post(path, requireSession, async (req, res) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const data = await handler(req.flow, body);
        res.json({ success: true, ...data });
      } catch (error) {
        sendError(res, error, req.flow, path);
      }
    });
  }

  return router;
}

module.exports = {
  createReverseRouter,
  buildReverseWebview,
  SESSION_QUERY_PARAM,
};
