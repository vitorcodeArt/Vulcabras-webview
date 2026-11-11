// ======================================================
// MENSAGENS PADRÃO POSTADAS NA CONVERSA AO FIM DO FLUXO
// ======================================================
// Linguagem simples, sem jargão do Troque. A conversa é com o próprio cliente,
// então número do pedido e código de postagem podem aparecer.

// "2026-10-01" -> "01/10/2026" (o track já devolve DD/MM/AAAA, que passa direto)
function formatDate(value) {
  if (typeof value !== "string") return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value) ? value : null;
}

function requestLabel({ type, retentionAccepted }) {
  if (type === "exchange") return "troca";
  return retentionAccepted ? "devolução (com vale-compras)" : "devolução";
}

// result: retorno de mapCreate (ou { outcome: "registered" } quando a criação foi confirmada depois)
function submitConfirmationMessage(result, { type, retentionAccepted, orderNumber }) {
  const lines = [`Sua solicitação de ${requestLabel({ type, retentionAccepted })} do pedido ${orderNumber} foi registrada.`];
  const shipping = result.shipping;

  switch (result.outcome) {
    case "approved_with_shipping":
      if (shipping && shipping.is_collect) {
        lines.push(shipping.posting_code ? `A coleta será feita no endereço informado. Código de coleta: ${shipping.posting_code}.` : "A coleta será feita no endereço informado.");
      } else if (shipping) {
        if (shipping.posting_code) lines.push(`Código de postagem: ${shipping.posting_code}.`);
        const due = formatDate(shipping.posting_due_date);
        if (due) lines.push(`Faça a postagem até ${due}.`);
      }
      lines.push("As instruções completas foram enviadas para o seu e-mail.");
      break;
    case "approved_without_shipping":
      if (shipping && shipping.posting_address) lines.push(`Entregue o produto em: ${shipping.posting_address}.`);
      lines.push("As instruções foram enviadas para o seu e-mail.");
      break;
    case "pending_analysis":
      lines.push("Ela será analisada pela loja, e a resposta chegará por e-mail.");
      break;
    default:
      // approved_shipping_failed e criação confirmada depois de resposta incerta
      lines.push("A loja vai enviar as instruções de envio para o seu e-mail.");
  }

  lines.push("Se precisar de algo mais, é só chamar por aqui.");
  return lines.join("\n");
}

function trackFinishedMessage() {
  return "Consulta da sua solicitação de troca ou devolução concluída. Se precisar de algo mais, é só chamar por aqui.";
}

// Texto da mensagem com o botão de atendente, conforme o motivo da transferência
const HANDOFF_TEXTS = {
  REASON: "Para o motivo escolhido, um atendente precisa analisar sua solicitação de troca ou devolução.",
  PHOTO_REQUIRED: "Para o motivo escolhido, precisamos de fotos do produto, e um atendente vai te ajudar com isso.",
  NOT_FOUND: "Não conseguimos localizar seu pedido por aqui, mas um atendente pode te ajudar.",
  ERROR: "Não foi possível concluir sua solicitação de troca ou devolução por aqui, mas um atendente pode te ajudar.",
  CUSTOMER_REQUEST: "Certo! Um atendente pode te ajudar com sua troca ou devolução.",
};

const HANDOFF_REASONS = Object.keys(HANDOFF_TEXTS);

function handoffMessage(reason, { orderNumber } = {}) {
  const lines = [HANDOFF_TEXTS[reason] || HANDOFF_TEXTS.ERROR];
  if (orderNumber) lines.push(`Pedido: ${orderNumber}.`);
  lines.push("Toque no botão abaixo para falar com a nossa equipe.");
  return lines.join("\n");
}

module.exports = {
  HANDOFF_REASONS,
  handoffMessage,
  formatDate,
  submitConfirmationMessage,
  trackFinishedMessage,
};
