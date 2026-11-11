const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { preparedOrder, createdReverse, IDENTITY } = require("./fixtures");
const { createReverseService } = require("../lib/reverse/service");
const { TroqueError } = require("../lib/troque");
const { setSink } = require("../lib/tracking");
const { getBrand } = require("../lib/brands");

// Troque falso: handlers por ferramenta (função ou fila de respostas)
function fakeTroque(handlers) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args, options) => {
      calls.push({ name, args, options });
      let handler = handlers[name];
      if (Array.isArray(handler)) handler = handler.shift();
      if (!handler) throw new Error(`chamada inesperada: ${name}`);
      const result = typeof handler === "function" ? handler(args) : handler;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeConversation({ fail = false } = {}) {
  const messages = [];
  return {
    messages,
    postText: async (conversationId, text) => {
      if (fail) throw Object.assign(new Error("x"), { code: "ZENDESK_NOT_CONFIGURED" });
      messages.push({ conversationId, text });
      return { messageId: "m1" };
    },
    postHandoff: async (conversationId, text) => {
      if (fail) throw Object.assign(new Error("x"), { code: "ZENDESK_NOT_CONFIGURED" });
      messages.push({ conversationId, text, handoff: true });
      return { messageId: "m2" };
    },
  };
}

function flow(overrides = {}) {
  return {
    conversationId: "conv1",
    store: "underarmour",
    brand: getBrand("underarmour"),
    sessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    ...overrides,
  };
}

const EXCHANGE_BODY = {
  ...IDENTITY,
  type: "exchange",
  items: [{ sku: "SKU-1", quantity: 1, reason: "Não serviu", sub_reason: "Ficou pequeno" }],
};

test.beforeEach((t) => {
  t.restoreEnv = useFakeEnv();
  setSink(() => {});
});
test.afterEach((t) => {
  t.restoreEnv();
  setSink(null);
});

test("prepare normaliza a entrada e devolve só o necessário", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder() });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  const result = await service.prepare(flow(), IDENTITY);

  assert.deepEqual(troque.calls[0].args, { ecommerce_number: "1000000000001-01", customer_identifier: "00000000000" });
  assert.equal(troque.calls[0].options.token, "token-falso-underarmour");
  assert.equal(result.order.customer.first_name, "Cliente");
  assert.equal(result.order.status, undefined);
  assert.equal(result.order.price, undefined);
  assert.equal(result.reasons.find((r) => r.reason === "Solicitação fora do prazo").handoff, true);
  assert.equal(result.reasons.find((r) => r.reason === "Defeito").handoff, false);
});

test("entrada inválida não chama o Troque", async () => {
  const troque = fakeTroque({});
  const service = createReverseService({ troque, conversation: fakeConversation() });
  await assert.rejects(service.prepare(flow(), { order_number: "1", customer_identifier: "12" }), { code: "INVALID_INPUT", field: "customer_identifier" });
  assert.equal(troque.calls.length, 0);
});

test("marca sem token do Troque responde BRAND_NOT_CONFIGURED", async () => {
  const service = createReverseService({ troque: fakeTroque({}), conversation: fakeConversation() });
  await assert.rejects(service.prepare(flow({ store: "mizuno", brand: getBrand("mizuno") }), IDENTITY), { code: "BRAND_NOT_CONFIGURED" });
});

test("após 5 ORDER_NOT_FOUND na conversa, bloqueia novas tentativas", async () => {
  const notFound = () => new TroqueError("ORDER_NOT_FOUND");
  const troque = fakeTroque({ prepare_reverse_order: notFound });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(service.prepare(flow(), IDENTITY), { code: "ORDER_NOT_FOUND" });
  }
  await assert.rejects(service.prepare(flow(), IDENTITY), { code: "TOO_MANY_ATTEMPTS" });
  assert.equal(troque.calls.length, 5);

  // Outra conversa não é afetada
  await assert.rejects(service.prepare(flow({ conversationId: "conv2" }), IDENTITY), { code: "ORDER_NOT_FOUND" });
});

test("retenção só é consultada em devolução", async () => {
  const troque = fakeTroque({ get_retention_offer: { available: true, mode: "offer", blocked_reason: null, offers: [{ level: 1, bonus_type: "fixed", bonus_config_value: 10, bonus_value: 10, retained_value: 50, credit_value: 60 }], cancel_days: null } });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  assert.deepEqual(await service.retention(flow(), EXCHANGE_BODY), { available: false, mode: "none", offers: [], cancel_days: null });
  assert.equal(troque.calls.length, 0);

  const result = await service.retention(flow(), { ...EXCHANGE_BODY, type: "refund" });
  assert.deepEqual(troque.calls[0].args.items, [{ sku: "SKU-1", quantity: 1, is_exchange: false, reason_description: "Não serviu" }]);
  assert.equal(result.offers[0].credit_value, 60);
  assert.equal(result.blocked_reason, undefined);
});

test("cotação devolve só opções escolhíveis, com token assinado", async () => {
  const troque = fakeTroque({
    quote_return_shipping: {
      shipping_options: [
        { shipping_company_id: 2, can_be_chosen: true, shipping_company_name: "Correios", is_collect: false, is_paid_collect: false, fee_amount: null, delivery_address_id: null, posting_address: null, posting_address_name: null, posting_address_opening_hours: null },
        { shipping_company_id: 5, can_be_chosen: false, shipping_company_name: "Coleta paga", is_collect: true, is_paid_collect: true, fee_amount: 2490, delivery_address_id: null, posting_address: null, posting_address_name: null, posting_address_opening_hours: null },
      ],
    },
  });
  const service = createReverseService({ troque, conversation: fakeConversation() });
  const result = await service.quote(flow(), EXCHANGE_BODY);

  assert.equal(troque.calls[0].args.retention_accepted, false);
  assert.deepEqual(troque.calls[0].args.items, [{ sku: "SKU-1", quantity: 1, is_exchange: true, reason: { description: "Não serviu" } }]);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].name, "Correios");
  assert.equal(typeof result.options[0].option_token, "string");
  assert.equal(result.has_store_only_options, true);
});

// Faz a cotação e devolve o token da primeira opção
async function quoteToken(service, body, options) {
  const quote = await service.quote(flow(), body);
  return quote.options[0].option_token;
}

function correiosQuote() {
  return { shipping_options: [{ shipping_company_id: 2, can_be_chosen: true, shipping_company_name: "Correios", is_collect: false, is_paid_collect: false, fee_amount: null, delivery_address_id: null, posting_address: null, posting_address_name: null, posting_address_opening_hours: null }] };
}

test("submit: troca completa com envio cotado e mensagem na conversa", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder(), quote_return_shipping: correiosQuote(), create_reverse_order: createdReverse() });
  const conversation = fakeConversation();
  const service = createReverseService({ troque, conversation });

  const token = await quoteToken(service, EXCHANGE_BODY);
  const result = await service.submit(flow(), { ...EXCHANGE_BODY, shipping_option_token: token });

  const create = troque.calls.find((c) => c.name === "create_reverse_order").args;
  assert.deepEqual(create, {
    confirm: true,
    ecommerce_number: "1000000000001-01",
    customer_identifier: "00000000000",
    items: [{ sku: "SKU-1", quantity: 1, is_exchange: true, reason: { description: "Não serviu", sub_reason: "Ficou pequeno" } }],
    language: "pt-BR",
    shipping: { shipping_company_id: 2, is_collect: false },
  });

  assert.equal(result.outcome, "approved_with_shipping");
  assert.equal(result.shipping.posting_code, "AP123456789BR");
  assert.equal(result.next_step, undefined);
  assert.equal(result.message_posted, true);
  assert.match(conversation.messages[0].text, /troca do pedido 1000000000001-01 foi registrada/);
  assert.match(conversation.messages[0].text, /Faça a postagem até 20\/11\/2026/);
});

test("submit: token de envio de outra decisão é recusado (QUOTE_EXPIRED)", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder(), quote_return_shipping: correiosQuote() });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  const token = await quoteToken(service, EXCHANGE_BODY);
  // Cliente mudou a quantidade depois de cotar
  const body = { ...EXCHANGE_BODY, items: [{ ...EXCHANGE_BODY.items[0], quantity: 2 }], shipping_option_token: token };
  await assert.rejects(service.submit(flow(), body), { code: "QUOTE_EXPIRED" });

  // Token de outra conversa
  await assert.rejects(service.submit(flow({ conversationId: "conv2" }), { ...EXCHANGE_BODY, shipping_option_token: token }), { code: "QUOTE_EXPIRED" });
  assert.ok(!troque.calls.some((c) => c.name === "create_reverse_order"));
});

test("submit: motivo de atendente e motivo com foto não criam nada", async () => {
  const troque = fakeTroque({ prepare_reverse_order: () => preparedOrder() });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  await assert.rejects(service.submit(flow(), { ...EXCHANGE_BODY, items: [{ sku: "SKU-1", quantity: 1, reason: "Solicitação fora do prazo", comment: "x" }] }), { code: "HANDOFF_REQUIRED" });
  await assert.rejects(service.submit(flow(), { ...EXCHANGE_BODY, items: [{ sku: "SKU-1", quantity: 1, reason: "Defeito", sub_reason: "Meu produto descolou", comment: "x" }] }), { code: "PHOTO_UNAVAILABLE" });
  assert.ok(!troque.calls.some((c) => c.name === "create_reverse_order"));
});

test("submit: pedido não elegível devolve a mensagem pronta do Troque", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder({ eligible: false, ineligibility_code: "expiredExchangeReturnDeadlines", ineligibility_message: "O prazo para troca expirou.", reasons: [] }) });
  const service = createReverseService({ troque, conversation: fakeConversation() });
  await assert.rejects(service.submit(flow(), EXCHANGE_BODY), (error) => {
    assert.equal(error.code, "ORDER_NOT_ELIGIBLE");
    assert.equal(error.details.ineligibility_message, "O prazo para troca expirou.");
    return true;
  });
});

test("submit: CREATION_UNCONFIRMED confere existing_reverses e não repete a criação", async () => {
  const created = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status_name: "Em Análise", created_at: "2026-11-11T12:00:00Z", items: [] };
  const troque = fakeTroque({
    prepare_reverse_order: [preparedOrder(), preparedOrder({ existing_reverses: [created] })],
    create_reverse_order: () => new TroqueError("CREATION_UNCONFIRMED", { created: null }),
  });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  const result = await service.submit(flow(), EXCHANGE_BODY);
  assert.equal(result.outcome, "registered");
  assert.equal(result.reverse_order_id, created.id);
  assert.equal(troque.calls.filter((c) => c.name === "create_reverse_order").length, 1);
});

test("submit: CREATION_UNCONFIRMED sem reversa nova continua incerto", async () => {
  const troque = fakeTroque({
    prepare_reverse_order: [preparedOrder(), preparedOrder()],
    create_reverse_order: () => new TroqueError("CREATION_UNCONFIRMED", { created: null }),
  });
  const conversation = fakeConversation();
  const service = createReverseService({ troque, conversation });
  await assert.rejects(service.submit(flow(), EXCHANGE_BODY), { code: "CREATION_UNCONFIRMED" });
  assert.equal(conversation.messages.length, 0);
});

test("submit: CREATED_WITH_ERRORS é tratado como sucesso", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder(), create_reverse_order: () => new TroqueError("CREATED_WITH_ERRORS", { created: true }) });
  const service = createReverseService({ troque, conversation: fakeConversation() });
  const result = await service.submit(flow(), EXCHANGE_BODY);
  assert.equal(result.outcome, "registered");
});

test("submit: clique duplo devolve o mesmo resultado sem criar de novo", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const troque = fakeTroque({
    prepare_reverse_order: async () => {
      await gate;
      return preparedOrder();
    },
    create_reverse_order: createdReverse(),
  });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  const first = service.submit(flow(), EXCHANGE_BODY);
  await assert.rejects(service.submit(flow(), EXCHANGE_BODY), { code: "SUBMIT_IN_PROGRESS" });
  release();
  await first;

  const again = await service.submit(flow(), EXCHANGE_BODY);
  assert.equal(again.replayed, true);
  assert.equal(troque.calls.filter((c) => c.name === "create_reverse_order").length, 1);
});

test("submit: falha ao postar na conversa não desfaz a reversa", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const troque = fakeTroque({ prepare_reverse_order: preparedOrder(), create_reverse_order: createdReverse() });
    const service = createReverseService({ troque, conversation: fakeConversation({ fail: true }) });
    const result = await service.submit(flow(), EXCHANGE_BODY);
    assert.equal(result.reverse_order_id, "3137c99b-c4cf-46bd-b0ed-d21bd3824263");
    assert.equal(result.message_posted, false);
  } finally {
    console.error = originalError;
  }
});

test("submit: devolução com transferência exige dados de reembolso (salvo retenção automática)", async () => {
  const refundBody = { ...IDENTITY, type: "refund", items: [{ sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "Não quero mais" }] };
  const bankOrder = () => preparedOrder({ order: { ...preparedOrder().order, is_bank_transfer: true } });

  // Sem dados e com retenção do tipo oferta: pede os dados
  let troque = fakeTroque({ prepare_reverse_order: bankOrder, get_retention_offer: { available: true, mode: "offer", offers: [] } });
  let service = createReverseService({ troque, conversation: fakeConversation() });
  await assert.rejects(service.submit(flow(), refundBody), { code: "INVALID_INPUT", field: "payment_bill" });

  // Retenção automática: segue sem dados bancários
  troque = fakeTroque({ prepare_reverse_order: bankOrder, get_retention_offer: { available: true, mode: "automatic", offers: [] }, create_reverse_order: createdReverse() });
  service = createReverseService({ troque, conversation: fakeConversation() });
  await service.submit(flow(), refundBody);
  assert.equal(troque.calls.find((c) => c.name === "create_reverse_order").args.payment_bill, undefined);

  // Com PIX: envia payment_bill
  troque = fakeTroque({ prepare_reverse_order: bankOrder, create_reverse_order: createdReverse() });
  service = createReverseService({ troque, conversation: fakeConversation() });
  await service.submit(flow({ conversationId: "conv3" }), { ...refundBody, payment_bill: { is_pix: true, pix_type: "Chave aleatória", pix_key: "abc-123" }, retention: { accepted: false } });
  const args = troque.calls.find((c) => c.name === "create_reverse_order").args;
  assert.deepEqual(args.payment_bill, { is_pix: true, pix_type: "Chave aleatória", pix_key: "abc-123" });
  assert.deepEqual(args.retention, { accepted: false });
});

test("submit: retenção aceita não pede dados bancários e não muda is_exchange", async () => {
  const troque = fakeTroque({ prepare_reverse_order: preparedOrder({ order: { ...preparedOrder().order, is_bank_transfer: true } }), create_reverse_order: createdReverse() });
  const conversation = fakeConversation();
  const service = createReverseService({ troque, conversation });
  await service.submit(flow(), { ...IDENTITY, type: "refund", items: [{ sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "x" }], retention: { accepted: true, level: 1 } });

  const args = troque.calls.find((c) => c.name === "create_reverse_order").args;
  assert.equal(args.items[0].is_exchange, false);
  assert.deepEqual(args.retention, { accepted: true, level: 1 });
  assert.match(conversation.messages[0].text, /devolução \(com vale-compras\)/);
});

test("submit: endereço obrigatório quando faltam campos e enviado quando informado", async () => {
  const order = preparedOrder({ address_step: { mode: "confirm", missing_fields: ["number"], missing_customer_fields: ["email"] } });
  const troque = fakeTroque({ prepare_reverse_order: () => order, create_reverse_order: createdReverse() });
  const service = createReverseService({ troque, conversation: fakeConversation() });

  await assert.rejects(service.submit(flow(), EXCHANGE_BODY), { code: "INVALID_INPUT", field: "address" });

  const address = { zipcode: "01000000", street: "Rua Exemplo", number: "100", neighborhood: "Centro", city: "São Paulo", state: "SP" };
  await service.submit(flow(), { ...EXCHANGE_BODY, address, customer: { email: "cliente@exemplo.com" } });
  const args = troque.calls.find((c) => c.name === "create_reverse_order").args;
  assert.deepEqual(args.address, address);
  assert.deepEqual(args.customer, { email: "cliente@exemplo.com" });
});

test("track e finish", async () => {
  const troque = fakeTroque({
    track_reverse_order: { reverses: [{ id: "r1", ecommerce_number: "1", status_id: 2, status_name: "Aguardando Envio", created_at: null, replacement_order_number: null, items: [], shipment: null, store_credit: null, refund: null }] },
  });
  const conversation = fakeConversation();
  const service = createReverseService({ troque, conversation });

  const result = await service.track(flow(), IDENTITY);
  assert.equal(result.reverses[0].status_name, "Aguardando Envio");
  assert.equal(result.reverses[0].shipment, null);

  assert.deepEqual(await service.finish(flow(), { flow: "track" }), { message_posted: true });
  assert.equal((await service.finish(flow(), { flow: "track" })).replayed, true);
  assert.equal(conversation.messages.length, 1);
  await assert.rejects(service.finish(flow(), { flow: "outro" }), { code: "INVALID_INPUT" });
});

test("handoff: posta a mensagem com botão uma vez e registra o evento sem dados pessoais", async () => {
  const records = [];
  setSink((record) => records.push(record));
  const conversation = fakeConversation();
  const service = createReverseService({ troque: fakeTroque({}), conversation });

  const result = await service.handoff(flow(), { reason: "REASON", error_code: "HANDOFF_REQUIRED", step: "reasons", order_number: "# 1000-01" });
  assert.deepEqual(result, { message_posted: true });
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].handoff, true);
  assert.match(conversation.messages[0].text, /Pedido: 1000-01\./);

  // Clique repetido não posta de novo
  assert.equal((await service.handoff(flow(), { reason: "REASON" })).replayed, true);
  assert.equal(conversation.messages.length, 1);

  const event = records.find((r) => r.event === "handoff_requested");
  assert.equal(event.step, "reasons");
  assert.equal(event.error_code, "HANDOFF_REQUIRED");
  assert.equal(event.meta.handoff_reason, "REASON");
  assert.ok(!JSON.stringify(event).includes("1000-01"));
});

test("handoff: motivo inválido é recusado e falha ao postar devolve message_posted false", async () => {
  const service = createReverseService({ troque: fakeTroque({}), conversation: fakeConversation({ fail: true }) });
  await assert.rejects(service.handoff(flow(), { reason: "QUALQUER" }), { code: "INVALID_INPUT" });
  assert.deepEqual(await service.handoff(flow(), { reason: "ERROR", error_code: "minúsculo inválido" }), { message_posted: false });
});

// ---------- Fotos (Fase 3) ----------

function fakeStorage({ enabled = true, fail = false } = {}) {
  const stored = [];
  const notes = [];
  return {
    stored,
    notes,
    isEnabled: () => enabled,
    store: async (input) => {
      if (fail) throw Object.assign(new Error("x"), { code: "ZENDESK_REQUEST_FAILED" });
      stored.push(input);
      const urlsBySku = {};
      for (const [sku, list] of Object.entries(input.photosBySku)) urlsBySku[sku] = list.map((_, i) => `https://exemplo.zendesk.com/attachments/token/abc/?name=${sku}-${i + 1}.jpg`);
      return { ticketId: 555, urlsBySku };
    },
    addNote: async (ticketId, body) => notes.push({ ticketId, body }),
  };
}

const PHOTO_BODY = { ...EXCHANGE_BODY, items: [{ sku: "SKU-1", quantity: 1, reason: "Defeito", sub_reason: "Meu produto descolou", comment: "Descolou a sola" }] };
const JPEG = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), mime: "image/jpeg" };

test("submit com foto: exige foto, cria ticket, envia image_url e anota o resultado", async () => {
  const troque = fakeTroque({ prepare_reverse_order: () => preparedOrder(), create_reverse_order: createdReverse() });
  const storage = fakeStorage();
  const service = createReverseService({ troque, conversation: fakeConversation(), storage });

  await assert.rejects(service.submit(flow(), PHOTO_BODY, { photosByIndex: {} }), { code: "PHOTO_REQUIRED", field: "items[0].photos" });
  assert.equal(storage.stored.length, 0);

  const result = await service.submit(flow(), PHOTO_BODY, { photosByIndex: { 0: [JPEG, JPEG] } });
  assert.equal(result.outcome, "approved_with_shipping");

  const ticket = storage.stored[0];
  assert.match(ticket.ticketBody, /Pedido: 1000000000001-01/);
  assert.match(ticket.ticketBody, /Fotos anexadas: 2/);
  assert.match(ticket.ticketBody, /Documento: 000\*{5}000/); // só o documento mascarado
  assert.doesNotMatch(ticket.ticketBody, /\b00000000000\b/); // nunca o documento digitado

  const create = troque.calls.find((c) => c.name === "create_reverse_order");
  assert.equal(create.args.items[0].reason.image_url.length, 2);
  assert.match(create.args.items[0].reason.image_url[0], /^https:\/\//);
  assert.equal(storage.notes.length, 1);
  assert.match(storage.notes[0].body, /Resultado no Troque/);
});

test("submit com foto: falha na criação devolve photo_resume e a nova tentativa não reenvia fotos", async () => {
  const troque = fakeTroque({
    prepare_reverse_order: () => preparedOrder(),
    create_reverse_order: [new TroqueError("VALIDATION_FAILED"), createdReverse()],
  });
  const storage = fakeStorage();
  const service = createReverseService({ troque, conversation: fakeConversation(), storage });

  let resume;
  await assert.rejects(service.submit(flow(), PHOTO_BODY, { photosByIndex: { 0: [JPEG] } }), (error) => {
    resume = error.details.photo_resume;
    return error.code === "VALIDATION_FAILED";
  });
  assert.ok(resume);
  assert.match(storage.notes[0].body, /não foi criada/);

  // Token de outra conversa não vale
  await assert.rejects(service.submit(flow({ conversationId: "conv2" }), { ...PHOTO_BODY, photo_resume: resume }), { code: "PHOTO_REQUIRED" });

  const result = await service.submit(flow(), { ...PHOTO_BODY, photo_resume: resume });
  assert.equal(result.outcome, "approved_with_shipping");
  assert.equal(storage.stored.length, 1); // um único ticket
});

test("submit com foto: falha no Zendesk vira PHOTO_UPLOAD_FAILED sem criar reversa", async () => {
  const troque = fakeTroque({ prepare_reverse_order: () => preparedOrder() });
  const service = createReverseService({ troque, conversation: fakeConversation(), storage: fakeStorage({ fail: true }) });
  await assert.rejects(service.submit(flow(), PHOTO_BODY, { photosByIndex: { 0: [JPEG] } }), { code: "PHOTO_UPLOAD_FAILED" });
  assert.ok(!troque.calls.some((c) => c.name === "create_reverse_order"));
});

test("features: fotos conforme o armazenamento", () => {
  assert.deepEqual(createReverseService({ troque: fakeTroque({}), conversation: fakeConversation(), storage: fakeStorage() }).features(flow()), { photos: true });
  assert.deepEqual(createReverseService({ troque: fakeTroque({}), conversation: fakeConversation(), storage: fakeStorage({ enabled: false }) }).features(flow()), { photos: false });
});
