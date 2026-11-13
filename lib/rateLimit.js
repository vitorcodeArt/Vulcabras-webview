// ======================================================
// LIMITES DE REQUISIÇÕES (em memória, janela fixa)
// ======================================================
// Protege os endpoints do fluxo por IP e por conversa. Em mais de uma
// instância, cada uma conta separado (trocar por Redis se escalar).
// Nada de IP ou dado pessoal no log: só o nome do limite.

const MAX_KEYS = 20000;

function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // chave -> { count, resetAt }

  function prune() {
    if (hits.size < MAX_KEYS) return;
    const time = now();
    for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
    if (hits.size >= MAX_KEYS) hits.clear();
  }

  // Conta uma requisição; devolve { allowed, retryAfterS }
  function hit(key) {
    const time = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      prune();
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= max, retryAfterS: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) };
  }

  return { hit };
}

const LIMIT_MESSAGE = "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.";

// key(req) -> string ou null (null = não limita esta requisição)
function rateLimit({ name, windowMs, max, key, now }) {
  const limiter = createRateLimiter({ windowMs, max, now });
  const warned = new Map();

  return (req, res, next) => {
    const id = key(req);
    if (!id) return next();

    const { allowed, retryAfterS } = limiter.hit(`${name}:${id}`);
    if (allowed) return next();

    // Um aviso por chave e janela, sem a chave em si
    const warnKey = `${name}:${id}`;
    if (!warned.has(warnKey) || warned.get(warnKey) < Date.now()) {
      if (warned.size > MAX_KEYS) warned.clear();
      warned.set(warnKey, Date.now() + windowMs);
      console.warn(`Troca/Devolução: limite "${name}" atingido`);
    }

    res.set("Retry-After", String(retryAfterS));
    return res.status(429).json({ success: false, code: "RATE_LIMITED", error: LIMIT_MESSAGE, action: "retry" });
  };
}

// Freio das chamadas ao Troque: o limite de 70 requisições a cada 10 s é por
// IP e vale para todas as marcas juntas. Espera até maxWaitMs antes de seguir.
function createOutboundThrottle({ max = 60, windowMs = 10000, maxWaitMs = 5000, now = () => Date.now(), sleep } = {}) {
  const stamps = [];
  return async function throttle() {
    const deadline = now() + maxWaitMs;
    for (;;) {
      const time = now();
      while (stamps.length && stamps[0] <= time - windowMs) stamps.shift();
      if (stamps.length < max || time >= deadline) break;
      await sleep(Math.min(stamps[0] + windowMs - time, deadline - time));
    }
    stamps.push(now());
  };
}

module.exports = { createRateLimiter, rateLimit, createOutboundThrottle, LIMIT_MESSAGE };
