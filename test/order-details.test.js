const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { preparedOrder, createdReverse, IDENTITY } = require("./fixtures");
const { createReverseService } = require("../lib/reverse/service");
const { saveOrderDetails, selectedItems, publicImageUrl, typedOrderNumber } = require("../lib/order-details");
const { setSink } = require("../lib/tracking");
const { getBrand } = require("../lib/brands");

const SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ORDER = "1000000000001-01";
const ITEM = { sku: "SKU-1", quantity: 1, reason: "Não serviu", sub_reason: "Ficou pequeno" };
const EXPECTED_ITEM = { title: "Tênis Teste 40", sku: "SKU-1", size: null, image_url: "https://exemplo.com/a.jpg" };

test.beforeEach((t) => {
  t.restoreEnv = useFakeEnv();
  setSink(() => {});
});
test.afterEach((t) => {
  t.restoreEnv();
  setSink(null);
});

function setup(handlers) {
  const saved = [];
  const orders = { selectedItems, saveOrderDetails: async (data) => saved.push(data) };
  const troque = { callTool: async (name) => (typeof handlers[name] === "function" ? handlers[name]() : handlers[name]) };
  const conversation = { postText: async () => ({}), postHandoff: async () => ({}) };
  const contacts = { rememberTroqueName: async () => false };
  const service = createReverseService({ troque, conversation, orders, contacts });
  return { service, saved };
}

const flow = (extra = {}) => ({ conversationId: "conv1", store: "underarmour", brand: getBrand("underarmour"), sessionId: SESSION, sendId: "s1", ...extra });

test("só entram os produtos selecionados, com os campos do contrato", () => {
  const items = selectedItems(preparedOrder().order.items, [{ sku: "SKU-1" }, { sku: "SKU-1" }, { sku: "NAO-EXISTE" }]);
  assert.deepEqual(items, [EXPECTED_ITEM]);
  assert.deepEqual(selectedItems(undefined, [{ sku: "SKU-1" }]), []);
});

test("imagem: só https pública, sem token nem dado do cliente", () => {
  assert.equal(publicImageUrl("https://exemplo.com/a.jpg?v=123"), "https://exemplo.com/a.jpg?v=123");
  for (const url of ["http://exemplo.com/a.jpg", "data:image/png;base64,AA", "https://u:p@exemplo.com/a.jpg", "https://exemplo.com/a.jpg?token=x", "https://exemplo.com/a.jpg?X-Amz-Signature=x", "https://exemplo.com/a.jpg?email=a%40b.com", "nada", null]) {
    assert.equal(publicImageUrl(url), null, String(url));
  }
});

test("prepare grava o número digitado e depois o confirma; a cotação grava os itens escolhidos", async () => {
  const { service, saved } = setup({ prepare_reverse_order: preparedOrder(), quote_return_shipping: { shipping_options: [] } });
  await service.prepare(flow(), IDENTITY);
  const base = { sessionId: SESSION, sendId: "s1", conversationId: "conv1", orderNumber: ORDER, items: [] };
  assert.deepEqual(saved, [{ ...base, verified: false }, { ...base, verified: true }]);

  await service.quote(flow(), { ...IDENTITY, type: "exchange", items: [ITEM] });
  assert.deepEqual(saved[2].items, [EXPECTED_ITEM]);
  assert.equal(saved[2].verified, true);
  const fields = ["conversationId", "items", "orderNumber", "sendId", "sessionId", "verified"];
  assert.ok(saved.every((row) => Object.keys(row).sort().join() === fields.join()), "identificação do cliente nunca é gravada");
});

test("retenção também grava os itens, mesmo que o Troque falhe", async () => {
  const { service, saved } = setup({
    prepare_reverse_order: preparedOrder(),
    get_retention_offer: () => {
      throw Object.assign(new Error("x"), { code: "TEMPORARY" });
    },
  });
  await service.prepare(flow(), IDENTITY);
  await assert.rejects(service.retention(flow(), { ...IDENTITY, type: "refund", items: [ITEM] }));
  assert.deepEqual(saved.at(-1).items, [EXPECTED_ITEM]);
});

test("envio grava os itens mesmo sem prepare em memória", async () => {
  const { service, saved } = setup({ prepare_reverse_order: preparedOrder(), create_reverse_order: createdReverse() });
  await service.submit(flow(), { ...IDENTITY, type: "exchange", items: [ITEM] });
  assert.deepEqual(saved[0].items, [EXPECTED_ITEM]);
});

test("bot (sem sessão de webview) não grava", async () => {
  const bot = setup({ prepare_reverse_order: preparedOrder(), quote_return_shipping: { shipping_options: [] } });
  await bot.service.prepare(flow({ sessionId: null, channel: "bot" }), IDENTITY);
  await bot.service.quote(flow({ sessionId: null }), { ...IDENTITY, type: "exchange", items: [ITEM] });
  assert.equal(bot.saved.length, 0);
});

const notFound = () => {
  throw Object.assign(new Error("x"), { code: "ORDER_NOT_FOUND" });
};

test("pedido não encontrado grava o número digitado como não confirmado, na troca e na consulta", async () => {
  const missing = setup({ prepare_reverse_order: notFound, track_reverse_order: notFound });
  await assert.rejects(missing.service.prepare(flow(), IDENTITY));
  await assert.rejects(missing.service.track(flow(), IDENTITY));
  assert.equal(missing.saved.length, 2);
  assert.ok(missing.saved.every((row) => row.verified === false && row.orderNumber === ORDER && row.items.length === 0));
});

test("o que parece CPF, CNPJ ou a própria identificação não é gravado", async () => {
  const missing = setup({ prepare_reverse_order: notFound });
  for (const order_number of ["12345678900", "123.456.789-00", "12345678000190", "cpf12345678900"]) {
    await assert.rejects(missing.service.prepare(flow(), { ...IDENTITY, order_number }));
  }
  assert.equal(missing.saved.length, 0);

  assert.equal(typedOrderNumber("PED-11122233344", "11122233344"), null);
  assert.equal(typedOrderNumber("", "11122233344"), null);
  // números de pedido de verdade continuam passando
  for (const order of ["1000000000001-01", "1000000000001", "4911233", "UABR-VT-1000000000001-01"]) {
    assert.equal(typedOrderNumber(order, "11122233344"), order);
  }
});

test("antes da migração 005: pedido confirmado grava sem a coluna; não confirmado é ignorado", async (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  const calls = [];
  const db = {
    getPool: () => ({}),
    query: async (text, params) => {
      calls.push({ text, params });
      if (text.includes("verified")) throw Object.assign(new Error("x"), { code: "42703" });
    },
  };
  const data = { sessionId: SESSION, conversationId: "conv1", orderNumber: ORDER };
  assert.equal(await saveOrderDetails(data, { db }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.length, 5);
  assert.equal(await saveOrderDetails({ ...data, verified: false }, { db }), false);
  assert.equal(calls.length, 3);
});

test("gravação: parametrizada, best-effort e sem valores no log", async (t) => {
  const logs = [];
  const original = console.error;
  console.error = (m) => logs.push(String(m));
  t.after(() => (console.error = original));

  const calls = [];
  const db = { getPool: () => ({}), query: async (text, params) => calls.push({ text, params }) };
  const data = { sessionId: SESSION, conversationId: "conv1", orderNumber: ORDER, items: [EXPECTED_ITEM] };
  assert.equal(await saveOrderDetails(data, { db }), true);
  assert.ok(!calls[0].text.includes(ORDER));
  assert.equal(calls[0].params[3], ORDER);

  assert.equal(await saveOrderDetails(data, { db: { getPool: () => null } }), false);
  const failing = { getPool: () => ({}), query: async () => { throw Object.assign(new Error(ORDER), { code: "42P01" }); } };
  assert.equal(await saveOrderDetails(data, { db: failing }), false);
  assert.ok(logs.length === 1 && !logs[0].includes(ORDER));
});
