// ======================================================
// API DE ACOMPANHAMENTO (GET /api/analytics/*)
// ======================================================
// Consumida pelo app da Zendesk. Contrato em docs/api-contract.md.
// - Bearer ANALYTICS_API_SECRET (tempo constante). Segredo ausente: 503; errado: 401.
// - Sem CORS: o app chama pelo backend da Zendesk, nunca direto do navegador.
// - 60 requisições por minuto (429 RATE_LIMITED); freio extra por IP contra tentativa de segredo.
// - Erros nunca expõem SQL, stack, segredo nem dado pessoal: só código e texto curto.

const crypto = require("crypto");
const express = require("express");
const { createAnalytics, ApiError, toCsv } = require("../lib/analytics");
const { createRateLimiter } = require("../lib/rateLimit");
const { createVtexOrders } = require("../lib/vtex-orders");

const MINUTE = 60 * 1000;
const RATE_LIMIT_PER_MINUTE = 60;
const IP_LIMIT_PER_MINUTE = 120;

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function sendError(res, status, code, error) {
  return res.status(status).json({ success: false, code, error });
}

function createAnalyticsRouter({ db = require("../lib/db"), now = () => Date.now(), env = process.env, getVtexStores = () => ({}), vtex } = {}) {
  const router = express.Router();
  const analytics = createAnalytics({ db, now, vtex: vtex || createVtexOrders({ getStores: getVtexStores, env, now }) });
  const secretLimiter = createRateLimiter({ windowMs: MINUTE, max: RATE_LIMIT_PER_MINUTE, now });
  const ipLimiter = createRateLimiter({ windowMs: MINUTE, max: IP_LIMIT_PER_MINUTE, now });

  function limited(res, retryAfterS) {
    res.set("Retry-After", String(retryAfterS));
    return sendError(res, 429, "RATE_LIMITED", "Muitas consultas em pouco tempo. Aguarde um instante.");
  }

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");

    const expected = env.ANALYTICS_API_SECRET;
    if (!expected) return sendError(res, 503, "SERVICE_UNAVAILABLE", "API de acompanhamento desativada.");

    // Freio por IP antes de comparar o segredo (tentativas erradas também contam)
    const byIp = ipLimiter.hit(req.ip || "ip");
    if (!byIp.allowed) return limited(res, byIp.retryAfterS);

    const match = (req.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
    const provided = match ? match[1].trim() : "";
    if (!provided || !crypto.timingSafeEqual(digest(provided), digest(expected))) {
      return sendError(res, 401, "UNAUTHORIZED", "Não autorizado.");
    }

    const bySecret = secretLimiter.hit("secret");
    if (!bySecret.allowed) return limited(res, bySecret.retryAfterS);
    return next();
  });

  function meta(period) {
    return {
      generated_at: new Date(now()).toISOString(),
      from: period?.from ?? null,
      to: period?.to ?? null,
      timezone: "America/Sao_Paulo",
    };
  }

  // Envolve o handler: erro conhecido vira JSON do contrato; qualquer outro vira 503 genérico
  function handle(fn) {
    return async (req, res) => {
      try {
        if (!db.getPool()) return sendError(res, 503, "SERVICE_UNAVAILABLE", "Banco de acompanhamento indisponível.");
        const result = await fn(req, res);
        if (result === undefined) return undefined; // o handler já respondeu (CSV)
        return res.json({ success: true, data: result.data, meta: meta(result.period) });
      } catch (error) {
        if (error instanceof ApiError) return sendError(res, error.status, error.code, error.message);
        // Só o código do erro no log: a mensagem do pg pode repetir valores da consulta
        console.error(`Analytics: falha na consulta (${error?.code || error?.name || "erro"})`);
        return sendError(res, 503, "SERVICE_UNAVAILABLE", "Não foi possível consultar os dados agora. Tente novamente.");
      }
    };
  }

  router.get("/health", handle(async () => ({ period: null, data: await analytics.health() })));
  router.get("/summary", handle((req) => analytics.summary(req.query)));
  router.get("/funnel", handle((req) => analytics.funnel(req.query)));
  router.get("/sends", handle((req) => analytics.sends(req.query)));
  router.get("/sends/:sendId", handle((req) => analytics.sendDetail(req.params.sendId)));
  router.get("/sends/:sendId/order", handle((req) => analytics.sendOrder(req.params.sendId)));
  router.get("/sessions/:sessionId", handle((req) => analytics.sessionDetail(req.params.sessionId)));
  router.get("/reports/reverse", handle((req) => analytics.reverseReport(req.query)));
  router.get("/reports/catalog", handle((req) => analytics.catalogReport(req.query)));

  router.get(
    "/export.csv",
    handle(async (req, res) => {
      const report = await analytics.exportRows(req.query);
      const day = new Date(now()).toISOString().slice(0, 10);
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${report.name}-${day}.csv"`);
      res.send(toCsv(report));
      return undefined;
    }),
  );

  router.use((req, res) => sendError(res, 404, "NOT_FOUND", "Rota não encontrada."));

  return router;
}

module.exports = { createAnalyticsRouter, RATE_LIMIT_PER_MINUTE };
