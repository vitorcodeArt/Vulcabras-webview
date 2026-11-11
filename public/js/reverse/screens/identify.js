// Tela 1 - Identificação: número do pedido + CPF, CNPJ ou e-mail
import { state, reasonsForType, invalidateFrom } from "../state.js";
import { go, handleApiError, showFatal, requestHandoff } from "../flow.js";
import { api } from "../api.js";
import { trackEvent } from "../tracking.js";
import {
  render,
  heading,
  inputField,
  primaryButton,
  linkButton,
  fieldValue,
  showFieldError,
  clearFieldErrors,
  showScreenError,
  setBusy,
  on,
  onlyDigits,
  SCREEN_ERROR_SLOT,
} from "../ui.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Depois de algumas tentativas sem sucesso, oferece o atendente
const NOT_FOUND_HANDOFF_AFTER = 2;

function normalizeOrderNumber(value) {
  const cleaned = value.replace(/[#\s]/g, "");
  return /^[A-Za-z0-9._-]{1,60}$/.test(cleaned) ? cleaned : null;
}

function normalizeIdentifier(value) {
  const raw = value.trim();
  if (raw.includes("@")) return EMAIL_PATTERN.test(raw) ? raw.toLowerCase() : null;
  const digits = onlyDigits(raw);
  return digits.length === 11 || digits.length === 14 ? digits : null;
}

const TYPE_LABEL = { exchange: "a troca", refund: "a devolução", track: "o acompanhamento" };

export const identifyScreen = {
  title: "Identificação",
  render() {
    const isTrack = state.type === "track";
    render(`
      ${heading("Identifique seu pedido", `Para ${TYPE_LABEL[state.type] || "continuar"}, informe os dados da compra.`)}
      <form id="identifyForm" class="flex flex-col gap-4" novalidate>
        ${inputField("orderNumber", "Número do pedido", {
          value: state.identity?.orderNumber || "",
          placeholder: "Ex.: 1664284820905-01",
          hint: "Está no e-mail de confirmação da compra.",
          maxlength: 70,
        })}
        ${inputField("customerIdentifier", "CPF, CNPJ ou e-mail da compra", {
          value: state.identity?.identifier || "",
          placeholder: "Digite só os números ou o e-mail",
          maxlength: 200,
          autocomplete: "off",
        })}
        ${SCREEN_ERROR_SLOT}
        <div id="notFoundHelp"></div>
        ${primaryButton("identifyBtn", isTrack ? "Consultar" : "Continuar", { icon: isTrack ? "search" : "arrow-right" })}
      </form>
    `);

    on("#identifyForm", "submit", (event) => {
      event.preventDefault();
      submit();
    });
    on("#identifyBtn", "click", submit);
    showNotFoundHelp();
  },
};

function showNotFoundHelp() {
  const slot = document.getElementById("notFoundHelp");
  if (!slot || state.notFoundCount < NOT_FOUND_HANDOFF_AFTER) return;
  slot.innerHTML = `<div class="flex justify-center">${linkButton("notFoundHandoffBtn", "Não consegue localizar? Falar com atendente")}</div>`;
  on("#notFoundHandoffBtn", "click", () => requestHandoff("NOT_FOUND", { errorCode: "ORDER_NOT_FOUND" }));
}

async function submit() {
  clearFieldErrors();
  showScreenError("");

  const orderNumber = normalizeOrderNumber(fieldValue("orderNumber"));
  const identifier = normalizeIdentifier(fieldValue("customerIdentifier"));

  let valid = true;
  if (!orderNumber) {
    showFieldError("orderNumber", "Informe o número do pedido.");
    trackEvent("validation_error", { step: "identify", meta: { field: "order_number" } });
    valid = false;
  }
  if (!identifier) {
    showFieldError("customerIdentifier", "Informe um CPF (11 números), CNPJ (14 números) ou e-mail válido.");
    trackEvent("validation_error", { step: "identify", meta: { field: "customer_identifier" } });
    valid = false;
  }
  if (!valid) return;

  // Identificação nova: descarta o que dependia do pedido anterior
  const changed = !state.identity || state.identity.orderNumber !== orderNumber || state.identity.identifier !== identifier;
  state.identity = { orderNumber, identifier };

  const restore = setBusy(document.getElementById("identifyBtn"), "Buscando pedido...");
  const isTrack = state.type === "track";
  const result = await api(isTrack ? "/api/reverse/track" : "/api/reverse/prepare", {
    order_number: orderNumber,
    customer_identifier: identifier,
  });
  restore();

  if (!result.ok) {
    if (result.data.code === "ORDER_NOT_FOUND") {
      state.notFoundCount += 1;
      trackEvent("error_shown", { step: "identify", error_code: "ORDER_NOT_FOUND", meta: { attempt: state.notFoundCount } });
      showScreenError(result.data.error);
      showNotFoundHelp();
      return;
    }
    if (!handleApiError(result, "identify")) showScreenError(result.data.error);
    return;
  }

  if (isTrack) {
    state.trackResult = result.data;
    go("track");
    return;
  }

  const prepared = result.data;

  if (!prepared.eligible) {
    trackEvent("error_shown", { step: "identify", error_code: prepared.ineligibility_code || "ORDER_NOT_ELIGIBLE" });
    showFatal({
      message: prepared.ineligibility_message || "Este pedido não pode ser trocado ou devolvido no momento.",
      code: "ORDER_NOT_ELIGIBLE",
      action: prepared.existing_reverses.length > 0 ? "track" : "close",
    });
    return;
  }

  if (changed || !state.prepared) {
    state.selectedSkus = [];
    state.selection = {};
    state.address = null;
    state.addressForcedOrder = false;
    state.customer = {};
    state.paymentBill = null;
    invalidateFrom("items");
  }
  state.prepared = prepared;

  if (reasonsForType().length === 0) {
    const other = state.type === "exchange" ? "devolução" : "troca";
    const hasOther = prepared.reasons.some((r) => (state.type === "exchange" ? r.is_refund : r.is_exchange));
    trackEvent("error_shown", { step: "identify", error_code: "NO_REASONS_FOR_TYPE" });
    showFatal({
      message: hasOther
        ? `Este pedido não tem opção de ${state.type === "exchange" ? "troca" : "devolução"} disponível agora, mas você pode solicitar a ${other}.`
        : "Este pedido não tem opção de troca ou devolução disponível agora.",
      code: "NO_REASONS_FOR_TYPE",
      action: hasOther ? "close" : "handoff",
      offerRestart: hasOther,
    });
    return;
  }

  go("items", { meta: { existing_reverses: prepared.existing_reverses.length } });
}
