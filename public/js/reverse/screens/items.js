// Tela 2 - Itens: escolha dos produtos e quantidades
import { state, orderItems, invalidateFrom } from "../state.js";
import { go, openTracking } from "../flow.js";
import { trackEvent } from "../tracking.js";
import { render, heading, esc, money, safeUrl, alertBox, alertText, primaryButton, $, $all, on } from "../ui.js";

function itemCard(item) {
  const selected = state.selectedSkus.includes(item.sku);
  const quantity = state.selection[item.sku]?.quantity || 1;
  const image = safeUrl(item.image);

  return `
    <div class="bg-white rounded-2xl border ${selected ? "border-blue-500 ring-2 ring-blue-500/20" : "border-slate-200"} shadow-sm overflow-hidden">
      <button type="button" data-toggle="${esc(item.sku)}" aria-pressed="${selected}"
        class="w-full text-left p-3 flex items-center gap-3">
        <span class="w-16 h-16 rounded-xl bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center">
          ${
            image
              ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="w-full h-full object-cover" />`
              : `<i data-lucide="package" class="w-6 h-6 text-slate-400"></i>`
          }
        </span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm font-bold text-slate-900 leading-snug">${esc(item.description || item.sku)}</span>
          <span class="block text-xs text-slate-500 mt-1">
            ${item.quantity > 1 ? `${esc(item.quantity)} unidades` : "1 unidade"}${item.price ? ` · ${esc(money(item.price))}` : ""}
          </span>
        </span>
        <span class="w-6 h-6 rounded-full border-2 ${selected ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300"} flex items-center justify-center shrink-0">
          ${selected ? `<i data-lucide="check" class="w-3.5 h-3.5"></i>` : ""}
        </span>
      </button>
      ${
        selected && item.quantity > 1
          ? `
        <div class="px-3 pb-3 flex items-center justify-between border-t border-slate-100 pt-3">
          <span class="text-xs font-bold text-slate-600">Quantas unidades?</span>
          <div class="flex items-center gap-2">
            <button type="button" data-dec="${esc(item.sku)}" aria-label="Diminuir" ${quantity <= 1 ? "disabled" : ""}
              class="w-8 h-8 rounded-lg bg-slate-100 disabled:opacity-40 flex items-center justify-center"><i data-lucide="minus" class="w-4 h-4"></i></button>
            <span class="w-6 text-center text-sm font-bold" aria-live="polite">${esc(quantity)}</span>
            <button type="button" data-inc="${esc(item.sku)}" aria-label="Aumentar" ${quantity >= item.quantity ? "disabled" : ""}
              class="w-8 h-8 rounded-lg bg-slate-100 disabled:opacity-40 flex items-center justify-center"><i data-lucide="plus" class="w-4 h-4"></i></button>
          </div>
        </div>`
          : ""
      }
    </div>`;
}

function toggle(sku) {
  const index = state.selectedSkus.indexOf(sku);
  if (index >= 0) {
    state.selectedSkus.splice(index, 1);
    delete state.selection[sku];
  } else {
    state.selectedSkus.push(sku);
    state.selection[sku] = { quantity: 1, reason: null, sub_reason: null, comment: "" };
  }
  invalidateFrom("items");
  itemsScreen.render();
}

function changeQuantity(sku, delta) {
  const item = orderItems().find((i) => i.sku === sku);
  const entry = state.selection[sku];
  if (!item || !entry) return;
  entry.quantity = Math.min(item.quantity, Math.max(1, entry.quantity + delta));
  invalidateFrom("items");
  itemsScreen.render();
}

export const itemsScreen = {
  title: "Produtos",
  render() {
    const items = orderItems();
    const unavailable = state.prepared?.order?.unavailable_items || [];
    const existing = state.prepared?.existing_reverses || [];
    const action = state.type === "exchange" ? "trocar" : "devolver";

    render(`
      ${heading(`Quais produtos você quer ${action}?`, "Selecione um ou mais produtos do pedido.")}
      ${
        existing.length > 0
          ? alertBox(
              "info",
              `Este pedido já tem ${existing.length > 1 ? "solicitações" : "uma solicitação"} de troca ou devolução.
               <button type="button" id="existingTrackBtn" class="font-bold underline">Acompanhar</button>`,
            )
          : ""
      }
      ${
        items.length === 0
          ? alertText("warn", "Nenhum produto deste pedido pode ser trocado ou devolvido agora.")
          : `<div class="flex flex-col gap-3">${items.map(itemCard).join("")}</div>`
      }
      ${
        unavailable.length > 0
          ? alertBox(
              "warn",
              `Não podem ser trocados ou devolvidos por aqui:
               <ul class="list-disc ml-4 mt-1">${unavailable.map((i) => `<li>${esc(i.description || i.sku)}</li>`).join("")}</ul>`,
            )
          : ""
      }
      ${primaryButton("itemsNextBtn", "Continuar", { disabled: state.selectedSkus.length === 0, icon: "arrow-right" })}
    `);

    $all("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.toggle)));
    $all("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQuantity(b.dataset.inc, 1)));
    $all("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQuantity(b.dataset.dec, -1)));
    on("#existingTrackBtn", "click", (event) => openTracking(event.currentTarget));

    on("#itemsNextBtn", "click", () => {
      if (state.selectedSkus.length === 0) {
        trackEvent("validation_error", { step: "items", meta: { field: "items" } });
        return;
      }
      state.reasonIndex = 0;
      go("reasons", { meta: { items: state.selectedSkus.length } });
    });

    // Evita o "piscar" do botão de continuar sem itens
    const next = $("#itemsNextBtn");
    if (next && items.length === 0) next.classList.add("hidden");
  },
};
