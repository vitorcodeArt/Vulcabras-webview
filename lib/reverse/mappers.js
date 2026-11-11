// ======================================================
// RESPOSTAS DO TROQUE -> SÓ O QUE A TELA PRECISA
// ======================================================
// Nada de campos internos (next_step, blocked_reason, status do pedido de
// venda, preços totais etc.). O que o cliente não precisa ver não sai daqui.

const { isHandoffReason } = require("./validation");

function firstName(name) {
  if (typeof name !== "string") return null;
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}

function mapPrepare(raw) {
  const order = raw.order || null;
  const reasons = Array.isArray(raw.reasons) ? raw.reasons : [];
  const existing = Array.isArray(raw.existing_reverses) ? raw.existing_reverses : [];

  return {
    eligible: raw.eligible === true,
    ineligibility_code: raw.ineligibility_code || null,
    ineligibility_message: raw.ineligibility_message || null,
    order: order
      ? {
          ecommerce_number: order.ecommerce_number,
          delivered_at: order.delivered_at || null,
          is_bank_transfer: order.is_bank_transfer === true,
          second_reverse: order.second_reverse === true,
          number_of_defect_images: order.number_of_defect_images ?? null,
          customer: {
            first_name: firstName(order.customer?.name),
            email_masked: order.customer?.email_masked || null,
            document_masked: order.customer?.document_masked || null,
          },
          // O próprio cliente confirma este endereço na etapa de endereço
          address: order.address || null,
          items: (order.items || []).map((item) => ({
            sku: item.sku,
            description: item.description,
            quantity: item.quantity,
            price: item.price,
            image: item.image,
          })),
          unavailable_items: (order.unavailable_items || []).map((item) => ({
            sku: item.sku,
            description: item.description,
            quantity: item.quantity,
          })),
        }
      : null,
    reasons: reasons.map((reason) => ({
      reason: reason.reason,
      is_exchange: reason.is_exchange === true,
      is_refund: reason.is_refund === true,
      has_image: reason.has_image === true,
      has_comment: reason.has_comment === true,
      image_text: reason.image_text || null,
      sub_reasons: Array.isArray(reason.sub_reasons) ? reason.sub_reasons : [],
      // Motivo que vai para um atendente (decisão de negócio)
      handoff: isHandoffReason(reason.reason),
    })),
    existing_reverses: existing.map((reverse) => ({
      id: reverse.id,
      status_name: reverse.status_name || null,
      created_at: reverse.created_at || null,
    })),
    address_step: raw.address_step
      ? {
          mode: raw.address_step.mode,
          missing_fields: raw.address_step.missing_fields || [],
          missing_customer_fields: raw.address_step.missing_customer_fields || [],
        }
      : null,
  };
}

function mapRetention(raw) {
  if (!raw.available) {
    return { available: false, mode: "none", offers: [], cancel_days: null };
  }
  return {
    available: true,
    mode: raw.mode,
    offers: (raw.offers || []).map((offer) => ({
      level: offer.level,
      bonus_value: offer.bonus_value,
      retained_value: offer.retained_value,
      credit_value: offer.credit_value,
    })),
    cancel_days: raw.cancel_days ?? null,
  };
}

// signOption(option) devolve o token assinado da opção (ver reverse/service.js)
function mapQuote(raw, signOption) {
  const options = Array.isArray(raw.shipping_options) ? raw.shipping_options : [];
  const choosable = options.filter((o) => o.can_be_chosen === true && o.shipping_company_id !== null && o.shipping_company_id !== undefined);

  return {
    options: choosable.map((option) => ({
      option_token: signOption(option),
      name: option.shipping_company_name || null,
      is_collect: option.is_collect === true,
      is_store_dropoff: option.shipping_company_id === 6,
      posting_address: option.posting_address || null,
      posting_address_name: option.posting_address_name || null,
      opening_hours: option.posting_address_opening_hours || null,
    })),
    // A loja oferece opções que só a Central de Trocas contrata (ex.: coleta paga)
    has_store_only_options: options.length > choosable.length,
  };
}

function mapShipping(shipping) {
  if (!shipping) return null;
  return {
    carrier: shipping.courier_company || null,
    is_collect: shipping.is_collect === true,
    posting_code: shipping.posting_code || null,
    posting_due_date: shipping.posting_due_date || null,
    posting_address: shipping.posting_address || null,
    tracking_url: shipping.tracking_url || null,
    label_in_email: shipping.label_in_email === true,
  };
}

function mapCreate(raw) {
  return {
    reverse_order_id: raw.reverse_order_id,
    outcome: raw.outcome,
    status: raw.status || null,
    refund_value: raw.refund_value ?? null,
    exchange_value: raw.exchange_value ?? null,
    credit_instead_of_refund: raw.retention?.credit_instead_of_refund === true,
    shipping: mapShipping(raw.shipping),
  };
}

function mapTrack(raw) {
  const reverses = Array.isArray(raw.reverses) ? raw.reverses : [];
  return {
    reverses: reverses.map((reverse) => ({
      id: reverse.id,
      ecommerce_number: reverse.ecommerce_number || null,
      status_name: reverse.status_name || null,
      created_at: reverse.created_at || null,
      replacement_order_number: reverse.replacement_order_number || null,
      items: (reverse.items || []).map((item) => ({
        sku: item.sku,
        description: item.description || null,
        quantity: item.quantity,
        is_exchange: item.is_exchange === true,
        replacement_description: item.replacement_description || null,
        image_url: item.image_url || null,
        received: item.received === true,
      })),
      // Campos nulos = "ainda não aconteceu"
      shipment: reverse.shipment
        ? {
            carrier: reverse.shipment.carrier || null,
            is_collect: reverse.shipment.is_collect ?? null,
            status: reverse.shipment.status || null,
            handover_instruction: reverse.shipment.handover_instruction || null,
            posting_code: reverse.shipment.posting_code || null,
            posting_qr_code_url: reverse.shipment.posting_qr_code_url || null,
            posting_due_date: reverse.shipment.posting_due_date || null,
            posting_address: reverse.shipment.posting_address || null,
            tracking_code: reverse.shipment.tracking_code || null,
            tracking_url: reverse.shipment.tracking_url || null,
            posted_at: reverse.shipment.posted_at || null,
            expected_delivery_date: reverse.shipment.expected_delivery_date || null,
            delivered_at: reverse.shipment.delivered_at || null,
          }
        : null,
      store_credit: reverse.store_credit
        ? {
            is_store_credit: reverse.store_credit.is_store_credit === true,
            code: reverse.store_credit.code || null,
            value: reverse.store_credit.value ?? null,
            valid_until: reverse.store_credit.valid_until || null,
            issued_at: reverse.store_credit.issued_at || null,
            bonus_code: reverse.store_credit.bonus_code || null,
            bonus_value: reverse.store_credit.bonus_value ?? null,
          }
        : null,
      refund: reverse.refund
        ? {
            method: reverse.refund.method || null,
            value: reverse.refund.value ?? null,
            paid_at: reverse.refund.paid_at || null,
          }
        : null,
    })),
  };
}

module.exports = {
  mapPrepare,
  mapRetention,
  mapQuote,
  mapCreate,
  mapTrack,
};
