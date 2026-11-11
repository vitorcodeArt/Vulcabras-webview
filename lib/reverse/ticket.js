// ======================================================
// TEXTO DO TICKET DO ZENDESK (nota interna)
// ======================================================
// Dados do cliente mascarados (decisão D): primeiro nome, documento e e-mail
// mascarados como o Troque devolve. Nunca o CPF/e-mail digitado.

const TYPE_LABEL = { exchange: "Troca", refund: "Devolução" };
const ID_KIND_LABEL = { cpf: "CPF", cnpj: "CNPJ", email: "e-mail" };

function firstName(name) {
  return typeof name === "string" && name.trim() ? name.trim().split(/\s+/)[0] : "não informado";
}

// selection: itens validados (com reason.description, sub_reason, client_comment)
function buildTicketBody({ flow, orderNumber, identifierKind, customer, type, selection, photoCountBySku }) {
  const lines = [
    "Solicitação de troca/devolução enviada pela webview.",
    "",
    `Conversa: ${flow.conversationId}`,
    `Marca: ${flow.brand?.label || flow.store}`,
    `Pedido: ${orderNumber}`,
    `Cliente: ${firstName(customer?.name)}`,
    `Documento: ${customer?.document_masked || "não informado"}`,
    `E-mail: ${customer?.email_masked || "não informado"}`,
    `Identificado por: ${ID_KIND_LABEL[identifierKind] || "não informado"}`,
    `Tipo: ${TYPE_LABEL[type] || type}`,
    "",
    "Itens:",
  ];

  selection.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.productDescription || item.sku} (SKU ${item.sku}) - quantidade ${item.quantity}`);
    lines.push(`   Motivo: ${item.reason.description}${item.reason.sub_reason ? ` / ${item.reason.sub_reason}` : ""}`);
    if (item.reason.client_comment) lines.push(`   Comentário do cliente: ${item.reason.client_comment}`);
    const photos = photoCountBySku[item.sku] || 0;
    if (photos > 0) lines.push(`   Fotos anexadas: ${photos}`);
  });

  const total = Object.values(photoCountBySku).reduce((sum, n) => sum + n, 0);
  lines.push("", `Total de fotos: ${total}`, `Sessão do fluxo: ${flow.sessionId || "não informada"}`);
  return lines.join("\n");
}

// Nota final com o resultado da criação da reversa (ou o código do erro)
function buildResultNote({ result = null, errorCode = null }) {
  if (result) {
    return [
      "Resultado no Troque:",
      `Reversa: ${result.reverse_order_id || "não informada"}`,
      `Resultado: ${result.outcome || "não informado"}`,
      `Status: ${result.status || "não informado"}`,
      result.shipping?.posting_code ? `Código de postagem: ${result.shipping.posting_code}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `A reversa não foi criada no Troque (código: ${errorCode || "desconhecido"}). As fotos continuam neste ticket para uma nova tentativa.`;
}

module.exports = { buildTicketBody, buildResultNote };
