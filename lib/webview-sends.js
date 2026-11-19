// ======================================================
// REGISTRO DOS ENVIOS DO BOTÃO DA WEBVIEW (tabela webview_sends)
// ======================================================
// Uma linha por tentativa de postar o botão na Sunshine, em sucesso e em falha.
// Best-effort: banco desligado, lento (mais de ~1 s) ou com erro NUNCA faz o
// envio ao cliente falhar nem demorar além do limite. Nada de corpo de resposta,
// token ou dado pessoal: só IDs técnicos e um código curto de erro.

const TIMEOUT_MS = 1000;

// Código curto e seguro: "HTTP_403", "ECONNABORTED"... nunca o corpo da resposta
function sendErrorCode(error) {
  const status = error?.response?.status;
  const raw = Number.isInteger(status) ? `HTTP_${status}` : error?.code || error?.name || "UNKNOWN";
  const code = String(raw).replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  return code || "UNKNOWN";
}

// Nunca rejeita. Devolve true se gravou, false se não gravou (por qualquer motivo).
async function recordWebviewSend({ sendId, conversationId, brand, flow, messageId = null, ok, errorCode = null }, { db = require("./db"), timeoutMs = TIMEOUT_MS } = {}) {
  let timer;
  try {
    if (!db.getPool()) return false; // sem banco: o rastreamento fica só no console
    const insert = db.query(
      `insert into webview_sends (send_id, conversation_id, brand, flow, message_id, ok, error_code)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (send_id) do nothing`,
      [sendId, conversationId, brand, flow, messageId, ok === true, errorCode],
    );
    insert.catch(() => {}); // se perder a corrida do tempo, o erro (já logado pelo db) não vira exceção solta
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    await Promise.race([insert, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { recordWebviewSend, sendErrorCode, TIMEOUT_MS };
