// ============================================================
// ROTEADOR DE ETAPAS E AÇÕES COMUNS
// Uma tela por etapa. O histórico guarda só as telas efetivamente vistas
// (etapas puladas automaticamente não entram), para o "voltar" funcionar.
// ============================================================

import { state, identityBody, needsAddressStep, needsRefundStep, takeFlash } from "./state.js";
import { trackEvent, markFinished, flush } from "./tracking.js";
import { api } from "./api.js";
import { render, loadingBlock, alertText, primaryButton, on } from "./ui.js";

// Aviso pendente (ex.: "corrija o endereço") exibido no topo da próxima tela
export function flashHtml() {
  const flash = takeFlash();
  return flash ? alertText(flash.kind, flash.text) : "";
}

const screens = {};
const history = [];
let current = null;
let enteredAt = 0;

// Ordem das etapas de troca/devolução
const ORDER = ["start", "identify", "items", "reasons", "address", "retention", "shipping", "refund", "summary", "result"];

export function registerScreen(name, screen) {
  screens[name] = screen;
}

export function currentStep() {
  return current;
}

// Rótulos das etapas no painel lateral (telas largas) e na barra de progresso
const STEP_LABELS = {
  identify: "Identificação",
  items: "Produtos",
  reasons: "Motivo",
  address: "Endereço",
  retention: "Vale-compras",
  shipping: "Envio",
  refund: "Reembolso",
  summary: "Resumo",
  result: "Pronto",
  track: "Acompanhar",
};
// Antes de escolher o tipo, o painel mostra um resumo do caminho
const PREVIEW_STEPS = ["identify", "items", "reasons", "address", "shipping", "summary"];

function visibleSteps() {
  if (state.type === "track") return ["identify", "track"];
  if (!state.type) return [];
  return ORDER.slice(1).filter(isNeeded);
}

function updateProgress(name) {
  const steps = visibleSteps();
  const index = steps.indexOf(name);

  const fill = document.getElementById("progressFill");
  if (fill) {
    const bar = fill.parentElement;
    bar.classList.toggle("is-hidden", index < 0 && name !== "start");
    fill.style.width = index < 0 ? "0%" : `${Math.round(((index + 1) / steps.length) * 100)}%`;
  }

  const stepper = document.getElementById("stepper");
  if (stepper) {
    const list = steps.length ? steps : PREVIEW_STEPS;
    stepper.innerHTML = list
      .map((step, i) => {
        const status = index < 0 ? "" : i < index ? "is-done" : i === index ? "is-current" : "";
        return `<li class="${status}"${i === index ? ' aria-current="step"' : ""}><span class="num">${i + 1}</span>${STEP_LABELS[step]}</li>`;
      })
      .join("");
  }
}

function updateHeader(screen) {
  const title = document.getElementById("headerTitle");
  if (title) title.textContent = screen.title || "Troca e devolução";

  const back = document.getElementById("headerBackBtn");
  if (back) {
    const canGoBack = screen.allowBack !== false && history.length > 0;
    back.classList.toggle("hidden", !canGoBack);
    back.classList.toggle("flex", canGoBack);
  }
}

function show(name) {
  const screen = screens[name];
  current = name;
  enteredAt = Date.now();
  updateHeader(screen);
  updateProgress(name);
  trackEvent("step_viewed", { step: name });
  // onEnter: só ao entrar na tela (não em refresh de subetapa)
  if (typeof screen.onEnter === "function") screen.onEnter();
  screen.render();
}

// replace: a tela atual não entra no histórico (ex.: etapa pulada)
// clearHistory: a partir daqui não há volta (resultado, erro final)
export function go(name, { replace = false, clearHistory = false, meta } = {}) {
  if (!screens[name]) return;
  if (current) {
    trackEvent("step_completed", { step: current, duration_ms: Date.now() - enteredAt, meta });
    if (!replace && current !== name) history.push(current);
  }
  if (clearHistory) history.length = 0;
  show(name);
}

export function back() {
  const screen = screens[current];
  // A tela pode tratar o voltar internamente (subetapas)
  if (screen && typeof screen.onBack === "function" && screen.onBack() === true) {
    trackEvent("step_back", { step: current });
    return;
  }
  const previous = history.pop();
  if (!previous) return;
  trackEvent("step_back", { step: current });
  show(previous);
}

// Re-renderiza a tela atual (ex.: subetapa) mantendo histórico
export function refresh() {
  if (current) {
    updateHeader(screens[current]);
    updateProgress(current);
    screens[current].render();
  }
}

function isNeeded(step) {
  switch (step) {
    case "address":
      return needsAddressStep();
    case "retention":
      return state.type === "refund";
    case "refund":
      return needsRefundStep();
    default:
      return true;
  }
}

// Avança para a próxima etapa necessária depois de "from"
export function goNext(from, options = {}) {
  const index = ORDER.indexOf(from);
  for (let i = index + 1; i < ORDER.length; i += 1) {
    if (isNeeded(ORDER[i])) {
      go(ORDER[i], options);
      return;
    }
  }
}

// ---------- Erros ----------

// Mapeia o campo apontado pelo servidor para a etapa onde ele é corrigido
export function stepForField(field) {
  if (typeof field !== "string") return null;
  if (field.startsWith("items")) return "reasons";
  if (field.startsWith("address") || field.startsWith("customer")) return "address";
  if (field.startsWith("payment_bill")) return "refund";
  if (field === "order_number" || field === "customer_identifier") return "identify";
  if (field === "type") return "start";
  return null;
}

function handoffReasonFor(code) {
  if (code === "HANDOFF_REQUIRED") return "REASON";
  if (code === "PHOTO_REQUIRED") return "PHOTO_REQUIRED";
  if (code === "TOO_MANY_ATTEMPTS") return "NOT_FOUND";
  return "ERROR";
}

// Tela final de erro/transferência
export function showFatal({ message, code = null, action = "handoff", offerTrack = false, offerRestart = false }) {
  state.error = {
    message,
    code,
    handoffReason: action === "handoff" ? handoffReasonFor(code) : null,
    offerTrack: offerTrack || action === "track",
    offerRestart,
  };
  go("error", { clearHistory: true });
}

// Decide o que fazer com um erro da API. Devolve true quando já navegou;
// false quando a tela deve mostrar o erro no próprio lugar (retry/fix_input).
export function handleApiError(result, step) {
  const { code, error, action } = result.data;
  trackEvent("error_shown", { step, error_code: code });

  if (action === "handoff" || action === "close" || action === "track") {
    showFatal({ message: error, code, action });
    return true;
  }
  return false;
}

// ---------- Fim do fluxo ----------

export function closeWebview() {
  markFinished();
  flush();
  const sdk = window.WebviewSdk;
  if (sdk && typeof sdk.hasFeature === "function" && sdk.hasFeature("close")) {
    sdk.close();
    return;
  }
  // Fora do widget (link aberto no navegador): tenta fechar e, se não der, orienta
  window.close();
  setTimeout(() => {
    render(`
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm text-center flex flex-col gap-2">
        <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-600 mx-auto"></i>
        <p class="text-sm text-slate-700">Pronto! Você já pode fechar esta página e voltar à conversa.</p>
      </div>`);
    const backBtn = document.getElementById("headerBackBtn");
    if (backBtn) backBtn.classList.add("hidden");
  }, 300);
}

// Posta na conversa a mensagem com o botão "Falar com atendente" e fecha
export async function requestHandoff(reason, { errorCode = null } = {}) {
  render(loadingBlock("Chamando um atendente..."));
  const body = { reason, step: current || "handoff" };
  if (errorCode) body.error_code = errorCode;
  if (state.identity?.orderNumber) body.order_number = state.identity.orderNumber;

  const result = await api("/api/reverse/handoff", body);
  if (result.ok && result.data.message_posted) {
    closeWebview();
    return;
  }

  render(`
    ${alertText("info", "Não conseguimos chamar o atendente automaticamente. Volte à conversa e escreva \"falar com atendente\".")}
    ${primaryButton("handoffCloseBtn", "Voltar ao chat")}`);
  on("#handoffCloseBtn", "click", closeWebview);
}

// Atalho para o fluxo de acompanhamento com a identificação já informada
export async function openTracking(button) {
  const restore = button ? button.disabled : null;
  if (button) button.disabled = true;
  const result = await api("/api/reverse/track", identityBody());
  if (button) button.disabled = restore;
  if (!result.ok) {
    // Erro temporário: a tela de erro oferece tentar o acompanhamento de novo
    if (!handleApiError(result, "track")) showFatal({ message: result.data.error, code: result.data.code, action: "track" });
    return;
  }
  state.type = "track";
  state.trackResult = result.data;
  go("track", { clearHistory: true });
}
