const express = require("express");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================================================
// CONFIGURAÇÕES
// ======================================================

const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_APP_ID = process.env.ZENDESK_APP_ID;
const ZENDESK_KEY_ID = process.env.ZENDESK_KEY_ID;
const ZENDESK_SECRET = process.env.ZENDESK_SECRET;

const WEBVIEW_URL = process.env.WEBVIEW_URL || `http://localhost:${PORT}/webview`;

// ======================================================
// FRONTEND
// ======================================================

app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    application: "Zendesk Tracking Webview",
    status: "online",
  });
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    application: "Zendesk Tracking Webview",
    status: "online",
  });
});

// ======================================================
// WEBVIEW
// ======================================================

app.get("/webview", (req, res) => {
  console.log("Webview aberta", {
    conversationId: req.query.conversationId,
  });

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ======================================================
// CATÁLOGO
// ======================================================

app.get("/catalog", (req, res) => {
  console.log("Catálogo de produtos acessado");

  res.sendFile(path.join(__dirname, "public", "pages", "catalog.html"));
});

// ======================================================
// DADOS DE TESTE DO RASTREAMENTO
// ======================================================

app.get("/api/tracking", (req, res) => {
  const tracking = {
    orderId: "1637695728977-01",

    events: [
      {
        status: 83,
        descricao: "COLETA REALIZADA",
        data: "2026-06-10T09:10:57",
        cidade: "Extrema",
        uf: "MG",
      },
      {
        status: 99,
        descricao: "INÍCIO DE COLETA",
        data: "2026-06-10T09:10:55",
        cidade: "Extrema",
        uf: "MG",
      },
      {
        status: 100,
        descricao: "ARQUIVO APROVADO",
        data: "2026-06-10T09:10:55",
        cidade: "Extrema",
        uf: "MG",
      },
      {
        status: 0,
        descricao: "ARQUIVO RECEBIDO",
        data: "2026-06-10T07:16:11",
        cidade: "Barueri",
        uf: "SP",
      },
    ],
  };

  res.json(tracking);
});

// ======================================================
// ENVIAR WEBVIEW PARA UMA CONVERSA (DINÂMICO)
// ======================================================

app.post("/api/send-webview", async (req, res) => {
  try {
    const { conversationId, type = "tracking", store = "mizuno", customText, buttonText } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: "conversationId é obrigatório",
      });
    }

    if (!ZENDESK_SUBDOMAIN || !ZENDESK_APP_ID || !ZENDESK_KEY_ID || !ZENDESK_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Credenciais do Zendesk não configuradas",
      });
    }

    const isCatalog = type === "catalog";
    const storeKey = String(store || "mizuno").toLowerCase();

    // valida a loja apenas quando o fluxo for de catálogo
    if (isCatalog && !VTEX_STORES[storeKey]) {
      return res.status(400).json({
        success: false,
        error: `Loja "${storeKey}" inválida. Opções: ${Object.keys(VTEX_STORES).join(", ")}`,
      });
    }

    const baseUrl = process.env.WEBVIEW_URL ? process.env.WEBVIEW_URL.replace(/\/(webview|catalog)\/?$/, "") : `http://localhost:${PORT}`;

    const targetPath = isCatalog ? "catalog" : "webview";

    const params = new URLSearchParams({ conversationId });
    if (isCatalog) params.set("store", storeKey);

    const uri = `${baseUrl}/${targetPath}?${params.toString()}`;

    const storeLabel = isCatalog ? VTEX_STORES[storeKey].label : null;

    const messageText = customText || (isCatalog ? `Confira o nosso catálogo ${storeLabel}:` : "Consulte o rastreamento do seu pedido:");
    const actionButtonText = buttonText || (isCatalog ? "Ver Catálogo" : "Ver rastreamento");

    const payload = {
      author: { type: "business" },
      content: {
        type: "text",
        text: messageText,
        actions: [
          {
            type: "webview",
            text: actionButtonText,
            size: "tall",
            uri,
            fallback: uri,
          },
        ],
      },
    };

    const response = await axios.post(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/sc/v2/apps/${ZENDESK_APP_ID}/conversations/${conversationId}/messages`,
      payload,
      {
        auth: { username: ZENDESK_KEY_ID, password: ZENDESK_SECRET },
        headers: { "Content-Type": "application/json" },
      }
    );

    res.json({
      success: true,
      message: `Webview (${isCatalog ? `catálogo ${storeLabel}` : "rastreamento"}) enviada com sucesso`,
      data: response.data,
    });
  } catch (error) {
    console.error("Erro ao enviar Webview:");
    console.error(error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ======================================================
// CATÁLOGO DE PRODUTOS (VTEX)
// ======================================================

// Uma configuração de loja VTEX por bot/instância (Mizuno, Olympikus, Under Armour).
// Mantém compatibilidade com as variáveis antigas VTEX_STORE_URL/API_KEY/API_TOKEN para a Mizuno.
const VTEX_STORES = {
  mizuno: {
    label: "Mizuno",
    storeUrl: process.env.VTEX_MIZUNO_STORE_URL || process.env.VTEX_STORE_URL,
    apiKey: process.env.VTEX_MIZUNO_API_KEY || process.env.VTEX_API_KEY,
    apiToken: process.env.VTEX_MIZUNO_API_TOKEN || process.env.VTEX_API_TOKEN,
  },
  olympikus: {
    label: "Olympikus",
    storeUrl: process.env.VTEX_OLYMPIKUS_STORE_URL,
    apiKey: process.env.VTEX_OLYMPIKUS_API_KEY,
    apiToken: process.env.VTEX_OLYMPIKUS_API_TOKEN,
  },
  underarmour: {
    label: "Under Armour",
    storeUrl: process.env.VTEX_UNDERARMOUR_STORE_URL,
    apiKey: process.env.VTEX_UNDERARMOUR_API_KEY,
    apiToken: process.env.VTEX_UNDERARMOUR_API_TOKEN,
  },
};

// Categorias por loja (IDs específicos da árvore de categorias de cada VTEX)
const STORE_CATEGORIES = {
  mizuno: [
    { id: "1", name: "Masculino", categoryId: "1" },
    { id: "2", name: "Feminino", categoryId: "2" },
    { id: "3", name: "Kids", categoryId: "3" },
    { id: "4", name: "Esportes", categoryId: "69" },
    { id: "5", name: "Calçados", categoryId: "74" },
  ],
  // TODO: ajustar os categoryId reais da Olympikus e Under Armour quando disponíveis
  olympikus: [
    { id: "1", name: "Masculino", categoryId: "1" },
    { id: "2", name: "Feminino", categoryId: "2" },
    { id: "3", name: "Kids", categoryId: "3" },
    { id: "4", name: "Esportes", categoryId: "69" },
    { id: "5", name: "Calçados", categoryId: "74" },
  ],
  underarmour: [
    { id: "1", name: "Masculino", categoryId: "1" },
    { id: "2", name: "Feminino", categoryId: "2" },
    { id: "3", name: "Kids", categoryId: "3" },
    { id: "4", name: "Esportes", categoryId: "69" },
    { id: "5", name: "Calçados", categoryId: "74" },
  ],
};

// Resolve a configuração da loja a partir de ?store= (padrão: mizuno) e valida credenciais
function resolveStore(req, res) {
  const storeKey = String(req.query.store || "mizuno").toLowerCase();
  const config = VTEX_STORES[storeKey];

  if (!config) {
    res.status(400).json({
      success: false,
      error: `Loja "${storeKey}" inválida. Opções: ${Object.keys(VTEX_STORES).join(", ")}`,
    });
    return null;
  }

  if (!config.storeUrl || !config.apiKey || !config.apiToken) {
    res.status(500).json({
      success: false,
      error: `Credenciais VTEX não configuradas para a loja "${storeKey}"`,
    });
    return null;
  }

  return { key: storeKey, ...config };
}

// Endpoint: listar categorias
app.get("/api/catalog/categories", (req, res) => {
  const storeKey = String(req.query.store || "mizuno").toLowerCase();
  const categories = STORE_CATEGORIES[storeKey];

  if (!categories) {
    return res.status(400).json({
      success: false,
      error: `Loja "${storeKey}" inválida. Opções: ${Object.keys(STORE_CATEGORIES).join(", ")}`,
    });
  }

  res.json({
    success: true,
    categories,
  });
});

// Mapeia o retorno cru da VTEX para os campos usados pelo catálogo
function mapVtexProduct(product, storeLabel) {
  let imageUrl = null;
  let price = null;
  let listPrice = null;

  // Buscar a primeira imagem válida em todos os items
  if (Array.isArray(product.items)) {
    for (const item of product.items) {
      const itemImages = item.images || item.image || [];
      if (Array.isArray(itemImages) && itemImages.length > 0) {
        for (const img of itemImages) {
          const url = typeof img === "object" ? img?.imageUrl || img?.url : img;
          if (url && typeof url === "string" && url.trim().length > 0) {
            imageUrl = url.trim();
            break;
          }
        }
      }
      if (imageUrl) break;
    }

    // Buscar preços
    const firstSeller = product.items[0]?.sellers?.[0];
    if (firstSeller?.commertialOffer) {
      price = firstSeller.commertialOffer.Price || null;
      listPrice = firstSeller.commertialOffer.ListPrice || null;
    }
  }

  // Fallback para raiz do produto
  if (!imageUrl && product.image) {
    imageUrl = typeof product.image === "object" ? product.image.imageUrl || product.image.url : product.image;
  }

  const productName = product.productName || product.name || product.productTitle || product.metaTagDescription || "Produto";

  return {
    productId: product.productId,
    name: productName,
    brand: product.brand || storeLabel || "Produto",
    metaTagDescription: product.metaTagDescription || "",
    price: price,
    listPrice: listPrice,
    image: imageUrl,
    imageUrl: imageUrl,
  };
}

// Agrupa produtos com o mesmo nome (a VTEX retorna um produto por cor) em um único card
function groupProductsByName(rawProducts, storeLabel) {
  const groups = new Map();

  rawProducts.forEach((product) => {
    const key = (product.productName || product.name || product.productTitle || product.metaTagDescription || "").trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  });

  return Array.from(groups.values()).map((group) => ({
    ...mapVtexProduct(group[0], storeLabel),
    productIds: group.map((p) => String(p.productId)),
  }));
}

// Endpoint: buscar produtos por categoria
app.get("/api/catalog/products", async (req, res) => {
  try {
    const { categoryId } = req.query;
    const store = resolveStore(req, res);
    if (!store) return;

    if (!categoryId) {
      return res.status(400).json({
        success: false,
        error: "categoryId é obrigatório",
      });
    }

    const url = `https://${store.storeUrl}/api/catalog_system/pub/products/search?fq=C:${categoryId}`;

    const response = await axios.get(url, {
      headers: {
        "X-VTEX-API-AppKey": store.apiKey,
        "X-VTEX-API-AppToken": store.apiToken,
      },
    });

    const products = groupProductsByName(response.data, store.label);
    console.log("Produtos mapeados:", products);

    res.json({
      success: true,
      products,
    });
  } catch (error) {
    console.error("Erro ao buscar produtos VTEX:");
    console.error(error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Endpoint: buscar produtos por nome/termo de pesquisa
app.get("/api/catalog/search", async (req, res) => {
  try {
    const { query } = req.query;
    const store = resolveStore(req, res);
    if (!store) return;

    if (!query || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: "query é obrigatório",
      });
    }

    const url = `https://${store.storeUrl}/api/catalog_system/pub/products/search/${encodeURIComponent(query.trim())}`;

    const response = await axios.get(url, {
      headers: {
        "X-VTEX-API-AppKey": store.apiKey,
        "X-VTEX-API-AppToken": store.apiToken,
      },
    });

    const products = groupProductsByName(response.data, store.label);
    console.log(`Produtos encontrados para "${query}":`, products.length);

    res.json({
      success: true,
      products,
    });
  } catch (error) {
    console.error("Erro ao buscar produtos VTEX por nome:");
    console.error(error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Endpoint: buscar detalhes do produto
app.get("/api/catalog/product-details", async (req, res) => {
  try {
    const { productId } = req.query;
    const store = resolveStore(req, res);
    if (!store) return;

    if (!productId) {
      return res.status(400).json({
        success: false,
        error: "productId é obrigatório",
      });
    }

    // productId pode conter múltiplos IDs (um por cor) separados por vírgula
    const ids = String(productId)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    const headers = {
      "X-VTEX-API-AppKey": store.apiKey,
      "X-VTEX-API-AppToken": store.apiToken,
    };

    const responses = await Promise.all(ids.map((id) => axios.get(`https://${store.storeUrl}/api/catalog_system/pub/products/search?fq=productId:${id}`, { headers })));

    const rawProducts = responses.map((r) => r.data?.[0]).filter(Boolean);

    if (rawProducts.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Produto não encontrado",
      });
    }

    const productsWithItems = rawProducts.filter((p) => Array.isArray(p.items) && p.items.length > 0);

    if (productsWithItems.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Produto sem variações disponíveis",
      });
    }

    const mainProduct = productsWithItems[0];

    // Extrair variações (SKUs com tamanho, cor, link e imagens) de todas as cores agrupadas
    const variations = productsWithItems.flatMap((product) =>
      product.items.map((item) => {
        const seller = item.sellers?.[0];
        const commertialOffer = seller?.commertialOffer || {};
        const itemImages = (item.images || item.image || []).map((img) => ({
          imageUrl: typeof img === "object" ? img?.imageUrl || img?.url || "" : img || "",
          url: typeof img === "object" ? img?.imageUrl || img?.url || "" : img || "",
        }));

        const size = (Array.isArray(item.Tamanho) && item.Tamanho[0]) || null;
        const color = (Array.isArray(item.Cor) && item.Cor[0]) || null;

        return {
          sku: item.itemId,
          name: item.name,
          nameComplete: item.nameComplete,
          size: size,
          color: color,
          price: commertialOffer.Price || null,
          listPrice: commertialOffer.ListPrice || null,
          complementName: item.complementName || product.complementName,
          addToCartLink: seller?.addToCartLink || null,
          images: itemImages,
        };
      }),
    );

    // Coletar imagens únicas do produto/cor padrão (primeiro da lista) para a galeria inicial
    const imagesMap = new Map();
    mainProduct.items.forEach((item) => {
      const itemImages = item.images || item.image || [];
      if (Array.isArray(itemImages)) {
        itemImages.forEach((img) => {
          const url = typeof img === "object" ? img?.imageUrl || img?.url || "" : img || "";
          if (url && !imagesMap.has(url)) {
            imagesMap.set(url, {
              imageUrl: url,
              url: url,
              text: (typeof img === "object" && (img.imageText || img.text)) || mainProduct.productName || "",
            });
          }
        });
      }
    });

    const images = Array.from(imagesMap.values()).slice(0, 8);

    if (images.length === 0 && mainProduct.image) {
      const fallbackUrl = typeof mainProduct.image === "object" ? mainProduct.image.imageUrl || mainProduct.image.url : mainProduct.image;
      images.push({
        imageUrl: fallbackUrl,
        url: fallbackUrl,
        text: mainProduct.productName || "",
      });
    }

    res.json({
      success: true,
      productId: mainProduct.productId,
      name: mainProduct.productName || mainProduct.name || mainProduct.productTitle || mainProduct.metaTagDescription || "Produto Mizuno",
      brand: mainProduct.brand || "Mizuno",
      description: mainProduct.description || mainProduct.metaTagDescription || "",
      complementName: mainProduct.complementName,
      images,
      variations,
    });
  } catch (error) {
    console.error("Erro ao buscar detalhes do produto VTEX:");
    console.error(error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ======================================================
// START
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado na porta ${PORT}`);

  if (process.env.NODE_ENV !== "production") {
    console.log(`Webview: http://localhost:${PORT}/webview`);
  }
});
