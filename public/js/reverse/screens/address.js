// Tela 4 - Endereço de onde o produto sai, conforme address_step.mode,
// mais CPF/CNPJ ou e-mail quando o pedido veio sem eles.
import { state, invalidateFrom } from "../state.js";
import { goNext, refresh, flashHtml } from "../flow.js";
import { trackEvent } from "../tracking.js";
import {
  render,
  heading,
  esc,
  card,
  alertText,
  inputField,
  selectField,
  primaryButton,
  secondaryButton,
  fieldValue,
  showFieldError,
  clearFieldErrors,
  onlyDigits,
  $,
  on,
} from "../ui.js";

const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_IDS = { zipcode: "addrZip", street: "addrStreet", number: "addrNumber", neighborhood: "addrNeighborhood", city: "addrCity", state: "addrState" };

// Subetapa local: "confirm" (mostra o endereço do pedido) ou "form"
let view = null;

function addressStep() {
  return state.prepared?.address_step || { mode: "skip", missing_fields: [], missing_customer_fields: [] };
}

function effectiveMode() {
  return state.addressForcedOrder ? "locked" : addressStep().mode;
}

function orderAddress() {
  return state.prepared?.order?.address || null;
}

function formatAddress(a) {
  if (!a) return "";
  const line1 = [a.street, a.number].filter(Boolean).join(", ");
  const line2 = [a.description, a.neighborhood].filter(Boolean).join(" · ");
  const zip = a.zipcode ? String(a.zipcode).replace(/^(\d{5})(\d{3})$/, "$1-$2") : "";
  const line3 = [a.city && a.state ? `${a.city}/${a.state}` : a.city || a.state, zip].filter(Boolean).join(" · ");
  return [line1, line2, line3].filter(Boolean).map(esc).join("<br>");
}

function addressForm(initial, highlight = []) {
  const a = initial || {};
  return `
    <div class="flex flex-col gap-3">
      ${inputField("addrZip", "CEP", { value: a.zipcode ? String(a.zipcode).replace(/^(\d{5})(\d{3})$/, "$1-$2") : "", inputmode: "numeric", placeholder: "00000-000", maxlength: 9, autocomplete: "postal-code" })}
      ${inputField("addrStreet", "Rua", { value: a.street || "", autocomplete: "address-line1" })}
      <div class="grid grid-cols-2 gap-3">
        ${inputField("addrNumber", "Número", { value: a.number || "", maxlength: 30 })}
        ${inputField("addrComplement", "Complemento", { value: a.description || "", placeholder: "Opcional", autocomplete: "address-line2" })}
      </div>
      ${inputField("addrNeighborhood", "Bairro", { value: a.neighborhood || "" })}
      <div class="grid grid-cols-[1fr_96px] gap-3">
        ${inputField("addrCity", "Cidade", { value: a.city || "", autocomplete: "address-level2" })}
        ${selectField("addrState", "UF", UFS.map((uf) => ({ value: uf, label: uf })), { value: a.state || "", placeholder: "UF" })}
      </div>
    </div>
    ${highlight.length ? `<span data-highlight="${esc(highlight.join(","))}" class="hidden"></span>` : ""}`;
}

function customerFields() {
  const missing = addressStep().missing_customer_fields || [];
  if (missing.length === 0) return "";
  return `
    <div class="flex flex-col gap-3">
      <p class="text-sm text-slate-600">Precisamos também de alguns dados que não vieram no pedido:</p>
      ${missing.includes("document") ? inputField("custDocument", "CPF ou CNPJ", { value: state.customer.document || "", inputmode: "numeric", maxlength: 18 }) : ""}
      ${missing.includes("email") ? inputField("custEmail", "E-mail", { value: state.customer.email || "", type: "email", maxlength: 200, autocomplete: "email" }) : ""}
    </div>`;
}

export const addressScreen = {
  title: "Endereço",
  onEnter() {
    view = null;
  },
  onBack() {
    // Do formulário volta para a confirmação do endereço do pedido
    if (view === "form" && effectiveMode() === "confirm" && (addressStep().missing_fields || []).length === 0 && orderAddress()) {
      view = "confirm";
      refresh();
      return true;
    }
    return false;
  },
  render() {
    const mode = effectiveMode();
    const step = addressStep();
    const missing = step.missing_fields || [];
    const order = orderAddress();
    const flash = flashHtml();

    if (!view || (mode !== "confirm" && view === "confirm")) {
      view = mode === "ask_full_address" || state.address || (mode === "confirm" && (missing.length > 0 || !order)) ? "form" : "confirm";
    }
    state.addressMode = mode;

    let body = "";
    if (mode === "confirm" && view === "confirm") {
      body = `
        ${card(`<p class="text-xs font-bold text-slate-500 mb-1">Endereço da compra</p><p class="text-sm text-slate-800 leading-relaxed">${formatAddress(order)}</p>`)}`;
    } else if (mode === "confirm" || mode === "ask_full_address") {
      // ask_full_address: pede tudo, sem mostrar o endereço do pedido
      const initial = state.address || (mode === "confirm" && missing.length > 0 ? order : null);
      body = `
        ${mode === "confirm" && missing.length > 0 && !state.address ? alertText("info", "Complete os dados que faltam no endereço da compra.") : ""}
        ${addressForm(initial, missing)}`;
    } else if (mode === "locked" && order) {
      body = card(`<p class="text-xs font-bold text-slate-500 mb-1">Endereço da compra</p><p class="text-sm text-slate-800 leading-relaxed">${formatAddress(order)}</p>
        <p class="text-xs text-slate-500 mt-2">A devolução usa o endereço da compra.</p>`);
    }

    const showsAddress = mode === "confirm" || mode === "ask_full_address" || (mode === "locked" && order);
    const title = showsAddress ? (view === "confirm" ? "O produto sai deste endereço?" : "De onde o produto vai sair?") : "Seus dados";

    render(`
      ${heading(title, view === "confirm" ? "É daqui que o produto será coletado ou de onde você vai levá-lo ao ponto de entrega." : "")}
      ${flash}
      ${body}
      ${customerFields()}
      <div class="flex flex-col gap-2">
        ${
          view === "confirm" && mode === "confirm"
            ? `${primaryButton("addrConfirmBtn", "Sim, sai deste endereço", { icon: "check" })}${secondaryButton("addrChangeBtn", "Usar outro endereço")}`
            : primaryButton("addrNextBtn", "Continuar", { icon: "arrow-right" })
        }
      </div>
    `);

    // Destaca os campos que faltam no endereço da compra
    const highlight = $("[data-highlight]");
    if (highlight) {
      highlight.dataset.highlight.split(",").forEach((field) => {
        if (FIELD_IDS[field] && !state.address) showFieldError(FIELD_IDS[field], "Preencha este campo.");
      });
    }

    on("#addrZip", "input", (event) => {
      const d = onlyDigits(event.target.value).slice(0, 8);
      event.target.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    });
    on("#addrConfirmBtn", "click", () => submit({ useOrder: true }));
    on("#addrChangeBtn", "click", () => {
      view = "form";
      trackEvent("step_completed", { step: "address", meta: { choice: "change" } });
      refresh();
    });
    on("#addrNextBtn", "click", () => submit({ useOrder: mode === "locked" || mode === "skip" }));
  },
};

function readAddress() {
  const address = {
    zipcode: onlyDigits(fieldValue("addrZip")),
    street: fieldValue("addrStreet"),
    number: fieldValue("addrNumber"),
    description: fieldValue("addrComplement"),
    neighborhood: fieldValue("addrNeighborhood"),
    city: fieldValue("addrCity"),
    state: fieldValue("addrState"),
  };

  const errors = [];
  if (address.zipcode.length !== 8) errors.push(["addrZip", "CEP deve ter 8 números.", "zipcode"]);
  if (address.street.length < 2) errors.push(["addrStreet", "Informe a rua.", "street"]);
  if (!/\d/.test(address.number)) errors.push(["addrNumber", "Informe o número (use o número do imóvel).", "number"]);
  if (address.neighborhood.length < 2) errors.push(["addrNeighborhood", "Informe o bairro.", "neighborhood"]);
  if (address.city.length < 2) errors.push(["addrCity", "Informe a cidade.", "city"]);
  if (!UFS.includes(address.state)) errors.push(["addrState", "Escolha a UF.", "state"]);

  if (!address.description) delete address.description;
  return { address, errors };
}

function readCustomer() {
  const missing = addressStep().missing_customer_fields || [];
  const customer = {};
  const errors = [];
  if (missing.includes("document")) {
    customer.document = onlyDigits(fieldValue("custDocument"));
    if (customer.document.length !== 11 && customer.document.length !== 14) errors.push(["custDocument", "Informe um CPF (11 números) ou CNPJ (14 números).", "document"]);
  }
  if (missing.includes("email")) {
    customer.email = fieldValue("custEmail").toLowerCase();
    if (!EMAIL_PATTERN.test(customer.email)) errors.push(["custEmail", "Informe um e-mail válido.", "email"]);
  }
  return { customer, errors };
}

function submit({ useOrder }) {
  clearFieldErrors();
  let address = null;
  const errors = [];

  if (!useOrder) {
    const read = readAddress();
    address = read.address;
    errors.push(...read.errors);
  }
  const { customer, errors: customerErrors } = readCustomer();
  errors.push(...customerErrors);

  if (errors.length > 0) {
    errors.forEach(([id, message, field]) => {
      showFieldError(id, message);
      trackEvent("validation_error", { step: "address", meta: { field } });
    });
    const first = $(`#${errors[0][0]}`);
    if (first) first.focus();
    return;
  }

  // Endereço diferente muda as opções de envio
  if (JSON.stringify(address) !== JSON.stringify(state.address)) invalidateFrom("shipping");
  state.address = address;
  state.customer = customer;

  goNext("address", { meta: { choice: address ? "informed" : "order", step_mode: state.addressMode } });
}
