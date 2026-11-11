// ======================================================
// MENSAGENS NA CONVERSA (Sunshine Conversations)
// ======================================================
// Mesmo mecanismo e credenciais do POST /api/send-webview.

const axios = require("axios");

// Botão de transferência para atendente. "reply" (resposta rápida) faz o
// cliente "dizer" o texto do botão na conversa, e o bot do Ultimate reconhece
// como uma mensagem comum. "postback" envia só o payload (evento à parte).
const HANDOFF_BUTTON_TYPES = ["reply", "postback"];

function getHandoffButton() {
  const type = HANDOFF_BUTTON_TYPES.includes(process.env.REVERSE_HANDOFF_BUTTON_TYPE) ? process.env.REVERSE_HANDOFF_BUTTON_TYPE : "reply";
  return {
    type,
    text: process.env.REVERSE_HANDOFF_BUTTON_TEXT || "Falar com atendente",
    payload: process.env.REVERSE_HANDOFF_PAYLOAD || "REVERSE_HANDOFF",
  };
}

function createConversationClient({ http = axios } = {}) {
  async function postContent(conversationId, content) {
    const { ZENDESK_SUBDOMAIN, ZENDESK_APP_ID, ZENDESK_KEY_ID, ZENDESK_SECRET } = process.env;
    if (!ZENDESK_SUBDOMAIN || !ZENDESK_APP_ID || !ZENDESK_KEY_ID || !ZENDESK_SECRET) {
      const error = new Error("ZENDESK_NOT_CONFIGURED");
      error.code = "ZENDESK_NOT_CONFIGURED";
      throw error;
    }

    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/sc/v2/apps/${encodeURIComponent(ZENDESK_APP_ID)}/conversations/${encodeURIComponent(conversationId)}/messages`;

    const response = await http.post(
      url,
      { author: { type: "business" }, content },
      {
        auth: { username: ZENDESK_KEY_ID, password: ZENDESK_SECRET },
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      },
    );

    return { messageId: response.data?.messages?.[0]?.id || null };
  }

  function postText(conversationId, text) {
    return postContent(conversationId, { type: "text", text });
  }

  // Mensagem com o botão "Falar com atendente" que o bot reconhece
  function postHandoff(conversationId, text) {
    const button = getHandoffButton();
    return postContent(conversationId, {
      type: "text",
      text,
      actions: [{ type: button.type, text: button.text, payload: button.payload }],
    });
  }

  return { postText, postHandoff };
}

module.exports = { createConversationClient, getHandoffButton };
