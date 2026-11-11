// Tela 11 - Erro e transferência: falhas não recuperáveis, com opção de
// voltar ao chat, falar com um atendente ou acompanhar a solicitação.
import { state, resetFlow } from "../state.js";
import { go, closeWebview, requestHandoff, openTracking } from "../flow.js";
import { render, esc, primaryButton, secondaryButton, on } from "../ui.js";

export const errorScreen = {
  title: "Troca e devolução",
  allowBack: false,
  render() {
    const error = state.error || { message: "Algo deu errado.", handoffReason: "ERROR" };
    const canTrack = error.offerTrack && Boolean(state.identity);

    const buttons = [];
    if (canTrack) buttons.push(primaryButton("errorTrackBtn", "Acompanhar solicitação", { icon: "search" }));
    if (error.offerRestart) buttons.push((buttons.length ? secondaryButton : primaryButton)("errorRestartBtn", "Escolher outra opção"));
    if (error.handoffReason) buttons.push((buttons.length ? secondaryButton : primaryButton)("errorHandoffBtn", "Falar com atendente", { icon: "headset" }));
    buttons.push((buttons.length ? secondaryButton : primaryButton)("errorCloseBtn", "Voltar ao chat"));

    render(`
      <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm text-center flex flex-col gap-3">
        <span class="w-11 h-11 mx-auto rounded-full ${error.handoffReason ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"} flex items-center justify-center">
          <i data-lucide="${error.handoffReason ? "alert-circle" : "info"}" class="w-5 h-5"></i>
        </span>
        <p class="text-sm text-slate-700 leading-relaxed">${esc(error.message)}</p>
      </div>
      <div class="flex flex-col gap-2">${buttons.join("")}</div>
    `);

    on("#errorTrackBtn", "click", (event) => openTracking(event.currentTarget));
    on("#errorRestartBtn", "click", () => {
      resetFlow();
      go("start", { clearHistory: true });
    });
    on("#errorHandoffBtn", "click", () => requestHandoff(error.handoffReason, { errorCode: error.code }));
    on("#errorCloseBtn", "click", closeWebview);
  },
};
