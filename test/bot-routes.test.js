// API do bot (WhatsApp): HTTP de ponta a ponta com o serviço real e o Troque falso
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { preparedOrder, createdReverse } = require("./fixtures");
const { createBotRouter, botField } = require("../routes/bot");
const { reverseErrorHandler } = require("../routes/reverse");
const { createReverseService } = require("../lib/reverse/service");
const { TroqueError } = require("../lib/troque");
const { setSink } = require("../lib/tracking");

const SECRET = "segredo-do-bot-de-teste";
const BASE_BODY = { conversation_id: "conv-bot-1", store: "underarmour", order_number: "#1000000000001-01", customer_identifier: "000.000.000-00" };
const EXCHANGE = { ...BASE_BODY, type: "troca", item_option: "1", reason_option: "1", sub_reason_option: "2" };

const SHIPPING = {
  shipping_options: [
    { shipping_company_id: 2, can_be_chosen: true, shipping_company_name: "Correios", is_collect: false, delivery_address_id: null, posting_address: null, posting_address_name: null, posting_address_opening_hours: null },
    { shipping_company_id: 3, can_be_chosen: true, shipping_company_name: "Coleta", is_collect: true, delivery_address_id: null, posting_address: null, posting_address_name: null, posting_address_opening_hours: null },
  ],
};

function fakeTroque(handlers) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`chamada inesperada: ${name}`);
      const result = typeof handler === "function" ? handler(args) : handler;
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
}

function fakeConversation() {
  const messages = [];
  return {
    messages,
    postText: async (id, text) => messages.push({ id, text }),
    postHandoff: async (id, text) => messages.push({ id, text, handoff: true }),
  };
}

async function start(t, handlers, { env = {} } = {}) {
  t.after(useFakeEnv({ BOT_API_SECRET: SECRET, ...env }));
  setSink(() => {});
  t.after(() => setSink(null));
  const troque = fakeTroque(handlers);
  const conversation = fakeConversation();
  const storage = { isEnabled: () => false, store: async () => ({}), addNote: async () => {} };
  const service = createReverseService({ troque, conversation, storage });

  const app = express();
  app.use(express.json());
  app.use(createBotRouter({ service }));
  app.use(reverseErrorHandler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(path, body, headers = { "X-Api-Secret": SECRET }) {
    const res = await fetch(`${base}/api/bot/reverse/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  return { post, troque, conversation };
}

test("sem BOT_API_SECRET a API fica desligada; segredo errado é 401", async (t) => {
  const off = await start(t, {}, { env: { BOT_API_SECRET: undefined } });
  assert.equal((await off.post("lookup", BASE_BODY)).status, 503);
});

test("segredo errado responde 401 sem chamar o Troque", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder() });
  const res = await api.post("lookup", BASE_BODY, { "X-Api-Secret": "errado" });
  assert.equal(res.status, 401);
  assert.equal(api.troque.calls.length, 0);
});

test("lookup devolve JSON plano com listas numeradas e sem dados pessoais", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder() });
  const { status, body } = await api.post("lookup", BASE_BODY);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.next, "continue");
  assert.equal(body.eligible, true);
  assert.equal(body.first_name, "Cliente");
  assert.equal(body.items_count, 2);
  assert.equal(body.items_text, "1 - Tênis Teste 40 (2 un.)\n2 - Meia Teste");
  assert.equal(body.item_2_name, "Meia Teste");
  assert.equal(body.address_mode, "confirm");
  assert.match(body.address_text, /Rua Exemplo, 100/);
  assert.equal(body.is_bank_transfer, false);
  assert.deepEqual(api.troque.calls[0].args, { ecommerce_number: "1000000000001-01", customer_identifier: "00000000000" });

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("Cliente Teste"));
  assert.ok(!raw.includes("token-falso"));
});

test("pedido não elegível encerra com a mensagem do Troque", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder({ eligible: false, ineligibility_code: "DEADLINE", ineligibility_message: "O prazo para troca terminou." }) });
  const { body } = await api.post("lookup", BASE_BODY);
  assert.equal(body.ok, true);
  assert.equal(body.eligible, false);
  assert.equal(body.next, "close");
  assert.equal(body.message, "O prazo para troca terminou.");
});

test("entrada inválida: HTTP 200, campo do bot e nenhuma chamada ao Troque", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder() });
  const { status, body } = await api.post("lookup", { ...BASE_BODY, customer_identifier: "123" });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: false, next: "fix_input", code: "INVALID_INPUT", field: "customer_identifier", message: "Confira o CPF, CNPJ ou e-mail usado na compra." });
  assert.equal(api.troque.calls.length, 0);

  const store = await api.post("lookup", { ...BASE_BODY, store: "adidas" });
  assert.equal(store.body.field, "store");
});

test("falha temporária do Troque vira next: retry, sem CPF no log", async (t) => {
  const api = await start(t, { prepare_reverse_order: () => new TroqueError("TEMPORARY_FAILURE") });
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });

  const { status, body } = await api.post("lookup", BASE_BODY);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.next, "retry");
  assert.equal(body.code, "TEMPORARY_FAILURE");
  assert.ok(logs.length > 0);
  assert.ok(!logs.join("\n").includes("00000000000"));
  assert.ok(!logs.join("\n").includes("000.000.000-00"));
});

test("motivos e detalhes: subopções, fora do prazo e foto vão para atendente", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder() });

  const reasons = await api.post("reasons", { ...BASE_BODY, type: "troca", item_option: 1 });
  assert.equal(reasons.body.reasons_count, 3);
  assert.equal(reasons.body.reasons_text, "1 - Não serviu\n2 - Defeito\n3 - Solicitação fora do prazo");
  assert.equal(reasons.body.item_max_quantity, 2);

  const fits = await api.post("reason_detail", { ...BASE_BODY, type: "troca", item_option: 1, reason_option: 1 });
  assert.equal(fits.body.next, "continue");
  assert.equal(fits.body.sub_reasons_text, "1 - Ficou grande\n2 - Ficou pequeno");
  assert.equal(fits.body.requires_comment, false);

  const photo = await api.post("reason_detail", { ...BASE_BODY, type: "troca", item_option: 1, reason_option: 2 });
  assert.equal(photo.body.next, "handoff");
  assert.equal(photo.body.handoff_reason, "PHOTO_REQUIRED");

  const late = await api.post("reason_detail", { ...BASE_BODY, type: "troca", item_option: 1, reason_option: 3 });
  assert.equal(late.body.next, "handoff");
  assert.equal(late.body.handoff_reason, "REASON");

  const bad = await api.post("reason_detail", { ...BASE_BODY, type: "troca", item_option: 1, reason_option: 9 });
  assert.equal(bad.body.field, "reason_option");
});

test("troca completa: cotação, resumo, confirmação e registro sem postar na conversa", async (t) => {
  const api = await start(t, {
    prepare_reverse_order: preparedOrder(),
    quote_return_shipping: SHIPPING,
    create_reverse_order: createdReverse(),
  });

  const quote = await api.post("quote", EXCHANGE);
  assert.equal(quote.body.options_count, 2);
  assert.match(quote.body.options_text, /^1 - Correios: você leva até um ponto de postagem\n2 - Coleta: coleta no endereço informado$/);

  // Sem escolher o envio, o resumo pede a opção
  const missing = await api.post("summary", EXCHANGE);
  assert.equal(missing.body.field, "shipping_option");

  const summary = await api.post("summary", { ...EXCHANGE, shipping_option: "1", address_confirmed: "sim" });
  assert.equal(summary.body.ok, true);
  assert.match(summary.body.summary_text, /Tipo: troca/);
  assert.match(summary.body.summary_text, /Motivo: Não serviu - Ficou pequeno/);
  assert.match(summary.body.summary_text, /Envio: Correios/);
  assert.equal(typeof summary.body.confirmation_token, "string");

  // Sem o token do resumo não cria
  const noToken = await api.post("submit", { ...EXCHANGE, shipping_option: "1" });
  assert.equal(noToken.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(noToken.body.next, "summary");

  // Mudou a escolha depois do resumo: pede nova confirmação
  const changed = await api.post("submit", { ...EXCHANGE, sub_reason_option: "1", shipping_option: "1", confirmation_token: summary.body.confirmation_token });
  assert.equal(changed.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(api.troque.calls.filter((c) => c.name === "create_reverse_order").length, 0);

  const done = await api.post("submit", { ...EXCHANGE, shipping_option: "1", confirmation_token: summary.body.confirmation_token });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.next, "close");
  assert.equal(done.body.reverse_order_id, "3137c99b-c4cf-46bd-b0ed-d21bd3824263");
  assert.equal(done.body.posting_code, "AP123456789BR");
  assert.equal(done.body.posting_due_date, "20/11/2026");
  assert.match(done.body.message, /Sua solicitação de troca do pedido 1000000000001-01 foi registrada/);

  const create = api.troque.calls.find((c) => c.name === "create_reverse_order");
  assert.deepEqual(create.args.items, [{ sku: "SKU-1", quantity: 1, is_exchange: true, reason: { description: "Não serviu", sub_reason: "Ficou pequeno" } }]);
  assert.deepEqual(create.args.shipping, { shipping_company_id: 2, is_collect: false });
  assert.equal(api.conversation.messages.length, 0);

  // Repetir o envio devolve a mesma solicitação, sem criar outra
  const again = await api.post("submit", { ...EXCHANGE, shipping_option: "1", confirmation_token: summary.body.confirmation_token });
  assert.equal(again.body.replayed, true);
  assert.equal(api.troque.calls.filter((c) => c.name === "create_reverse_order").length, 1);
});

test("devolução de pedido por transferência: decide o vale-compras e pede PIX", async (t) => {
  const order = preparedOrder();
  order.order.is_bank_transfer = true;
  const api = await start(t, {
    prepare_reverse_order: order,
    quote_return_shipping: SHIPPING,
    get_retention_offer: { available: true, mode: "offer", offers: [{ level: 1, bonus_value: 10, retained_value: 50, credit_value: 60 }], cancel_days: null },
    create_reverse_order: createdReverse({ outcome: "approved_with_shipping" }),
  });
  const refund = { ...BASE_BODY, type: "devolução", item_option: 1, reason_option: 1, sub_reason_option: 1, shipping_option: 1 };

  const retention = await api.post("retention", refund);
  assert.equal(retention.body.must_choose, true);
  assert.equal(retention.body.offer_text, "Em vez do reembolso, você pode receber um vale-compras de R$ 60,00 (com R$ 10,00 de bônus) para usar na loja.");
  assert.equal(retention.body.needs_pix_if_declined, true);

  const noDecision = await api.post("summary", refund);
  assert.equal(noDecision.body.field, "retention_accepted");

  const noPix = await api.post("summary", { ...refund, retention_accepted: "não" });
  assert.equal(noPix.body.field, "pix_key");

  const summary = await api.post("summary", { ...refund, retention_accepted: "não", pix_type: "1", pix_key: "000.000.000-00" });
  assert.equal(summary.body.ok, true);
  assert.match(summary.body.summary_text, /Reembolso: PIX \(CPF ou CNPJ: \*+0000\)/);
  assert.doesNotMatch(summary.body.summary_text, /\b00000000000\b/);

  const done = await api.post("submit", { ...refund, retention_accepted: "não", pix_type: "1", pix_key: "000.000.000-00", confirmation_token: summary.body.confirmation_token });
  assert.equal(done.body.ok, true);
  const create = api.troque.calls.find((c) => c.name === "create_reverse_order");
  assert.deepEqual(create.args.payment_bill, { is_pix: true, pix_type: "CPF ou CNPJ", pix_key: "00000000000" });
  assert.deepEqual(create.args.retention, { accepted: false });
});

test("motivo com foto não chega a cotar nem criar", async (t) => {
  const api = await start(t, { prepare_reverse_order: preparedOrder() });
  const { body } = await api.post("summary", { ...BASE_BODY, type: "troca", item_option: 1, reason_option: 2, sub_reason_option: 1, comment: "x", shipping_option: 1 });
  assert.equal(body.next, "handoff");
  assert.equal(body.handoff_reason, "PHOTO_REQUIRED");
  assert.deepEqual(
    api.troque.calls.map((c) => c.name),
    ["prepare_reverse_order"],
  );
});

test("acompanhamento devolve texto pronto", async (t) => {
  const api = await start(t, {
    track_reverse_order: {
      reverses: [
        {
          id: "r1",
          ecommerce_number: "1000000000001-01",
          status_name: "Aguardando envio",
          created_at: "2026-11-01",
          items: [{ sku: "SKU-1", description: "Tênis Teste 40", quantity: 1, is_exchange: true }],
          shipment: { carrier: "Correios", posting_code: "AP1", posting_due_date: "2026-11-20", posted_at: null },
          store_credit: null,
          refund: null,
        },
      ],
    },
  });
  const { body } = await api.post("track", BASE_BODY);
  assert.equal(body.reverses_count, 1);
  assert.equal(body.next, "close");
  assert.match(body.track_text, /Situação: Aguardando envio/);
  assert.match(body.track_text, /Código de postagem: AP1/);
  assert.match(body.track_text, /Postar até: 20\/11\/2026/);
});

test("JSON malformado responde no formato do bot", async (t) => {
  const api = await start(t, {});
  const res = await api.post("lookup", "{nao-e-json");
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("campos do serviço viram os campos que o bot envia", () => {
  assert.equal(botField("items[0].reason"), "reason_option");
  assert.equal(botField("items[0].sub_reason"), "sub_reason_option");
  assert.equal(botField("address.zipcode"), "address_zipcode");
  assert.equal(botField("address.description"), "address_complement");
  assert.equal(botField("payment_bill.pix_type"), "pix_type");
  assert.equal(botField("payment_bill"), "pix_key");
  assert.equal(botField("retention"), "retention_accepted");
});
