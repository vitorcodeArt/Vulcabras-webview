const test = require("node:test");
const assert = require("node:assert/strict");
const { createTroqueClient, TroqueError, parseSse } = require("../lib/troque");
const { setSink } = require("../lib/tracking");

const TOKEN = "token-falso";

function jsonResponse(payload, { isError = false, status = 200 } = {}) {
  return {
    status,
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }], isError } }),
  };
}

// http falso: devolve as respostas em sequência e guarda as chamadas
function fakeHttp(responses) {
  const calls = [];
  return {
    calls,
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function client(responses) {
  const http = fakeHttp(responses);
  const sleeps = [];
  const c = createTroqueClient({ http, sleep: async (ms) => sleeps.push(ms) });
  return { c, http, sleeps };
}

test.beforeEach(() => setSink(() => {}));
test.afterEach(() => setSink(null));

test("monta a requisição JSON-RPC com headers e devolve structuredContent", async () => {
  const { c, http } = client([jsonResponse({ eligible: true })]);
  const result = await c.callTool("prepare_reverse_order", { ecommerce_number: "1", customer_identifier: "a@b.co" }, { token: TOKEN });

  assert.deepEqual(result, { eligible: true });
  const { body, config } = http.calls[0];
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.method, "tools/call");
  assert.equal(body.params.name, "prepare_reverse_order");
  assert.equal(config.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(config.headers.Accept, "application/json, text/event-stream");
  assert.equal(config.timeout, 20000);
});

test("cotação e criação têm timeout maior", async () => {
  const { c, http } = client([jsonResponse({ shipping_options: [] })]);
  await c.callTool("quote_return_shipping", {}, { token: TOKEN });
  assert.equal(http.calls[0].config.timeout, 60000);
});

test("aceita resposta em SSE", async () => {
  const payload = { reverses: [] };
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: payload } })}\n\n`;
  const { c } = client([{ status: 200, headers: { "content-type": "text/event-stream" }, data: sse }]);
  assert.deepEqual(await c.callTool("track_reverse_order", {}, { token: TOKEN }), payload);
});

test("SSE com várias mensagens usa a última com result", () => {
  const text = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":1}}}\n\n';
  assert.deepEqual(parseSse(text).result.structuredContent, { ok: 1 });
});

test("usa content[0].text quando não há structuredContent", async () => {
  const data = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"available":false}' }] } });
  const { c } = client([{ status: 200, headers: {}, data }]);
  assert.deepEqual(await c.callTool("get_retention_offer", {}, { token: TOKEN }), { available: false });
});

test("isError vira TroqueError com error_code e detalhes, sem a message", async () => {
  const { c } = client([jsonResponse({ error_code: "VALIDATION_FAILED", message: "secret text 000.000.000-00", missing_address_fields: ["number"] }, { isError: true })]);
  await assert.rejects(c.callTool("quote_return_shipping", {}, { token: TOKEN }), (error) => {
    assert.ok(error instanceof TroqueError);
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.deepEqual(error.details, { missing_address_fields: ["number"] });
    assert.ok(!JSON.stringify(error).includes("secret text"));
    return true;
  });
});

test("ORDER_NOT_FOUND não é repetido", async () => {
  const { c, http } = client([jsonResponse({ error_code: "ORDER_NOT_FOUND", message: "..." }, { isError: true })]);
  await assert.rejects(c.callTool("prepare_reverse_order", {}, { token: TOKEN }), { code: "ORDER_NOT_FOUND" });
  assert.equal(http.calls.length, 1);
});

test("HTTP 401 vira UNAUTHORIZED sem retry", async () => {
  const { c, http } = client([{ status: 401, headers: {}, data: "" }]);
  await assert.rejects(c.callTool("prepare_reverse_order", {}, { token: TOKEN }), { code: "UNAUTHORIZED" });
  assert.equal(http.calls.length, 1);
});

test("HTTP 429 é repetido respeitando Retry-After (com teto)", async () => {
  const { c, http, sleeps } = client([{ status: 429, headers: { "retry-after": "2" }, data: "" }, { status: 429, headers: { "retry-after": "60" }, data: "" }, jsonResponse({ eligible: true })]);
  assert.deepEqual(await c.callTool("prepare_reverse_order", {}, { token: TOKEN }), { eligible: true });
  assert.equal(http.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 5000]);
});

test("TEMPORARY_FAILURE é repetido até 2 vezes", async () => {
  const temp = () => jsonResponse({ error_code: "TEMPORARY_FAILURE", message: "..." }, { isError: true });
  const { c, http } = client([temp(), temp(), temp()]);
  await assert.rejects(c.callTool("track_reverse_order", {}, { token: TOKEN }), { code: "TEMPORARY_FAILURE" });
  assert.equal(http.calls.length, 3);
});

test("erro de rede em leitura é repetido; timeout não", async () => {
  const net = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const { c, http } = client([net, jsonResponse({ reverses: [] })]);
  await c.callTool("track_reverse_order", {}, { token: TOKEN });
  assert.equal(http.calls.length, 2);

  const timeout = Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
  const second = client([timeout]);
  await assert.rejects(second.c.callTool("quote_return_shipping", {}, { token: TOKEN }), { code: "TIMEOUT" });
  assert.equal(second.http.calls.length, 1);
});

test("criação: timeout vira CREATION_UNCONFIRMED e nunca é repetida", async () => {
  const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  const { c, http } = client([timeout]);
  await assert.rejects(c.callTool("create_reverse_order", { confirm: true }, { token: TOKEN }), (error) => {
    assert.equal(error.code, "CREATION_UNCONFIRMED");
    assert.equal(error.created, null);
    return true;
  });
  assert.equal(http.calls.length, 1);
});

test("criação: TEMPORARY_FAILURE com created=false continua TEMPORARY_FAILURE, sem retry", async () => {
  const { c, http } = client([jsonResponse({ error_code: "TEMPORARY_FAILURE", message: "...", created: false }, { isError: true })]);
  await assert.rejects(c.callTool("create_reverse_order", {}, { token: TOKEN }), { code: "TEMPORARY_FAILURE" });
  assert.equal(http.calls.length, 1);
});

test("criação: 429 pode ser repetido (requisição recusada antes de processar)", async () => {
  const { c, http } = client([{ status: 429, headers: {}, data: "" }, jsonResponse({ created: true })]);
  await c.callTool("create_reverse_order", {}, { token: TOKEN });
  assert.equal(http.calls.length, 2);
});

test("erro de protocolo JSON-RPC (-32602) vira INVALID_PARAMS", async () => {
  const data = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } });
  const { c } = client([{ status: 200, headers: {}, data }]);
  await assert.rejects(c.callTool("prepare_reverse_order", {}, { token: TOKEN }), { code: "INVALID_PARAMS" });
});

test("recusa ferramentas proibidas e chamada sem token", async () => {
  const { c, http } = client([]);
  for (const tool of ["list_reverse_orders", "get_reverse_order", "create_order_exception", "resend_shipping_email"]) {
    await assert.rejects(c.callTool(tool, {}, { token: TOKEN }), { code: "TOOL_NOT_ALLOWED" });
  }
  await assert.rejects(c.callTool("prepare_reverse_order", {}, {}), { code: "UNAUTHORIZED" });
  assert.equal(http.calls.length, 0);
});

test("registra api_call sem token nem argumentos", async () => {
  const records = [];
  setSink((r) => records.push(r));
  const { c } = client([jsonResponse({ eligible: true })]);
  await c.callTool("prepare_reverse_order", { ecommerce_number: "999", customer_identifier: "00000000000" }, { token: TOKEN, context: { conversationId: "conv1", brand: "underarmour", step: "identify" } });

  assert.equal(records.length, 1);
  assert.equal(records[0].event, "api_call");
  assert.equal(records[0].meta.tool, "prepare_reverse_order");
  assert.equal(records[0].meta.ok, true);
  const serialized = JSON.stringify(records[0]);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes("00000000000"));
});
