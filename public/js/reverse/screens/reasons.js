// Tela 3 - Motivo de cada item (um motivo por item; submotivo e comentário
// conforme as flags). Motivos que pedem foto ficam bloqueados até a Fase 3.
import { state, reasonsForType, findReason, findOrderItem, invalidateFrom } from "../state.js";
import { goNext, refresh, requestHandoff, flashHtml } from "../flow.js";
import { trackEvent } from "../tracking.js";
import {
  render,
  heading,
  esc,
  alertBox,
  primaryButton,
  secondaryButton,
  textareaField,
  bindCounter,
  showFieldError,
  clearFieldErrors,
  $,
  $all,
  on,
} from "../ui.js";

const MAX_COMMENT = 1000;
// Fase 2: ainda não há envio de fotos
const PHOTOS_ENABLED = false;

function currentSku() {
  return state.selectedSkus[state.reasonIndex];
}

function radioOption(name, value, label, checked, extra = "") {
  return `
    <label class="flex items-start gap-3 p-3 rounded-xl border ${checked ? "border-blue-500 bg-blue-50/50" : "border-slate-200 bg-white"} cursor-pointer">
      <input type="radio" name="${name}" value="${esc(value)}" ${checked ? "checked" : ""} class="mt-0.5 accent-blue-600 w-4 h-4 shrink-0" />
      <span class="flex-1 text-sm text-slate-800 leading-snug">${esc(label)}${extra}</span>
    </label>`;
}

function blockedReason(reason) {
  if (!reason) return null;
  if (reason.handoff) return "REASON";
  if (reason.has_image && !PHOTOS_ENABLED) return "PHOTO_REQUIRED";
  return null;
}

export const reasonsScreen = {
  title: "Motivo",
  onBack() {
    if (state.reasonIndex > 0) {
      state.reasonIndex -= 1;
      refresh();
      return true;
    }
    return false;
  },
  render() {
    const sku = currentSku();
    const entry = state.selection[sku];
    const item = findOrderItem(sku);
    const reasons = reasonsForType();
    const reason = findReason(entry.reason);
    const blocked = blockedReason(reason);
    const total = state.selectedSkus.length;
    const flash = flashHtml();

    render(`
      ${heading(state.type === "exchange" ? "Por que você quer trocar?" : "Por que você quer devolver?", total > 1 ? `Produto ${state.reasonIndex + 1} de ${total}` : "")}
      ${flash}
      <div class="bg-white rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-800">
        ${esc(item?.description || sku)}${entry.quantity > 1 ? ` <span class="text-slate-500 font-normal">· ${esc(entry.quantity)} unidades</span>` : ""}
      </div>
      <fieldset class="flex flex-col gap-2">
        <legend class="text-xs font-bold text-slate-600 mb-2">Motivo</legend>
        ${reasons
          .map((r) =>
            radioOption(
              "reason",
              r.reason,
              r.reason,
              r.reason === entry.reason,
              r.has_image && !PHOTOS_ENABLED ? ` <span class="ml-1 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 whitespace-nowrap">pede foto</span>` : "",
            ),
          )
          .join("")}
        <span data-error-for="reason" class="hidden text-xs font-semibold text-red-600"></span>
      </fieldset>
      ${reason && !blocked ? detailsHtml(reason, entry) : ""}
      ${blocked ? blockedHtml(blocked) : ""}
      ${blocked ? "" : primaryButton("reasonNextBtn", state.reasonIndex < total - 1 ? "Próximo produto" : "Continuar", { icon: "arrow-right" })}
    `);

    $all('input[name="reason"]').forEach((input) =>
      input.addEventListener("change", () => {
        if (entry.reason !== input.value) {
          entry.reason = input.value;
          entry.sub_reason = null;
          invalidateFrom("retention");
        }
        reasonsScreen.render();
        const chosen = findReason(entry.reason);
        const block = blockedReason(chosen);
        if (block) trackEvent("validation_error", { step: "reasons", error_code: block === "REASON" ? "HANDOFF_REQUIRED" : "PHOTO_REQUIRED", meta: { reason: chosen.reason } });
      }),
    );
    $all('input[name="subReason"]').forEach((input) =>
      input.addEventListener("change", () => {
        entry.sub_reason = input.value;
        $all('input[name="subReason"]').forEach((other) => {
          const label = other.closest("label");
          label.classList.toggle("border-blue-500", other.checked);
          label.classList.toggle("bg-blue-50/50", other.checked);
          label.classList.toggle("border-slate-200", !other.checked);
        });
      }),
    );
    bindCounter("reasonComment");
    on("#reasonHandoffBtn", "click", () => requestHandoff(blocked, { errorCode: blocked === "REASON" ? "HANDOFF_REQUIRED" : "PHOTO_REQUIRED" }));
    on("#reasonChangeBtn", "click", () => {
      entry.reason = null;
      entry.sub_reason = null;
      reasonsScreen.render();
    });
    on("#reasonNextBtn", "click", () => next(entry));
  },
};

function detailsHtml(reason, entry) {
  let html = "";
  if (reason.sub_reasons.length > 0) {
    html += `
      <fieldset class="flex flex-col gap-2">
        <legend class="text-xs font-bold text-slate-600 mb-2">Conte um pouco mais</legend>
        ${reason.sub_reasons.map((s) => radioOption("subReason", s, s, s === entry.sub_reason)).join("")}
        <span data-error-for="subReason" class="hidden text-xs font-semibold text-red-600"></span>
      </fieldset>`;
  }
  html += textareaField("reasonComment", reason.has_comment ? "Descreva o que aconteceu" : "Comentário (opcional)", {
    value: entry.comment || "",
    maxlength: MAX_COMMENT,
    placeholder: reason.has_comment ? "Conte com detalhes o que aconteceu com o produto" : "",
  });
  return html;
}

function blockedHtml(kind) {
  const text =
    kind === "REASON"
      ? "Para este motivo, um atendente precisa analisar sua solicitação."
      : "Este motivo precisa de fotos do produto, e o envio de fotos ainda não está disponível por aqui. Um atendente pode te ajudar.";
  return `
    ${alertBox("warn", esc(text))}
    <div class="flex flex-col gap-2">
      ${primaryButton("reasonHandoffBtn", "Falar com atendente", { icon: "headset" })}
      ${secondaryButton("reasonChangeBtn", "Escolher outro motivo")}
    </div>`;
}

function next(entry) {
  clearFieldErrors();
  const reason = findReason(entry.reason);
  if (!reason) {
    showFieldError("reason", "Escolha um motivo.");
    trackEvent("validation_error", { step: "reasons", meta: { field: "reason" } });
    return;
  }
  if (reason.sub_reasons.length > 0 && !reason.sub_reasons.includes(entry.sub_reason)) {
    showFieldError("subReason", "Escolha uma opção.");
    trackEvent("validation_error", { step: "reasons", meta: { field: "sub_reason" } });
    return;
  }

  const comment = ($("#reasonComment")?.value || "").trim();
  if (reason.has_comment && !comment) {
    showFieldError("reasonComment", "Descreva o que aconteceu.");
    trackEvent("validation_error", { step: "reasons", meta: { field: "comment" } });
    return;
  }
  entry.comment = comment.slice(0, MAX_COMMENT);

  // Um evento por item, com o motivo (sem o texto do comentário)
  const meta = { reason: reason.reason, sub_reason: entry.sub_reason || null, item_index: state.reasonIndex, with_note: Boolean(entry.comment) };

  if (state.reasonIndex < state.selectedSkus.length - 1) {
    trackEvent("step_completed", { step: "reasons", meta });
    state.reasonIndex += 1;
    refresh();
    return;
  }
  goNext("reasons", { meta });
}
