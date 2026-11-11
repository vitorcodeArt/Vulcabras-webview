// ======================================================
// SERVIÇO DO FLUXO DE TROCA E DEVOLUÇÃO
// ======================================================
// Cada método recebe a sessão validada (flow) e o corpo da requisição, chama o
// Troque com o token da marca da sessão e devolve só o que a tela precisa.
//
// O servidor não guarda o fluxo: o navegador reenvia pedido e identificador a
// cada chamada. Estado em memória só para proteção (tentativas, envio em
// andamento, resultado recente para clique duplo). Em mais de uma instância,
// trocar por Redis.

const { createTroqueClient } = require("../troque");
const { createConversationClient } = require("../zendesk/conversation");
const { signData, verifyData } = require("../session");
const { track, hashOrderNumber } = require("../tracking");
const { ReverseError } = require("./errors");
const v = require("./validation");
const { mapPrepare, mapRetention, mapQuote, mapCreate, mapTrack } = require("./mappers");
const { createZendeskAttachmentStorage } = require("../storage/zendeskAttachments");
const { buildTicketBody, buildResultNote } = require("./ticket");
const { submitConfirmationMessage, trackFinishedMessage, handoffMessage, HANDOFF_REASONS } = require("./messages");

const MAX_NOT_FOUND = 5;
const NOT_FOUND_WINDOW_MS = 30 * 60 * 1000;
const COMPLETED_TTL_MS = 30 * 60 * 1000;
const FINISH_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const SHIPPING_TOKEN_TTL_S = 60 * 60;
const PHOTO_RESUME_TTL_S = 60 * 60;
// Marcador usado na validação antes do upload (a URL real vem do armazenamento)
const PENDING_PHOTO = "pending";
const STORE_DROPOFF_ID = 6;
const MAX_MAP_SIZE = 5000;

function createReverseService({
  troque = createTroqueClient(),
  conversation = createConversationClient(),
  storage = createZendeskAttachmentStorage(),
  now = () => Date.now(),
} = {}) {
  const notFoundAttempts = new Map(); // conversationId -> { count, resetAt }
  const inFlight = new Set(); // conversationId com envio em andamento
  const completed = new Map(); // conversationId:pedido -> { result, expiresAt }
  const finished = new Map(); // conversationId -> expiresAt
  const handedOff = new Map(); // conversationId -> expiresAt

  // Evita crescimento sem limite dos mapas em memória
  function prune(map) {
    if (map.size < MAX_MAP_SIZE) return;
    const time = now();
    for (const [key, value] of map) {
      const expiresAt = typeof value === "number" ? value : value.expiresAt ?? value.resetAt;
      if (expiresAt <= time) map.delete(key);
    }
    if (map.size >= MAX_MAP_SIZE) map.clear();
  }

  function context(flow, step) {
    return { sessionId: flow.sessionId, conversationId: flow.conversationId, brand: flow.store, step };
  }

  function emit(flow, step, event, data = {}) {
    track({ event, step, session_id: flow.sessionId, conversation_id: flow.conversationId, brand: flow.store, ...data });
  }

  function checkAttempts(flow) {
    const entry = notFoundAttempts.get(flow.conversationId);
    if (!entry) return;
    if (entry.resetAt <= now()) {
      notFoundAttempts.delete(flow.conversationId);
      return;
    }
    if (entry.count >= MAX_NOT_FOUND) throw new ReverseError("TOO_MANY_ATTEMPTS");
  }

  function registerNotFound(flow) {
    prune(notFoundAttempts);
    const entry = notFoundAttempts.get(flow.conversationId);
    if (entry && entry.resetAt > now()) entry.count += 1;
    else notFoundAttempts.set(flow.conversationId, { count: 1, resetAt: now() + NOT_FOUND_WINDOW_MS });
  }

  async function call(flow, step, tool, args) {
    if (!flow.brand || !flow.brand.troqueToken) throw new ReverseError("BRAND_NOT_CONFIGURED");
    checkAttempts(flow);
    try {
      return await troque.callTool(tool, args, { token: flow.brand.troqueToken, context: context(flow, step) });
    } catch (error) {
      if (error.code === "ORDER_NOT_FOUND") registerNotFound(flow);
      throw error;
    }
  }

  function identityArgs(id) {
    return { ecommerce_number: id.orderNumber, customer_identifier: id.identifier };
  }

  function signShippingOption(flow, contextHash) {
    return (option) =>
      signData(
        "ship",
        {
          c: flow.conversationId,
          h: contextHash,
          id: option.shipping_company_id,
          col: option.is_collect === true,
          addr: option.delivery_address_id || null,
        },
        SHIPPING_TOKEN_TTL_S,
        now(),
      );
  }

  // Lê o token da opção de envio e confere se vale para esta conversa e decisão
  function readShippingOption(flow, token, contextHash) {
    const data = verifyData("ship", token, now());
    if (!data || data.c !== flow.conversationId || (contextHash && data.h !== contextHash)) {
      throw new ReverseError("QUOTE_EXPIRED");
    }
    return data;
  }

  // Token para nova tentativa sem reenviar fotos nem criar outro ticket
  function signPhotoResume(flow, orderNumber, stored) {
    return signData("photos", { c: flow.conversationId, o: orderNumber, t: stored.ticketId, u: stored.urlsBySku }, PHOTO_RESUME_TTL_S, now());
  }

  // Só vale para a mesma conversa e pedido, e se cobrir todos os itens com foto
  function readPhotoResume(flow, token, orderNumber, imageSkus) {
    if (!token) return null;
    const data = verifyData("photos", token, now());
    if (!data || data.c !== flow.conversationId || data.o !== orderNumber || !data.u || typeof data.u !== "object") return null;
    const covers = imageSkus.every((sku) => Array.isArray(data.u[sku]) && data.u[sku].length > 0 && data.u[sku].every((u) => typeof u === "string" && /^https:\/\//.test(u)));
    return covers ? { ticketId: data.t, urlsBySku: data.u } : null;
  }

  // Fotos recebidas por índice do item -> por SKU (só itens que exigem foto)
  function photosBySkuFrom(items, photosByIndex, imageSkus) {
    const result = {};
    for (const [index, photos] of Object.entries(photosByIndex || {})) {
      const sku = items[Number(index)]?.sku;
      if (sku && imageSkus.includes(sku)) result[sku] = photos;
    }
    return result;
  }

  // ---------- Etapa 1: identificar o pedido ----------
  async function prepare(flow, body) {
    const id = v.parseIdentification(body);
    const raw = await call(flow, "identify", "prepare_reverse_order", identityArgs(id));
    const result = mapPrepare(raw);

    emit(flow, "identify", "step_completed", {
      meta: {
        order_hash: hashOrderNumber(id.orderNumber),
        id_kind: id.identifierKind,
        eligible: result.eligible,
        ineligibility_code: result.ineligibility_code,
        reasons: result.reasons.length,
        existing_reverses: result.existing_reverses.length,
        step_mode: result.address_step?.mode || null,
      },
    });

    return result;
  }

  // ---------- Retenção (só devolução) ----------
  async function retention(flow, body) {
    const id = v.parseIdentification(body);
    const type = v.parseType(body.type);
    if (type !== "refund") return mapRetention({ available: false });

    const items = v.parseItemsShape(body.items);
    const args = {
      ...identityArgs(id),
      items: items.map((i) => ({ sku: i.sku, quantity: i.quantity, is_exchange: false, reason_description: i.reason })),
    };

    // Depois de RETENTION_OFFER_CHANGED: consulta de novo com a opção de envio escolhida
    if (body.shipping_option_token) {
      args.shipping_company_id = readShippingOption(flow, body.shipping_option_token, null).id;
    }

    const raw = await call(flow, "retention", "get_retention_offer", args);
    return mapRetention(raw);
  }

  // ---------- Cotação do envio ----------
  async function quote(flow, body) {
    const id = v.parseIdentification(body);
    const type = v.parseType(body.type);
    const items = v.parseItemsShape(body.items);
    const retentionAccepted = type === "refund" && body.retention_accepted === true;
    const address = body.address === undefined || body.address === null ? null : v.parseFullAddress(body.address);

    const args = {
      ...identityArgs(id),
      items: items.map((i) => ({ sku: i.sku, quantity: i.quantity, is_exchange: type === "exchange", reason: { description: i.reason } })),
      retention_accepted: retentionAccepted,
    };
    if (address) args.address = address;

    const raw = await call(flow, "shipping", "quote_return_shipping", args);
    const contextHash = v.quoteContextHash({ orderNumber: id.orderNumber, type, items, retentionAccepted, address });
    return mapQuote(raw, signShippingOption(flow, contextHash));
  }

  // ---------- Acompanhar ----------
  async function trackReverse(flow, body) {
    const id = v.parseIdentification(body);
    const raw = await call(flow, "track", "track_reverse_order", identityArgs(id));
    const result = mapTrack(raw);
    emit(flow, "track", "step_completed", { meta: { order_hash: hashOrderNumber(id.orderNumber), reverses: result.reverses.length } });
    return result;
  }

  // ---------- Criação da reversa ----------
  // options.photosByIndex: fotos recebidas no multipart, por índice do item
  async function submit(flow, body, options = {}) {
    const id = v.parseIdentification(body);
    const type = v.parseType(body.type);
    const completedKey = `${flow.conversationId}:${id.orderNumber}`;

    // Clique duplo ou nova tentativa depois de sucesso: devolve o mesmo resultado
    const previous = completed.get(completedKey);
    if (previous && previous.expiresAt > now()) return { ...previous.result, replayed: true };

    if (inFlight.has(flow.conversationId)) throw new ReverseError("SUBMIT_IN_PROGRESS");
    inFlight.add(flow.conversationId);

    try {
      // Relê o pedido: a validação usa a lista de motivos e itens atual
      const prepared = await call(flow, "submit", "prepare_reverse_order", identityArgs(id));
      if (!prepared.eligible) {
        throw new ReverseError("ORDER_NOT_ELIGIBLE", {
          details: { ineligibility_message: prepared.ineligibility_message || undefined, ineligibility_code: prepared.ineligibility_code || undefined },
        });
      }

      // Valida os itens; as fotos entram depois, só se tudo estiver certo
      const placeholders = Object.fromEntries((Array.isArray(body.items) ? body.items : []).map((i) => [i?.sku, [PENDING_PHOTO]]));
      const selection = v.validateSelection(body.items, prepared, { type, imageUrlsBySku: placeholders });
      const imageSkus = selection.filter((i) => Array.isArray(i.reason.image_url)).map((i) => i.sku);

      let stored = null;
      let photosBySku = {};
      if (imageSkus.length > 0) {
        if (!storage.isEnabled(flow.brand)) throw new ReverseError("PHOTO_UNAVAILABLE");
        stored = readPhotoResume(flow, body.photo_resume, id.orderNumber, imageSkus);
        if (!stored) {
          photosBySku = photosBySkuFrom(body.items, options.photosByIndex, imageSkus);
          const missing = imageSkus.find((sku) => !photosBySku[sku] || photosBySku[sku].length === 0);
          if (missing) {
            const index = body.items.findIndex((i) => i.sku === missing);
            throw new ReverseError("PHOTO_REQUIRED", { field: `items[${index}].photos` });
          }
        }
      }
      const address = v.resolveAddress(body.address, prepared.address_step);
      const customer = v.resolveCustomer(body.customer, prepared.address_step?.missing_customer_fields);
      const retentionDecision = v.resolveRetention(body.retention, type);
      const retentionAccepted = retentionDecision?.accepted === true;

      // Opção de envio: precisa ter vindo da cotação desta mesma decisão
      let shipping = null;
      if (body.shipping_option_token) {
        const contextHash = v.quoteContextHash({
          orderNumber: id.orderNumber,
          type,
          items: selection.map((i) => ({ sku: i.sku, quantity: i.quantity, reason: i.reason.description })),
          retentionAccepted,
          address,
        });
        const option = readShippingOption(flow, body.shipping_option_token, contextHash);
        shipping = { shipping_company_id: option.id, is_collect: option.col };
        if (option.id === STORE_DROPOFF_ID) {
          if (!option.addr) throw new ReverseError("QUOTE_EXPIRED");
          shipping.organisation_address_id = option.addr;
        }
      }

      // Dados de reembolso: pedido pago por transferência, com devolução sem vale-compras
      let paymentBill = null;
      if (prepared.order?.is_bank_transfer === true && type === "refund" && !retentionAccepted) {
        if (body.payment_bill) {
          paymentBill = v.resolvePaymentBill(body.payment_bill);
        } else {
          // Na retenção automática a devolução fecha em vale-compras: não há reembolso
          const offerArgs = {
            ...identityArgs(id),
            items: selection.map((i) => ({ sku: i.sku, quantity: i.quantity, is_exchange: false, reason_description: i.reason.description })),
          };
          // Entrega em loja física pode fechar em vale-compras ("forced")
          if (shipping) offerArgs.shipping_company_id = shipping.shipping_company_id;
          const offer = await call(flow, "submit", "get_retention_offer", offerArgs);
          const closesInCredit = offer.available && (offer.mode === "automatic" || offer.mode === "forced");
          if (!closesInCredit) throw new ReverseError("INVALID_INPUT", { field: "payment_bill" });
        }
      }

      // Fotos: upload + ticket juntos, só agora (depois de validar tudo)
      if (imageSkus.length > 0 && !stored) {
        const ticketBody = buildTicketBody({
          flow,
          orderNumber: id.orderNumber,
          identifierKind: id.identifierKind,
          customer: prepared.order?.customer,
          type,
          selection,
          photoCountBySku: Object.fromEntries(Object.entries(photosBySku).map(([sku, list]) => [sku, list.length])),
        });
        const startedAt = now();
        try {
          stored = await storage.store({ brandKey: flow.store, ticketBody, photosBySku });
        } catch (error) {
          console.error(`Troca/Devolução: falha ao enviar fotos/criar ticket (${error.code || "erro"}${error.httpStatus ? ` ${error.httpStatus}` : ""})`);
          emit(flow, "submit", "api_call", { duration_ms: now() - startedAt, error_code: error.code || "PHOTO_UPLOAD_FAILED", meta: { service: "zendesk", ok: false } });
          throw new ReverseError("PHOTO_UPLOAD_FAILED");
        }
        emit(flow, "submit", "ticket_created", {
          duration_ms: now() - startedAt,
          meta: { ticket_id: stored.ticketId, photos: Object.values(photosBySku).reduce((n, list) => n + list.length, 0) },
        });
      }
      for (const item of selection) {
        if (stored && Array.isArray(item.reason.image_url)) item.reason.image_url = stored.urlsBySku[item.sku].slice(0, 10);
      }

      const args = {
        confirm: true,
        ...identityArgs(id),
        items: selection.map(({ productDescription, ...item }) => item),
        language: "pt-BR",
      };
      if (address) args.address = address;
      if (customer) args.customer = customer;
      if (shipping) args.shipping = shipping;
      if (retentionDecision) args.retention = retentionDecision;
      if (paymentBill) args.payment_bill = paymentBill;

      const existingIds = new Set((prepared.existing_reverses || []).map((r) => r.id));
      let result;
      try {
        result = await createWithConfirmation(flow, id, args, existingIds);
      } catch (error) {
        if (stored) {
          // A nova tentativa reaproveita o ticket e as URLs, sem reenviar fotos
          error.details = { ...(error.details || {}), photo_resume: signPhotoResume(flow, id.orderNumber, stored) };
          await addTicketNote(stored.ticketId, buildResultNote({ errorCode: error.code }));
        }
        throw error;
      }
      if (stored) await addTicketNote(stored.ticketId, buildResultNote({ result }));

      emit(flow, "submit", "reverse_created", {
        meta: {
          outcome: result.outcome,
          type,
          items: selection.length,
          retention_accepted: retentionAccepted,
          shipping_company_id: shipping ? shipping.shipping_company_id : null,
          reverse_order_id: result.reverse_order_id || null,
          ticket_id: stored ? stored.ticketId : null,
          order_hash: hashOrderNumber(id.orderNumber),
        },
      });

      // Mensagem de confirmação na conversa (falha aqui não desfaz a reversa)
      const text = submitConfirmationMessage(result, { type, retentionAccepted, orderNumber: id.orderNumber });
      result.message_posted = await postMessage(flow, "submit", text);

      emit(flow, "submit", "completed", { meta: { outcome: result.outcome } });

      prune(completed);
      completed.set(completedKey, { result, expiresAt: now() + COMPLETED_TTL_MS });
      return result;
    } finally {
      inFlight.delete(flow.conversationId);
    }
  }

  // Cria a reversa. Resposta incerta: confere existing_reverses antes de desistir,
  // sem nunca repetir a criação.
  async function createWithConfirmation(flow, id, args, existingIds) {
    try {
      const raw = await call(flow, "submit", "create_reverse_order", args);
      return mapCreate(raw);
    } catch (error) {
      if (error.code === "CREATED_WITH_ERRORS") {
        return { reverse_order_id: error.details?.reverse_order_id || null, outcome: "registered", status: null, shipping: null };
      }
      if (error.code !== "CREATION_UNCONFIRMED") throw error;

      let recheck;
      try {
        recheck = await call(flow, "submit", "prepare_reverse_order", identityArgs(id));
      } catch {
        throw new ReverseError("CREATION_UNCONFIRMED");
      }
      const created = (recheck.existing_reverses || []).find((r) => r.id && !existingIds.has(r.id));
      if (!created) throw new ReverseError("CREATION_UNCONFIRMED");

      return { reverse_order_id: created.id, outcome: "registered", status: created.status_name || null, shipping: null };
    }
  }

  // Nota interna no ticket (melhor esforço: não muda o resultado do fluxo)
  async function addTicketNote(ticketId, body) {
    try {
      await storage.addNote(ticketId, body);
    } catch (error) {
      console.error(`Troca/Devolução: falha ao anotar o ticket ${ticketId} (${error.code || "erro"})`);
    }
  }

  async function postMessage(flow, step, text) {
    try {
      await conversation.postText(flow.conversationId, text);
      return true;
    } catch (error) {
      console.error(`Troca/Devolução: falha ao postar mensagem na conversa (${error.code || error.response?.status || "erro"})`);
      emit(flow, step, "error_shown", { error_code: "MESSAGE_NOT_POSTED" });
      return false;
    }
  }

  // ---------- Fim do fluxo de acompanhamento ----------
  async function finish(flow, body) {
    if (body.flow !== "track") throw new ReverseError("INVALID_INPUT", { field: "flow" });

    const expiresAt = finished.get(flow.conversationId);
    if (expiresAt && expiresAt > now()) return { message_posted: true, replayed: true };

    const posted = await postMessage(flow, "track", trackFinishedMessage());
    if (posted) {
      prune(finished);
      finished.set(flow.conversationId, now() + FINISH_TTL_MS);
    }
    emit(flow, "track", "completed", { meta: { flow: "track" } });
    return { message_posted: posted };
  }

  // ---------- Transferência para atendente ----------
  // Posta na conversa a mensagem com o botão que o bot do Ultimate reconhece.
  // body: { reason: REASON | PHOTO_REQUIRED | NOT_FOUND | ERROR | CUSTOMER_REQUEST, error_code?, step?, order_number? }
  async function handoff(flow, body) {
    const reason = HANDOFF_REASONS.includes(body.reason) ? body.reason : null;
    if (!reason) throw new ReverseError("INVALID_INPUT", { field: "reason" });

    const errorCode = typeof body.error_code === "string" && /^[A-Z_]{1,40}$/.test(body.error_code) ? body.error_code : null;
    const step = typeof body.step === "string" && /^[a-z_]{1,30}$/.test(body.step) ? body.step : null;
    // Número do pedido é opcional (o cliente pode não ter chegado a informar)
    const orderNumber = body.order_number ? v.normalizeOrderNumber(body.order_number) : null;

    const expiresAt = handedOff.get(flow.conversationId);
    if (expiresAt && expiresAt > now()) return { message_posted: true, replayed: true };

    let posted = false;
    try {
      await conversation.postHandoff(flow.conversationId, handoffMessage(reason, { orderNumber }));
      posted = true;
      prune(handedOff);
      handedOff.set(flow.conversationId, now() + HANDOFF_TTL_MS);
    } catch (error) {
      console.error(`Troca/Devolução: falha ao postar transferência na conversa (${error.code || error.response?.status || "erro"})`);
    }

    emit(flow, step || "handoff", "handoff_requested", {
      error_code: errorCode,
      meta: { handoff_reason: reason, message_posted: posted, order_hash: orderNumber ? hashOrderNumber(orderNumber) : null },
    });

    return { message_posted: posted };
  }

  // Recursos disponíveis para a marca da sessão (a tela de foto depende disso)
  function features(flow) {
    return { photos: storage.isEnabled(flow.brand) };
  }

  return { prepare, retention, quote, track: trackReverse, submit, finish, handoff, features };
}

module.exports = { createReverseService };
