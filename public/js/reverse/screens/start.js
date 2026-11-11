// Tela 0 - Início: trocar, devolver ou acompanhar
import { state, resetFlow } from "../state.js";
import { go, flashHtml } from "../flow.js";
import { render, heading, esc, $all } from "../ui.js";

const OPTIONS = [
  { type: "exchange", icon: "repeat", title: "Trocar produto", text: "Trocar por outro tamanho, cor ou modelo" },
  { type: "refund", icon: "undo-2", title: "Devolver produto", text: "Devolver e receber o valor de volta" },
  { type: "track", icon: "search", title: "Acompanhar solicitação", text: "Ver o andamento de uma troca ou devolução" },
];

export const startScreen = {
  title: "Troca e devolução",
  allowBack: false,
  render() {
    const brand = state.brand?.label ? ` ${state.brand.label}` : "";
    const flash = flashHtml();

    render(`
      ${heading(`Troca e devolução${brand}`, "O que você precisa fazer?")}
      ${flash}
      <div class="flex flex-col gap-3">
        ${OPTIONS.map(
          (o) => `
          <button type="button" data-type="${o.type}"
            class="w-full text-left bg-white rounded-2xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 p-4 shadow-sm transition-colors flex items-center gap-3">
            <span class="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
              <i data-lucide="${o.icon}" class="w-5 h-5"></i>
            </span>
            <span class="flex-1">
              <span class="block font-bold text-slate-900 text-sm">${esc(o.title)}</span>
              <span class="block text-xs text-slate-500 mt-0.5">${esc(o.text)}</span>
            </span>
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400"></i>
          </button>`,
        ).join("")}
      </div>
    `);

    $all("[data-type]").forEach((button) => {
      button.addEventListener("click", () => {
        resetFlow();
        state.type = button.dataset.type;
        go("identify", { meta: { flow_type: state.type } });
      });
    });
  },
};
