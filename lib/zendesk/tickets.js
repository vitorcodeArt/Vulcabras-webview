// ======================================================
// API DE TICKETS DO ZENDESK: upload, ticket, comentários e nota final
// ======================================================
// Autenticação por Bearer (lib/zendesk/oauth.js). Em 401, renova o token uma
// vez e repete a chamada. Nenhum corpo de resposta vai para log ou erro.

const axios = require("axios");
const { getBrand } = require("../brands");

const TICKET_TAG = "troca_devolucao_webview";
const DEFAULT_SUBJECT = "Troca/Devolução via webview";

function ticketsError(code, httpStatus = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function baseUrl() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  if (!subdomain) throw ticketsError("ZENDESK_NOT_CONFIGURED");
  return `https://${subdomain}.zendesk.com/api/v2`;
}

// Formulário de ticket por marca (ex.: ZENDESK_TICKET_FORM_ID_UNDERARMOUR)
function ticketFormIdFor(brandKey) {
  const value = Number(process.env[`ZENDESK_TICKET_FORM_ID_${String(brandKey).toUpperCase()}`]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function createTicketsClient({ http = axios, tokenProvider }) {
  async function request(method, path, { data, headers = {}, params, timeout = 20000 } = {}) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const token = await tokenProvider.getAccessToken({ forceRefresh: attempt > 1 });
      let response;
      try {
        response = await http.request({
          method,
          url: `${baseUrl()}${path}`,
          data,
          params,
          headers: { Authorization: `Bearer ${token}`, ...headers },
          timeout,
          maxBodyLength: 20 * 1024 * 1024,
          validateStatus: () => true,
        });
      } catch {
        throw ticketsError("ZENDESK_NETWORK_ERROR");
      }

      if (response.status === 401 && attempt === 1) continue;
      if (response.status >= 200 && response.status < 300) return response.data;
      throw ticketsError(response.status === 429 ? "ZENDESK_RATE_LIMITED" : "ZENDESK_REQUEST_FAILED", response.status);
    }
    throw ticketsError("ZENDESK_UNAUTHORIZED", 401);
  }

  // Envia um arquivo; token: do primeiro upload, para juntar os demais
  async function upload({ filename, buffer, mime, token = null }) {
    const params = { filename };
    if (token) params.token = token;
    const data = await request("post", "/uploads", { data: buffer, params, headers: { "Content-Type": mime }, timeout: 30000 });
    const uploadToken = data?.upload?.token;
    if (!uploadToken) throw ticketsError("ZENDESK_UPLOAD_FAILED");
    return { token: uploadToken };
  }

  // Descarta um upload não usado (melhor esforço)
  async function discardUpload(token) {
    try {
      await request("delete", `/uploads/${encodeURIComponent(token)}`);
    } catch {
      // O token expira sozinho em 60 minutos
    }
  }

  // Ticket já resolvido, com nota interna (public: false), formulário e marca
  async function createTicket({ brandKey, body, uploadToken, idempotencyKey, extraTags = [] }) {
    const brand = getBrand(brandKey);
    if (!brand || !brand.zendeskBrandId) throw ticketsError("ZENDESK_BRAND_NOT_CONFIGURED");

    const ticket = {
      subject: process.env.ZENDESK_TICKET_SUBJECT || DEFAULT_SUBJECT,
      brand_id: brand.zendeskBrandId,
      status: "solved",
      comment: { body, public: false },
      tags: [TICKET_TAG, brand.zendeskTag, ...extraTags],
    };
    if (uploadToken) ticket.comment.uploads = [uploadToken];

    const formId = ticketFormIdFor(brand.key);
    if (formId) ticket.ticket_form_id = formId;

    const assigneeId = Number(process.env.ZENDESK_TICKET_ASSIGNEE_ID);
    if (Number.isSafeInteger(assigneeId) && assigneeId > 0) ticket.assignee_id = assigneeId;

    const headers = { "Content-Type": "application/json" };
    // Evita ticket duplicado em nova tentativa da mesma criação
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const data = await request("post", "/tickets", { data: { ticket }, headers });
    const id = data?.ticket?.id;
    if (!id) throw ticketsError("ZENDESK_TICKET_FAILED");
    return { ticketId: id };
  }

  // Anexos do primeiro comentário: [{ file_name, content_url }]
  async function firstCommentAttachments(ticketId) {
    const data = await request("get", `/tickets/${encodeURIComponent(ticketId)}/comments`, { params: { sort_order: "asc" } });
    const first = Array.isArray(data?.comments) ? data.comments[0] : null;
    return (first?.attachments || []).map((a) => ({ file_name: a.file_name, content_url: a.content_url }));
  }

  // Nota interna adicional, mantendo o ticket resolvido
  async function addInternalNote(ticketId, body) {
    await request("put", `/tickets/${encodeURIComponent(ticketId)}`, {
      data: { ticket: { status: "solved", comment: { body, public: false } } },
      headers: { "Content-Type": "application/json" },
    });
  }

  return { upload, discardUpload, createTicket, firstCommentAttachments, addInternalNote };
}

module.exports = { createTicketsClient, ticketFormIdFor, TICKET_TAG };
