// ======================================================
// API DO BOT PARA TROCA E DEVOLUÇÃO (WhatsApp / agente de IA do Zendesk)
// ======================================================
// Mesmas regras do webview (lib/reverse/service.js), com respostas em JSON
// plano para o fluxo do Ultimate mapear em variáveis:
// - sempre HTTP 200 com { ok, next, code?, field?, message? } (exceto 401/503 de configuração);
// - escolhas por número (item_option, reason_option...), resolvidas aqui;
// - nada é guardado no servidor: o bot reenvia pedido e escolhas a cada chamada;
// - o bot fala com o cliente (nada é postado na conversa por aqui).
// Nesta versão: um produto por solicitação. Fotos: o cliente manda na própria
// conversa e o servidor busca as imagens pelo Sunshine (rota "photos").

const crypto = require("crypto");
const express = require("express");
const { getBrand } = require("../lib/brands");
const { isValidConversationId, signData, verifyData } = require("../lib/session");
const { requireApiSecret } = require("../lib/apiAuth");
const { createRateLimiter, LIMIT_MESSAGE } = require("../lib/rateLimit");
const { createReverseService } = require("../lib/reverse/service");
const { createConversationClient } = require("../lib/zendesk/conversation");
const { detectImageType, MAX_PER_ITEM } = require("../lib/reverse/photos");
const { ReverseError, describeError } = require("../lib/reverse/errors");
const { submitConfirmationMessage, formatDate } = require("../lib/reverse/messages");
const v = require("../lib/reverse/validation");
const input = require("../lib/bot/input");
const f = require("../lib/bot/format");

const MINUTE = 60 * 1000;
const CONFIRMATION_TTL_S = 30 * 60;
// Validade do pedido de fotos (o cliente pode demorar para achar a foto)
const PHOTO_TOKEN_TTL_S = 2 * 60 * 60;
// Margem para o relógio do Zendesk e o momento exato do pedido
const PHOTO_SINCE_MARGIN_MS = 60 * 1000;
const MAX_TOTAL_PHOTO_BYTES = 40 * 1024 * 1024;
const DEFAULT_PHOTO_TEXT = "Envie aqui na conversa uma ou mais fotos do produto que mostrem o problema. Quando terminar, me avise.";

// action do serviço -> "next" do bot
const NEXT = {
  retry: "retry",
  fix_input: "fix_input",
  track: "track",
  refresh_retention: "retention",
  requote: "quote",
  retry_without_address: "address",
  handoff: "handoff",
  close: "close",
};

// Mensagens do serviço que falam em "voltar ao chat" ou em telas do webview
const BOT_MESSAGES = {
  TOO_MANY_ATTEMPTS: "Não foi possível localizar o pedido após algumas tentativas. Vou te encaminhar para um atendente.",
  BRAND_NOT_CONFIGURED: "A troca e devolução está indisponível no momento. Vou te encaminhar para um atendente.",
  SERVICE_ERROR: "A troca e devolução está indisponível no momento. Vou te encaminhar para um atendente.",
  HANDOFF_REQUIRED: "Para este motivo, um atendente precisa analisar sua solicitação. Vou te encaminhar.",
  PHOTO_UNAVAILABLE: "Para este motivo, precisamos de fotos do produto. Vou te encaminhar para um atendente.",
  PHOTO_REQUIRED: "Ainda não recebi a foto do produto. Envie a foto aqui na conversa e me avise quando terminar.",
  PHOTO_INVALID: "Não consegui abrir as fotos enviadas. Envie a imagem de novo (JPG ou PNG).",
  PHOTO_TOO_LARGE: "As fotos ficaram grandes demais. Envie menos fotos ou imagens menores.",
  PHOTO_UPLOAD_FAILED: "Não consegui buscar as fotos agora. Tente novamente em instantes.",
  CREATION_UNCONFIRMED: "Não conseguimos confirmar se sua solicitação foi registrada. Não envie de novo: em alguns minutos, consulte o status da solicitação.",
  ALREADY_HAS_ACTIVE_REVERSE: "Este pedido já tem uma solicitação em andamento. Posso te mostrar o status dela.",
  DUPLICATE_SUSPECTED: "Recebemos uma solicitação deste pedido há poucos minutos. Posso te mostrar o status antes de enviar outra.",
  ADDRESS_NOT_EDITABLE: "Não é possível alterar o endereço deste pedido. Vamos usar o endereço da compra.",
  CONFIRMATION_REQUIRED: "Os dados mudaram desde o resumo. Vou montar o resumo de novo para você confirmar.",
  CUSTOMER_DATA_MISSING: "Para continuar, um atendente precisa completar alguns dados do seu cadastro. Vou te encaminhar.",
};

// Erros próprios da API do bot (não existem no webview)
const BOT_ERRORS = {
  CONFIRMATION_REQUIRED: { next: "summary" },
  CUSTOMER_DATA_MISSING: { next: "handoff" },
};

// Campo do serviço -> campo enviado pelo bot
const ITEM_FIELDS = { sku: "item_option", quantity: "quantity", reason: "reason_option", sub_reason: "sub_reason_option", comment: "comment", photos: "photos" };

function botField(field) {
  if (!field) return null;
  if (field === "items") return "item_option";
  const item = field.match(/^items\[\d+\]\.?(\w+)?/);
  if (item) return ITEM_FIELDS[item[1]] || "item_option";
  if (field === "address.description") return "address_complement";
  if (field.startsWith("address.")) return `address_${field.slice(8)}`;
  if (field === "payment_bill.pix_type") return "pix_type";
  if (field.startsWith("payment_bill")) return "pix_key";
  if (field === "retention.level") return "retention_level";
  if (field === "retention") return "retention_accepted";
  if (field.startsWith("customer.")) return "customer";
  return field;
}

// Orientação por campo, para o bot repetir a pergunta certa
const FIELD_MESSAGES = {
  conversation_id: "conversation_id ausente ou inválido.",
  store: "Marca (store) inválida: use mizuno, olympikus ou underarmour.",
  order_number: "Confira o número do pedido.",
  customer_identifier: "Confira o CPF, CNPJ ou e-mail usado na compra.",
  type: "Escolha entre troca ou devolução.",
  item_option: "Escolha um dos produtos da lista pelo número.",
  quantity: "Informe uma quantidade válida para este produto.",
  reason_option: "Escolha um dos motivos da lista pelo número.",
  sub_reason_option: "Escolha uma das opções do motivo pelo número.",
  comment: "Conte em poucas palavras o que aconteceu com o produto (até 1000 caracteres).",
  address: "Precisamos do endereço completo: CEP, rua, número, bairro, cidade e estado.",
  address_zipcode: "Confira o CEP (8 números).",
  address_street: "Confira o nome da rua.",
  address_number: "Confira o número do endereço.",
  address_neighborhood: "Confira o bairro.",
  address_city: "Confira a cidade.",
  address_state: "Confira o estado (sigla com 2 letras, ex.: SP).",
  address_complement: "O complemento pode ter até 200 caracteres.",
  shipping_option: "Escolha uma das formas de envio pelo número.",
  retention_accepted: "Responda se aceita o vale-compras (sim ou não).",
  retention_level: "Oferta de vale-compras inválida.",
  pix_type: "Escolha o tipo da chave PIX pelo número.",
  pix_key: "Para o reembolso, informe uma chave PIX válida.",
  photo_token: "O pedido de fotos expirou ou não foi feito. Chame o reason_detail de novo para pedir as fotos.",
};

function errorBody(error) {
  const local = error && BOT_ERRORS[error.code];
  if (local) {
    return { ok: false, next: local.next, code: error.code, field: null, message: BOT_MESSAGES[error.code] };
  }

  const { body, internalCode } = describeError(error);
  const field = botField(body.field);
  const result = {
    ok: false,
    next: NEXT[body.action] || "handoff",
    code: body.code,
    field,
    message: (body.code === "INVALID_INPUT" && FIELD_MESSAGES[field]) || BOT_MESSAGES[body.code] || body.error,
  };
  // Motivo para o bot escolher a mensagem de transferência
  if (result.next === "handoff") result.handoff_reason = body.code === "PHOTO_UNAVAILABLE" || body.code === "PHOTO_REQUIRED" ? "PHOTO_REQUIRED" : body.code === "HANDOFF_REQUIRED" ? "REASON" : body.code === "TOO_MANY_ATTEMPTS" ? "NOT_FOUND" : "ERROR";
  if (Array.isArray(body.missing_address_fields)) result.missing_address_fields = body.missing_address_fields.map((x) => `address_${x}`);
  // Nova tentativa do submit sem reenviar fotos nem criar outro ticket
  if (typeof body.photo_resume === "string") result.photo_resume = body.photo_resume;
  return { ...result, internalCode };
}

// ---------- Sessão "virtual" do bot ----------

function botFlow(body) {
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
  if (!isValidConversationId(conversationId)) throw new ReverseError("INVALID_INPUT", { field: "conversation_id" });
  const brand = getBrand(body.store);
  if (!brand) throw new ReverseError("INVALID_INPUT", { field: "store" });
  return { conversationId, store: brand.key, brand, sessionId: null, channel: "bot" };
}

// Liga o resumo confirmado ao envio. HMAC (não hash simples): CPF e chave PIX
// entram no cálculo e não podem ser descobertos a partir do token.
function decisionHash(parts) {
  const key = process.env.FLOW_SESSION_SECRET || "";
  return crypto.createHmac("sha256", key).update(JSON.stringify(parts)).digest("base64url").slice(0, 32);
}

function createBotRouter({ service = createReverseService(), conversation = createConversationClient(), now = () => Date.now() } = {}) {
  const router = express.Router();

  // Limites por conversa (as chamadas do Ultimate saem de poucos IPs do Zendesk,
  // então limitar por IP travaria todos os clientes juntos)
  const limiters = {
    all: createRateLimiter({ windowMs: 10 * MINUTE, max: 150, now }),
    submit: createRateLimiter({ windowMs: 10 * MINUTE, max: 10, now }),
  };

  router.use("/api/bot/reverse", requireApiSecret("BOT_API_SECRET", { required: true }));

  function limited(name, req) {
    const id = typeof req.body?.conversation_id === "string" && isValidConversationId(req.body.conversation_id.trim()) ? req.body.conversation_id.trim() : "sem-conversa";
    return !limiters[name].hit(id).allowed;
  }

  function handle(path, handler, { limit = null } = {}) {
    router.post(`/api/bot/reverse/${path}`, async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (limited("all", req) || (limit && limited(limit, req))) {
        return res.json({ ok: false, next: "retry", code: "RATE_LIMITED", field: null, message: LIMIT_MESSAGE });
      }

      let flow = null;
      try {
        flow = botFlow(body);
        const data = await handler(flow, body);
        return res.json({ ok: true, next: "continue", ...data });
      } catch (error) {
        const { internalCode, ...response } = errorBody(error);
        // Só código e IDs técnicos no log: o corpo tem CPF, e-mail e endereço
        if (response.code === "SERVICE_ERROR" || response.code === "BRAND_NOT_CONFIGURED" || response.next === "retry") {
          console.error(`Bot Troca/Devolução: ${path} terminou em ${internalCode} (conversa ${flow?.conversationId || "?"}, marca ${flow?.store || "?"})`);
          if (!error || !error.code) console.error(`Bot Troca/Devolução: erro inesperado (${error?.name || "Error"}) em ${path}`, error?.stack?.split("\n")[1]?.trim() || "");
        }
        return res.json(response);
      }
    });
  }

  // Pedido + identificação + produto e motivo escolhidos (base de quase todas as etapas)
  async function loadDecision(flow, body) {
    const prepared = await service.prepare(flow, body);
    if (!prepared.eligible) {
      throw new ReverseError("ORDER_NOT_ELIGIBLE", { details: { ineligibility_message: prepared.ineligibility_message || undefined } });
    }
    if ((prepared.address_step?.missing_customer_fields || []).length > 0) throw new ReverseError("CUSTOMER_DATA_MISSING");

    const sel = input.selection(prepared, body);
    if (sel.reason.handoff) throw new ReverseError("HANDOFF_REQUIRED", { field: "items[0].reason" });
    if (sel.reason.has_image && !service.features(flow).photos) throw new ReverseError("PHOTO_UNAVAILABLE");

    const address = input.address(body);
    const identity = { order_number: body.order_number, customer_identifier: body.customer_identifier };
    return { prepared, sel, address, identity, base: { ...identity, type: sel.type, items: sel.items } };
  }

  // ---------- Fotos (motivos com has_image) ----------

  function signPhotoToken(flow) {
    return signData("botphoto", { c: flow.conversationId, t: now() }, PHOTO_TOKEN_TTL_S, now());
  }

  // Momento em que as fotos foram pedidas: só imagens enviadas depois contam
  function readPhotoToken(flow, body) {
    const data = verifyData("botphoto", typeof body.photo_token === "string" ? body.photo_token : "", now());
    if (!data || data.c !== flow.conversationId || typeof data.t !== "number") throw new ReverseError("INVALID_INPUT", { field: "photo_token" });
    return data.t - PHOTO_SINCE_MARGIN_MS;
  }

  // Imagens do cliente na conversa desde o pedido (as 10 mais recentes)
  async function customerImages(flow, body) {
    const sinceMs = readPhotoToken(flow, body);
    let images;
    try {
      images = await conversation.listCustomerImages(flow.conversationId, { sinceMs });
    } catch (error) {
      console.error(`Bot Troca/Devolução: falha ao listar imagens da conversa (${error.code || error.response?.status || "erro"})`);
      throw new ReverseError("PHOTO_UPLOAD_FAILED");
    }
    return images.slice(-MAX_PER_ITEM);
  }

  // Baixa e confere as imagens (JPEG, PNG ou WebP pela assinatura do arquivo)
  async function downloadImages(images) {
    const photos = [];
    let total = 0;
    for (const image of images) {
      let buffer;
      try {
        buffer = await conversation.downloadMedia(image.mediaUrl);
      } catch (error) {
        const status = error.response?.status;
        console.error(`Bot Troca/Devolução: falha ao baixar imagem da conversa (${error.code || status || "erro"})`);
        if (error.code === "ERR_BAD_RESPONSE" || /maxContentLength/i.test(error.message || "")) throw new ReverseError("PHOTO_TOO_LARGE", { field: "photos" });
        throw new ReverseError("PHOTO_UPLOAD_FAILED");
      }
      const mime = detectImageType(buffer);
      if (!mime) continue;
      total += buffer.length;
      if (total > MAX_TOTAL_PHOTO_BYTES) throw new ReverseError("PHOTO_TOO_LARGE", { field: "photos" });
      photos.push({ buffer, mime });
    }
    if (photos.length === 0) throw new ReverseError("PHOTO_INVALID", { field: "photos" });
    return photos;
  }

  // ---------- 1. Identificar o pedido ----------
  handle("lookup", async (flow, body) => {
    const prepared = await service.prepare(flow, body);
    const order = prepared.order || {};
    const items = order.items || [];
    const existing = prepared.existing_reverses || [];
    const step = prepared.address_step || {};

    const common = {
      eligible: prepared.eligible,
      order_number: order.ecommerce_number || v.normalizeOrderNumber(body.order_number),
      existing_count: existing.length,
      existing_text: existing.length ? f.existingText(existing) : "",
    };

    if (!prepared.eligible) {
      return {
        ...common,
        next: existing.length ? "track" : "close",
        message: prepared.ineligibility_message || "Este pedido não pode ser trocado ou devolvido no momento.",
        ineligibility_code: prepared.ineligibility_code,
      };
    }

    if ((step.missing_customer_fields || []).length > 0) {
      return { ...common, next: "handoff", handoff_reason: "ERROR", code: "CUSTOMER_DATA_MISSING", message: BOT_MESSAGES.CUSTOMER_DATA_MISSING };
    }

    const unavailable = order.unavailable_items || [];
    return {
      ...common,
      first_name: order.customer?.first_name || null,
      delivered_at: formatDate(order.delivered_at),
      items_count: items.length,
      items_text: f.itemsText(items),
      ...f.flatItems(items),
      unavailable_count: unavailable.length,
      unavailable_text: unavailable.length ? f.itemsText(unavailable) : "",
      exchange_available: (prepared.reasons || []).some((r) => r.is_exchange),
      refund_available: (prepared.reasons || []).some((r) => r.is_refund),
      // none: não pergunta endereço | confirm: mostrar e confirmar | ask_full_address: coletar tudo
      address_mode: step.mode === "confirm" || step.mode === "ask_full_address" ? step.mode : "none",
      address_text: f.addressText(order.address) || "",
      address_complete: (step.missing_fields || []).length === 0,
      is_bank_transfer: order.is_bank_transfer === true,
      pix_types_text: f.PIX_TYPES_TEXT,
    };
  });

  // ---------- 2. Motivos do produto escolhido ----------
  handle("reasons", async (flow, body) => {
    const prepared = await service.prepare(flow, body);
    if (!prepared.eligible) throw new ReverseError("ORDER_NOT_ELIGIBLE", { details: { ineligibility_message: prepared.ineligibility_message || undefined } });
    const kind = input.type(body.type);
    const orderItem = input.item(prepared, body);
    const reasons = input.reasonsFor(prepared, kind);

    return {
      next: reasons.length ? "continue" : "handoff",
      ...(reasons.length ? {} : { handoff_reason: "ERROR", message: "Não há motivos disponíveis para esta opção. Vou te encaminhar para um atendente." }),
      item_name: orderItem.description || orderItem.sku,
      item_max_quantity: Number(orderItem.quantity) || 1,
      reasons_count: reasons.length,
      reasons_text: f.reasonsText(reasons),
    };
  });

  // ---------- 3. Detalhes do motivo escolhido ----------
  handle("reason_detail", async (flow, body) => {
    const prepared = await service.prepare(flow, body);
    if (!prepared.eligible) throw new ReverseError("ORDER_NOT_ELIGIBLE", { details: { ineligibility_message: prepared.ineligibility_message || undefined } });
    const kind = input.type(body.type);
    input.item(prepared, body);
    const reason = input.reason(prepared, kind, body);
    const subs = Array.isArray(reason.sub_reasons) ? reason.sub_reasons : [];

    const result = {
      reason_name: reason.reason,
      goes_to_agent: reason.handoff === true,
      requires_photo: reason.has_image === true,
      photo_text: reason.image_text || "",
      has_sub_reasons: subs.length > 0,
      sub_reasons_count: subs.length,
      sub_reasons_text: subs.length ? f.subReasonsText(subs) : "",
      requires_comment: reason.has_comment === true,
    };
    // Fora do prazo vai para atendente; motivo com foto pede a foto (ou atendente, se as fotos estiverem desligadas)
    if (result.goes_to_agent) return { ...result, next: "handoff", handoff_reason: "REASON", message: BOT_MESSAGES.HANDOFF_REQUIRED };
    if (result.requires_photo) {
      if (!service.features(flow).photos) return { ...result, next: "handoff", handoff_reason: "PHOTO_REQUIRED", message: BOT_MESSAGES.PHOTO_UNAVAILABLE };
      // photo_token marca o momento do pedido: guardar e repassar nas próximas chamadas
      return { ...result, next: "photos", photo_text: reason.image_text || DEFAULT_PHOTO_TEXT, photo_token: signPhotoToken(flow) };
    }
    return result;
  });

  // ---------- 3b. Conferir as fotos recebidas ----------
  handle("photos", async (flow, body) => {
    const images = await customerImages(flow, body);
    if (images.length === 0) throw new ReverseError("PHOTO_REQUIRED", { field: "photos" });
    return { photos_count: images.length, max_photos: MAX_PER_ITEM };
  });

  // ---------- 4. Vale-compras (só devolução) ----------
  handle("retention", async (flow, body) => {
    const { prepared, sel, base } = await loadDecision(flow, body);
    if (sel.type !== "refund") return { available: false, mode: "none", needs_pix_if_declined: false };

    const offer = await service.retention(flow, base);
    const isBankTransfer = prepared.order?.is_bank_transfer === true;
    if (!offer.available || offer.mode === "none") {
      return { available: false, mode: "none", needs_pix_if_declined: isBankTransfer };
    }
    if (offer.mode === "automatic" || offer.mode === "forced") {
      return { available: true, mode: offer.mode, must_choose: false, offer_text: f.automaticRetentionText(offer), needs_pix_if_declined: false };
    }

    const offers = (offer.offers || []).filter((o) => o.level === 1 || o.level === 2).sort((a, b) => a.level - b.level);
    if (offers.length === 0) return { available: false, mode: "none", needs_pix_if_declined: isBankTransfer };
    const better = offers.find((o) => o.level === 2 && offers[0].level === 1);
    return {
      available: true,
      mode: "offer",
      must_choose: true,
      offer_text: f.offerText(offers[0]),
      offer_level: offers[0].level,
      has_better_offer: Boolean(better),
      better_offer_text: better ? f.offerText(better) : "",
      better_offer_level: better ? 2 : null,
      needs_pix_if_declined: isBankTransfer,
    };
  });

  // Cotação com a decisão atual (retenção aceita muda as opções)
  async function quoteFor(flow, decision, body) {
    const retention = input.retention(body, decision.sel.type);
    return service.quote(flow, { ...decision.base, retention_accepted: retention?.accepted === true, address: decision.address });
  }

  // ---------- 5. Formas de envio ----------
  handle("quote", async (flow, body) => {
    const decision = await loadDecision(flow, body);
    const quote = await quoteFor(flow, decision, body);
    if (quote.options.length === 0) {
      return { options_count: 0, options_text: "", message: "A loja vai definir a melhor forma de envio e mandar as instruções para o seu e-mail depois que a solicitação for registrada." };
    }
    return { options_count: quote.options.length, options_text: f.optionsText(quote.options) };
  });

  // Monta e confere a decisão completa (resumo e envio usam a mesma conta)
  async function buildFinal(flow, body) {
    const decision = await loadDecision(flow, body);
    const { prepared, sel, address } = decision;
    const kind = sel.type;

    // Mesmas validações do envio, antes de mostrar o resumo
    const needsPhotos = sel.reason.has_image === true;
    v.validateSelection(sel.items, prepared, { type: kind, imageUrlsBySku: needsPhotos ? { [sel.orderItem.sku]: ["pending"] } : {} });
    const addressConfirmed = input.yesNo(body.address_confirmed) === true;
    v.resolveAddress(address, prepared.address_step);

    const quote = await quoteFor(flow, decision, body);
    let option = null;
    if (quote.options.length > 0) option = quote.options[input.option(body.shipping_option, "shipping_option", quote.options.length)];

    let retention = input.retention(body, kind);
    let closesInCredit = false;
    if (kind === "refund") {
      const offerArgs = { ...decision.base };
      if (option) offerArgs.shipping_option_token = option.option_token;
      const offer = await service.retention(flow, offerArgs);
      closesInCredit = offer.available && (offer.mode === "automatic" || offer.mode === "forced");
      const mustChoose = offer.available && offer.mode === "offer" && (offer.offers || []).some((o) => o.level === 1 || o.level === 2);
      if (closesInCredit) retention = null;
      else if (mustChoose && !retention) throw new ReverseError("INVALID_INPUT", { field: "retention" });
      else if (!mustChoose && retention?.accepted) throw new ReverseError("RETENTION_NOT_AVAILABLE");
    }

    let paymentBill = null;
    if (kind === "refund" && prepared.order?.is_bank_transfer === true && retention?.accepted !== true && !closesInCredit) {
      paymentBill = input.paymentBill(body);
      if (!paymentBill) throw new ReverseError("INVALID_INPUT", { field: "payment_bill" });
    }

    const orderNumber = v.normalizeOrderNumber(body.order_number);
    const identifier = v.normalizeCustomerIdentifier(body.customer_identifier)?.value || "";
    const hash = decisionHash([flow.conversationId, orderNumber, identifier, kind, sel.items, address, retention, paymentBill, option ? option.name : null]);

    // Fotos: com photo_resume (nova tentativa), o serviço reaproveita as já enviadas
    let images = [];
    const photoResume = typeof body.photo_resume === "string" && body.photo_resume ? body.photo_resume : null;
    if (needsPhotos && !photoResume) {
      images = await customerImages(flow, body);
      if (images.length === 0) throw new ReverseError("PHOTO_REQUIRED", { field: "photos" });
    }

    return { decision, option, retention, closesInCredit, paymentBill, addressConfirmed, orderNumber, hash, needsPhotos, images, photoResume };
  }

  // ---------- 6. Resumo para o cliente confirmar ----------
  handle("summary", async (flow, body) => {
    const final = await buildFinal(flow, body);
    const { decision, option } = final;
    const token = signData("botconfirm", { c: flow.conversationId, h: final.hash, o: option ? option.option_token : null }, CONFIRMATION_TTL_S, now());

    return {
      summary_text: f.summaryText({
        type: decision.sel.type,
        orderNumber: final.orderNumber,
        orderItem: decision.sel.orderItem,
        quantity: decision.sel.quantity,
        reason: decision.sel.reason,
        subReason: decision.sel.subReason,
        comment: decision.sel.comment,
        option,
        addressConfirmed: final.addressConfirmed,
        address: decision.address,
        purchaseAddress: decision.prepared.order?.address,
        retention: final.retention,
        closesInCredit: final.closesInCredit,
        paymentBill: final.paymentBill,
        photosCount: final.needsPhotos ? final.images.length || null : null,
      }),
      // Repassar no submit, sem alterar
      confirmation_token: token,
    };
  });

  // ---------- 7. Registrar a solicitação ----------
  handle(
    "submit",
    async (flow, body) => {
      const data = verifyData("botconfirm", typeof body.confirmation_token === "string" ? body.confirmation_token : "", now());
      if (!data || data.c !== flow.conversationId) throw new ReverseError("CONFIRMATION_REQUIRED");

      const final = await buildFinal(flow, body);
      // O cliente confirmou exatamente este resumo?
      if (data.h !== final.hash) throw new ReverseError("CONFIRMATION_REQUIRED");

      const { decision, retention, paymentBill } = final;
      const submitBody = { ...decision.base };
      if (decision.address) submitBody.address = decision.address;
      if (retention) submitBody.retention = retention;
      if (paymentBill) submitBody.payment_bill = paymentBill;
      if (data.o) submitBody.shipping_option_token = data.o;

      // Fotos baixadas só agora, depois da confirmação; o upload e o ticket ficam com o serviço
      const photosByIndex = {};
      if (final.photoResume) submitBody.photo_resume = final.photoResume;
      else if (final.needsPhotos) photosByIndex[0] = await downloadImages(final.images);

      const result = await service.submit(flow, submitBody, { photosByIndex });
      const retentionAccepted = retention?.accepted === true;
      const shipping = result.shipping || {};

      return {
        next: "close",
        reverse_order_id: result.reverse_order_id || null,
        outcome: result.outcome || null,
        status: result.status || null,
        message: submitConfirmationMessage(result, { type: decision.sel.type, retentionAccepted, orderNumber: final.orderNumber }),
        carrier: shipping.carrier || null,
        posting_code: shipping.posting_code || null,
        posting_due_date: formatDate(shipping.posting_due_date),
        tracking_url: shipping.tracking_url || null,
        replayed: result.replayed === true,
      };
    },
    { limit: "submit" },
  );

  // ---------- Acompanhar ----------
  handle("track", async (flow, body) => {
    const result = await service.track(flow, body);
    const reverses = result.reverses || [];
    if (reverses.length === 0) {
      return { next: "close", reverses_count: 0, track_text: "", message: "Não encontramos solicitações de troca ou devolução para este pedido." };
    }
    return { next: "close", reverses_count: reverses.length, track_text: f.trackText(reverses) };
  });

  return router;
}

module.exports = { createBotRouter, botField };
