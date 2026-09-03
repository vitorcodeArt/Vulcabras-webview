/* ============================================================
   CATALOG LOGIC - Gerenciamento de categorias, produtos e variações
   ============================================================ */

// Estado da aplicação
const state = {
  selectedCategory: null,
  selectedProduct: null,
  selectedVariation: null,
  products: [],
  productDetails: null,
  swiperInstance: null,
};

// Elementos do DOM
const dom = {
  categoriesContainer: document.getElementById("categoriesContainer"),
  productsSection: document.getElementById("productsSection"),
  detailsSection: document.getElementById("detailsSection"),
  categoryTitle: document.getElementById("categoryTitle"),
  clearCategoryBtn: document.getElementById("clearCategoryBtn"),
  backToCarouselBtn: document.getElementById("backToCarouselBtn"),
  productsCarousel: document.getElementById("productsCarousel"),
  mainImage: document.getElementById("mainImage"),
  thumbnailsContainer: document.getElementById("thumbnailsContainer"),
  productBrand: document.getElementById("productBrand"),
  productName: document.getElementById("productName"),
  productDescription: document.getElementById("productDescription"),
  sizeSelect: document.getElementById("sizeSelect"),
  colorSelect: document.getElementById("colorSelect"),
  selectedVariationDiv: document.getElementById("selectedVariationDiv"),
  selectedVariationText: document.getElementById("selectedVariationText"),
  addToCartBtn: document.getElementById("addToCartBtn"),
  loadingMessage: document.getElementById("loadingMessage"),
  errorSection: document.getElementById("errorSection"),
  errorText: document.getElementById("errorText"),
  errorMessage: document.getElementById("errorMessage"),
  errorMessageContent: document.getElementById("errorMessageContent"),
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

// ============================================================
// INICIALIZAÇÃO
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  refreshIcons();
  loadCategories();
});

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
          class="category-btn group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200/90 hover:border-blue-500 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col items-center text-center gap-2.5 cursor-pointer"
          data-category-id="${category.categoryId}"
          data-category-name="${category.name}"
        >
          <div class="category-icon-wrapper w-11 h-11 rounded-xl bg-slate-100 group-hover:bg-blue-50 text-slate-600 group-hover:text-blue-600 flex items-center justify-center transition-colors">
            <i data-lucide="${iconName}" class="w-5 h-5 pointer-events-none"></i>
          </div>
          <span class="font-bold text-xs sm:text-sm text-slate-800 group-hover:text-blue-600 pointer-events-none transition-colors">
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
  // Remover classe ativa de todos os botões
  document.querySelectorAll(".category-btn").forEach((b) => {
    b.classList.remove("active");
  });

  // Adicionar classe ativa ao botão selecionado
  btn.classList.add("active");

  // Atualizar estado
  state.selectedCategory = {
    categoryId: btn.dataset.categoryId,
    name: btn.dataset.categoryName,
  };

  // Carregar produtos
  loadProducts(state.selectedCategory.categoryId);
}

// ============================================================
// CARREGAMENTO DE PRODUTOS
// ============================================================

async function loadProducts(categoryId) {
  try {
    showLoading(true);
    dom.productsSection.classList.add("hidden");
    dom.detailsSection.classList.add("hidden");

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
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    showError(`Erro ao carregar produtos: ${error.message}`);
  } finally {
    showLoading(false);
  }
}

// Utilitário para formatar preços
function formatPrice(value) {
  if (value === null || value === undefined || isNaN(value)) return null;
  return Number(value).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
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
        <div class="swiper-slide h-auto">
          <div class="group h-full bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:-translate-y-1.5 transition-all duration-300 flex flex-col overflow-hidden">
            <!-- Container Imagem -->
            <div class="relative bg-gradient-to-b from-slate-50 to-slate-100/50 p-6 flex items-center justify-center h-52 sm:h-60 overflow-hidden">
              <span class="absolute top-3 left-3 px-2.5 py-1 bg-white/95 backdrop-blur-sm rounded-lg text-[10px] sm:text-xs font-bold uppercase tracking-wider text-slate-600 shadow-sm border border-slate-100">
                ${escapeHtml(brand)}
              </span>
              <img
                src="${productImage}"
                alt="${escapeHtml(productName)}"
                class="max-h-40 sm:max-h-48 w-auto max-w-full object-contain mix-blend-multiply group-hover:scale-105 transition-transform duration-300"
                onerror="this.src='https://via.placeholder.com/320x260?text=Mizuno'"
                loading="lazy"
              />
            </div>

            <!-- Informações e Ação -->
            <div class="p-5 flex-1 flex flex-col justify-between gap-4">
              <div>
                <h3 class="font-bold text-slate-900 text-sm leading-snug line-clamp-2 min-h-[2.5rem]" title="${escapeHtml(productName)}">
                  ${escapeHtml(productName)}
                </h3>
                ${
                  formattedPrice
                    ? `
                    <div class="mt-2 flex items-baseline gap-2">
                      <span class="text-base font-extrabold text-blue-700">${formattedPrice}</span>
                      ${formattedListPrice ? `<span class="text-xs text-slate-400 line-through">${formattedListPrice}</span>` : ""}
                    </div>
                  `
                    : product.metaTagDescription
                      ? `<p class="text-xs text-slate-400 mt-1.5 line-clamp-1">${escapeHtml(product.metaTagDescription)}</p>`
                      : ""
                }
              </div>

              <button
                class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs sm:text-sm font-bold rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer"
                data-product-id="${product.productId}"
                onclick="viewProductDetails(this)"
              >
                <i data-lucide="eye" class="w-4 h-4"></i>
                <span>Ver Detalhes</span>
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  // Mostrar seção de produtos
  dom.productsSection.classList.remove("hidden");
  refreshIcons();

  // Inicializar/atualizar Swiper com botões customizados
  if (state.swiperInstance) {
    state.swiperInstance.destroy(true, true);
  }

  state.swiperInstance = new Swiper(".productCarousel", {
    slidesPerView: 1,
    spaceBetween: 20,
    grabCursor: true,
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
    },
    navigation: {
      nextEl: ".swiper-button-next-custom",
      prevEl: ".swiper-button-prev-custom",
    },
    breakpoints: {
      540: {
        slidesPerView: 2,
        spaceBetween: 20,
      },
      840: {
        slidesPerView: 3,
        spaceBetween: 24,
      },
      1200: {
        slidesPerView: 4,
        spaceBetween: 24,
      },
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
  } catch (error) {
    console.error("Erro ao carregar detalhes:", error);
    showError(`Erro ao carregar detalhes do produto: ${error.message}`);
  } finally {
    showLoading(false);
  }
}

function renderProductDetails(product) {
  // Informações básicas
  dom.productBrand.querySelector("span") ? (dom.productBrand.querySelector("span").textContent = product.brand || "Mizuno") : (dom.productBrand.textContent = product.brand || "Mizuno");
  dom.productName.textContent = product.name || product.productName || "Produto Mizuno";
  dom.productDescription.textContent = product.description || product.metaTagDescription || "Sem descrição disponível para este produto.";

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

  // Variações
  renderVariations(product.variations || []);

  // Mostrar seção de detalhes
  dom.detailsSection.classList.remove("hidden");
  dom.productsSection.classList.add("hidden");

  refreshIcons();

  // Scroll suave para o topo
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderThumbnails(images) {
  if (!images || images.length <= 1) {
    dom.thumbnailsContainer.parentElement.classList.add("hidden");
    return;
  }

  dom.thumbnailsContainer.parentElement.classList.remove("hidden");
  dom.thumbnailsContainer.innerHTML = images
    .map(
      (image, index) => `
        <div
          class="thumbnail-image ${index === 0 ? "active" : ""} w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-slate-50 border-2 border-slate-200/90 hover:border-blue-400 p-1 flex items-center justify-center cursor-pointer shrink-0 shadow-sm transition-all"
          data-full-url="${image.imageUrl}"
          onclick="changeMainImage(this)"
        >
          <img
            src="${image.imageUrl}"
            alt="Miniatura ${index + 1}"
            class="max-h-full max-w-full object-contain mix-blend-multiply"
            onerror="this.src='https://via.placeholder.com/80x80?text=Foto'"
          />
        </div>
      `,
    )
    .join("");
}

function changeMainImage(thumbnail) {
  // Remover classe ativa de todas as miniaturas
  document.querySelectorAll(".thumbnail-image").forEach((img) => {
    img.classList.remove("active");
  });

  // Adicionar classe ativa à miniatura selecionada
  thumbnail.classList.add("active");

  // Atualizar imagem principal com animação sutil
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
  dom.addToCartBtn.classList.add("disabled");
  dom.addToCartBtn.href = "#";

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

    if (variations[0].addToCartLink) {
      dom.addToCartBtn.href = variations[0].addToCartLink;
      dom.addToCartBtn.classList.remove("disabled");
    }
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
      dom.addToCartBtn.classList.add("disabled");
      dom.addToCartBtn.href = "#";
      return;
    }

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
    }
    refreshIcons();
  };

  // Event listener para cor
  dom.colorSelect.onchange = function () {
    updateSelectedVariation(sizeMap);
  };
}

function updateSelectedVariation(sizeMap) {
  const selectedSize = dom.sizeSelect.value;
  const selectedColor = dom.colorSelect.value;

  if (!selectedSize || !selectedColor) {
    dom.selectedVariationDiv.classList.add("hidden");
    dom.addToCartBtn.classList.add("disabled");
    dom.addToCartBtn.href = "#";
    return;
  }

  const variationsForSize = sizeMap?.[selectedSize] || [];
  const variation = variationsForSize.find((v) => v._resolvedColor === selectedColor) || variationsForSize[0];

  if (variation) {
    state.selectedVariation = variation;

    dom.selectedVariationText.textContent = variation.nameComplete || variation.name || `${selectedSize} - ${selectedColor}`;
    dom.selectedVariationDiv.classList.remove("hidden");

    if (variation.addToCartLink) {
      dom.addToCartBtn.href = variation.addToCartLink;
      dom.addToCartBtn.classList.remove("disabled");
      dom.addToCartBtn.removeAttribute("disabled");
    } else {
      dom.addToCartBtn.classList.add("disabled");
      dom.addToCartBtn.setAttribute("disabled", "true");
      dom.addToCartBtn.href = "#";
    }

    // Se a variação tem imagens específicas, trocar
    if (variation.images && variation.images.length > 0 && variation.images[0].imageUrl) {
      dom.mainImage.src = variation.images[0].imageUrl;
    }

    refreshIcons();
  }
}

// ============================================================
// NAVEGAÇÃO
// ============================================================

dom.clearCategoryBtn.addEventListener("click", () => {
  state.selectedProduct = null;
  state.selectedVariation = null;
  dom.detailsSection.classList.add("hidden");
  dom.productsSection.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

dom.backToCarouselBtn.addEventListener("click", () => {
  state.selectedProduct = null;
  state.selectedVariation = null;
  dom.detailsSection.classList.add("hidden");
  dom.productsSection.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

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
  dom.productsSection.classList.add("hidden");
  dom.detailsSection.classList.add("hidden");
  refreshIcons();
}
