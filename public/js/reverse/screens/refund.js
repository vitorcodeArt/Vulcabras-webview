// Tela 7 - Dados para reembolso (pedido pago por transferência, devolução sem
// vale-compras): PIX ou conta bancária, com tela de conferência.
import { state } from "../state.js";
import { goNext, refresh, flashHtml } from "../flow.js";
import { trackEvent } from "../tracking.js";
import {
  render,
  heading,
  esc,
  card,
  inputField,
  selectField,
  primaryButton,
  secondaryButton,
  fieldValue,
  showFieldError,
  clearFieldErrors,
  onlyDigits,
  $all,
  on,
} from "../ui.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIX_TYPES = ["CPF ou CNPJ", "Telefone", "E-mail", "Chave aleatória"];
const ACCOUNT_TYPES = ["Corrente", "Poupança"];

// Subetapa: "form" ou "review"
let view = "form";
// Rascunho do formulário (inclui o método escolhido)
let draft = { method: "pix" };

function methodToggle() {
  const option = (value, label, icon) => `
    <button type="button" data-method="${value}" aria-pressed="${draft.method === value}"
      class="flex-1 h-11 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 ${
        draft.method === value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700"
      }">
      <i data-lucide="${icon}" class="w-4 h-4"></i>${esc(label)}
    </button>`;
  return `<div class="flex gap-2">${option("pix", "PIX", "zap")}${option("bank", "Conta bancária", "landmark")}</div>`;
}

function formHtml() {
  if (draft.method === "pix") {
    return `
      ${selectField("pixType", "Tipo de chave PIX", PIX_TYPES.map((t) => ({ value: t, label: t })), { value: draft.pix_type || "" })}
      ${inputField("pixKey", "Chave PIX", { value: draft.pix_key || "", maxlength: 200 })}`;
  }
  return `
    ${inputField("bankCode", "Código do banco", { value: draft.bank_code || "", inputmode: "numeric", placeholder: "Ex.: 001", maxlength: 20 })}
    <div class="grid grid-cols-2 gap-3">
      ${inputField("bankAgency", "Agência", { value: draft.bank_agency || "", inputmode: "numeric", maxlength: 20 })}
      ${inputField("bankAccount", "Conta com dígito", { value: draft.bank_account || "", placeholder: "Ex.: 12345-6", maxlength: 30 })}
    </div>
    ${selectField("bankAccountType", "Tipo de conta", ACCOUNT_TYPES.map((t) => ({ value: t, label: t })), { value: draft.bank_account_type || "" })}`;
}

function saveDraft() {
  if (draft.method === "pix") {
    draft.pix_type = fieldValue("pixType");
    draft.pix_key = fieldValue("pixKey");
  } else {
    draft.bank_code = fieldValue("bankCode");
    draft.bank_agency = fieldValue("bankAgency");
    draft.bank_account = fieldValue("bankAccount");
    draft.bank_account_type = fieldValue("bankAccountType");
  }
}

// Mesmas regras do servidor (a validação do servidor é a que vale)
function validate() {
  const errors = [];
  if (draft.method === "pix") {
    const type = draft.pix_type;
    let key = (draft.pix_key || "").trim();
    if (!PIX_TYPES.includes(type)) errors.push(["pixType", "Escolha o tipo de chave."]);
    if (type === "CPF ou CNPJ") {
      key = onlyDigits(key);
      if (key.length !== 11 && key.length !== 14) errors.push(["pixKey", "Informe um CPF (11 números) ou CNPJ (14 números)."]);
    } else if (type === "Telefone") {
      key = onlyDigits(key);
      if (key.length < 10 || key.length > 13) errors.push(["pixKey", "Informe o telefone com DDD."]);
    } else if (type === "E-mail") {
      key = key.toLowerCase();
      if (!EMAIL_PATTERN.test(key)) errors.push(["pixKey", "Informe um e-mail válido."]);
    } else if (!key) {
      errors.push(["pixKey", "Informe a chave PIX."]);
    }
    return { errors, bill: { is_pix: true, pix_type: type, pix_key: key } };
  }

  const code = onlyDigits(draft.bank_code);
  const agency = (draft.bank_agency || "").trim();
  const account = (draft.bank_account || "").trim();
  if (!code) errors.push(["bankCode", "Informe o código do banco."]);
  if (!/^[0-9xX-]{1,20}$/.test(agency)) errors.push(["bankAgency", "Informe a agência (só números)."]);
  if (!/^[0-9xX-]{1,30}$/.test(account)) errors.push(["bankAccount", "Informe a conta (números e dígito)."]);
  if (!ACCOUNT_TYPES.includes(draft.bank_account_type)) errors.push(["bankAccountType", "Escolha o tipo de conta."]);
  return {
    errors,
    bill: { is_pix: false, bank_code: code, bank_agency: agency, bank_account: account, bank_account_type: draft.bank_account_type },
  };
}

function reviewRows(bill) {
  const rows = bill.is_pix
    ? [
        ["Forma", "PIX"],
        ["Tipo de chave", bill.pix_type],
        ["Chave", bill.pix_key],
      ]
    : [
        ["Forma", "Conta bancária"],
        ["Banco", bill.bank_code],
        ["Agência", bill.bank_agency],
        ["Conta", bill.bank_account],
        ["Tipo", bill.bank_account_type],
      ];
  return rows
    .map(([label, value]) => `<div class="flex justify-between gap-3 py-2 border-b border-slate-100 last:border-0 text-sm"><span class="text-slate-500">${esc(label)}</span><span class="font-semibold text-slate-900 text-right break-all select-text">${esc(value)}</span></div>`)
    .join("");
}

export const refundScreen = {
  title: "Reembolso",
  onEnter() {
    view = "form";
  },
  onBack() {
    if (view === "review") {
      view = "form";
      refresh();
      return true;
    }
    return false;
  },
  render() {
    const flash = flashHtml();

    if (view === "review" && state.paymentBill) {
      render(`
        ${heading("Confira os dados do reembolso", "O valor será enviado para esta conta. Confira com atenção.")}
        ${flash}
        ${card(reviewRows(state.paymentBill))}
        <div class="flex flex-col gap-2">
          ${primaryButton("refundConfirmBtn", "Os dados estão corretos", { icon: "check" })}
          ${secondaryButton("refundEditBtn", "Corrigir")}
        </div>`);
      on("#refundConfirmBtn", "click", () => goNext("refund", { meta: { method: state.paymentBill.is_pix ? "pix" : "bank" } }));
      on("#refundEditBtn", "click", () => {
        view = "form";
        refresh();
      });
      return;
    }

    render(`
      ${heading("Para onde enviamos o reembolso?", "Este pedido foi pago por transferência, então precisamos de uma conta para devolver o valor.")}
      ${flash}
      ${methodToggle()}
      <div class="flex flex-col gap-3">${formHtml()}</div>
      ${primaryButton("refundNextBtn", "Continuar", { icon: "arrow-right" })}`);

    $all("[data-method]").forEach((button) =>
      button.addEventListener("click", () => {
        saveDraft();
        draft.method = button.dataset.method;
        refresh();
      }),
    );
    on("#refundNextBtn", "click", () => {
      clearFieldErrors();
      saveDraft();
      const { errors, bill } = validate();
      if (errors.length > 0) {
        errors.forEach(([id, message]) => {
          showFieldError(id, message);
          trackEvent("validation_error", { step: "refund", meta: { field: id } });
        });
        return;
      }
      state.paymentBill = bill;
      view = "review";
      trackEvent("step_completed", { step: "refund", meta: { substep: "form" } });
      refresh();
    });
  },
};
