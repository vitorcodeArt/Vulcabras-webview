// ============================================================
// UTILITÁRIOS DE INTERFACE
// Todo texto vindo da API passa por esc() antes de entrar no HTML.
// ============================================================

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function money(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? BRL.format(number) : "";
}

// "2026-10-01..." ou "01/10/2026" -> "01/10/2026"
export function formatDate(value) {
  if (typeof value !== "string") return "";
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return /^\d{2}\/\d{2}\/\d{4}/.test(value) ? value.slice(0, 10) : "";
}

// Só aceita imagens https (as fotos dos produtos vêm do Troque)
export function safeUrl(url) {
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
}

export function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function screenEl() {
  return document.getElementById("screen");
}

export function render(html) {
  const el = screenEl();
  el.innerHTML = `<div class="animate-fadeIn flex flex-col gap-4">${html}</div>`;
  if (window.lucide) window.lucide.createIcons();
  window.scrollTo(0, 0);
}

export function $(selector) {
  return screenEl().querySelector(selector);
}

export function $all(selector) {
  return Array.from(screenEl().querySelectorAll(selector));
}

export function on(selector, event, handler) {
  const el = $(selector);
  if (el) el.addEventListener(event, handler);
  return el;
}

// ---------- Blocos de HTML ----------

export function heading(title, subtitle = "") {
  return `
    <div>
      <h2 class="text-xl font-extrabold text-slate-900 leading-tight">${esc(title)}</h2>
      ${subtitle ? `<p class="text-sm text-slate-500 mt-1">${esc(subtitle)}</p>` : ""}
    </div>`;
}

const ALERT_STYLES = {
  info: { box: "bg-blue-50 border-blue-100 text-blue-900", icon: "info" },
  warn: { box: "bg-amber-50 border-amber-200 text-amber-900", icon: "alert-triangle" },
  error: { box: "bg-red-50 border-red-100 text-red-800", icon: "alert-circle" },
  success: { box: "bg-emerald-50 border-emerald-100 text-emerald-900", icon: "check-circle-2" },
};

// html: conteúdo já escapado (use alertText para texto puro)
export function alertBox(kind, html, extraClass = "") {
  const style = ALERT_STYLES[kind] || ALERT_STYLES.info;
  return `
    <div class="flex gap-2.5 items-start border rounded-xl px-3.5 py-3 text-sm ${style.box} ${extraClass}" role="${kind === "error" ? "alert" : "status"}">
      <i data-lucide="${style.icon}" class="w-4 h-4 mt-0.5 shrink-0"></i>
      <div class="leading-snug">${html}</div>
    </div>`;
}

export function alertText(kind, text, extraClass = "") {
  return alertBox(kind, esc(text), extraClass);
}

export function card(html, extraClass = "") {
  return `<div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm ${extraClass}">${html}</div>`;
}

export function primaryButton(id, label, { disabled = false, icon = "" } = {}) {
  return `
    <button id="${id}" type="button" ${disabled ? "disabled" : ""}
      class="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-bold transition-colors flex items-center justify-center gap-2">
      ${icon ? `<i data-lucide="${icon}" class="w-4 h-4"></i>` : ""}<span>${esc(label)}</span>
    </button>`;
}

export function secondaryButton(id, label, { icon = "" } = {}) {
  return `
    <button id="${id}" type="button"
      class="w-full h-12 rounded-xl bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-slate-800 text-sm font-bold transition-colors flex items-center justify-center gap-2">
      ${icon ? `<i data-lucide="${icon}" class="w-4 h-4"></i>` : ""}<span>${esc(label)}</span>
    </button>`;
}

export function linkButton(id, label) {
  return `<button id="${id}" type="button" class="text-sm font-semibold text-blue-700 hover:underline self-center py-2">${esc(label)}</button>`;
}

export function loadingBlock(text = "Carregando...") {
  return `
    <div class="flex flex-col items-center justify-center py-16 text-slate-500" role="status">
      <div class="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-3"></div>
      <p class="text-sm text-center px-6">${esc(text)}</p>
    </div>`;
}

// Botão em espera: desabilita e troca o rótulo; devolve função que restaura
export function setBusy(button, label = "Aguarde...") {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></span><span>${esc(label)}</span>`;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
    if (window.lucide) window.lucide.createIcons();
  };
}

// ---------- Formulários ----------

const INPUT_CLASS =
  "w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500";

export function inputField(id, label, { value = "", type = "text", placeholder = "", inputmode = "", autocomplete = "off", maxlength = 200, hint = "" } = {}) {
  return `
    <label class="flex flex-col gap-1.5" for="${id}">
      <span class="text-xs font-bold text-slate-600">${esc(label)}</span>
      <input id="${id}" name="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"
        ${inputmode ? `inputmode="${inputmode}"` : ""} autocomplete="${autocomplete}" maxlength="${maxlength}"
        class="${INPUT_CLASS} select-text" />
      ${hint ? `<span class="text-xs text-slate-400">${esc(hint)}</span>` : ""}
      <span data-error-for="${id}" class="hidden text-xs font-semibold text-red-600"></span>
    </label>`;
}

export function selectField(id, label, options, { value = "", placeholder = "Selecione" } = {}) {
  const items = options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  return `
    <label class="flex flex-col gap-1.5" for="${id}">
      <span class="text-xs font-bold text-slate-600">${esc(label)}</span>
      <select id="${id}" name="${id}" class="${INPUT_CLASS}">
        <option value="" ${value ? "" : "selected"}>${esc(placeholder)}</option>${items}
      </select>
      <span data-error-for="${id}" class="hidden text-xs font-semibold text-red-600"></span>
    </label>`;
}

export function textareaField(id, label, { value = "", maxlength = 1000, placeholder = "" } = {}) {
  return `
    <label class="flex flex-col gap-1.5" for="${id}">
      <span class="text-xs font-bold text-slate-600">${esc(label)}</span>
      <textarea id="${id}" name="${id}" rows="4" maxlength="${maxlength}" placeholder="${esc(placeholder)}"
        class="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 select-text resize-none">${esc(value)}</textarea>
      <span class="flex justify-between text-xs">
        <span data-error-for="${id}" class="hidden font-semibold text-red-600"></span>
        <span data-counter-for="${id}" class="ml-auto text-slate-400">${String(value).length}/${maxlength}</span>
      </span>
    </label>`;
}

export function bindCounter(id) {
  const input = $(`#${id}`);
  const counter = $(`[data-counter-for="${id}"]`);
  if (!input || !counter) return;
  input.addEventListener("input", () => {
    counter.textContent = `${input.value.length}/${input.maxLength}`;
  });
}

export function fieldValue(id) {
  const el = $(`#${id}`);
  return el ? el.value.trim() : "";
}

export function showFieldError(id, message) {
  const input = $(`#${id}`);
  const slot = $(`[data-error-for="${id}"]`);
  if (input) {
    input.classList.add("border-red-400");
    input.setAttribute("aria-invalid", "true");
  }
  if (slot) {
    slot.textContent = message;
    slot.classList.remove("hidden");
  }
}

export function clearFieldErrors() {
  $all("[aria-invalid]").forEach((el) => {
    el.classList.remove("border-red-400");
    el.removeAttribute("aria-invalid");
  });
  $all("[data-error-for]").forEach((el) => {
    el.textContent = "";
    el.classList.add("hidden");
  });
}

// Área de mensagem de erro geral da tela
export function showScreenError(text) {
  const slot = $("#screenError");
  if (!slot) return;
  slot.innerHTML = text ? alertText("error", text) : "";
  if (text) {
    if (window.lucide) window.lucide.createIcons();
    slot.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export const SCREEN_ERROR_SLOT = `<div id="screenError"></div>`;
