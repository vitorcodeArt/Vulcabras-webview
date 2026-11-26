// ======================================================
// PEDIDO E PRODUTOS SELECIONADOS (tabela flow_session_orders)
// ======================================================
// Única exceção à regra "pedido só como hash": o número do pedido e os produtos
// que o cliente selecionou, para o detalhe de um envio (GET /sends/:sendId).
// Tudo é best-effort: falha aqui nunca afeta o fluxo, e o log leva só o código
// do erro (nunca o pedido, os produtos nem a conversa).

const MAX_ITEMS = 50;
const MAX_TITLE = 300;
const MAX_SKU = 200;
const MAX_URL = 1000;
// Parâmetros de URL que indicam token ou dado do cliente
const SENSITIVE_PARAM = /token|signature|^sig$|key|auth|expires|x-amz|e-?mail|cpf|document|customer|session/i;

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Só https pública, sem usuário/senha e sem parâmetro sensível; senão null
function publicImageUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_PARAM.test(name)) return null;
  }
  return url.toString();
}

// Cruza os SKUs escolhidos com os itens do pedido: só entra o que existe no pedido.
// O Troque não informa o tamanho em campo separado (vem no texto do produto): size = null.
function selectedItems(orderItems, selection) {
  if (!Array.isArray(orderItems) || !Array.isArray(selection)) return [];
  const result = [];
  const seen = new Set();
  for (const chosen of selection.slice(0, MAX_ITEMS)) {
    const sku = chosen?.sku;
    if (typeof sku !== "string" || seen.has(sku)) continue;
    const item = orderItems.find((o) => o.sku === sku);
    if (!item) continue;
    seen.add(sku);
    result.push({
      title: clip(item.description, MAX_TITLE) || clip(sku, MAX_TITLE),
      sku: clip(sku, MAX_SKU) || null,
      size: null,
      image_url: publicImageUrl(item.image),
    });
  }
  return result;
}

function errorLabel(error) {
  return error?.code || error?.name || "erro";
}

// Uma linha por sessão. Lista vazia não apaga os itens já gravados do mesmo
// pedido; trocar de pedido substitui os dois. Nunca rejeita.
async function saveOrderDetails({ sessionId, sendId = null, conversationId, orderNumber, items = [] }, { db = require("./db") } = {}) {
  try {
    if (!sessionId || !conversationId || !orderNumber || !db.getPool()) return false;
    await db.query(
      `insert into flow_session_orders (session_id, send_id, conversation_id, order_number, items)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (session_id) do update set
         send_id = coalesce(excluded.send_id, flow_session_orders.send_id),
         items = case
           when flow_session_orders.order_number = excluded.order_number and excluded.items = '[]'::jsonb
             then flow_session_orders.items
           else excluded.items
         end,
         order_number = excluded.order_number,
         updated_at = now()`,
      [sessionId, sendId || null, conversationId, orderNumber, JSON.stringify(items)],
    );
    return true;
  } catch (error) {
    console.error(`Pedido do acompanhamento não gravado (${errorLabel(error)})`);
    return false;
  }
}

module.exports = { saveOrderDetails, selectedItems, publicImageUrl };
