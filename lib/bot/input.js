// ======================================================
// ENTRADA DA API DO BOT (WhatsApp / agente de IA do Zendesk)
// ======================================================
// O bot envia escolhas por número ("2"), respostas sim/não e campos soltos,
// muitas vezes como texto. Aqui tudo vira o formato que o serviço do fluxo
// (lib/reverse/service.js) já valida. Uma solicitação = um produto.

const { ReverseError } = require("../reverse/errors");
const v = require("../reverse/validation");

const PIX_TYPES = ["CPF ou CNPJ", "Telefone", "E-mail", "Chave aleatória"];

function invalid(field) {
  return new ReverseError("INVALID_INPUT", { field });
}

function text(value) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function fold(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Escolha numerada: aceita 2, "2", "2 - Tênis..." (1 a max)
function option(value, field, max) {
  const match = text(value).match(/^(\d{1,3})\b/);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > max) throw invalid(field);
  return number - 1;
}

// true/false a partir de booleano ou texto ("sim", "não", "true"...); null se ausente
function yesNo(value) {
  if (value === true || value === false) return value;
  const answer = fold(value);
  if (!answer) return null;
  if (["sim", "s", "true", "yes", "1", "aceito", "confirmo"].includes(answer)) return true;
  if (["nao", "n", "false", "no", "0", "recuso"].includes(answer)) return false;
  return null;
}

// "exchange" / "troca" -> exchange; "refund" / "devolução" -> refund
function type(value) {
  const answer = fold(value);
  if (answer === "exchange" || answer === "troca" || answer === "trocar") return "exchange";
  if (answer === "refund" || answer === "devolucao" || answer === "devolver") return "refund";
  throw invalid("type");
}

// Produto escolhido (item_option, 1 = primeiro da lista do lookup)
function item(prepared, body) {
  const items = Array.isArray(prepared.order?.items) ? prepared.order.items : [];
  if (items.length === 0) throw invalid("item_option");
  return items[option(body.item_option, "item_option", items.length)];
}

// Quantidade: padrão 1; nunca maior que a comprada
function quantity(body, orderItem) {
  if (body.quantity === undefined || body.quantity === null || body.quantity === "") return 1;
  const number = Number(text(body.quantity));
  if (!Number.isInteger(number) || number < 1 || number > (Number(orderItem.quantity) || 0)) throw invalid("quantity");
  return number;
}

// Motivos do tipo escolhido, na ordem em que o Troque devolve (a mesma do texto numerado)
function reasonsFor(prepared, kind) {
  return v.reasonsForType(prepared.reasons, kind);
}

function reason(prepared, kind, body) {
  const reasons = reasonsFor(prepared, kind);
  if (reasons.length === 0) throw invalid("reason_option");
  return reasons[option(body.reason_option, "reason_option", reasons.length)];
}

function subReason(chosen, body) {
  const list = Array.isArray(chosen.sub_reasons) ? chosen.sub_reasons : [];
  if (list.length === 0) return null;
  return list[option(body.sub_reason_option, "sub_reason_option", list.length)];
}

// Seleção completa (produto + motivo) no formato de "items" do serviço
function selection(prepared, body) {
  const kind = type(body.type);
  const orderItem = item(prepared, body);
  const qty = quantity(body, orderItem);
  const chosen = reason(prepared, kind, body);
  const sub = subReason(chosen, body);
  const comment = text(body.comment);

  const entry = { sku: orderItem.sku, quantity: qty, reason: chosen.reason };
  if (sub) entry.sub_reason = sub;
  if (comment) entry.comment = comment;

  return { type: kind, orderItem, quantity: qty, reason: chosen, subReason: sub, comment, items: [entry] };
}

// Endereço: confirmado (usa o da compra) ou informado campo a campo
function address(body) {
  const fields = ["zipcode", "street", "number", "neighborhood", "city", "state"];
  const informed = fields.some((f) => text(body[`address_${f}`]));
  if (!informed) return null;

  const result = {};
  for (const f of fields) result[f] = text(body[`address_${f}`]);
  const complement = text(body.address_complement);
  if (complement) result.description = complement;
  // A validação completa (CEP, UF etc.) é a mesma do webview
  return v.parseFullAddress(result);
}

// Decisão sobre o vale-compras (só devolução). null = cliente ainda não respondeu
function retention(body, kind) {
  if (kind !== "refund") return null;
  const accepted = yesNo(body.retention_accepted);
  if (accepted === null) return null;
  if (!accepted) return { accepted: false };
  const level = body.retention_level === undefined || body.retention_level === null || body.retention_level === "" ? 1 : Number(text(body.retention_level));
  if (level !== 1 && level !== 2) throw invalid("retention_level");
  return { accepted: true, level };
}

// Reembolso por PIX (conta bancária vai para atendente nesta versão)
function paymentBill(body) {
  if (!text(body.pix_key) && !text(body.pix_type)) return null;
  let pixType = PIX_TYPES.find((t) => fold(t) === fold(body.pix_type));
  if (!pixType) pixType = PIX_TYPES[option(body.pix_type, "pix_type", PIX_TYPES.length)];
  return v.resolvePaymentBill({ is_pix: true, pix_type: pixType, pix_key: text(body.pix_key) });
}

module.exports = {
  PIX_TYPES,
  option,
  yesNo,
  type,
  item,
  reasonsFor,
  reason,
  selection,
  address,
  retention,
  paymentBill,
};
