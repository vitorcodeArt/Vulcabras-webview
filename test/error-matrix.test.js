// Matriz de erros: todo error_code que o Troque documenta tem destino definido
const test = require("node:test");
const assert = require("node:assert/strict");
const { describeError } = require("../lib/reverse/errors");
const openapi = require("../docs/troque-mcp-openapi.json");

// Ferramentas usadas pela webview (as 4 da equipe da loja ficam de fora)
const TOOLS = ["prepare_reverse_order", "get_retention_offer", "quote_return_shipping", "create_reverse_order", "track_reverse_order"];
// Códigos que vão de propósito para o atendente (sem mensagem própria)
const HANDOFF_ON_PURPOSE = new Set(["FORBIDDEN"]);
// Tratados no serviço antes de chegar ao navegador
const HANDLED_IN_SERVICE = new Set(["CREATED_WITH_ERRORS"]);
const ENGLISH = /\b(the|order|not|found|please|error|failed)\b/i;

function documentedCodes() {
  const codes = new Set();
  for (const tool of TOOLS) {
    const responses = openapi.paths[`/tools/call/${tool}`].post.responses;
    for (const code of responses.default.content["application/json"].schema.properties.error_code.enum) codes.add(code);
  }
  return [...codes];
}

test("todo error_code documentado das 5 ferramentas tem mensagem em português e ação", () => {
  const codes = documentedCodes();
  assert.ok(codes.length >= 10);
  for (const code of codes) {
    if (HANDLED_IN_SERVICE.has(code)) continue;
    const { body, status } = describeError({ code });
    assert.ok(body.error && !ENGLISH.test(body.error), `${code}: mensagem ausente ou em inglês`);
    assert.ok(["retry", "fix_input", "track", "refresh_retention", "requote", "retry_without_address", "handoff", "close"].includes(body.action), `${code}: ação inválida`);
    if (HANDOFF_ON_PURPOSE.has(code)) assert.equal(body.action, "handoff");
    else assert.notEqual(body.code, "SERVICE_ERROR", `${code} caiu no erro genérico`);
    assert.ok(status >= 200 && status < 600);
  }
});

test("erros de transporte e protocolo: retry para falha temporária, atendente para configuração", () => {
  for (const code of ["TEMPORARY_FAILURE", "NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED"]) assert.equal(describeError({ code }).body.action, "retry");
  for (const code of ["UNAUTHORIZED", "INVALID_PARAMS", "PROTOCOL_ERROR", "BRAND_NOT_CONFIGURED"]) assert.equal(describeError({ code }).body.action, "handoff");
  // Criação incerta nunca oferece reenviar
  assert.equal(describeError({ code: "CREATION_UNCONFIRMED" }).body.action, "track");
});

test("a message do Troque nunca chega ao navegador", () => {
  const { body } = describeError({ code: "VALIDATION_FAILED", message: "Field number is invalid", details: { missing_address_fields: ["number"] } });
  assert.ok(!JSON.stringify(body).includes("Field number"));
  assert.deepEqual(body.missing_address_fields, ["number"]);
});
