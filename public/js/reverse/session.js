// ============================================================
// SESSÃO DA WEBVIEW
// Lê o token assinado da URL, guarda só em memória e o remove da barra de
// endereço. Gera o session_id (UUID por abertura) usado no rastreamento.
// ============================================================

function readUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t") || null;
  const store = (params.get("store") || "").toLowerCase();

  // Tira o token da URL visível (o store pode ficar)
  if (token) {
    params.delete("t");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }

  return { token, store };
}

function newSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  // Alternativa para navegadores antigos
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const { token, store } = readUrlParams();

export const session = {
  token,
  store,
  sessionId: newSessionId(),
};

// Headers comuns a todas as chamadas da webview
export function sessionHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Flow-Token": session.token || "",
    "X-Flow-Session": session.sessionId,
  };
}
