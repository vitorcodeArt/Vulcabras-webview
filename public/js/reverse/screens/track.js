// Tela 10 - Acompanhar: status, envio, vale-compras e reembolso de cada
// solicitação. Campo nulo = "ainda não aconteceu".
import { state } from "../state.js";
import { go, closeWebview } from "../flow.js";
import { api } from "../api.js";
import { render, heading, esc, money, formatDate, safeUrl, card, alertText, primaryButton, secondaryButton, setBusy, on } from "../ui.js";

const PENDING = `<span class="text-slate-400">Ainda não aconteceu</span>`;

function line(label, valueHtml) {
  return `<div class="flex justify-between gap-3 py-1.5 text-sm"><span class="text-slate-500 shrink-0">${esc(label)}</span><span class="text-slate-800 text-right">${valueHtml}</span></div>`;
}

function section(title, icon, html) {
  return `
    <div class="pt-3 mt-3 border-t border-slate-100">
      <p class="flex items-center gap-1.5 text-xs font-bold text-slate-600 uppercase tracking-wider mb-1"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${esc(title)}</p>
      ${html}
    </div>`;
}

function shipmentHtml(s) {
  if (!s) return section("Envio", "truck", `<p class="text-sm">${PENDING}</p>`);
  const tracking = safeUrl(s.tracking_url);
  return section(
    "Envio",
    "truck",
    [
      s.status ? line("Situação", esc(s.status)) : "",
      s.carrier ? line("Transportadora", esc(s.carrier)) : "",
      s.handover_instruction ? `<p class="text-xs text-slate-600 py-1">${esc(s.handover_instruction)}</p>` : "",
      s.posting_code ? line("Código de postagem", `<strong class="select-text">${esc(s.posting_code)}</strong>`) : "",
      s.posting_due_date && !s.posted_at ? line("Postar até", esc(formatDate(s.posting_due_date))) : "",
      s.posting_address && !s.posted_at ? `<p class="text-xs text-slate-600 py-1">Onde postar: ${esc(s.posting_address)}</p>` : "",
      line("Postado em", s.posted_at ? esc(formatDate(s.posted_at)) : PENDING),
      s.expected_delivery_date && !s.delivered_at ? line("Previsão de chegada", esc(formatDate(s.expected_delivery_date))) : "",
      line("Recebido pela loja", s.delivered_at ? esc(formatDate(s.delivered_at)) : PENDING),
      s.tracking_code ? line("Rastreio", esc(s.tracking_code)) : "",
      tracking ? `<a href="${esc(tracking)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 mt-1">Rastrear envio <i data-lucide="external-link" class="w-3.5 h-3.5"></i></a>` : "",
    ].join(""),
  );
}

function creditHtml(c) {
  if (!c || !c.is_store_credit) return "";
  return section(
    "Vale-compras",
    "ticket",
    c.code
      ? [
          line("Código", `<strong class="select-text">${esc(c.code)}</strong>`),
          c.value !== null ? line("Valor", esc(money(c.value))) : "",
          c.valid_until ? line("Válido até", esc(formatDate(c.valid_until))) : "",
          c.bonus_code ? line("Bônus", `<strong class="select-text">${esc(c.bonus_code)}</strong>${c.bonus_value !== null ? ` · ${esc(money(c.bonus_value))}` : ""}`) : "",
        ].join("")
      : `<p class="text-sm">${PENDING}</p>`,
  );
}

function refundHtml(r) {
  if (!r) return "";
  return section(
    "Reembolso",
    "wallet",
    [r.method ? line("Forma", esc(r.method)) : "", r.value !== null ? line("Valor", esc(money(r.value))) : "", line("Pago em", r.paid_at ? esc(formatDate(r.paid_at)) : PENDING)].join(""),
  );
}

function reverseCard(reverse) {
  const items = reverse.items
    .map(
      (item) => `
      <li class="text-sm text-slate-800">
        ${esc(item.description || item.sku)}${item.quantity > 1 ? ` · ${esc(item.quantity)} un.` : ""}
        <span class="text-xs text-slate-500">(${item.is_exchange ? "troca" : "devolução"}${item.replacement_description ? ` por ${esc(item.replacement_description)}` : ""})</span>
      </li>`,
    )
    .join("");

  return card(`
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-xs text-slate-500">${reverse.created_at ? `Aberta em ${esc(formatDate(reverse.created_at))}` : "Solicitação"}</p>
        <p class="text-base font-extrabold text-slate-900 mt-0.5">${esc(reverse.status_name || "Em andamento")}</p>
      </div>
      <span class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><i data-lucide="package-check" class="w-4 h-4"></i></span>
    </div>
    ${items ? `<ul class="mt-2 flex flex-col gap-1">${items}</ul>` : ""}
    ${reverse.replacement_order_number ? `<p class="text-xs text-slate-600 mt-2">Pedido da troca: <strong class="select-text">${esc(reverse.replacement_order_number)}</strong></p>` : ""}
    ${shipmentHtml(reverse.shipment)}
    ${creditHtml(reverse.store_credit)}
    ${refundHtml(reverse.refund)}
  `);
}

async function finish(button) {
  const restore = setBusy(button, "Encerrando...");
  // Melhor esforço: a mensagem na conversa não impede o fechamento
  await api("/api/reverse/finish", { flow: "track" });
  restore();
  closeWebview();
}

export const trackScreen = {
  title: "Acompanhar",
  render() {
    const reverses = state.trackResult?.reverses || [];

    render(`
      ${heading("Sua solicitação", state.identity?.orderNumber ? `Pedido ${state.identity.orderNumber}` : "")}
      ${
        reverses.length === 0
          ? alertText("info", "Não encontramos solicitações de troca ou devolução para este pedido.")
          : `<div class="flex flex-col gap-3">${reverses.map(reverseCard).join("")}</div>`
      }
      <div class="flex flex-col gap-2">
        ${primaryButton("trackDoneBtn", "Concluir")}
        ${reverses.length === 0 ? secondaryButton("trackNewBtn", "Fazer uma solicitação") : ""}
      </div>
    `);
    on("#trackDoneBtn", "click", (event) => finish(event.currentTarget));
    on("#trackNewBtn", "click", () => go("start", { clearHistory: true }));
  },
};
