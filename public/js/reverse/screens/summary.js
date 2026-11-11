// Tela 8 - Resumo e confirmação. O botão Confirmar desabilita no primeiro
// clique. Resposta incerta (CREATION_UNCONFIRMED) nunca reenvia.
import { state, identityBody, itemsPayload, findOrderItem, retentionAccepted, closesInCredit, invalidateFrom } from "../state.js";
import { go, handleApiError, stepForField, flashHtml } from "../flow.js";
import { api } from "../api.js";
import { trackEvent } from "../tracking.js";
import { render, heading, esc, money, card, primaryButton, showScreenError, setBusy, on, SCREEN_ERROR_SLOT } from "../ui.js";

let submitting = false;

function row(label, valueHtml) {
  return `<div class="py-2.5 border-b border-slate-100 last:border-0"><p class="text-xs font-bold text-slate-500">${esc(label)}</p><div class="text-sm text-slate-800 mt-0.5">${valueHtml}</div></div>`;
}

function itemsHtml() {
  return state.selectedSkus
    .map((sku) => {
      const entry = state.selection[sku];
      const item = findOrderItem(sku);
      return `
        <div class="py-1.5">
          <p class="font-semibold">${esc(item?.description || sku)}${entry.quantity > 1 ? ` · ${esc(entry.quantity)} un.` : ""}</p>
          <p class="text-xs text-slate-500">${esc(entry.reason)}${entry.sub_reason ? ` · ${esc(entry.sub_reason)}` : ""}</p>
        </div>`;
    })
    .join("");
}

function addressHtml() {
  const a = state.address;
  if (a) {
    return esc(`${a.street}, ${a.number}${a.description ? ` - ${a.description}` : ""} · ${a.neighborhood} · ${a.city}/${a.state}`);
  }
  return "Endereço da compra";
}

function shippingHtml() {
  const option = state.quote?.options.find((o) => o.option_token === state.shippingToken);
  if (!option) return "A loja vai enviar as instruções por e-mail";
  const how = option.is_store_dropoff ? "Entrega em loja física" : option.is_collect ? "Coleta no endereço" : "Postagem em ponto de envio";
  return `${esc(how)}${option.name ? ` <span class="text-slate-500">· ${esc(option.name)}</span>` : ""}${
    option.posting_address_name ? `<br><span class="text-xs text-slate-500">${esc(option.posting_address_name)}</span>` : ""
  }`;
}

function valueReturnHtml() {
  if (state.type === "exchange") return "Troca do produto";
  if (retentionAccepted()) {
    const offer = (state.retention.offer?.offers || []).find((o) => o.level === state.retention.decision.level);
    return `Vale-compras${offer ? ` de <strong>${esc(money(offer.credit_value))}</strong>` : ""}`;
  }
  if (closesInCredit()) return "Vale-compras";
  if (sendsPaymentBill()) return state.paymentBill.is_pix ? "Reembolso por PIX" : "Reembolso em conta bancária";
  return "Reembolso";
}

// Também vale quando o servidor pediu os dados (campo payment_bill) mesmo sem
// a etapa ter sido prevista no navegador
function sendsPaymentBill() {
  return state.type === "refund" && Boolean(state.paymentBill) && !retentionAccepted();
}

function submitBody() {
  const body = { ...identityBody(), type: state.type, items: itemsPayload({ full: true }) };
  if (state.address) body.address = state.address;
  if (Object.keys(state.customer).length > 0) body.customer = state.customer;
  if (state.type === "refund" && state.retention.decision) body.retention = state.retention.decision;
  if (state.shippingToken) body.shipping_option_token = state.shippingToken;
  if (sendsPaymentBill()) body.payment_bill = state.paymentBill;
  return body;
}

async function confirm(button) {
  if (submitting) return;
  submitting = true;
  showScreenError("");
  const restore = setBusy(button, "Enviando...");

  const result = await api("/api/reverse/submit", submitBody());
  submitting = false;

  if (result.ok) {
    state.result = result.data;
    go("result", { clearHistory: true, meta: { outcome: result.data.outcome } });
    return;
  }

  const { code, action, field, error } = result.data;

  // Pode ter sido criada: nunca reenviar; orienta acompanhar
  if (code === "CREATION_UNCONFIRMED") {
    handleApiError(result, "summary");
    return;
  }

  if (action === "requote") {
    trackEvent("error_shown", { step: "summary", error_code: code });
    invalidateFrom("shipping");
    state.flash = { kind: "warn", text: error };
    go("shipping");
    return;
  }

  if (action === "refresh_retention") {
    trackEvent("error_shown", { step: "summary", error_code: code });
    const shippingToken = code === "RETENTION_OFFER_CHANGED" ? state.shippingToken : null;
    invalidateFrom("retention");
    state.retention.shippingToken = shippingToken;
    state.flash = { kind: "warn", text: error };
    go("retention");
    return;
  }

  if (action === "retry_without_address") {
    trackEvent("error_shown", { step: "summary", error_code: code });
    state.address = null;
    state.addressForcedOrder = true;
    invalidateFrom("shipping");
    state.flash = { kind: "warn", text: error };
    go("address");
    return;
  }

  if (action === "fix_input") {
    trackEvent("error_shown", { step: "summary", error_code: code, meta: { field: field || null } });
    const step = stepForField(field);
    if (step && step !== "summary") {
      if (step === "reasons") {
        const match = /^items\[(\d+)\]/.exec(field || "");
        state.reasonIndex = match ? Math.min(Number(match[1]), state.selectedSkus.length - 1) : 0;
      }
      state.flash = { kind: "error", text: error };
      go(step);
      return;
    }
    restore();
    showScreenError(error);
    return;
  }

  if (handleApiError(result, "summary")) return;

  // retry: libera o botão para nova tentativa (o servidor protege contra duplicidade)
  restore();
  showScreenError(error);
}

export const summaryScreen = {
  title: "Resumo",
  onEnter() {
    submitting = false;
  },
  render() {
    const flash = flashHtml();
    render(`
      ${heading("Confira sua solicitação", "Depois de confirmar, não é possível alterar.")}
      ${flash}
      ${card(`
        ${row("Pedido", esc(state.identity.orderNumber))}
        ${row("Tipo", state.type === "exchange" ? "Troca" : "Devolução")}
        ${row(state.selectedSkus.length > 1 ? "Produtos e motivos" : "Produto e motivo", itemsHtml())}
        ${state.addressMode && state.addressMode !== "skip" ? row("Endereço", addressHtml()) : ""}
        ${row("Envio", shippingHtml())}
        ${row(state.type === "exchange" ? "Solicitação" : "Valor volta como", valueReturnHtml())}
      `)}
      ${SCREEN_ERROR_SLOT}
      ${primaryButton("summaryConfirmBtn", "Confirmar solicitação", { icon: "check" })}
    `);
    on("#summaryConfirmBtn", "click", (event) => confirm(event.currentTarget));
  },
};
