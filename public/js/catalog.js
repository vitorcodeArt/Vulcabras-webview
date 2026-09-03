/* ============================================================
   CATALOG LOGIC - Gerenciamento de categorias, produtos e variações
   Adaptado para Zendesk WebWidget (~400px × 600px)
   ============================================================ */

// Estado da aplicação
const state = {
  currentView: "categories", // 'categories' | 'products' | 'details'
  selectedCategory: null,
  selectedProduct: null,
  selectedVariation: null,
  products: [],
  productDetails: null,
  swiperInstance: null,
};

// Elementos do DOM
const dom = {
  headerBackBtn: document.getElementById("headerBackBtn"),
  headerTitle: document.getElementById("headerTitle"),
  headerBrand: document.getElementById("headerBrand"),
  headerBadge: document.getElementById("headerBadge"),

  categoriesSection: document.getElementById("categoriesSection"),
  categoriesContainer: document.getElementById("categoriesContainer"),

  productsSection: document.getElementById("productsSection"),
  productsCarousel: document.getElementById("productsCarousel"),
  categoryTitle: document.getElementById("categoryTitle"),
  clearCategoryBtn: document.getElementById("clearCategoryBtn"),

  detailsSection: document.getElementById("detailsSection"),
  backToCarouselBtn: document.getElementById("backToCarouselBtn"),
  mainImage: document.getElementById("mainImage"),
  thumbnailsWrapper: document.getElementById("thumbnailsWrapper"),
  thumbnailsContainer: document.getElementById("thumbnailsContainer"),
  productBrand: document.getElementById("productBrand"),
  productName: document.getElementById("productName"),
  productPrice: document.getElementById("productPrice"),
  productListPrice: document.getElementById("productListPrice"),
  productDescription: document.getElementById("productDescription"),
  sizeSelect: document.getElementById("sizeSelect"),
  colorSelect: document.getElementById("colorSelect"),
  selectedVariationDiv: document.getElementById("selectedVariationDiv"),
  selectedVariationText: document.getElementById("selectedVariationText"),
  variationAlert: document.getElementById("variationAlert"),
  variationAlertText: document.getElementById("variationAlertText"),
  addToCartBtn: document.getElementById("addToCartBtn"),

  loadingMessage: document.getElementById("loadingMessage"),
  errorSection: document.getElementById("errorSection"),
  errorText: document.getElementById("errorText"),
};

// Ícones por categoria
const CATEGORY_ICONS = {
  Masculino: "user",
  Feminino: "sparkles",
  Kids: "smile",
  Esportes: "trophy",
  Calçados: "footprints",
};

// Utilitário para atualizar ícones do Lucide
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// Utilitário para escapar strings no HTML
function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Utilitário para formatar preços
function formatPrice(value) {
  if (value === null || value === undefined || isNaN(value)) return null;
  return Number(value).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// ============================================================
// CONTROLE DE TELAS (VIEW MANAGER)
// ============================================================

function setView(viewName) {
  state.currentView = viewName;

  dom.categoriesSection.classList.add("hidden");
  dom.productsSection.classList.add("hidden");
  dom.detailsSection.classList.add("hidden");
  dom.errorSection.classList.add("hidden");

  if (viewName === "categories") {
    dom.categoriesSection.classList.remove("hidden");
    dom.headerBackBtn.classList.add("hidden");
    dom.headerBackBtn.classList.remove("flex");
    dom.headerTitle.textContent = "Catálogo Mizuno";
    state.selectedCategory = null;
    state.selectedProduct = null;
  } else if (viewName === "products") {
    dom.productsSection.classList.remove("hidden");
    dom.headerBackBtn.classList.remove("hidden");
    dom.headerBackBtn.classList.add("flex");
    dom.headerTitle.textContent = state.selectedCategory?.name || "Produtos";
    state.selectedProduct = null;
  } else if (viewName === "details") {
    dom.detailsSection.classList.remove("hidden");
    dom.headerBackBtn.classList.remove("hidden");
    dom.headerBackBtn.classList.add("flex");
    dom.headerTitle.textContent = "Detalhes";
  }

  refreshIcons();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setupNavigationEvents();
  refreshIcons();
  loadCategories();
});

function setupNavigationEvents() {
  // Botão voltar do topo
  dom.headerBackBtn.addEventListener("click", () => {
    if (state.currentView === "details") {
      setView("products");
    } else if (state.currentView === "products") {
      setView("categories");
    }
  });

  // Botão trocar categoria na tela de produtos
  dom.clearCategoryBtn.addEventListener("click", () => {
    setView("categories");
  });

  // Botão voltar ao catálogo na tela de detalhes
  dom.backToCarouselBtn.addEventListener("click", () => {
    setView("products");
  });

  // Botão Comprar na Loja Oficial
  dom.addToCartBtn.addEventListener("click", handleAddToCart);
}

// Handler de validação antes de redirecionar para a loja oficial
function handleAddToCart() {
  // Se ainda não houver variação/opções definidas
  if (!state.selectedVariation || !state.selectedVariation.addToCartLink) {
    const sizeSelected = !!dom.sizeSelect.value;
    const colorSelected = !!dom.colorSelect.value;

    let pendingMsg = "Defina o tamanho e a cor antes de continuar.";
    if (!sizeSelected && !colorSelected) {
      pendingMsg = "Por favor, selecione o tamanho e a cor desejados.";
      dom.sizeSelect.focus();
    } else if (!sizeSelected) {
      pendingMsg = "Por favor, selecione o tamanho do produto.";
      dom.sizeSelect.focus();
    } else if (!colorSelected) {
      pendingMsg = "Por favor, selecione a cor do produto.";
      dom.colorSelect.focus();
    } else if (state.selectedVariation && !state.selectedVariation.addToCartLink) {
      pendingMsg = "Esta opção está indisponível no momento.";
    }

    showVariationAlert(pendingMsg);
    return;
  }

  // Se estiver tudo selecionado corretamente, abre o link oficial
  hideVariationAlert();
  window.open(state.selectedVariation.addToCartLink, "_blank", "noopener,noreferrer");
}

function showVariationAlert(message) {
  if (dom.variationAlert && dom.variationAlertText) {
    dom.variationAlertText.textContent = message;
    dom.variationAlert.classList.remove("hidden");
    refreshIcons();
    dom.variationAlert.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function hideVariationAlert() {
  if (dom.variationAlert) {
    dom.variationAlert.classList.add("hidden");
  }
}

function updateCartButtonState(enabled) {
  if (enabled && state.selectedVariation?.addToCartLink) {
    dom.addToCartBtn.className =
      "w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold rounded-xl text-center transition-all duration-200 shadow-glow flex items-center justify-center gap-2 text-sm cursor-pointer";
  } else {
    dom.addToCartBtn.className =
      "w-full py-3 px-4 bg-slate-300 text-slate-500 font-bold rounded-xl text-center transition-all duration-200 flex items-center justify-center gap-2 text-sm cursor-not-allowed shadow-none";
  }
}

// ============================================================
// CARREGAMENTO DE CATEGORIAS
// ============================================================

async function loadCategories() {
  try {
    showLoading(true);
    const response = await fetch("/api/catalog/categories");

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Erro ao carregar categorias");
    }

    renderCategories(data.categories);
  } catch (error) {
    console.error("Erro ao carregar categorias:", error);
    showError("Erro ao carregar categorias. Tente novamente.");
  } finally {
    showLoading(false);
  }
}

function renderCategories(categories) {
  dom.categoriesContainer.innerHTML = categories
    .map((category) => {
      const iconName = CATEGORY_ICONS[category.name] || "tag";
      return `
        <button
          class="category-btn group p-3.5 rounded-2xl bg-white border border-slate-200/90 hover:border-blue-500 shadow-soft hover:shadow-card transition-all duration-200 flex flex-col items-center text-center gap-2 cursor-pointer"
          data-category-id="${category.categoryId}"
          data-category-name="${escapeHtml(category.name)}"
        >
          <div class="category-icon-wrapper w-10 h-10 rounded-xl bg-blue-50/80 group-hover:bg-blue-600 text-blue-600 group-hover:text-white flex items-center justify-center transition-all">
            <i data-lucide="${iconName}" class="w-5 h-5 pointer-events-none"></i>
          </div>
          <span class="font-bold text-xs text-slate-800 group-hover:text-blue-600 pointer-events-none transition-colors">
            ${escapeHtml(category.name)}
          </span>
        </button>
      `;
    })
    .join("");

  refreshIcons();

  // Adicionar event listeners
  document.querySelectorAll(".category-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectCategory(btn);
    });
  });
}

function selectCategory(btn) {
  state.selectedCategory = {
    categoryId: btn.dataset.categoryId,
    name: btn.dataset.categoryName,
  };

  loadProducts(state.selectedCategory.categoryId);
}

// ============================================================
// CARREGAMENTO DE PRODUTOS
// ============================================================

async function loadProducts(categoryId) {
  try {
    showLoading(true);

    const response = await fetch(`/api/catalog/products?categoryId=${categoryId}`);

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Erro ao carregar produtos");
    }

    state.products = data.products || [];
    renderProducts(state.products);
    setView("products");
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    showError(`Erro ao carregar produtos: ${error.message}`);
  } finally {
    showLoading(false);
  }
}

function renderProducts(products) {
  if (!products || products.length === 0) {
    showError("Nenhum produto encontrado nesta categoria no momento.");
    return;
  }

  // Atualizar título da categoria
  dom.categoryTitle.textContent = state.selectedCategory ? state.selectedCategory.name : "Produtos";

  // Renderizar carrossel de cards
  dom.productsCarousel.innerHTML = products
    .map((product) => {
      const productName = product.name || product.productName || product.metaTagDescription || "Produto Mizuno";
      const productImage = product.image || product.imageUrl || "https://via.placeholder.com/320x260?text=Mizuno";
      const brand = product.brand || "Mizuno";
      const formattedPrice = formatPrice(product.price);
      const formattedListPrice = product.listPrice && product.listPrice > product.price ? formatPrice(product.listPrice) : null;

      return `
        <div class="swiper-slide h-auto flex justify-center">
          <div class="w-full bg-white rounded-2xl border border-slate-100 shadow-card flex flex-col overflow-hidden">
            <!-- Container Imagem -->
            <div class="relative bg-gradient-to-b from-slate-50 to-slate-100/60 p-4 flex items-center justify-center h-44 overflow-hidden">
              <span class="absolute top-2.5 left-2.5 px-2 py-0.5 bg-white/95 rounded-md text-[10px] font-bold uppercase tracking-wider text-slate-600 shadow-xs border border-slate-100">
                ${escapeHtml(brand)}
              </span>
              <img
                src="${productImage}"
                alt="${escapeHtml(productName)}"
                class="max-h-36 w-auto max-w-full object-contain mix-blend-multiply transition-transform duration-200"
                onerror="this.src='https://via.placeholder.com/320x260?text=Mizuno'"
                loading="lazy"
              />
            </div>

            <!-- Informações & Ação -->
            <div class="p-3.5 flex-1 flex flex-col justify-between gap-3">
              <div>
                <h4 class="font-extrabold text-slate-900 text-xs sm:text-sm leading-snug line-clamp-2" title="${escapeHtml(productName)}">
                  ${escapeHtml(productName)}
                </h4>
                ${
                  formattedPrice
                    ? `
                    <div class="mt-1.5 flex items-baseline gap-1.5">
                      <span class="text-sm sm:text-base font-black text-blue-700">${formattedPrice}</span>
                      ${formattedListPrice ? `<span class="text-[11px] text-slate-400 line-through">${formattedListPrice}</span>` : ""}
                    </div>
                  `
                    : product.metaTagDescription
                      ? `<p class="text-[11px] text-slate-400 mt-1 line-clamp-1">${escapeHtml(product.metaTagDescription)}</p>`
                      : ""
                }
              </div>

              <button
                class="w-full py-2.5 px-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs font-bold rounded-xl shadow-glow flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                data-product-id="${product.productId}"
                onclick="viewProductDetails(this)"
              >
                <i data-lucide="eye" class="w-3.5 h-3.5"></i>
                <span>Ver Detalhes</span>
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  refreshIcons();

  // Inicializar/atualizar Swiper com botões customizados
  if (state.swiperInstance) {
    state.swiperInstance.destroy(true, true);
  }

  state.swiperInstance = new Swiper(".productCarousel", {
    slidesPerView: 1,
    spaceBetween: 12,
    grabCursor: true,
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
    },
    navigation: {
      nextEl: ".swiper-button-next-custom",
      prevEl: ".swiper-button-prev-custom",
    },
  });
}

// ============================================================
// DETALHES DO PRODUTO
// ============================================================

async function viewProductDetails(btn) {
  try {
    const productId = btn.dataset.productId;
    showLoading(true);

    const response = await fetch(`/api/catalog/product-details?productId=${productId}`);

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Erro ao carregar detalhes");
    }

    state.productDetails = data;
    state.selectedProduct = productId;
    renderProductDetails(data);
    setView("details");
  } catch (error) {
    console.error("Erro ao carregar detalhes:", error);
    showError(`Erro ao carregar detalhes do produto: ${error.message}`);
  } finally {
    showLoading(false);
  }
}

function renderProductDetails(product) {
  // Marca
  dom.productBrand.textContent = product.brand || "Mizuno";

  // Nome
  dom.productName.textContent = product.name || product.productName || "Produto Mizuno";

  // Descrição
  dom.productDescription.textContent = product.description || product.metaTagDescription || "Produto oficial Mizuno com tecnologia e alta durabilidade.";

  // Preço (da primeira variação disponível)
  const firstVariation = product.variations?.[0];
  if (firstVariation?.price) {
    dom.productPrice.textContent = formatPrice(firstVariation.price);
    if (firstVariation.listPrice && firstVariation.listPrice > firstVariation.price) {
      dom.productListPrice.textContent = formatPrice(firstVariation.listPrice);
      dom.productListPrice.classList.remove("hidden");
    } else {
      dom.productListPrice.classList.add("hidden");
    }
  } else {
    dom.productPrice.textContent = "";
    dom.productListPrice.classList.add("hidden");
  }

  // Normalizar lista de imagens
  const images = (product.images || []).map((img) => ({
    imageUrl: typeof img === "object" ? img?.imageUrl || img?.url || "" : img || "",
  }));

  // Imagem principal
  const mainImgUrl = images[0]?.imageUrl || "https://via.placeholder.com/500x500?text=Mizuno";
  dom.mainImage.src = mainImgUrl;
  dom.mainImage.onerror = () => {
    dom.mainImage.src = "https://via.placeholder.com/500x500?text=Mizuno";
  };

  // Miniaturas
  renderThumbnails(images);

  // Variações (tamanho e cor)
  renderVariations(product.variations || []);

  refreshIcons();
}

function renderThumbnails(images) {
  if (!images || images.length <= 1) {
    dom.thumbnailsWrapper.classList.add("hidden");
    return;
  }

  dom.thumbnailsWrapper.classList.remove("hidden");
  dom.thumbnailsContainer.innerHTML = images
    .map(
      (image, index) => `
        <div
          class="thumbnail-image ${index === 0 ? "active" : ""} w-12 h-12 rounded-xl bg-slate-50 border border-slate-200 hover:border-blue-400 p-1 flex items-center justify-center cursor-pointer shrink-0 transition-all"
          data-full-url="${image.imageUrl}"
          onclick="changeMainImage(this)"
        >
          <img
            src="${image.imageUrl}"
            alt="Foto ${index + 1}"
            class="max-h-full max-w-full object-contain mix-blend-multiply"
            onerror="this.src='https://via.placeholder.com/80x80?text=Foto'"
          />
        </div>
      `,
    )
    .join("");
}

function changeMainImage(thumbnail) {
  document.querySelectorAll(".thumbnail-image").forEach((img) => {
    img.classList.remove("active");
  });

  thumbnail.classList.add("active");

  dom.mainImage.classList.add("opacity-50");
  dom.mainImage.src = thumbnail.dataset.fullUrl;
  dom.mainImage.onload = () => {
    dom.mainImage.classList.remove("opacity-50");
  };
}

function renderVariations(variations) {
  // Resetar estados
  dom.sizeSelect.innerHTML = '<option value="">Selecione o tamanho</option>';
  dom.colorSelect.innerHTML = '<option value="">Selecione a cor</option>';
  dom.colorSelect.disabled = true;
  dom.selectedVariationDiv.classList.add("hidden");
  hideVariationAlert();
  state.selectedVariation = null;
  updateCartButtonState(false);

  if (!variations || variations.length === 0) {
    dom.sizeSelect.innerHTML = '<option value="" selected>Produto sem variações</option>';
    dom.sizeSelect.disabled = true;
    return;
  }

  // Se houver apenas uma variação simples
  const uniqueNames = new Set(variations.map((v) => v.name));

  if (uniqueNames.size === 1 && variations.length === 1) {
    dom.sizeSelect.innerHTML = `<option value="${variations[0].sku}" selected>Padrão / Único</option>`;
    dom.colorSelect.innerHTML = "<option value>Padrão</option>";
    dom.colorSelect.disabled = true;
    dom.sizeSelect.disabled = true;

    state.selectedVariation = variations[0];
    dom.selectedVariationDiv.classList.remove("hidden");
    dom.selectedVariationText.textContent = variations[0].name || "Padrão";

    updateCartButtonState(true);
    refreshIcons();
    return;
  }

  dom.sizeSelect.disabled = false;

  // Extrair tamanhos e cores
  const sizes = new Set();
  const sizeMap = {};

  variations.forEach((variation) => {
    let size = variation.size;
    let color = variation.color;

    if (!size) {
      const match = (variation.name || "").match(/^(\d+)/);
      size = match ? match[1] : variation.name || variation.nameComplete;
    }

    if (!color) {
      const match = (variation.name || "").match(/\s+(.+)$/);
      color = match ? match[1] : "Padrão";
    }

    variation._resolvedSize = size;
    variation._resolvedColor = color;

    sizes.add(size);
    if (!sizeMap[size]) {
      sizeMap[size] = [];
    }
    sizeMap[size].push(variation);
  });

  // Popular select de tamanho
  dom.sizeSelect.innerHTML =
    '<option value="">Selecione o tamanho</option>' +
    Array.from(sizes)
      .sort((a, b) => {
        const aNum = parseInt(a, 10);
        const bNum = parseInt(b, 10);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return aNum - bNum;
        }
        return String(a).localeCompare(String(b));
      })
      .map((size) => `<option value="${escapeHtml(size)}">${escapeHtml(size)}</option>`)
      .join("");

  // Event listener para tamanho
  dom.sizeSelect.onchange = function () {
    const selectedSize = this.value;

    if (!selectedSize) {
      dom.colorSelect.innerHTML = '<option value="">Selecione a cor</option>';
      dom.colorSelect.disabled = true;
      dom.selectedVariationDiv.classList.add("hidden");
      state.selectedVariation = null;
      updateCartButtonState(false);
      return;
    }

    hideVariationAlert();

    // Atualizar cores disponíveis para o tamanho
    const variationsForSize = sizeMap[selectedSize] || [];
    const colors = new Set();

    variationsForSize.forEach((variation) => {
      colors.add(variation._resolvedColor || "Padrão");
    });

    if (colors.size <= 1) {
      const onlyColor = colors.size === 1 ? Array.from(colors)[0] : "Padrão";
      dom.colorSelect.innerHTML = `<option value="${escapeHtml(onlyColor)}" selected>${escapeHtml(onlyColor)}</option>`;
      dom.colorSelect.disabled = false;
      updateSelectedVariation(sizeMap);
    } else {
      dom.colorSelect.innerHTML =
        '<option value="">Selecione a cor</option>' +
        Array.from(colors)
          .sort()
          .map((color) => `<option value="${escapeHtml(color)}">${escapeHtml(color)}</option>`)
          .join("");
      dom.colorSelect.disabled = false;
      dom.selectedVariationDiv.classList.add("hidden");
      state.selectedVariation = null;
      updateCartButtonState(false);
    }
    refreshIcons();
  };

  // Event listener para cor
  dom.colorSelect.onchange = function () {
    hideVariationAlert();
    updateSelectedVariation(sizeMap);
  };
}

function updateSelectedVariation(sizeMap) {
  const selectedSize = dom.sizeSelect.value;
  const selectedColor = dom.colorSelect.value;

  if (!selectedSize || !selectedColor) {
    dom.selectedVariationDiv.classList.add("hidden");
    state.selectedVariation = null;
    updateCartButtonState(false);
    return;
  }

  const variationsForSize = sizeMap?.[selectedSize] || [];
  const variation = variationsForSize.find((v) => v._resolvedColor === selectedColor) || variationsForSize[0];

  if (variation) {
    state.selectedVariation = variation;

    dom.selectedVariationText.textContent = variation.nameComplete || variation.name || `${selectedSize} - ${selectedColor}`;
    dom.selectedVariationDiv.classList.remove("hidden");
    hideVariationAlert();

    if (variation.price) {
      dom.productPrice.textContent = formatPrice(variation.price);
    }

    updateCartButtonState(true);

    // Se a variação tem imagens específicas, trocar
    if (variation.images && variation.images.length > 0 && variation.images[0].imageUrl) {
      dom.mainImage.src = variation.images[0].imageUrl;
    }

    refreshIcons();
  }
}

// ============================================================
// UTILITÁRIOS DE FEEDBACK
// ============================================================

function showLoading(show) {
  if (show) {
    dom.loadingMessage.classList.remove("hidden");
    dom.errorSection.classList.add("hidden");
  } else {
    dom.loadingMessage.classList.add("hidden");
  }
}

function showError(message) {
  dom.errorSection.classList.remove("hidden");
  dom.errorText.textContent = message;
  dom.categoriesSection.classList.add("hidden");
  dom.productsSection.classList.add("hidden");
  dom.detailsSection.classList.add("hidden");
  refreshIcons();
}
