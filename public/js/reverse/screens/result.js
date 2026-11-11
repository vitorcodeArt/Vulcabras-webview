// Tela 9 - Resultado conforme o outcome da criação. A mensagem na conversa já
// foi postada pelo servidor; aqui o cliente só fecha.
import { state } from "../state.js";
import { closeWebview } from "../flow.js";
import { render, esc, formatDate, card, primaryButton, alertText, on } from "../ui.js";

function shippingDetails(shipping) {
  if (!shipping) return "";
  const lines = [];
  if (shipping.is_collect) {
    lines.push(`<p>A transportadora vai buscar o produto no endereço informado.</p>`);
    if (shipping.posting_code) lines.push(`<p>Código da coleta: <strong class="select-text">${esc(shipping.posting_code)}</strong></p>`);
  } else {
    if (shipping.posting_code) {
      lines.push(`<p class="text-xs text-slate-500">Código de postagem</p><p class="text-2xl font-extrabold tracking-wider text-slate-900 select-text">${esc(shipping.posting_code)}</p>`);
    }
    const due = formatDate(shipping.posting_due_date);
    if (due) lines.push(`<p>Faça a postagem até <strong>${esc(due)}</strong>.</p>`);
    if (shipping.posting_address) lines.push(`<p class="text-xs text-slate-600">Onde postar: ${esc(shipping.posting_address)}</p>`);
  }
  if (shipping.carrier) lines.push(`<p class="text-xs text-slate-500">Transportadora: ${esc(shipping.carrier)}</p>`);
  if (shipping.label_in_email) lines.push(`<p class="text-xs text-slate-500">A etiqueta de envio foi para o seu e-mail.</p>`);
  return lines.length ? card(`<div class="flex flex-col gap-1.5 text-sm text-slate-700">${lines.join("")}</div>`) : "";
}

function outcomeContent(result) {
  switch (result.outcome) {
    case "approved_with_shipping":
      return {
        title: "Solicitação aprovada!",
        text: "Siga as instruções abaixo para enviar o produto. Também enviamos tudo para o seu e-mail.",
        extra: shippingDetails(result.shipping),
      };
    case "approved_without_shipping":
      return {
        title: "Solicitação aprovada!",
        text: "As instruções foram enviadas para o seu e-mail.",
        extra: result.shipping?.posting_address ? card(`<p class="text-xs text-slate-500">Entregue o produto em</p><p class="text-sm text-slate-800 mt-1">${esc(result.shipping.posting_address)}</p>`) : "",
      };
    case "pending_analysis":
      return {
        title: "Solicitação recebida",
        text: "A loja vai analisar sua solicitação e enviar a resposta para o seu e-mail.",
        extra: "",
      };
    default:
      // approved_shipping_failed ou criação confirmada depois de resposta incerta
      return {
        title: "Solicitação registrada",
        text: "A loja vai enviar as instruções de envio para o seu e-mail.",
        extra: "",
      };
  }
}

export const resultScreen = {
  title: "Pronto",
  allowBack: false,
  render() {
    const result = state.result || {};
    const content = outcomeContent(result);
    const credit = result.credit_instead_of_refund ? alertText("info", "O valor será devolvido em vale-compras.") : "";

    render(`
      <div class="flex flex-col items-center text-center gap-2 pt-4">
        <span class="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center"><i data-lucide="check-circle-2" class="w-8 h-8"></i></span>
        <h2 class="text-xl font-extrabold text-slate-900">${esc(content.title)}</h2>
        <p class="text-sm text-slate-600">${esc(content.text)}</p>
      </div>
      ${content.extra}
      ${credit}
      ${result.message_posted ? `<p class="text-xs text-slate-500 text-center">Também deixamos um resumo na conversa.</p>` : ""}
      ${primaryButton("resultCloseBtn", "Fechar")}
    `);
    on("#resultCloseBtn", "click", closeWebview);
  },
};
