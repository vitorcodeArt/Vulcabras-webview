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
};

// ============================================================
// INICIALIZAÇÃO
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
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
    .map(
      (category) => `
        <button
          class="category-btn"
          data-category-id="${category.categoryId}"
          data-category-name="${category.name}"
        >
          ${category.name}
        </button>
      `,
    )
    .join("");

  // Adicionar event listeners
  document.querySelectorAll(".category-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      selectCategory(e.target);
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

    state.products = data.products;
    renderProducts(data.products);
  } catch (error) {
    console.error("Erro ao carregar produtos:", error);
    showError(`Erro ao carregar produtos: ${error.message}`);
  } finally {
    showLoading(false);
  }
}

function renderProducts(products) {
  if (products.length === 0) {
    showError("Nenhum produto encontrado nesta categoria.");
    return;
  }

  // Atualizar título
  dom.categoryTitle.textContent = state.selectedCategory.name;

  // Renderizar carrossel
  dom.productsCarousel.innerHTML = products
    .map(
      (product) => `
        <div class="swiper-slide">
          <div class="product-card">
            <img
              src="${product.image || "https://via.placeholder.com/280x200"}"
              alt="${product.name}"
              class="product-card-image"
              onerror="this.src='https://via.placeholder.com/280x200'"
            />
            <div class="product-card-body">
              <div class="product-card-brand">${product.brand || "Mizuno"}</div>
              <h3 class="product-card-name">${product.name}</h3>
              <button
                class="product-card-btn"
                data-product-id="${product.productId}"
                onclick="viewProductDetails(this)"
              >
                Mais Informações
              </button>
            </div>
          </div>
        </div>
      `,
    )
    .join("");

  // Mostrar seção de produtos
  dom.productsSection.classList.remove("hidden");

  // Inicializar/atualizar Swiper
  if (state.swiperInstance) {
    state.swiperInstance.destroy();
  }

  state.swiperInstance = new Swiper(".productCarousel", {
    slidesPerView: 1,
    spaceBetween: 20,
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
    },
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    breakpoints: {
      640: {
        slidesPerView: 2,
      },
      1024: {
        slidesPerView: 3,
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
  dom.productBrand.textContent = product.brand || "Mizuno";
  dom.productName.textContent = product.name;
  dom.productDescription.textContent = product.description || "Sem descrição disponível";

  // Imagem principal
  const mainImg = product.images[0]?.url || "https://via.placeholder.com/500x500";
  dom.mainImage.src = mainImg;
  dom.mainImage.onerror = () => {
    dom.mainImage.src = "https://via.placeholder.com/500x500";
  };

  // Miniaturas
  renderThumbnails(product.images);

  // Variações
  renderVariations(product.variations);

  // Mostrar seção de detalhes
  dom.detailsSection.classList.remove("hidden");
  dom.productsSection.classList.add("hidden");

  // Scroll para o topo
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderThumbnails(images) {
  dom.thumbnailsContainer.innerHTML = images
    .map(
      (image, index) => `
        <img
          src="${image.url || "https://via.placeholder.com/80x80"}"
          alt="Miniatura ${index + 1}"
          class="thumbnail-image ${index === 0 ? "active" : ""}"
          data-full-url="${image.url}"
          onclick="changMainImage(this)"
          onerror="this.src='https://via.placeholder.com/80x80'"
        />
      `,
    )
    .join("");
}

function changMainImage(thumbnail) {
  // Remover classe ativa de todas as miniaturas
  document.querySelectorAll(".thumbnail-image").forEach((img) => {
    img.classList.remove("active");
  });

  // Adicionar classe ativa à miniatura selecionada
  thumbnail.classList.add("active");

  // Atualizar imagem principal
  dom.mainImage.src = thumbnail.dataset.fullUrl;
}

function renderVariations(variations) {
  // Verificar se todas as variações são iguais (sem reais variações)
  const uniqueNames = new Set(variations.map((v) => v.name));

  if (uniqueNames.size === 1 && variations.length === 1) {
    // Produto sem variações - apenas uma opção
    dom.sizeSelect.innerHTML = `<option value="${variations[0].sku}" selected>Única opção disponível</option>`;
    dom.colorSelect.innerHTML = "<option value>Não aplicável</option>";
    dom.colorSelect.disabled = true;
    dom.sizeSelect.disabled = true;

    state.selectedVariation = variations[0];
    dom.selectedVariationDiv.classList.remove("hidden");
    dom.selectedVariationText.textContent = variations[0].name;

    if (variations[0].addToCartLink) {
      dom.addToCartBtn.href = variations[0].addToCartLink;
      dom.addToCartBtn.classList.remove("disabled");
    } else {
      dom.addToCartBtn.classList.add("disabled");
    }

    return;
  }

  // Tentar extrair tamanho e cor
  const sizes = new Set();
  const sizeMap = {}; // map de tamanho -> array de variações
  const hasComplexVariations = variations.some((v) => /\d+\s+\S+/.test(v.name));

  variations.forEach((variation) => {
    let size;

    if (hasComplexVariations) {
      // Extrair tamanho do formato "39 Roxo"
      const match = variation.name.match(/^(\d+)/);
      size = match ? match[1] : variation.name;
    } else {
      // Usar o nome completo como "tamanho"
      size = variation.name || variation.nameComplete;
    }

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
        // Ordenar numericamente se for número, senão alfabeticamente
        const aNum = parseInt(a);
        const bNum = parseInt(b);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return aNum - bNum;
        }
        return a.localeCompare(b);
      })
      .map((size) => `<option value="${size}">${size}</option>`)
      .join("");

  // Limpar select de cor
  dom.colorSelect.innerHTML = '<option value="">Selecione a cor</option>';
  dom.colorSelect.disabled = true;
  dom.selectedVariationDiv.classList.add("hidden");

  // Event listener para tamanho
  dom.sizeSelect.addEventListener("change", function () {
    const selectedSize = this.value;

    if (!selectedSize) {
      dom.colorSelect.innerHTML = '<option value="">Selecione a cor</option>';
      dom.colorSelect.disabled = true;
      dom.selectedVariationDiv.classList.add("hidden");
      dom.addToCartBtn.classList.add("disabled");
      return;
    }

    // Atualizar cores disponíveis para este tamanho
    const variationsForSize = sizeMap[selectedSize];
    const colors = new Set();

    variationsForSize.forEach((variation) => {
      if (hasComplexVariations) {
        // Extrair cor do formato "39 Roxo"
        const match = variation.name.match(/\s+(.+)$/);
        const color = match ? match[1] : variation.name;
        colors.add(color);
      } else {
        colors.add(variation.name);
      }
    });

    dom.colorSelect.innerHTML =
      '<option value="">Selecione a cor</option>' +
      Array.from(colors)
        .sort()
        .map((color) => `<option value="${color}">${color}</option>`)
        .join("");

    dom.colorSelect.disabled = colors.size === 0;
    dom.selectedVariationDiv.classList.add("hidden");
  });

  // Event listener para cor
  dom.colorSelect.addEventListener("change", function () {
    updateSelectedVariation(sizeMap, hasComplexVariations);
  });
}

function updateSelectedVariation(sizeMap, hasComplexVariations) {
  const selectedSize = dom.sizeSelect.value;
  const selectedColor = dom.colorSelect.value;

  if (!selectedSize || !selectedColor) {
    dom.selectedVariationDiv.classList.add("hidden");
    dom.addToCartBtn.classList.add("disabled");
    dom.addToCartBtn.href = "#";
    return;
  }

  // Encontrar a variação correspondente
  const variationsForSize = sizeMap?.[selectedSize] || [];

  let variation;
  if (hasComplexVariations) {
    variation = variationsForSize.find((v) => {
      const match = v.name.match(/^(\d+)\s+(.+)$/);
      if (!match) return false;
      const vSize = match[1];
      const vColor = match[2];
      return vSize === selectedSize && vColor === selectedColor;
    });
  } else {
    variation = variationsForSize.find((v) => v.name === selectedColor);
  }

  if (variation) {
    state.selectedVariation = variation;

    // Atualizar UI
    dom.selectedVariationText.textContent = variation.name;
    dom.selectedVariationDiv.classList.remove("hidden");

    // Atualizar link do carrinho
    if (variation.addToCartLink) {
      dom.addToCartBtn.href = variation.addToCartLink;
      dom.addToCartBtn.classList.remove("disabled");
      dom.addToCartBtn.textContent = "Adicionar ao Carrinho";
    } else {
      dom.addToCartBtn.classList.add("disabled");
      dom.addToCartBtn.textContent = "Indisponível";
      dom.addToCartBtn.href = "#";
    }
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
// UTILITÁRIOS
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
}
