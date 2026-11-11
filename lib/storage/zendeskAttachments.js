// ======================================================
// ARMAZENAMENTO DAS FOTOS: ANEXOS DE TICKET DO ZENDESK
// ======================================================
// Implementação padrão da interface ImageStorage usada pelo submit:
//   isEnabled(brand) -> boolean
//   store({ brandKey, ticketBody, photosBySku }) -> { ticketId, urlsBySku }
//   addNote(ticketId, body) -> Promise (melhor esforço)
// Para trocar por um bucket (S3/R2), basta outra implementação com a mesma
// interface; o resto do fluxo não muda.
//
// O upload e a criação do ticket acontecem juntos, só na confirmação final:
// antes de entrar num ticket, o arquivo é visível a qualquer usuário logado.

const crypto = require("crypto");
const { createTicketsClient } = require("../zendesk/tickets");
const { createTokenProvider, isOAuthConfigured } = require("../zendesk/oauth");

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Liga o envio de fotos só depois do teste de viabilidade (content_url pública)
function photosFlagOn() {
  return process.env.REVERSE_PHOTOS_ENABLED === "true";
}

// Nome do arquivo: SKU + índice (ex.: CAM-AZUL-M-1.jpg), para ligar a URL ao item
function safeName(sku) {
  return String(sku).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "item";
}

function createZendeskAttachmentStorage({ tickets = null } = {}) {
  let client = tickets;
  function getClient() {
    if (!client) client = createTicketsClient({ tokenProvider: createTokenProvider() });
    return client;
  }

  function isEnabled(brand) {
    return photosFlagOn() && isOAuthConfigured() && Boolean(brand && brand.zendeskBrandId);
  }

  async function store({ brandKey, ticketBody, photosBySku }) {
    const api = getClient();

    // Monta a lista de arquivos com nomes únicos
    const files = [];
    const usedNames = new Set();
    for (const [sku, photos] of Object.entries(photosBySku)) {
      photos.forEach((photo, index) => {
        let name = `${safeName(sku)}-${index + 1}.${EXTENSIONS[photo.mime] || "jpg"}`;
        while (usedNames.has(name)) name = `x${name}`;
        usedNames.add(name);
        files.push({ sku, name, photo });
      });
    }

    let uploadToken = null;
    try {
      for (const file of files) {
        const result = await api.upload({ filename: file.name, buffer: file.photo.buffer, mime: file.photo.mime, token: uploadToken });
        uploadToken = result.token;
      }
    } catch (error) {
      if (uploadToken) await api.discardUpload(uploadToken);
      throw error;
    }

    const idempotencyKey = crypto.createHash("sha256").update(`reverse:${uploadToken}`).digest("hex").slice(0, 40);
    const { ticketId } = await api.createTicket({ brandKey, body: ticketBody, uploadToken, idempotencyKey });

    // Fonte oficial da URL: os anexos do primeiro comentário do ticket
    let attachments = await api.firstCommentAttachments(ticketId);
    if (attachments.length < files.length) attachments = await api.firstCommentAttachments(ticketId);

    const urlByName = new Map(attachments.map((a) => [a.file_name, a.content_url]));
    const urlsBySku = {};
    for (const file of files) {
      const url = urlByName.get(file.name);
      if (typeof url !== "string" || !/^https:\/\//.test(url)) {
        const error = new Error("ZENDESK_ATTACHMENT_URL_MISSING");
        error.code = "ZENDESK_ATTACHMENT_URL_MISSING";
        error.ticketId = ticketId;
        throw error;
      }
      (urlsBySku[file.sku] = urlsBySku[file.sku] || []).push(url);
    }

    return { ticketId, urlsBySku };
  }

  async function addNote(ticketId, body) {
    await getClient().addInternalNote(ticketId, body);
  }

  return { isEnabled, store, addNote };
}

module.exports = { createZendeskAttachmentStorage, safeName };
