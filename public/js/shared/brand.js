// ============================================================
// IDENTIDADE DA MARCA NA TELA (catálogo)
// Troca o data-brand do <html> (cores e fontes, ver brand-theme.css) e desenha
// o logo da marca nos lugares marcados com [data-brand-logo]. Script comum, sem
// módulos. A Olympikus usa o símbolo + o nome escrito, como no site.
// ============================================================
(function () {
  // Versão colorida ou branca conforme o fundo de cada lugar
  var LOGOS = {
    mizuno: { header: "mizuno.png", aside: "mizuno-white.png", withName: false },
    olympikus: { header: "olympikus-white.png", aside: "olympikus-white.png", withName: true },
    underarmour: { header: "underarmour-white.png", aside: "underarmour-white.png", withName: false },
  };

  function applyLogos(brand) {
    var logo = LOGOS[brand.key];
    document.querySelectorAll("[data-brand-logo]").forEach(function (slot) {
      slot.innerHTML = "";
      var name = document.createElement("span");
      name.className = "wordmark";
      name.textContent = brand.label;

      if (!logo) {
        slot.appendChild(name);
        return;
      }
      var img = new Image();
      img.alt = logo.withName ? "" : brand.label;
      img.src = "/img/brands/" + (slot.classList.contains("brand-logo-header") ? logo.header : logo.aside);
      // Sem a imagem, fica o nome escrito
      img.onerror = function () {
        img.remove();
        if (!logo.withName) slot.appendChild(name);
      };
      slot.appendChild(img);
      if (logo.withName) slot.appendChild(name);
    });
  }

  function apply(brand) {
    document.documentElement.setAttribute("data-brand", brand.key);
    var eyebrow = document.getElementById("asideEyebrow");
    if (eyebrow) eyebrow.textContent = "Catálogo oficial";
    var accent = document.getElementById("asideBrandName");
    if (accent) accent.textContent = brand.label;
    applyLogos(brand);
  }

  window.BrandTheme = { apply: apply };
})();
