const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../lib/reverse/validation");
const { preparedOrder } = require("./fixtures");

function code(fn) {
  try {
    fn();
  } catch (error) {
    return `${error.code}:${error.field ?? ""}`;
  }
  return "ok";
}

test("normaliza número do pedido", () => {
  assert.equal(v.normalizeOrderNumber(" # 1664284820905-01 "), "1664284820905-01");
  assert.equal(v.normalizeOrderNumber("abc/../x"), null);
  assert.equal(v.normalizeOrderNumber(""), null);
  assert.equal(v.normalizeOrderNumber(123), null);
});

test("normaliza CPF, CNPJ e e-mail", () => {
  assert.deepEqual(v.normalizeCustomerIdentifier("000.000.000-00"), { value: "00000000000", kind: "cpf" });
  assert.deepEqual(v.normalizeCustomerIdentifier("00.000.000/0001-00"), { value: "00000000000100", kind: "cnpj" });
  assert.deepEqual(v.normalizeCustomerIdentifier(" Cliente@Exemplo.com "), { value: "cliente@exemplo.com", kind: "email" });
  assert.equal(v.normalizeCustomerIdentifier("123"), null);
  assert.equal(v.normalizeCustomerIdentifier("sem-arroba.com"), null);
});

test("validateSelection monta os itens no formato da criação", () => {
  const items = v.validateSelection([{ sku: "SKU-1", quantity: 2, reason: "Não serviu", sub_reason: "Ficou pequeno", comment: "  opcional  " }], preparedOrder(), { type: "exchange" });
  assert.deepEqual(items, [
    { sku: "SKU-1", quantity: 2, is_exchange: true, reason: { description: "Não serviu", sub_reason: "Ficou pequeno", client_comment: "opcional" }, productDescription: "Tênis Teste 40" },
  ]);
});

test("validateSelection aplica as regras do motivo", () => {
  const prepared = preparedOrder();
  const sel = (items, type = "refund") => code(() => v.validateSelection(items, prepared, { type }));

  assert.equal(sel([{ sku: "X", quantity: 1, reason: "Não serviu", sub_reason: "Ficou grande" }]), "INVALID_INPUT:items[0].sku");
  assert.equal(sel([{ sku: "SKU-1", quantity: 3, reason: "Não serviu", sub_reason: "Ficou grande" }]), "INVALID_INPUT:items[0].quantity");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1.5, reason: "Não serviu" }]), "INVALID_INPUT:items[0].quantity");
  // "Arrependimento" só aceita devolução
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "x" }], "exchange"), "INVALID_INPUT:items[0].reason");
  // texto do motivo tem que ser exato
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "não serviu", sub_reason: "Ficou grande" }]), "INVALID_INPUT:items[0].reason");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Não serviu" }]), "INVALID_INPUT:items[0].sub_reason");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Arrependimento" }]), "INVALID_INPUT:items[0].comment");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "x".repeat(1001) }]), "INVALID_INPUT:items[0].comment");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Defeito", sub_reason: "Meu produto descolou", comment: "x" }]), "PHOTO_REQUIRED:items[0].photos");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Solicitação fora do prazo", comment: "x" }]), "HANDOFF_REQUIRED:items[0].reason");
  assert.equal(sel([{ sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "x" }, { sku: "SKU-1", quantity: 1, reason: "Arrependimento", comment: "x" }]), "INVALID_INPUT:items[1].sku");
  assert.equal(sel([]), "INVALID_INPUT:items");
});

test("foto: com URLs o item passa (até 10)", () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://exemplo.com/${i}.jpg`);
  const [item] = v.validateSelection([{ sku: "SKU-1", quantity: 1, reason: "Defeito", sub_reason: "Meu produto descolou", comment: "Descolou" }], preparedOrder(), {
    type: "refund",
    imageUrlsBySku: { "SKU-1": urls },
  });
  assert.equal(item.reason.image_url.length, 10);
});

test("motivos de atendente são configuráveis", (t) => {
  const previous = process.env.REVERSE_HANDOFF_REASONS;
  t.after(() => {
    if (previous === undefined) delete process.env.REVERSE_HANDOFF_REASONS;
    else process.env.REVERSE_HANDOFF_REASONS = previous;
  });
  delete process.env.REVERSE_HANDOFF_REASONS;
  assert.equal(v.isHandoffReason("solicitacao FORA do prazo"), true);
  process.env.REVERSE_HANDOFF_REASONS = "Outro|Mais um";
  assert.equal(v.isHandoffReason("Solicitação fora do prazo"), false);
  assert.equal(v.isHandoffReason("mais um"), true);
});

test("endereço conforme address_step.mode", () => {
  const full = { zipcode: "01000-000", street: "Rua A", number: "10", neighborhood: "Centro", city: "São Paulo", state: "sp" };
  assert.deepEqual(v.resolveAddress(full, { mode: "confirm", missing_fields: [] }), { zipcode: "01000000", street: "Rua A", number: "10", neighborhood: "Centro", city: "São Paulo", state: "SP" });
  assert.equal(v.resolveAddress(null, { mode: "confirm", missing_fields: [] }), null);
  assert.equal(code(() => v.resolveAddress(null, { mode: "confirm", missing_fields: ["number"] })), "INVALID_INPUT:address");
  assert.equal(code(() => v.resolveAddress(null, { mode: "ask_full_address", missing_fields: [] })), "INVALID_INPUT:address");
  assert.equal(v.resolveAddress(full, { mode: "locked" }), null);
  assert.equal(v.resolveAddress(full, { mode: "skip" }), null);
  assert.equal(code(() => v.parseFullAddress({ ...full, zipcode: "123" })), "INVALID_INPUT:address.zipcode");
  assert.equal(code(() => v.parseFullAddress({ ...full, number: "S/N" })), "INVALID_INPUT:address.number");
  assert.equal(code(() => v.parseFullAddress({ ...full, state: "XX" })), "INVALID_INPUT:address.state");
});

test("customer só com os campos que faltam", () => {
  assert.equal(v.resolveCustomer({ document: "000.000.000-00" }, []), null);
  assert.deepEqual(v.resolveCustomer({ document: "000.000.000-00", email: "x@y.co" }, ["email"]), { email: "x@y.co" });
  assert.equal(code(() => v.resolveCustomer({}, ["document"])), "INVALID_INPUT:customer.document");
});

test("retenção", () => {
  assert.equal(v.resolveRetention({ accepted: true }, "exchange"), null);
  assert.equal(v.resolveRetention(undefined, "refund"), null);
  assert.deepEqual(v.resolveRetention({ accepted: true }, "refund"), { accepted: true, level: 1 });
  assert.deepEqual(v.resolveRetention({ accepted: false, level: 2 }, "refund"), { accepted: false });
  assert.equal(code(() => v.resolveRetention({ accepted: true, level: 3 }, "refund")), "INVALID_INPUT:retention.level");
});

test("dados de reembolso", () => {
  assert.deepEqual(v.resolvePaymentBill({ is_pix: true, pix_type: "CPF ou CNPJ", pix_key: "000.000.000-00" }), { is_pix: true, pix_type: "CPF ou CNPJ", pix_key: "00000000000" });
  assert.deepEqual(v.resolvePaymentBill({ is_pix: true, pix_type: "E-mail", pix_key: "X@Y.CO" }), { is_pix: true, pix_type: "E-mail", pix_key: "x@y.co" });
  assert.equal(code(() => v.resolvePaymentBill({ is_pix: true, pix_type: "Outro", pix_key: "a" })), "INVALID_INPUT:payment_bill.pix_type");
  assert.equal(code(() => v.resolvePaymentBill({ is_pix: true, pix_type: "Telefone", pix_key: "123" })), "INVALID_INPUT:payment_bill.pix_key");
  assert.deepEqual(v.resolvePaymentBill({ is_pix: false, bank_code: "001", bank_agency: "1234", bank_account: "12345-6", bank_account_type: "Poupança" }), {
    is_pix: false,
    bank_code: "001",
    bank_agency: "1234",
    bank_account: "12345-6",
    bank_account_type: "Poupança",
  });
  assert.equal(code(() => v.resolvePaymentBill({ is_pix: false, bank_code: "001", bank_agency: "1234", bank_account: "1", bank_account_type: "Salário" })), "INVALID_INPUT:payment_bill.bank_account_type");
  assert.equal(code(() => v.resolvePaymentBill(null)), "INVALID_INPUT:payment_bill");
});

test("hash de contexto não depende da ordem dos itens e muda com a decisão", () => {
  const base = { orderNumber: "1", type: "refund", retentionAccepted: false, address: null };
  const a = v.quoteContextHash({ ...base, items: [{ sku: "A", quantity: 1, reason: "R" }, { sku: "B", quantity: 1, reason: "R" }] });
  const b = v.quoteContextHash({ ...base, items: [{ sku: "B", quantity: 1, reason: "R" }, { sku: "A", quantity: 1, reason: "R" }] });
  const c = v.quoteContextHash({ ...base, retentionAccepted: true, items: [{ sku: "A", quantity: 1, reason: "R" }, { sku: "B", quantity: 1, reason: "R" }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
