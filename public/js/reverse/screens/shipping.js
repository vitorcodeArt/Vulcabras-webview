// Tela 6 - Envio: opções da cotação (só as que podem ser escolhidas).
// A cotação é a chamada mais cara: uma por decisão (itens, endereço, retenção).
import { state, identityBody, itemsPayload, retentionAccepted } from "../state.js";
import { goNext, handleApiError, flashHtml, currentStep } from "../flow.js";
import { api } from "../api.js";
import { trackEvent } from "../tracking.js";
import { render, heading, esc, loadingBlock, alertText, primaryButton, $all, on, showScreenError, SCREEN_ERROR_SLOT } from "../ui.js";

let loading = false;
let selectedIndex = null;

function quoteBody() {
  const body = {
    ...identityBody(),
    type: state.type,
    items: itemsPayload(),
    retention_accepted: retentionAccepted(),
  };
  if (state.address) body.address = state.address;
  return body;
}

async function load() {
  loading = true;
  render(loadingBlock("Buscando as opções de envio. Isso pode levar alguns segundos..."));
  const body = quoteBody();
  const key = JSON.stringify(body);
  const result = await api("/api/reverse/quote", body);
  loading = false;
  // O cliente voltou enquanto a cotação carregava
  if (currentStep() !== "shipping") return;

  if (!result.ok) {
    if (handleApiError(result, "shipping")) return;
    render(`
      ${alertText("error", result.data.error)}
      ${primaryButton("quoteRetryBtn", "Tentar novamente", { icon: "rotate-cw" })}`);
    on("#quoteRetryBtn", "click", load);
    return;
  }

  state.quote = result.data;
  state.quoteKey = key;
  state.shippingToken = null;
  selectedIndex = state.quote.options.length === 1 ? 0 : null;
  show();
}

function optionCard(option, index) {
  const selected = index === selectedIndex;
  const icon = option.is_store_dropoff ? "store" : option.is_collect ? "truck" : "map-pin";
  const how = option.is_store_dropoff ? "Entregar em uma loja física" : option.is_collect ? "Coleta no endereço informado" : "Você leva até um ponto de postagem";

  return `
    <label class="flex items-start gap-3 p-3.5 rounded-2xl border ${selected ? "border-blue-500 ring-2 ring-blue-500/20 bg-white" : "border-slate-200 bg-white"} shadow-sm cursor-pointer">
      <input type="radio" name="shipOption" value="${index}" ${selected ? "checked" : ""} class="mt-1 accent-blue-600 w-4 h-4 shrink-0" />
      <span class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
      <span class="flex-1 min-w-0 text-sm">
        <span class="block font-bold text-slate-900">${esc(how)}</span>
        ${option.name ? `<span class="block text-xs text-slate-500 mt-0.5">${esc(option.name)}</span>` : ""}
        ${option.posting_address_name ? `<span class="block text-xs text-slate-700 mt-2 font-semibold">${esc(option.posting_address_name)}</span>` : ""}
        ${option.posting_address ? `<span class="block text-xs text-slate-600 mt-0.5">${esc(option.posting_address)}</span>` : ""}
        ${option.opening_hours ? `<span class="block text-xs text-slate-500 mt-1">Horário: ${esc(option.opening_hours)}</span>` : ""}
      </span>
    </label>`;
}

function show() {
  const options = state.quote.options;
  const flash = flashHtml();

  if (options.length === 0) {
    render(`
      ${heading("Envio do produto")}
      ${flash}
      ${alertText("info", "A loja vai definir a melhor forma de envio e mandar as instruções para o seu e-mail depois que a solicitação for registrada.")}
      ${primaryButton("shipNextBtn", "Continuar", { icon: "arrow-right" })}`);
    on("#shipNextBtn", "click", () => {
      state.shippingToken = null;
      goNext("shipping", { meta: { options: 0 } });
    });
    return;
  }

  render(`
    ${heading("Como você quer enviar o produto?", "Escolha uma das opções disponíveis.")}
    ${flash}
    <div class="flex flex-col gap-3">${options.map(optionCard).join("")}</div>
    ${SCREEN_ERROR_SLOT}
    ${primaryButton("shipNextBtn", "Continuar", { icon: "arrow-right", disabled: selectedIndex === null })}
  `);

  $all('input[name="shipOption"]').forEach((input) =>
    input.addEventListener("change", () => {
      selectedIndex = Number(input.value);
      show();
    }),
  );
  on("#shipNextBtn", "click", () => {
    const option = options[selectedIndex];
    if (!option) {
      showScreenError("Escolha uma forma de envio.");
      trackEvent("validation_error", { step: "shipping", meta: { field: "shipping_option" } });
      return;
    }
    state.shippingToken = option.option_token;
    goNext("shipping", { meta: { options: options.length, is_collect: option.is_collect, is_store_dropoff: option.is_store_dropoff } });
  });
}

export const shippingScreen = {
  title: "Envio",
  onEnter() {
    // Mantém a escolha anterior se a cotação ainda vale
    if (state.quote && state.shippingToken) {
      const index = state.quote.options.findIndex((o) => o.option_token === state.shippingToken);
      selectedIndex = index >= 0 ? index : null;
    }
  },
  render() {
    if (loading) return;
    if (!state.quote || state.quoteKey !== JSON.stringify(quoteBody())) {
      load();
      return;
    }
    show();
  },
};
