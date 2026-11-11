// ============================================================
// ESTADO DO FLUXO (somente em memória)
// CPF, e-mail, endereço e dados bancários ficam aqui enquanto a webview está
// aberta. Nada vai para localStorage/sessionStorage.
// ============================================================

export const state = {
  brand: null,
  // exchange | refund | track
  type: null,
  // { orderNumber, identifier }
  identity: null,
  notFoundCount: 0,
  // Retorno do /prepare
  prepared: null,
  // Ordem em que os itens foram escolhidos
  selectedSkus: [],
  // sku -> { quantity, reason, sub_reason, comment }
  selection: {},
  reasonIndex: 0,
  // Endereço: null = usar o do pedido; objeto = endereço informado
  address: null,
  addressMode: null,
  // Depois de ADDRESS_NOT_EDITABLE: segue com o endereço do pedido
  addressForcedOrder: false,
  customer: {},
  retention: {
    offer: null,
    // null (sem decisão) | { accepted, level? }
    decision: null,
    shownLevel: null,
    // Token da opção de envio, depois de RETENTION_OFFER_CHANGED
    shippingToken: null,
  },
  quote: null,
  quoteKey: null,
  shippingToken: null,
  paymentBill: null,
  result: null,
  trackResult: null,
  // { message, code, handoffReason, offerTrack, offerRestart }
  error: null,
  // Aviso exibido uma vez na próxima tela { kind, text }
  flash: null,
};

export function identityBody() {
  return {
    order_number: state.identity?.orderNumber || "",
    customer_identifier: state.identity?.identifier || "",
  };
}

export function orderItems() {
  return state.prepared?.order?.items || [];
}

export function findOrderItem(sku) {
  return orderItems().find((item) => item.sku === sku) || null;
}

export function reasonsForType() {
  const reasons = state.prepared?.reasons || [];
  return reasons.filter((r) => (state.type === "exchange" ? r.is_exchange : r.is_refund));
}

export function findReason(text) {
  return reasonsForType().find((r) => r.reason === text) || null;
}

// Itens no formato da API (retenção, cotação e criação)
export function itemsPayload({ full = false } = {}) {
  return state.selectedSkus.map((sku) => {
    const entry = state.selection[sku];
    const item = { sku, quantity: entry.quantity, reason: entry.reason };
    if (full) {
      if (entry.sub_reason) item.sub_reason = entry.sub_reason;
      if (entry.comment) item.comment = entry.comment;
    }
    return item;
  });
}

export function retentionAccepted() {
  return state.type === "refund" && state.retention.decision?.accepted === true;
}

// automatic/forced: a devolução fecha em vale-compras sem o cliente escolher
export function closesInCredit() {
  const offer = state.retention.offer;
  return state.type === "refund" && Boolean(offer?.available) && (offer.mode === "automatic" || offer.mode === "forced");
}

export function needsAddressStep() {
  const step = state.prepared?.address_step;
  if (!step) return false;
  const customerFields = step.missing_customer_fields || [];
  const lockedWithAddress = step.mode === "locked" && Boolean(state.prepared?.order?.address);
  return step.mode === "confirm" || step.mode === "ask_full_address" || lockedWithAddress || customerFields.length > 0;
}

export function needsRefundStep() {
  return state.type === "refund" && state.prepared?.order?.is_bank_transfer === true && !retentionAccepted() && !closesInCredit();
}

// Descarta o que depende de uma decisão anterior. stage: items | address | retention | shipping
export function invalidateFrom(stage) {
  const order = ["items", "address", "retention", "shipping"];
  const index = order.indexOf(stage);
  if (index <= order.indexOf("items")) {
    state.reasonIndex = 0;
  }
  if (index <= order.indexOf("retention")) {
    state.retention = { offer: null, decision: null, shownLevel: null, shippingToken: null };
  }
  if (index <= order.indexOf("shipping")) {
    state.quote = null;
    state.quoteKey = null;
    state.shippingToken = null;
  }
}

// Volta ao início (nova escolha de tipo), mantendo marca e identificação
export function resetFlow() {
  const { brand, identity } = state;
  Object.assign(state, {
    type: null,
    prepared: null,
    selectedSkus: [],
    selection: {},
    reasonIndex: 0,
    address: null,
    addressMode: null,
    addressForcedOrder: false,
    customer: {},
    retention: { offer: null, decision: null, shownLevel: null, shippingToken: null },
    quote: null,
    quoteKey: null,
    shippingToken: null,
    paymentBill: null,
    result: null,
    trackResult: null,
    error: null,
    flash: null,
  });
  state.brand = brand;
  state.identity = identity;
}

export function takeFlash() {
  const flash = state.flash;
  state.flash = null;
  return flash;
}
