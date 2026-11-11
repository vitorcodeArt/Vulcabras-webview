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
  document.title = `Troca e devolução ${state.brand.label}`;
  const badge = document.getElementById("headerBadge");
  badge.textContent = state.brand.label;
  badge.classList.remove("hidden");

  trackEvent("webview_opened", { step: "start" });
  go("start");
}

init();
