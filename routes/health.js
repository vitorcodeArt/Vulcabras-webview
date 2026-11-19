// ======================================================
// SAÚDE DO BANCO (GET /health/db)
// ======================================================
// Sem autenticação e sem detalhes do erro: serve para acordar o Render e
// manter o Supabase ativo (workflow keepalive). Como qualquer um pode chamar,
// o resultado é reaproveitado por alguns segundos para não martelar o banco.

const express = require("express");

const CACHE_MS = 5000;

function createHealthRouter({ db = require("../lib/db"), now = () => Date.now() } = {}) {
  const router = express.Router();
  let cached = null; // { at, result }
  let inflight = null;

  async function check() {
    try {
      return { ok: true, ms: await db.ping() };
    } catch {
      return { ok: false };
    }
  }

  router.get("/health/db", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!cached || now() - cached.at > CACHE_MS) {
      inflight = inflight || check().finally(() => (inflight = null));
      cached = { at: now(), result: await inflight };
    }
    const { result } = cached;
    return res.status(result.ok ? 200 : 503).json(result);
  });

  return router;
}

module.exports = { createHealthRouter };
