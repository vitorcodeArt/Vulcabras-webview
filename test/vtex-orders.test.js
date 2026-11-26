const test = require("node:test");
const assert = require("node:assert/strict");
const { createVtexOrders, mapOrder, omsHost, orderIdCandidates } = require("../lib/vtex-orders");

// Resposta FICTÍCIA no formato da VTEX, com os campos pessoais que NÃO podem sair
const PERSONAL = [
  "Cliente Ficticio",
  "11122233344",
  "cliente@exemplo.invalid",
  "11900000000",
  "Rua Inventada",
  "00000-000",
  "999999",
  "4321",
  "CHAVE-NOTA-FICTICIA",
  "<xml>nota</xml>",
  "CAMPANHA_INTERNA",
  "SEGREDO-NOVO",
];
const raw = () => ({
  orderId: "1000000000001-01",
  status: "invoiced",
  statusDescription: "Faturado",
  value: 12685,
  creationDate: "2026-10-21T19:08:27.680+00:00",
  invoicedDate: "2026-10-22T01:32:19.142+00:00",
  campoNovoDaVtex: "SEGREDO-NOVO",
  totals: [
    { id: "Items", value: 17999 },
    { id: "Discounts", value: -6300 },
    { id: "Shipping", value: 986 },
  ],
  clientProfileData: { firstName: "Cliente Ficticio", document: "11122233344", email: "cliente@exemplo.invalid", phone: "11900000000" },
  followUpEmail: "cliente@exemplo.invalid",
  shippingData: {
    address: { receiverName: "Cliente Ficticio", street: "Rua Inventada", postalCode: "00000-000" },
    logisticsInfo: [{ deliveryCompany: "Transportadora Demo", selectedSla: "Normal", shippingEstimateDate: "2026-10-28T19:08:38+00:00" }],
  },
  paymentData: { transactions: [{ payments: [{ paymentSystemName: "Mastercard", installments: 2, firstDigits: "999999", lastDigits: "4321", billingAddress: { street: "Rua Inventada" } }] }] },
  packageAttachment: {
    packages: [
      {
        courier: "Transportadora Demo",
        trackingNumber: "DEMO123BR",
        trackingUrl: "https://rastreio.exemplo.invalid/#/tracking?codigo=DEMO123BR",
        invoiceKey: "CHAVE-NOTA-FICTICIA",
        embeddedInvoice: "<xml>nota</xml>",
        courierStatus: { deliveredDate: "2026-10-27T09:51:00+00:00", data: [{ city: "Rua Inventada" }] },
      },
    ],
  },
  ratesAndBenefitsData: { rateAndBenefitsIdentifiers: [{ name: "CAMPANHA_INTERNA" }] },
  itemMetadata: { Items: [{ Id: "58", SkuName: "40 Preto" }] },
  items: [
    {
      id: "58",
      name: "Tênis Demo",
      refId: "0000000-001-40",
      quantity: 1,
      sellingPrice: 11699,
      listPrice: 24999,
      imageUrl: "https://demo.vteximg.com.br/arquivos/ids/401785-55-55/foto.jpg?v=1",
    },
  ],
});

const STORES = {
  mizuno: { apiKey: "chave-m", apiToken: "token-m", storeUrl: "mizunobr.vtexcommercestable.com.br" },
  olympikus: { apiKey: "chave-o", apiToken: "token-o", storeUrl: "olympikus.vtexcommercestable.com.br" },
  underarmour: { storeUrl: "underarmourbr.vtexcommercestable.com.br" },
};

function client(responses, { stores = STORES, env = {}, now } = {}) {
  const calls = [];
  const http = {
    get: async (url, config) => {
      calls.push({ url, config });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { vtex: createVtexOrders({ getStores: () => stores, env, http, now }), calls };
}

function quiet(t) {
  const logs = [];
  const original = console.error;
  console.error = (m) => logs.push(String(m));
  t.after(() => (console.error = original));
  return logs;
}

test("só sai a lista fechada de campos: nenhum dado pessoal, cartão, nota ou campo novo", () => {
  const order = mapOrder(raw());
  const serialized = JSON.stringify(order);
  for (const value of PERSONAL) assert.ok(!serialized.includes(value), `vazou: ${value}`);
  assert.deepEqual(Object.keys(order).sort(), ["created_at", "invoiced_at", "items", "order_id", "packages", "payments", "shipping", "status", "status_label", "totals"]);
  assert.deepEqual(order.totals, { items_cents: 17999, discounts_cents: -6300, shipping_cents: 986, total_cents: 12685 });
  assert.deepEqual(order.items, [
    {
      name: "Tênis Demo",
      variation: "40 Preto",
      ref_id: "0000000-001-40",
      quantity: 1,
      price_cents: 11699,
      list_price_cents: 24999,
      image_url: "https://demo.vteximg.com.br/arquivos/ids/401785-200-200/foto.jpg?v=1",
    },
  ]);
  assert.deepEqual(order.payments, [{ method: "Mastercard", installments: 2 }]);
  assert.equal(order.packages[0].tracking_number, "DEMO123BR");
  assert.equal(order.packages[0].delivered_at, "2026-10-27T09:51:00.000Z");
  assert.equal(order.shipping.courier, "Transportadora Demo");
});

test("resposta incompleta não quebra; link e imagem inseguros são descartados", () => {
  const empty = mapOrder({});
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.packages, []);
  assert.equal(empty.totals.total_cents, null);
  const unsafe = mapOrder({ items: [{ imageUrl: "http://x.invalid/a.jpg" }], packageAttachment: { packages: [{ trackingUrl: "javascript:alert(1)" }] } });
  assert.equal(unsafe.items[0].image_url, null);
  assert.equal(unsafe.packages[0].tracking_url, null);
});

test("endereço de pedidos por marca: Mizuno usa mizunobrio; só aceita host da VTEX", () => {
  assert.equal(omsHost("mizuno", STORES.mizuno, {}), "mizunobrio.vtexcommercestable.com.br");
  assert.equal(omsHost("olympikus", STORES.olympikus, {}), "olympikus.vtexcommercestable.com.br");
  assert.equal(omsHost("mizuno", STORES.mizuno, { VTEX_MIZUNO_OMS_URL: "https://outra.vtexcommercestable.com.br/api" }), "outra.vtexcommercestable.com.br");
  assert.equal(omsHost("olympikus", { storeUrl: "atacante.invalid" }, {}), null);
  assert.equal(omsHost("olympikus", { storeUrl: "x.vtexcommercestable.com.br.atacante.invalid" }, {}), null);
});

test("formatos do número: com prefixo, sem o -01 e entrada inválida", () => {
  assert.deepEqual(orderIdCandidates("1000000000001-01"), ["1000000000001-01"]);
  assert.deepEqual(orderIdCandidates("1000000000001"), ["1000000000001", "1000000000001-01"]);
  assert.deepEqual(orderIdCandidates("UABR-VT-1000000000001-01"), ["UABR-VT-1000000000001-01", "1000000000001-01"]);
  for (const bad of ["../x", "1/2/3", "a b", "123", "x".repeat(61), null]) assert.deepEqual(orderIdCandidates(bad), [], String(bad));
});

test("consulta com as chaves da marca, tenta o formato seguinte e guarda em cache", async () => {
  let time = 0;
  const { vtex, calls } = client([{ status: 404 }, { status: 200, data: raw() }, { status: 200, data: raw() }], { now: () => time });
  const first = await vtex.lookup("mizuno", "1000000000001");
  assert.equal(first.reason, null);
  assert.equal(first.order.order_id, "1000000000001-01");
  assert.equal(calls[0].url, "https://mizunobrio.vtexcommercestable.com.br/api/oms/pvt/orders/1000000000001");
  assert.equal(calls[1].url, "https://mizunobrio.vtexcommercestable.com.br/api/oms/pvt/orders/1000000000001-01");
  assert.equal(calls[1].config.headers["X-VTEX-API-AppKey"], "chave-m");
  assert.equal(calls[1].config.maxRedirects, 0);

  await vtex.lookup("mizuno", "1000000000001");
  assert.equal(calls.length, 2, "segunda consulta veio do cache");
  time += 6 * 60 * 1000;
  await vtex.lookup("mizuno", "1000000000001");
  assert.equal(calls.length, 3);
});

test("falhas viram motivo, sem número do pedido nem chave no log", async (t) => {
  const logs = quiet(t);
  const cases = [
    [[{ status: 404 }], "not_found"],
    [[{ status: 403 }], "forbidden"],
    [[{ status: 500, data: "erro 1000000000001-01" }], "unavailable"],
    [[Object.assign(new Error("1000000000001-01 chave-o"), { code: "ECONNABORTED" })], "unavailable"],
  ];
  for (const [responses, reason] of cases) {
    const { vtex } = client(responses);
    assert.deepEqual(await vtex.lookup("olympikus", "1000000000001-01"), { order: null, reason });
  }
  assert.ok(logs.length === 3 && logs.every((l) => !l.includes("1000000000001") && !l.includes("chave-o")));
});

test("falha temporária não fica em cache", async (t) => {
  quiet(t);
  const { vtex, calls } = client([{ status: 502 }, { status: 200, data: raw() }]);
  assert.equal((await vtex.lookup("olympikus", "1000000000001-01")).reason, "unavailable");
  assert.equal((await vtex.lookup("olympikus", "1000000000001-01")).reason, null);
  assert.equal(calls.length, 2);
});

test("marca sem chaves ou desconhecida não faz requisição", async () => {
  const { vtex, calls } = client([]);
  assert.equal((await vtex.lookup("underarmour", "1000000000001-01")).reason, "not_configured");
  assert.equal((await vtex.lookup("outra", "1000000000001-01")).reason, "not_configured");
  assert.equal(calls.length, 0);
});
