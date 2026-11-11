const test = require("node:test");
const assert = require("node:assert/strict");
const { submitConfirmationMessage, formatDate } = require("../lib/reverse/messages");
const { describeError, ReverseError } = require("../lib/reverse/errors");
const { TroqueError } = require("../lib/troque");

const CTX = { type: "refund", retentionAccepted: false, orderNumber: "123-01" };

test("formata datas dos dois formatos do Troque", () => {
  assert.equal(formatDate("2026-10-01"), "01/10/2026");
  assert.equal(formatDate("01/10/2026"), "01/10/2026");
  assert.equal(formatDate(null), null);
});

test("mensagem conforme o outcome", () => {
  assert.match(submitConfirmationMessage({ outcome: "approved_with_shipping", shipping: { is_collect: true, posting_code: "C1" } }, CTX), /coleta será feita.*C1/);
  assert.match(submitConfirmationMessage({ outcome: "approved_without_shipping", shipping: { posting_address: "Av. Exemplo, 1" } }, CTX), /Entregue o produto em: Av\. Exemplo, 1/);
  assert.match(submitConfirmationMessage({ outcome: "pending_analysis" }, CTX), /analisada pela loja/);
  assert.match(submitConfirmationMessage({ outcome: "approved_shipping_failed" }, CTX), /instruções de envio para o seu e-mail/);
  assert.match(submitConfirmationMessage({ outcome: "registered" }, { ...CTX, type: "exchange" }), /troca do pedido 123-01/);
});

test("erros viram mensagem amigável e código curto, sem detalhes internos", () => {
  const notFound = describeError(new TroqueError("ORDER_NOT_FOUND"));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, "ORDER_NOT_FOUND");
  assert.equal(notFound.body.action, "fix_input");

  const validation = describeError(new TroqueError("VALIDATION_FAILED", { details: { missing_address_fields: ["number"], created: false } }));
  assert.deepEqual(validation.body.missing_address_fields, ["number"]);
  assert.equal(validation.body.created, undefined);

  const forbidden = describeError(new TroqueError("FORBIDDEN"));
  assert.equal(forbidden.body.code, "SERVICE_ERROR");
  assert.equal(forbidden.body.action, "handoff");
  assert.equal(forbidden.internalCode, "FORBIDDEN");

  const unknown = describeError(new Error("boom"));
  assert.equal(unknown.body.code, "SERVICE_ERROR");
  assert.ok(!JSON.stringify(unknown.body).includes("boom"));

  const ineligible = describeError(new ReverseError("ORDER_NOT_ELIGIBLE", { details: { ineligibility_message: "Prazo expirado." } }));
  assert.equal(ineligible.body.error, "Prazo expirado.");

  assert.equal(describeError(new ReverseError("INVALID_INPUT", { field: "items[0].comment" })).body.field, "items[0].comment");
});
