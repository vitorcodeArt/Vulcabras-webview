// ======================================================
// VALIDAÇÃO E NORMALIZAÇÃO DA ENTRADA DO FLUXO
// ======================================================
// A validação do navegador não vale: tudo é conferido aqui. Os textos de
// motivo e submotivo são comparados exatamente como vieram do Troque.

const crypto = require("crypto");
const { ReverseError } = require("./errors");

const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIX_TYPES = ["CPF ou CNPJ", "Telefone", "E-mail", "Chave aleatória"];
const BANK_ACCOUNT_TYPES = ["Corrente", "Poupança"];
const MAX_ITEMS = 50;
const MAX_COMMENT = 1000;
const MAX_IMAGES = 10;

// Motivos que, por decisão de negócio, vão para um atendente em vez de abrir a
// reversa (ex.: "Solicitação fora do prazo"). Separados por "|".
const DEFAULT_HANDOFF_REASONS = "Solicitação fora do prazo";

function invalid(field) {
  return new ReverseError("INVALID_INPUT", { field });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function digits(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "";
}

function foldText(value) {
  return String(value).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function getHandoffReasons() {
  const raw = process.env.REVERSE_HANDOFF_REASONS ?? DEFAULT_HANDOFF_REASONS;
  return raw
    .split("|")
    .map((r) => foldText(r))
    .filter(Boolean);
}

function isHandoffReason(reason) {
  return typeof reason === "string" && getHandoffReasons().includes(foldText(reason));
}

// Número do pedido: tira # e espaços (ex.: "# 1664284820905-01")
function normalizeOrderNumber(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[#\s]/g, "");
  return cleaned.length >= 1 && cleaned.length <= 60 && /^[A-Za-z0-9._-]+$/.test(cleaned) ? cleaned : null;
}

// CPF (11 dígitos), CNPJ (14 dígitos) ou e-mail
function normalizeCustomerIdentifier(value) {
  const raw = text(value);
  if (!raw) return null;

  if (raw.includes("@")) {
    const email = raw.toLowerCase();
    return email.length <= 200 && EMAIL_PATTERN.test(email) ? { value: email, kind: "email" } : null;
  }

  const onlyDigits = digits(raw);
  if (onlyDigits.length === 11) return { value: onlyDigits, kind: "cpf" };
  if (onlyDigits.length === 14) return { value: onlyDigits, kind: "cnpj" };
  return null;
}

function parseIdentification(body) {
  const orderNumber = normalizeOrderNumber(body.order_number);
  if (!orderNumber) throw invalid("order_number");

  const identifier = normalizeCustomerIdentifier(body.customer_identifier);
  if (!identifier) throw invalid("customer_identifier");

  return { orderNumber, identifier: identifier.value, identifierKind: identifier.kind };
}

function parseType(value) {
  if (value === "exchange" || value === "refund") return value;
  throw invalid("type");
}

function reasonsForType(reasons, type) {
  return (Array.isArray(reasons) ? reasons : []).filter((r) => (type === "exchange" ? r.is_exchange === true : r.is_refund === true));
}

// Forma básica dos itens (usada na retenção e na cotação, antes da validação completa)
function parseItemsShape(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw invalid("items");

  const seen = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== "object") throw invalid(`items[${index}]`);

    const sku = typeof item.sku === "string" ? item.sku : "";
    if (!sku || sku.length > 200 || seen.has(sku)) throw invalid(`items[${index}].sku`);
    seen.add(sku);

    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw invalid(`items[${index}].quantity`);

    const reason = typeof item.reason === "string" ? item.reason : "";
    if (!reason || reason.length > 300) throw invalid(`items[${index}].reason`);

    return { sku, quantity: item.quantity, reason };
  });
}

// Validação completa dos itens contra o retorno do prepare_reverse_order.
// imageUrlsBySku: { [sku]: [urls] } (preenchido a partir da Fase 3).
function validateSelection(items, prepared, { type, imageUrlsBySku = {} }) {
  const shape = parseItemsShape(items);
  const allowedReasons = reasonsForType(prepared.reasons, type);
  const orderItems = Array.isArray(prepared.order?.items) ? prepared.order.items : [];

  return shape.map((item, index) => {
    const raw = items[index];
    const field = `items[${index}]`;

    const orderItem = orderItems.find((o) => o.sku === item.sku);
    if (!orderItem) throw invalid(`${field}.sku`);
    if (item.quantity > (Number(orderItem.quantity) || 0)) throw invalid(`${field}.quantity`);

    const reason = allowedReasons.find((r) => r.reason === item.reason);
    if (!reason) throw invalid(`${field}.reason`);
    if (isHandoffReason(reason.reason)) throw new ReverseError("HANDOFF_REQUIRED", { field: `${field}.reason` });

    const troqueReason = { description: reason.reason };

    if (Array.isArray(reason.sub_reasons) && reason.sub_reasons.length > 0) {
      const subReason = typeof raw.sub_reason === "string" ? raw.sub_reason : "";
      if (!reason.sub_reasons.includes(subReason)) throw invalid(`${field}.sub_reason`);
      troqueReason.sub_reason = subReason;
    }

    const comment = text(raw.comment);
    if (comment.length > MAX_COMMENT) throw invalid(`${field}.comment`);
    if (reason.has_comment && !comment) throw invalid(`${field}.comment`);
    if (comment) troqueReason.client_comment = comment;

    if (reason.has_image) {
      const urls = Array.isArray(imageUrlsBySku[item.sku]) ? imageUrlsBySku[item.sku] : [];
      if (urls.length === 0) throw new ReverseError("PHOTO_REQUIRED", { field: `${field}.photos` });
      troqueReason.image_url = urls.slice(0, MAX_IMAGES);
    }

    return {
      sku: item.sku,
      quantity: item.quantity,
      is_exchange: type === "exchange",
      reason: troqueReason,
      // Só para resumo/ticket; removido antes de enviar ao Troque
      productDescription: orderItem.description || null,
    };
  });
}

// Endereço completo (todos os campos juntos, como o Troque exige)
function parseFullAddress(input) {
  if (!input || typeof input !== "object") throw invalid("address");

  const zipcode = digits(input.zipcode);
  if (zipcode.length !== 8) throw invalid("address.zipcode");

  const street = text(input.street);
  if (street.length < 2 || street.length > 200) throw invalid("address.street");

  const number = text(input.number);
  if (!number || number.length > 30 || !/\d/.test(number)) throw invalid("address.number");

  const neighborhood = text(input.neighborhood);
  if (neighborhood.length < 2 || neighborhood.length > 200) throw invalid("address.neighborhood");

  const city = text(input.city);
  if (city.length < 2 || city.length > 200) throw invalid("address.city");

  const state = text(input.state).toUpperCase();
  if (!UFS.has(state)) throw invalid("address.state");

  const description = text(input.description);
  if (description.length > 200) throw invalid("address.description");

  const address = { zipcode, street, number, neighborhood, city, state };
  if (description) address.description = description;
  return address;
}

// Endereço conforme address_step.mode
function resolveAddress(input, addressStep) {
  const mode = addressStep?.mode;
  if (mode !== "confirm" && mode !== "ask_full_address") return null;

  if (input === undefined || input === null) {
    if (mode === "ask_full_address") throw invalid("address");
    if (Array.isArray(addressStep.missing_fields) && addressStep.missing_fields.length > 0) throw invalid("address");
    return null;
  }

  return parseFullAddress(input);
}

// CPF/CNPJ e e-mail só quando o pedido veio sem eles (missing_customer_fields)
function resolveCustomer(input, missingFields) {
  const missing = Array.isArray(missingFields) ? missingFields : [];
  if (missing.length === 0) return null;

  const source = input && typeof input === "object" ? input : {};
  const customer = {};

  if (missing.includes("document")) {
    const document = digits(source.document);
    if (document.length !== 11 && document.length !== 14) throw invalid("customer.document");
    customer.document = document;
  }

  if (missing.includes("email")) {
    const email = text(source.email).toLowerCase();
    if (email.length > 200 || !EMAIL_PATTERN.test(email)) throw invalid("customer.email");
    customer.email = email;
  }

  return customer;
}

// Decisão sobre a retenção (só faz sentido em devolução)
function resolveRetention(input, type) {
  if (type !== "refund" || input === undefined || input === null) return null;
  if (typeof input !== "object" || typeof input.accepted !== "boolean") throw invalid("retention");

  if (!input.accepted) return { accepted: false };

  const level = input.level === undefined ? 1 : input.level;
  if (level !== 1 && level !== 2) throw invalid("retention.level");
  return { accepted: true, level };
}

// Dados para reembolso (PIX ou transferência)
function resolvePaymentBill(input) {
  if (!input || typeof input !== "object") throw invalid("payment_bill");

  if (input.is_pix === true) {
    const pixType = input.pix_type;
    if (!PIX_TYPES.includes(pixType)) throw invalid("payment_bill.pix_type");

    let pixKey = text(input.pix_key);
    if (pixType === "CPF ou CNPJ") {
      pixKey = digits(pixKey);
      if (pixKey.length !== 11 && pixKey.length !== 14) throw invalid("payment_bill.pix_key");
    } else if (pixType === "Telefone") {
      pixKey = digits(pixKey);
      if (pixKey.length < 10 || pixKey.length > 13) throw invalid("payment_bill.pix_key");
    } else if (pixType === "E-mail") {
      pixKey = pixKey.toLowerCase();
      if (!EMAIL_PATTERN.test(pixKey)) throw invalid("payment_bill.pix_key");
    }
    if (!pixKey || pixKey.length > 200) throw invalid("payment_bill.pix_key");

    return { is_pix: true, pix_type: pixType, pix_key: pixKey };
  }

  if (input.is_pix === false) {
    const bankCode = digits(input.bank_code);
    if (!bankCode || bankCode.length > 20) throw invalid("payment_bill.bank_code");

    const bankAgency = text(input.bank_agency);
    if (!bankAgency || bankAgency.length > 20 || !/^[0-9xX-]+$/.test(bankAgency)) throw invalid("payment_bill.bank_agency");

    const bankAccount = text(input.bank_account);
    if (!bankAccount || bankAccount.length > 30 || !/^[0-9xX-]+$/.test(bankAccount)) throw invalid("payment_bill.bank_account");

    if (!BANK_ACCOUNT_TYPES.includes(input.bank_account_type)) throw invalid("payment_bill.bank_account_type");

    return {
      is_pix: false,
      bank_code: bankCode,
      bank_agency: bankAgency,
      bank_account: bankAccount,
      bank_account_type: input.bank_account_type,
    };
  }

  throw invalid("payment_bill.is_pix");
}

// Impressão digital da decisão do cliente: liga a cotação à criação, para que
// a opção de envio escolhida só valha para os mesmos itens, endereço e retenção.
function quoteContextHash({ orderNumber, type, items, retentionAccepted, address }) {
  const normalizedItems = items.map((i) => [i.sku, i.quantity, i.reason]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const source = JSON.stringify([orderNumber, type, normalizedItems, Boolean(retentionAccepted), address || null]);
  return crypto.createHash("sha256").update(source).digest("base64url").slice(0, 32);
}

module.exports = {
  isHandoffReason,
  normalizeOrderNumber,
  normalizeCustomerIdentifier,
  parseIdentification,
  parseType,
  reasonsForType,
  parseItemsShape,
  validateSelection,
  parseFullAddress,
  resolveAddress,
  resolveCustomer,
  resolveRetention,
  resolvePaymentBill,
  quoteContextHash,
};
