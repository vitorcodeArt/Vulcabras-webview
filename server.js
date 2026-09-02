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
// ENVIAR WEBVIEW PARA UMA CONVERSA
// ======================================================

app.post("/api/send-webview", async (req, res) => {
  try {
    const { conversationId } = req.body;

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

    const uri = `${WEBVIEW_URL}?conversationId=${encodeURIComponent(conversationId)}`;

    const payload = {
      author: {
        type: "business",
      },

      content: {
        type: "text",

        text: "Consulte o rastreamento do seu pedido:",

        actions: [
          {
            type: "webview",

            text: "Ver rastreamento",

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
        auth: {
          username: ZENDESK_KEY_ID,

          password: ZENDESK_SECRET,
        },

        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    res.json({
      success: true,

      message: "Webview enviada com sucesso",

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

const VTEX_STORE_URL = process.env.VTEX_STORE_URL;
const VTEX_API_KEY = process.env.VTEX_API_KEY;
const VTEX_API_TOKEN = process.env.VTEX_API_TOKEN;

// Categorias disponíveis
const CATEGORIES = [
  { id: "1", name: "Masculino", categoryId: "3" },
  { id: "2", name: "Feminino", categoryId: "4" },
  { id: "3", name: "Kids", categoryId: "5" },
  { id: "4", name: "Esportes", categoryId: "6" },
  { id: "5", name: "Calçados", categoryId: "2" },
];

// Endpoint: listar categorias
app.get("/api/catalog/categories", (req, res) => {
  res.json({
    success: true,
    categories: CATEGORIES,
  });
});

// Endpoint: buscar produtos por categoria
app.get("/api/catalog/products", async (req, res) => {
  try {
    const { categoryId } = req.query;

    if (!categoryId) {
      return res.status(400).json({
        success: false,
        error: "categoryId é obrigatório",
      });
    }

    if (!VTEX_STORE_URL || !VTEX_API_KEY || !VTEX_API_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "Credenciais VTEX não configuradas",
      });
    }

    const url = `https://${VTEX_STORE_URL}/api/catalog_system/pub/products/search?fq=C:${categoryId}`;

    const response = await axios.get(url, {
      headers: {
        "X-VTEX-API-AppKey": VTEX_API_KEY,
        "X-VTEX-API-AppToken": VTEX_API_TOKEN,
      },
    });

    // Mapear apenas dados necessários
    const products = response.data.map((product) => ({
      productId: product.productId,
      name: product.name,
      brand: product.brand,
      metaTagDescription: product.metaTagDescription,
      image: product.image,
    }));

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

// Endpoint: buscar detalhes do produto
app.get("/api/catalog/product-details", async (req, res) => {
  try {
    const { productId } = req.query;

    if (!productId) {
      return res.status(400).json({
        success: false,
        error: "productId é obrigatório",
      });
    }

    if (!VTEX_STORE_URL || !VTEX_API_KEY || !VTEX_API_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "Credenciais VTEX não configuradas",
      });
    }

    const url = `https://${VTEX_STORE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}`;

    const response = await axios.get(url, {
      headers: {
        "X-VTEX-API-AppKey": VTEX_API_KEY,
        "X-VTEX-API-AppToken": VTEX_API_TOKEN,
      },
    });

    if (!response.data || response.data.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Produto não encontrado",
      });
    }

    const product = response.data[0];

    // Validar se tem items
    if (!product.items || product.items.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Produto sem variações disponíveis",
      });
    }

    // Extrair imagens do primeiro item (máximo 5)
    const images = product.items[0].images.slice(0, 5).map((img) => ({
      url: img.imageUrl,
      text: img.imageText,
    }));

    // Extrair variações (SKUs com tamanho, cor e link)
    const variations = product.items.map((item) => ({
      sku: item.itemId,
      name: item.name,
      nameComplete: item.nameComplete,
      complementName: item.complementName || product.complementName,
      addToCartLink: item.sellers?.[0]?.addToCartLink || null,
    }));

    res.json({
      success: true,
      productId: product.productId,
      name: product.productName,
      brand: product.brand,
      description: product.description,
      complementName: product.complementName,
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
