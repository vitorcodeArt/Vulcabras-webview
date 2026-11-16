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

// Imagens enviadas pelo cliente (bot do WhatsApp): limites de leitura e download
const MAX_MESSAGE_PAGES = 5;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

function sunshineConfig() {
  const { ZENDESK_SUBDOMAIN, ZENDESK_APP_ID, ZENDESK_KEY_ID, ZENDESK_SECRET } = process.env;
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_APP_ID || !ZENDESK_KEY_ID || !ZENDESK_SECRET) {
    const error = new Error("ZENDESK_NOT_CONFIGURED");
    error.code = "ZENDESK_NOT_CONFIGURED";
    throw error;
  }
  return { subdomain: ZENDESK_SUBDOMAIN, appId: ZENDESK_APP_ID, auth: { username: ZENDESK_KEY_ID, password: ZENDESK_SECRET } };
}

function messagesUrl(config, conversationId) {
  return `https://${config.subdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(config.appId)}/conversations/${encodeURIComponent(conversationId)}/messages`;
}

// Mensagem do cliente com imagem (tipo "image", ou "file" com MIME de imagem)
function customerImage(message) {
  if (message?.author?.type !== "user") return null;
  const content = message.content || {};
  const isImage = content.type === "image" || (content.type === "file" && /^image\//i.test(content.mediaType || ""));
  if (!isImage || typeof content.mediaUrl !== "string" || !/^https:\/\//.test(content.mediaUrl)) return null;
  return { id: message.id, mediaUrl: content.mediaUrl, mediaType: content.mediaType || null, receivedAt: Date.parse(message.received) || 0 };
}

function createConversationClient({ http = axios } = {}) {
  async function postContent(conversationId, content) {
    const config = sunshineConfig();
    const url = messagesUrl(config, conversationId);

    const response = await http.post(
      url,
      { author: { type: "business" }, content },
      {
        auth: config.auth,
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

  // Imagens que o cliente mandou na conversa desde "sinceMs" (mais antigas primeiro).
  // A API devolve a página mais recente; "page[before]" busca as anteriores.
  async function listCustomerImages(conversationId, { sinceMs }) {
    const config = sunshineConfig();
    const url = messagesUrl(config, conversationId);
    const images = [];
    let before = null;

    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const response = await http.get(url, { auth: config.auth, params: before ? { "page[before]": before } : {}, timeout: 10000 });
      const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
      for (const message of messages) {
        const image = customerImage(message);
        if (image && image.receivedAt >= sinceMs) images.push(image);
      }
      const oldest = messages[0];
      const reachedSince = !oldest || (Date.parse(oldest.received) || 0) < sinceMs;
      before = response.data?.meta?.beforeCursor || null;
      if (reachedSince || !response.data?.meta?.hasMore || !before) break;
    }

    const seen = new Set();
    return images.filter((i) => !seen.has(i.id) && seen.add(i.id)).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  // Baixa uma imagem da conversa. Tenta sem credencial; se o Zendesk exigir
  // (anexos restritos), repete com a chave do Sunshine, mas só para o próprio
  // subdomínio e sem seguir redirecionamentos com a credencial.
  async function downloadMedia(mediaUrl) {
    const config = sunshineConfig();
    const options = { responseType: "arraybuffer", timeout: 15000, maxContentLength: MAX_MEDIA_BYTES, maxBodyLength: MAX_MEDIA_BYTES };
    try {
      const response = await http.get(mediaUrl, { ...options, maxRedirects: 3 });
      return Buffer.from(response.data);
    } catch (error) {
      const status = error.response?.status;
      const ownHost = new URL(mediaUrl).hostname === `${config.subdomain}.zendesk.com`;
      if (!ownHost || (status !== 401 && status !== 403)) throw error;
    }

    const response = await http.get(mediaUrl, { ...options, auth: config.auth, maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
    if (response.status >= 300) {
      const location = response.headers?.location;
      if (typeof location !== "string" || !/^https:\/\//.test(location)) throw Object.assign(new Error("MEDIA_REDIRECT_INVALID"), { code: "MEDIA_REDIRECT_INVALID" });
      const followed = await http.get(location, { ...options, maxRedirects: 3 });
      return Buffer.from(followed.data);
    }
    return Buffer.from(response.data);
  }

  return { postText, postHandoff, listCustomerImages, downloadMedia };
}

module.exports = { createConversationClient, getHandoffButton };
