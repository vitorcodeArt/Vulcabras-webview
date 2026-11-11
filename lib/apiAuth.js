// ======================================================
// SEGREDO COMPARTILHADO PARA ENDPOINTS CHAMADOS PELO BOT
// ======================================================
// Protege o POST /api/send-webview. Para não quebrar a integração atual do
// Ultimate, a verificação só é ligada quando WEBVIEW_API_SECRET está definido:
// 1) cadastre o header no Ultimate; 2) defina a variável no Render.
//
// O bot envia o segredo em "X-Api-Secret: <segredo>" ou "Authorization: Bearer <segredo>".

const crypto = require("crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function readProvidedSecret(req) {
  const header = req.get("X-Api-Secret");
  if (header) return header;
  const auth = req.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function isApiSecretConfigured(envName = "WEBVIEW_API_SECRET") {
  return Boolean(process.env[envName]);
}

function requireApiSecret(envName = "WEBVIEW_API_SECRET") {
  return (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) return next();

    const provided = readProvidedSecret(req);
    // Compara hashes de tamanho fixo, em tempo constante
    if (provided && crypto.timingSafeEqual(digest(provided), digest(expected))) return next();

    return res.status(401).json({ success: false, error: "Não autorizado" });
  };
}

module.exports = { requireApiSecret, isApiSecretConfigured };
