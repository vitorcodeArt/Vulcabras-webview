// ======================================================
// ENVIAR WEBVIEW PARA UMA CONVERSA (POST /api/send-webview)
// ======================================================
// Posta na conversa (Sunshine) uma mensagem com o botão que abre a webview de
// rastreamento, catálogo ou troca/devolução. Cada chamada gera um send_id
// (uuid) que vai no token assinado e na URL do botão, e é gravado em
// webview_sends (best-effort, ver lib/webview-sends.js).

const crypto = require("crypto");
const express = require("express");
const defaultAxios = require("axios");
const { requireApiSecret } = require("../lib/apiAuth");
const { createSessionToken, isValidConversationId } = require("../lib/session");
const { normalizeBrandKey } = require("../lib/brands");
const { buildReverseWebview, SESSION_QUERY_PARAM } = require("./reverse");
const { recordWebviewSend, sendErrorCode } = require("../lib/webview-sends");
const { rememberSunshineName } = require("../lib/contacts");

// O botão do catálogo e do rastreamento fica na conversa e pode ser aberto bem
// depois do envio: o token vale mais que o da troca (que cria reversas)
const LINK_TTL_SECONDS = 24 * 60 * 60;

// getVtexStores: função (as lojas do catálogo são definidas depois, no server.js)
function createSendWebviewRouter({ getVtexStores, axios = defaultAxios, db, now, randomUUID = () => crypto.randomUUID(), env = process.env } = {}) {
  const router = express.Router();

  // Token do catálogo e do rastreamento: se não der para gerar (segredo ausente,
  // marca fora da lista), o link sai como antes, sem token e sem rastreamento
  function linkToken({ conversationId, store, sendId, flow }) {
    if (!normalizeBrandKey(store)) return null;
    try {
      return createSessionToken({ conversationId, store, sendId, flow, ttlSeconds: LINK_TTL_SECONDS });
    } catch (error) {
      console.error(`Webview ${flow}: sem token de acompanhamento (${error.message})`);
      return null;
    }
  }

  // Exige WEBVIEW_API_SECRET quando a variável estiver definida (ver lib/apiAuth.js)
  router.post("/api/send-webview", requireApiSecret(), async (req, res) => {
    const ZENDESK_SUBDOMAIN = env.ZENDESK_SUBDOMAIN;
    const ZENDESK_APP_ID = env.ZENDESK_APP_ID;
    const ZENDESK_KEY_ID = env.ZENDESK_KEY_ID;
    const ZENDESK_SECRET = env.ZENDESK_SECRET;
    const VTEX_STORES = getVtexStores();
    const PORT = env.PORT || 3000;

    let attempted = null; // preenchido quando vai tentar postar na Sunshine
    try {
      const { conversationId, type = "tracking", store = "mizuno", customText, buttonText } = req.body;

      if (!conversationId) {
        return res.status(400).json({
          success: false,
          error: "conversationId é obrigatório",
        });
      }

      if (!ZENDESK_SUBDOMAIN || !ZENDESK_APP_ID || !ZENDESK_KEY_ID || !ZENDESK_SECRET) {
        return res.status(500).json({
          success: false,
          error: "Credenciais do Zendesk não configuradas",
        });
      }

      const isCatalog = type === "catalog";
      const isReverse = type === "reverse";
      const flow = isCatalog ? "catalog" : isReverse ? "reverse" : "tracking";
      const storeKey = String(store || "mizuno").toLowerCase();
      const sendId = randomUUID();

      // valida a loja apenas quando o fluxo for de catálogo
      if (isCatalog && !VTEX_STORES[storeKey]) {
        return res.status(400).json({
          success: false,
          error: `Loja "${storeKey}" inválida. Opções: ${Object.keys(VTEX_STORES).join(", ")}`,
        });
      }

      const baseUrl = env.WEBVIEW_URL ? env.WEBVIEW_URL.replace(/\/(webview|catalog|reverse)\/?$/, "") : `http://localhost:${PORT}`;

      // Troca/devolução: URL com sessão assinada (conversationId, marca e expiração)
      const reverseWebview = isReverse ? buildReverseWebview({ baseUrl, conversationId, store: storeKey, customText, buttonText, sendId }) : null;

      if (reverseWebview && !reverseWebview.ok) {
        return res.status(reverseWebview.status).json({
          success: false,
          error: reverseWebview.error,
        });
      }

      const targetPath = isCatalog ? "catalog" : "webview";

      // Parâmetros atuais mantidos (links antigos continuam funcionando); o token é um a mais
      const params = new URLSearchParams({ conversationId });
      if (isCatalog) params.set("store", storeKey);
      if (!isReverse && isValidConversationId(conversationId)) {
        const token = linkToken({ conversationId, store: storeKey, sendId, flow });
        if (token) params.set(SESSION_QUERY_PARAM, token);
      }

      const uri = isReverse ? reverseWebview.uri : `${baseUrl}/${targetPath}?${params.toString()}`;

      const storeLabel = isCatalog ? VTEX_STORES[storeKey].label : isReverse ? reverseWebview.label : null;

      const messageText = isReverse ? reverseWebview.text : customText || (isCatalog ? `Confira o nosso catálogo ${storeLabel}:` : "Consulte o rastreamento do seu pedido:");
      const actionButtonText = isReverse ? reverseWebview.buttonText : buttonText || (isCatalog ? "Ver Catálogo" : "Ver rastreamento");

      const payload = {
        author: { type: "business" },
        content: {
          type: "text",
          text: messageText,
          actions: [
            {
              type: "webview",
              text: actionButtonText,
              size: "tall",
              uri,
              fallback: uri,
            },
          ],
        },
      };

      attempted = { sendId, conversationId, brand: normalizeBrandKey(storeKey) || storeKey.slice(0, 40), flow };

      const response = await axios.post(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/sc/v2/apps/${ZENDESK_APP_ID}/conversations/${conversationId}/messages`, payload, {
        auth: { username: ZENDESK_KEY_ID, password: ZENDESK_SECRET },
        headers: { "Content-Type": "application/json" },
      });

      // Na troca/devolução, a resposta do Zendesk contém a URL com o token da sessão:
      // devolver só o ID da mensagem, para o token não sair da conversa.
      const messageId = response.data?.messages?.[0]?.id || null;
      const responseData = isReverse ? { messageId } : response.data;

      await recordWebviewSend({ ...attempted, messageId, ok: true }, { db });

      // Nome de exibição ("Maria S.") para o painel dos analistas; em segundo plano, sem atrasar a resposta
      if (isValidConversationId(conversationId)) rememberSunshineName(conversationId, { axios, env, db });

      res.json({
        success: true,
        message: `Webview (${isCatalog ? `catálogo ${storeLabel}` : isReverse ? `troca e devolução ${storeLabel}` : "rastreamento"}) enviada com sucesso`,
        data: responseData,
        sendId,
      });
    } catch (error) {
      console.error("Erro ao enviar Webview:");
      console.error(error.response?.data || error.message);

      // Só quando chegou a tentar postar: validações e configuração não geram linha
      if (attempted) await recordWebviewSend({ ...attempted, ok: false, errorCode: sendErrorCode(error) }, { db });

      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data || error.message,
        ...(attempted ? { sendId: attempted.sendId } : {}),
      });
    }
  });

  return router;
}

module.exports = { createSendWebviewRouter, LINK_TTL_SECONDS };
