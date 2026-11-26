/* ============================================================
 * ZENDESK (Central de Ajuda) - EXPANDIR O WEBVIEW EM TELAS GRANDES
 *
 * JS: cole no script.js do tema da Central de Ajuda (no lugar do trecho que marca
 * só a troca e devolução). CSS: ver zendesk-widget-expand.css, vai no style.css.
 *
 * Marca o iframe da janela do widget com a classe "webview-wide" quando o webview
 * aberto é o catálogo (/catalog), a troca e devolução (/reverse) ou o rastreio
 * (/webview). O CSS alarga a janela só em telas largas.
 * ============================================================ */
// Marca o webview do Zendesk quando ele mostra catálogo, troca/devolução ou rastreio
setInterval(function () {
  var frame = document.querySelector('iframe[title="Janela de visualização da web"]');
  if (!frame) return;
  try {
    var inner =
      frame.contentDocument &&
      frame.contentDocument.querySelector(
        'iframe[src*="/reverse"], iframe[src*="/catalog"], iframe[src*="/webview"]'
      );
    frame.classList.toggle("webview-wide", !!inner);
  } catch (e) {}
}, 400);
