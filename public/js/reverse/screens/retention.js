// Tela 5 - Retenção (só devolução): vale-compras no lugar do reembolso.
// offer: o cliente escolhe (nível 2 só depois de recusar o 1). automatic e
// forced: só informa. none/indisponível: etapa pulada sem citar o assunto.
import { state, identityBody, itemsPayload, invalidateFrom } from "../state.js";
import { goNext, handleApiError, flashHtml, currentStep } from "../flow.js";
import { api } from "../api.js";
import { trackEvent } from "../tracking.js";
import { render, heading, esc, money, card, loadingBlock, alertText, primaryButton, secondaryButton, on, SCREEN_ERROR_SLOT, showScreenError } from "../ui.js";

let loading = false;

async function load() {
  loading = true;
  render(loadingBlock("Verificando as opções para sua devolução..."));

  const body = { ...identityBody(), type: "refund", items: itemsPayload() };
  if (state.retention.shippingToken) body.shipping_option_token = state.retention.shippingToken;

  const result = await api("/api/reverse/retention", body);
  loading = false;
  // O cliente voltou enquanto a consulta carregava
  if (currentStep() !== "retention") return;

  if (!result.ok) {
    if (handleApiError(result, "retention")) return;
    render(`
      ${alertText("error", result.data.error)}
      ${primaryButton("retentionRetryBtn", "Tentar novamente", { icon: "rotate-cw" })}`);
    on("#retentionRetryBtn", "click", load);
    return;
  }

  state.retention.offer = result.data;
  state.retention.shownLevel = null;
  show();
}

function sortedOffers() {
  return (state.retention.offer?.offers || []).filter((o) => o.level === 1 || o.level === 2).sort((a, b) => a.level - b.level);
}

function decide(decision, meta) {
  const previous = JSON.stringify(state.retention.decision);
  state.retention.decision = decision;
  // A decisão muda a cotação (vale-compras transforma a devolução em troca)
  if (previous !== JSON.stringify(decision)) invalidateFrom("shipping");
  goNext("retention", { meta });
}

function show() {
  const offer = state.retention.offer;
  const flash = flashHtml();

  if (!offer || !offer.available || offer.mode === "none") {
    state.retention.decision = null;
    // Etapa pulada: não entra no histórico
    goNext("retention", { replace: true, meta: { retention_mode: "none" } });
    return;
  }

  if (offer.mode === "automatic" || offer.mode === "forced") {
    const value = offer.offers?.[0]?.credit_value;
    render(`
      ${heading("Seu valor volta em vale-compras")}
      ${flash}
      ${card(`
        <div class="flex items-center gap-3">
          <span class="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0"><i data-lucide="ticket" class="w-5 h-5"></i></span>
          <p class="text-sm text-slate-700">
            ${offer.mode === "forced" ? "Com a entrega em loja física, a" : "Nesta loja, a"} devolução é feita em vale-compras${value ? ` de <strong>${esc(money(value))}</strong>` : ""}, para usar na loja.
          </p>
        </div>
        ${offer.cancel_days ? `<p class="text-xs text-slate-500 mt-3">Se preferir o reembolso, você pode pedir em até ${esc(offer.cancel_days)} dias depois de receber o vale-compras.</p>` : ""}
      `)}
      ${primaryButton("retentionOkBtn", "Entendi, continuar", { icon: "arrow-right" })}
    `);
    on("#retentionOkBtn", "click", () => decide(null, { retention_mode: offer.mode }));
    return;
  }

  // mode "offer"
  const offers = sortedOffers();
  if (offers.length === 0) {
    state.retention.decision = { accepted: false };
    goNext("retention", { replace: true, meta: { retention_mode: "offer_empty" } });
    return;
  }

  const current = offers.find((o) => o.level === state.retention.shownLevel) || offers[0];
  state.retention.shownLevel = current.level;
  const nextOffer = offers.find((o) => o.level > current.level);
  const bonus = Number(current.bonus_value) > 0;

  render(`
    ${heading(current.level === 2 ? "Temos uma oferta ainda melhor" : "Que tal um vale-compras?", "Em vez do reembolso, você pode receber um vale-compras para usar na loja.")}
    ${flash}
    ${card(`
      <div class="flex flex-col gap-2 text-center py-2">
        <span class="text-xs font-bold text-emerald-700 uppercase tracking-wider">Vale-compras</span>
        <span class="text-3xl font-extrabold text-slate-900">${esc(money(current.credit_value))}</span>
        ${
          bonus
            ? `<span class="text-sm text-slate-600">Valor da devolução ${esc(money(current.retained_value))} <strong class="text-emerald-700">+ ${esc(money(current.bonus_value))} de bônus</strong></span>`
            : `<span class="text-sm text-slate-600">Mesmo valor da devolução</span>`
        }
      </div>
    `)}
    ${SCREEN_ERROR_SLOT}
    <div class="flex flex-col gap-2">
      ${primaryButton("retentionAcceptBtn", "Quero o vale-compras", { icon: "ticket" })}
      ${secondaryButton("retentionRefuseBtn", "Prefiro o reembolso")}
    </div>
  `);

  on("#retentionAcceptBtn", "click", () => decide({ accepted: true, level: current.level }, { retention_mode: "offer", accepted: true, level: current.level }));
  on("#retentionRefuseBtn", "click", () => {
    trackEvent("step_completed", { step: "retention", meta: { retention_mode: "offer", accepted: false, level: current.level } });
    if (nextOffer) {
      state.retention.shownLevel = nextOffer.level;
      show();
      return;
    }
    decide({ accepted: false }, { retention_mode: "offer", accepted: false });
  });
  showScreenError("");
}

export const retentionScreen = {
  title: "Devolução",
  onEnter() {
    // Voltando a esta tela, a oferta recomeça do nível 1
    if (state.retention.offer) state.retention.shownLevel = null;
  },
  render() {
    if (loading) return;
    if (!state.retention.offer) {
      load();
      return;
    }
    show();
  },
};
