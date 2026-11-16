// ======================================================
// TEXTOS PRONTOS PARA O BOT MOSTRAR AO CLIENTE
// ======================================================
// Listas numeradas e resumos em texto simples (sem HTML nem markdown), para o
// fluxo do Ultimate só repassar o campo na mensagem. A conversa é com o
// próprio cliente: número do pedido, endereço e códigos podem aparecer.

const { formatDate } = require("../reverse/messages");

// Limite seguro abaixo dos 4096 caracteres de uma mensagem do WhatsApp
const MAX_TEXT = 3500;
const MAX_FLAT_ITEMS = 20;

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function money(value) {
  const number = Number(value);
  // Espaço comum no lugar do espaço inquebrável do Intl ("R$ 60,00")
  return value !== null && value !== undefined && Number.isFinite(number) ? BRL.format(number).replace(/\u00a0/g, " ") : null;
}

function clip(value) {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 3).trimEnd()}...` : value;
}

function numbered(lines) {
  return clip(lines.map((line, i) => `${i + 1} - ${line}`).join("\n"));
}

function itemLabel(item) {
  const name = item.description || item.sku;
  return item.quantity > 1 ? `${name} (${item.quantity} un.)` : name;
}

function addressText(address) {
  if (!address) return null;
  const street = [address.street, address.number].filter(Boolean).join(", ");
  const city = [address.city, address.state].filter(Boolean).join(" - ");
  const parts = [street, address.description, address.neighborhood, city, address.zipcode ? `CEP ${address.zipcode}` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function itemsText(items) {
  return numbered(items.map(itemLabel));
}

// Campos item_1_name, item_1_quantity... (fácil de mapear em variáveis)
function flatItems(items) {
  const result = {};
  items.slice(0, MAX_FLAT_ITEMS).forEach((item, i) => {
    result[`item_${i + 1}_name`] = item.description || item.sku;
    result[`item_${i + 1}_quantity`] = item.quantity;
  });
  return result;
}

function existingText(reverses) {
  return clip(
    reverses
      .map((r) => {
        const date = formatDate(r.created_at);
        return `Solicitação${date ? ` de ${date}` : ""}: ${r.status_name || "em andamento"}`;
      })
      .join("\n"),
  );
}

function reasonsText(reasons) {
  return numbered(reasons.map((r) => r.reason));
}

function subReasonsText(list) {
  return numbered(list);
}

function shippingLabel(option) {
  const how = option.is_store_dropoff ? "entregar em uma loja física" : option.is_collect ? "coleta no endereço informado" : "você leva até um ponto de postagem";
  const lines = [`${option.name || "Envio"}: ${how}`];
  if (option.posting_address_name) lines.push(`   ${option.posting_address_name}`);
  if (option.posting_address) lines.push(`   ${option.posting_address}`);
  if (option.opening_hours) lines.push(`   Horário: ${option.opening_hours}`);
  return lines.join("\n");
}

function optionsText(options) {
  return numbered(options.map(shippingLabel));
}

function offerText(offer) {
  const credit = money(offer.credit_value);
  const bonus = money(offer.bonus_value);
  if (!credit) return "Em vez do reembolso, você pode receber um vale-compras para usar na loja.";
  return `Em vez do reembolso, você pode receber um vale-compras de ${credit}${bonus && Number(offer.bonus_value) > 0 ? ` (com ${bonus} de bônus)` : ""} para usar na loja.`;
}

function automaticRetentionText(retention) {
  const credit = money(retention.offers?.[0]?.credit_value);
  const intro = retention.mode === "forced" ? "Com a entrega em loja física, a" : "Nesta loja, a";
  const lines = [`${intro} devolução é feita em vale-compras${credit ? ` de ${credit}` : ""}, para usar na loja.`];
  if (retention.cancel_days) lines.push(`Se preferir o reembolso, você pode pedir em até ${retention.cancel_days} dias depois de receber o vale-compras.`);
  return lines.join("\n");
}

function maskPixKey(key) {
  const value = String(key || "");
  if (value.length <= 4) return "****";
  return `${"*".repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`;
}

// Resumo para o cliente confirmar antes de registrar
function summaryText({ type, orderNumber, orderItem, quantity, reason, subReason, comment, photosCount, option, addressConfirmed, address, purchaseAddress, retention, closesInCredit, paymentBill }) {
  const lines = ["Confira o resumo da sua solicitação:", `Pedido: ${orderNumber}`, `Tipo: ${type === "exchange" ? "troca" : "devolução"}`];
  lines.push(`Produto: ${itemLabel({ description: orderItem.description, sku: orderItem.sku, quantity })}`);
  lines.push(`Motivo: ${reason.reason}${subReason ? ` - ${subReason}` : ""}`);
  if (comment) lines.push(`Comentário: ${comment}`);
  if (photosCount) lines.push(`Fotos: ${photosCount}`);

  if (option) lines.push(`Envio: ${shippingLabel(option).split("\n")[0]}`);
  else lines.push("Envio: a loja vai mandar as instruções por e-mail");

  const shownAddress = address ? addressText(address) : addressConfirmed ? addressText(purchaseAddress) : null;
  if (shownAddress) lines.push(`Endereço: ${shownAddress}`);

  if (type === "refund") {
    if (retention?.accepted) lines.push("Reembolso: vale-compras (oferta aceita)");
    else if (closesInCredit) lines.push("Reembolso: vale-compras");
    else if (paymentBill) lines.push(`Reembolso: PIX (${paymentBill.pix_type}: ${maskPixKey(paymentBill.pix_key)})`);
  }

  lines.push("Posso registrar a solicitação?");
  return clip(lines.join("\n"));
}

function shipmentLines(s) {
  if (!s) return [];
  const lines = [];
  if (s.carrier) lines.push(`Envio: ${s.carrier}${s.status ? ` (${s.status})` : ""}`);
  else if (s.status) lines.push(`Envio: ${s.status}`);
  if (s.handover_instruction) lines.push(s.handover_instruction);
  if (s.posting_code) lines.push(`Código de postagem: ${s.posting_code}`);
  if (s.posting_due_date && !s.posted_at) {
    const due = formatDate(s.posting_due_date);
    if (due) lines.push(`Postar até: ${due}`);
  }
  if (s.posting_address && !s.posted_at) lines.push(`Onde postar: ${s.posting_address}`);
  if (s.tracking_code) lines.push(`Rastreio: ${s.tracking_code}`);
  if (s.tracking_url) lines.push(`Acompanhe o envio: ${s.tracking_url}`);
  const delivered = formatDate(s.delivered_at);
  if (delivered) lines.push(`Entregue à loja em: ${delivered}`);
  return lines;
}

function trackText(reverses) {
  const blocks = reverses.map((r, i) => {
    const lines = [`Solicitação ${i + 1}${r.ecommerce_number ? ` - pedido ${r.ecommerce_number}` : ""}`, `Situação: ${r.status_name || "em andamento"}`];
    const created = formatDate(r.created_at);
    if (created) lines.push(`Criada em: ${created}`);
    for (const item of r.items || []) {
      const kind = item.is_exchange ? `troca${item.replacement_description ? ` por ${item.replacement_description}` : ""}` : "devolução";
      lines.push(`Produto: ${itemLabel(item)} (${kind})`);
    }
    if (r.replacement_order_number) lines.push(`Pedido da troca: ${r.replacement_order_number}`);
    lines.push(...shipmentLines(r.shipment));

    const c = r.store_credit;
    if (c && c.is_store_credit) {
      if (c.code) {
        lines.push(`Vale-compras: ${c.code}${money(c.value) ? ` (${money(c.value)})` : ""}`);
        const until = formatDate(c.valid_until);
        if (until) lines.push(`Válido até: ${until}`);
        if (c.bonus_code) lines.push(`Bônus: ${c.bonus_code}${money(c.bonus_value) ? ` (${money(c.bonus_value)})` : ""}`);
      } else {
        lines.push("Vale-compras: será emitido em breve");
      }
    }

    const refund = r.refund;
    if (refund) {
      const paid = formatDate(refund.paid_at);
      lines.push(`Reembolso${refund.method ? ` (${refund.method})` : ""}${money(refund.value) ? `: ${money(refund.value)}` : ""} - ${paid ? `pago em ${paid}` : "aguardando pagamento"}`);
    }
    return lines.join("\n");
  });
  return clip(blocks.join("\n\n"));
}

module.exports = {
  PIX_TYPES_TEXT: numbered(["CPF ou CNPJ", "Telefone", "E-mail", "Chave aleatória"]),
  money,
  addressText,
  itemsText,
  flatItems,
  existingText,
  reasonsText,
  subReasonsText,
  optionsText,
  offerText,
  automaticRetentionText,
  summaryText,
  trackText,
};
