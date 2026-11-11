// ============================================================
// CHAMADAS AO SERVIDOR
// Sempre POST com JSON e headers da sessão. Dados do cliente só no corpo.
// Devolve { ok, status, data } e nunca lança exceção.
// ============================================================

import { sessionHeaders } from "./session.js";

const OFFLINE = {
  code: "NETWORK_ERROR",
  error: "Sem conexão no momento. Verifique sua internet e tente novamente.",
  action: "retry",
};

const GENERIC = "Algo deu errado. Tente novamente em instantes.";

export async function api(path, body = {}) {
  let response;
  try {
    response = await fetch(path, { method: "POST", headers: sessionHeaders(), body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, data: { ...OFFLINE } };
  }

  const data = await response.json().catch(() => ({}));
  if (response.ok && data.success) return { ok: true, status: response.status, data };

  // Sessão vencida ou inválida: não há como seguir nesta abertura da webview
  const sessionProblem = typeof data.code === "string" && data.code.startsWith("SESSION_");

  return {
    ok: false,
    status: response.status,
    data: {
      ...data,
      code: data.code || (response.status === 429 ? "RATE_LIMITED" : "SERVICE_ERROR"),
      error: data.error || GENERIC,
      action: sessionProblem ? "close" : data.action || "retry",
    },
  };
}
