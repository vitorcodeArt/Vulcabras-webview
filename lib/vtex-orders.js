// ======================================================
// PEDIDO NA VTEX (OMS), para o detalhe de um envio no app da Zendesk
// ======================================================
// A resposta da VTEX tem muitos dados pessoais (documento, nome, e-mail, telefone,
// endereço, cartão, nota fiscal). Daqui só sai a LISTA FECHADA montada em mapOrder():
// um campo novo da VTEX nunca passa sozinho. Nada é gravado no banco; o cache é em
// memória e dura poucos minutos. O log leva só o status HTTP: nunca o número do
// pedido, o corpo da resposta nem as chaves.

const axios = require("axios");
const { publicImageUrl: publicUrl } = require("./order-details");

const TIMEOUT_MS = 10000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_ITEMS = 50;
const ORDER_NUMBER = /^[A-Za-z0-9_-]{4,60}$/;
// A Mizuno consulta pedidos num endereço próprio, diferente do usado no catálogo
const OMS_DEFAULTS = { mizuno: "mizunobrio.vtexcommercestable.com.br" };
// As chaves só são enviadas para a VTEX
const VTEX_HOST = /^[a-z0-9-]+\.vtexcommercestable\.com\.br$/i;

function omsHost(brand, store, env = process.env) {
  const raw = env[`VTEX_${String(brand).toUpperCase()}_OMS_URL`] || OMS_DEFAULTS[brand] || store?.storeUrl;
  const host = String(raw || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return VTEX_HOST.test(host) ? host : null;
}

// O cliente pode digitar o número com o prefixo da nota ("XXXX-VT-...") ou sem o "-01"
function orderIdCandidates(orderNumber) {
  if (typeof orderNumber !== "string" || !ORDER_NUMBER.test(orderNumber)) return [];
  const bare = orderNumber.replace(/^(?:[A-Za-z]+-){1,2}(?=\d)/, "");
  const list = [orderNumber, bare];
  if (/^\d{13}$/.test(bare)) list.push(`${bare}-01`);
  return [...new Set(list)];
}

const text = (value, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const int = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const list = (value) => (Array.isArray(value) ? value : []);

function date(value) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

// A VTEX manda a miniatura de 55 px: pede a mesma imagem em 200 px
function productImage(value) {
  const url = publicUrl(value);
  return url ? url.replace(/(\/arquivos\/ids\/\d+)-\d+-\d+\//, "$1-200-200/") : null;
}

function mapOrder(raw) {
  const total = (id) => int(list(raw.totals).find((t) => t?.id === id)?.value);
  const variations = new Map(list(raw.itemMetadata?.Items).map((m) => [String(m?.Id), m?.SkuName]));
  const logistics = list(raw.shippingData?.logisticsInfo)[0];

  return {
    order_id: text(raw.orderId, 60),
    status: text(raw.status, 40),
    status_label: text(raw.statusDescription, 60),
    created_at: date(raw.creationDate),
    invoiced_at: date(raw.invoicedDate),
    totals: {
      items_cents: total("Items"),
      discounts_cents: total("Discounts"),
      shipping_cents: total("Shipping"),
      total_cents: int(raw.value),
    },
    items: list(raw.items)
      .slice(0, MAX_ITEMS)
      .map((item) => ({
        name: text(item?.name),
        variation: text(variations.get(String(item?.id)), 80),
        ref_id: text(item?.refId, 80),
        quantity: int(item?.quantity),
        price_cents: int(item?.sellingPrice),
        list_price_cents: int(item?.listPrice),
        image_url: productImage(item?.imageUrl),
      })),
    shipping: {
      courier: text(logistics?.deliveryCompany, 80),
      method: text(logistics?.selectedSla, 80),
      estimate_at: date(logistics?.shippingEstimateDate),
    },
    packages: list(raw.packageAttachment?.packages)
      .slice(0, MAX_ITEMS)
      .map((p) => ({
        courier: text(p?.courier, 80),
        tracking_number: text(p?.trackingNumber, 80),
        tracking_url: publicUrl(p?.trackingUrl),
        delivered_at: date(p?.courierStatus?.deliveredDate),
      })),
    payments: list(raw.paymentData?.transactions)
      .flatMap((t) => list(t?.payments))
      .slice(0, 10)
      .map((p) => ({ method: text(p?.paymentSystemName, 60), installments: int(p?.installments) })),
  };
}

// lookup() nunca rejeita: devolve { order, reason }.
// reason: null | "not_found" | "not_configured" | "forbidden" | "unavailable"
function createVtexOrders({ getStores, env = process.env, http = axios, now = () => Date.now() }) {
  const cache = new Map();

  function remember(key, result) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { result, expiresAt: now() + CACHE_MS });
    return result;
  }

  const failure = (reason, detail) => {
    console.error(`VTEX pedidos: consulta não concluída (${detail})`);
    return { order: null, reason };
  };

  async function lookup(brand, orderNumber) {
    const store = getStores()?.[brand];
    const host = omsHost(brand, store, env);
    if (!store?.apiKey || !store?.apiToken || !host) return { order: null, reason: "not_configured" };

    const key = `${brand}|${orderNumber}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;

    for (const id of orderIdCandidates(orderNumber)) {
      let response;
      try {
        response = await http.get(`https://${host}/api/oms/pvt/orders/${encodeURIComponent(id)}`, {
          headers: { Accept: "application/json", "X-VTEX-API-AppKey": store.apiKey, "X-VTEX-API-AppToken": store.apiToken },
          timeout: TIMEOUT_MS,
          maxRedirects: 0,
          validateStatus: () => true,
        });
      } catch (error) {
        return failure("unavailable", error?.code || "sem resposta");
      }
      if (response.status === 200 && response.data?.orderId) return remember(key, { order: mapOrder(response.data), reason: null });
      if (response.status === 401 || response.status === 403) return failure("forbidden", `HTTP ${response.status}`);
      if (response.status !== 404 && response.status !== 400) return failure("unavailable", `HTTP ${response.status}`);
    }
    return remember(key, { order: null, reason: "not_found" });
  }

  return { lookup };
}

module.exports = { createVtexOrders, mapOrder, omsHost, orderIdCandidates };
