const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { buildRecord, sanitizeMeta, maskSensitive, track, setSink, ingestClientEvents, hashOrderNumber } = require("../lib/tracking");

const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("monta o registro com os campos do modelo", () => {
  const record = buildRecord(
    { event: "api_call", step: "identify", session_id: SESSION_ID, conversation_id: "conv1", brand: "mizuno", seq: 3, duration_ms: 812.4, meta: { tool: "prepare_reverse_order", ok: true } },
    { now: new Date("2026-11-11T12:00:00Z") },
  );
  assert.deepEqual(record, {
    kind: "flow_event",
    ts: "2026-11-11T12:00:00.000Z",
    source: "server",
    session_id: SESSION_ID,
    send_id: null,
    flow: null,
    conversation_id: "conv1",
    brand: "mizuno",
    seq: 3,
    step: "identify",
    event: "api_call",
    duration_ms: 812,
    error_code: null,
    meta: { tool: "prepare_reverse_order", ok: true },
  });
});

test("ignora evento desconhecido", () => {
  assert.equal(buildRecord({ event: "qualquer" }), null);
});

test("meta descarta chaves com dado pessoal e valores complexos", () => {
  const meta = sanitizeMeta({
    cpf: "12345678900",
    customer_email: "x@y.z",
    customerName: "Fulano",
    pix_key: "abc",
    zip: "01000000",
    client_comment: "texto",
    reason: "Defeito",
    items: 2,
    nested: { a: 1 },
    list: [1],
  });
  assert.deepEqual(meta, { reason: "Defeito", items: 2 });
  assert.equal(sanitizeMeta({ cpf: "1" }), undefined);
  assert.equal(sanitizeMeta("texto"), undefined);
});

test("campos de texto fora do padrão viram null; só o error_code vira UNKNOWN_ERROR para não perder o erro", () => {
  const record = buildRecord({ event: "step_viewed", step: "endereço com espaço", error_code: "x".repeat(80), session_id: "nao-uuid" });
  assert.equal(record.step, null);
  assert.equal(record.error_code, "UNKNOWN_ERROR");
  assert.equal(record.session_id, null);
});

test("track usa o sink e nunca lança", (t) => {
  const records = [];
  setSink((r) => records.push(r));
  t.after(() => setSink(null));

  assert.equal(track({ event: "completed" }), true);
  assert.equal(records.length, 1);

  setSink(() => {
    throw new Error("falha no sink");
  });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  assert.equal(track({ event: "completed" }), false);
});

test("eventos do navegador usam conversa e marca da sessão", (t) => {
  const records = [];
  setSink((r) => records.push(r));
  t.after(() => setSink(null));

  const flow = { sessionId: SESSION_ID, conversationId: "conv-real", store: "underarmour" };
  const result = ingestClientEvents(
    [
      { event: "step_viewed", step: "items", conversation_id: "conv-falsa", brand: "mizuno" },
      { event: "invalido" },
      null,
    ],
    flow,
  );

  assert.deepEqual(result, { accepted: 1, rejected: 2 });
  assert.equal(records[0].conversation_id, "conv-real");
  assert.equal(records[0].brand, "underarmour");
  assert.equal(records[0].source, "client");
  assert.deepEqual(ingestClientEvents("x", flow), { accepted: 0, rejected: 0 });
});

test("limita o tamanho do lote do navegador", (t) => {
  setSink(() => {});
  t.after(() => setSink(null));
  const events = Array.from({ length: 60 }, () => ({ event: "step_viewed" }));
  assert.deepEqual(ingestClientEvents(events, { sessionId: null, conversationId: "c", store: "mizuno" }), { accepted: 50, rejected: 10 });
});

test("hash do pedido é estável e depende do sal", (t) => {
  t.after(useFakeEnv());
  const a = hashOrderNumber("1664284820905-01");
  assert.equal(a, hashOrderNumber("1664284820905-01"));
  assert.equal(a.length, 32);
  assert.ok(!a.includes("1664284820905"));

  process.env.FLOW_HASH_SALT = "outro-sal";
  assert.notEqual(hashOrderNumber("1664284820905-01"), a);

  delete process.env.FLOW_HASH_SALT;
  assert.equal(hashOrderNumber("1664284820905-01"), null);
});

test("maskSensitive esconde e-mail, link, números longos e códigos opacos, e mantém códigos legíveis", () => {
  assert.equal(maskSensitive("alreadyHaveActiveExchangeRequest contactSAC"), "alreadyHaveActiveExchangeRequest contactSAC");
  assert.equal(maskSensitive("Falar com ana.silva@exemplo.com.br agora"), "Falar com [e-mail] agora");
  assert.equal(maskSensitive("CPF 123.456.789-00 e fone (11) 98765-4321"), "CPF ••• e fone (11) •••");
  assert.equal(maskSensitive("pedido 123456789 inválido"), "pedido ••• inválido");
  assert.equal(maskSensitive("veja https://x.exemplo.com/a?token=abc123 ok"), "veja [link] ok");
  assert.equal(maskSensitive("sessão 9b4f1bd19449c3a36b273fa971a3f5e9 expirou"), "sessão ••• expirou");
  assert.equal(maskSensitive("  vários   espaços  "), "vários espaços");
  assert.equal(maskSensitive(42), 42);
});

test("só as chaves de texto do sistema são mascaradas; valores comuns do meta não mudam", () => {
  const meta = sanitizeMeta({
    detail: "Pedido 987654321 não encontrado para ana@exemplo.com",
    upstream_code: "ERRO_COM_CPF_12345678900",
    ineligibility_code: "alreadyHaveActiveExchangeRequest contactSAC",
    sku: "1004-12345678", // catálogo: número longo legítimo, não pode ser alterado
    product_id: "1234567",
  });
  assert.equal(meta.detail, "Pedido ••• não encontrado para [e-mail]");
  assert.equal(meta.upstream_code, "ERRO_COM_CPF_•••");
  assert.equal(meta.ineligibility_code, "alreadyHaveActiveExchangeRequest contactSAC");
  assert.equal(meta.sku, "1004-12345678");
  assert.equal(meta.product_id, "1234567");
});

test("error_code fora do formato vira UNKNOWN_ERROR em vez de sumir; vazio continua nulo", () => {
  const base = { event: "error_shown", step: "identify", session_id: SESSION_ID };
  assert.equal(buildRecord({ ...base, error_code: "alreadyHaveActiveExchangeRequest contactSAC" }).error_code, "UNKNOWN_ERROR");
  assert.equal(buildRecord({ ...base, error_code: "x".repeat(41) }).error_code, "UNKNOWN_ERROR");
  assert.equal(buildRecord({ ...base, error_code: "ORDER_NOT_ELIGIBLE" }).error_code, "ORDER_NOT_ELIGIBLE");
  assert.equal(buildRecord({ ...base, error_code: null }).error_code, null);
  assert.equal(buildRecord({ ...base }).error_code, null);
  assert.equal(buildRecord({ ...base, error_code: "" }).error_code, null);
});

test("erro vindo do navegador guarda o motivo no meta, mascarado", () => {
  const records = [];
  setSink((r) => records.push(r));
  try {
    const flow = { sessionId: SESSION_ID, sendId: null, flow: "reverse", conversationId: "conv1", store: "mizuno" };
    ingestClientEvents(
      [{ event: "error_shown", step: "identify", error_code: "ORDER_NOT_ELIGIBLE", meta: { ineligibility_code: "alreadyHaveActiveExchangeRequest contactSAC", detail: "Pedido 555666777 já tem solicitação" } }],
      flow,
    );
  } finally {
    setSink(null);
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].error_code, "ORDER_NOT_ELIGIBLE");
  assert.equal(records[0].meta.ineligibility_code, "alreadyHaveActiveExchangeRequest contactSAC");
  assert.equal(records[0].meta.detail, "Pedido ••• já tem solicitação");
});
