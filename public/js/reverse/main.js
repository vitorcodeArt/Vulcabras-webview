// ============================================================
// TROCA E DEVOLUÇÃO - ponto de entrada da webview
// Valida a sessão, registra as telas e abre a tela inicial.
// ============================================================

import { session } from "./session.js";
import { trackEvent } from "./tracking.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { registerScreen, go, back, showFatal } from "./flow.js";
import { render, loadingBlock } from "./ui.js";
import { startScreen } from "./screens/start.js";
import { identifyScreen } from "./screens/identify.js";
import { itemsScreen } from "./screens/items.js";
import { reasonsScreen } from "./screens/reasons.js";
import { addressScreen } from "./screens/address.js";
import { retentionScreen } from "./screens/retention.js";
import { shippingScreen } from "./screens/shipping.js";
import { refundScreen } from "./screens/refund.js";
import { summaryScreen } from "./screens/summary.js";
import { resultScreen } from "./screens/result.js";
import { trackScreen } from "./screens/track.js";
import { errorScreen } from "./screens/error.js";

const SCREENS = {
  start: startScreen,
  identify: identifyScreen,
  items: itemsScreen,
  reasons: reasonsScreen,
  address: addressScreen,
  retention: retentionScreen,
  shipping: shippingScreen,
  refund: refundScreen,
  summary: summaryScreen,
  result: resultScreen,
  track: trackScreen,
  error: errorScreen,
};

for (const [name, screen] of Object.entries(SCREENS)) registerScreen(name, screen);

// Logo da marca (public/img/brands): versão colorida ou branca conforme o
// fundo de cada lugar. A Olympikus usa o símbolo + o nome escrito, como no site.
const LOGOS = {
  mizuno: { header: "mizuno.png", aside: "mizuno-white.png", withName: false },
  olympikus: { header: "olympikus-white.png", aside: "olympikus-white.png", withName: true },
  underarmour: { header: "underarmour-white.png", aside: "underarmour-white.png", withName: false },
};

function applyBrand(brand) {
  document.documentElement.setAttribute("data-brand", brand.key);
  const eyebrow = document.getElementById("asideEyebrow");
  if (eyebrow) eyebrow.textContent = `Central de trocas ${brand.label}`;

  const logo = LOGOS[brand.key];
  document.querySelectorAll("[data-brand-logo]").forEach((slot) => {
    slot.innerHTML = "";
    const name = document.createElement("span");
    name.className = "wordmark";
    name.textContent = brand.label;

    if (!logo) {
      slot.appendChild(name);
      return;
    }
    const img = new Image();
    img.alt = logo.withName ? "" : brand.label;
    img.src = `/img/brands/${slot.classList.contains("brand-logo-header") ? logo.header : logo.aside}`;
    // Sem a imagem, fica o nome escrito
    img.onerror = () => {
      img.remove();
      if (!logo.withName) slot.appendChild(name);
    };
    slot.appendChild(img);
    if (logo.withName) slot.appendChild(name);
  });
}

async function init() {
  document.getElementById("headerBackBtn").addEventListener("click", back);
  render(loadingBlock());

  if (!session.token) {
    showFatal({ message: "Este link não é válido. Volte ao chat e abra a opção de troca e devolução novamente.", action: "close" });
    return;
  }

  const result = await api("/api/reverse/session", {});
  if (!result.ok) {
    showFatal({
      message: result.status === 0 ? result.data.error : result.data.error || "Não foi possível abrir a troca e devolução agora. Tente novamente em instantes.",
      code: result.data.code,
      action: "close",
    });
    return;
  }

  state.brand = result.data.brand;
  state.features = result.data.features || {};
  document.title = `Troca e devolução ${state.brand.label}`;
  applyBrand(state.brand);

  trackEvent("webview_opened", { step: "start" });
  go("start");
}

init();
