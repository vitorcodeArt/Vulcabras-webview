// Dados fictícios no formato do Troque (sem dados pessoais reais)

function preparedOrder(overrides = {}) {
  return {
    eligible: true,
    ineligibility_code: null,
    ineligibility_message: null,
    order: {
      ecommerce_number: "1000000000001-01",
      status: "Faturado",
      created_at: "2026-09-01T13:20:11+00:00",
      updated_at: "2026-09-08T09:02:40+00:00",
      delivered_at: "2026-09-30T09:02:40+00:00",
      price: 100,
      total_price: 110,
      is_bank_transfer: false,
      second_request: false,
      second_reverse: false,
      number_of_defect_images: 1,
      customer: { name: "Cliente Teste", email_masked: "cli***@exemplo.com", phone_masked: "119*****999", document_masked: "000*****000" },
      address: { street: "Rua Exemplo", number: "100", description: null, zipcode: "01000000", neighborhood: "Centro", city: "São Paulo", state: "SP", country: "Brasil" },
      items: [
        { sku: "SKU-1", description: "Tênis Teste 40", quantity: 2, price: 50, image: "https://exemplo.com/a.jpg", seller: null },
        { sku: "SKU-2", description: "Meia Teste", quantity: 1, price: 10, image: null, seller: null },
      ],
      unavailable_items: [],
    },
    reasons: [
      { reason: "Não serviu", is_exchange: true, is_refund: true, has_image: false, has_comment: false, image_text: null, sub_reasons: ["Ficou grande", "Ficou pequeno"] },
      { reason: "Arrependimento", is_exchange: false, is_refund: true, has_image: false, has_comment: true, image_text: null, sub_reasons: [] },
      { reason: "Defeito", is_exchange: true, is_refund: true, has_image: true, has_comment: true, image_text: null, sub_reasons: ["Meu produto descolou"] },
      { reason: "Solicitação fora do prazo", is_exchange: true, is_refund: true, has_image: true, has_comment: true, image_text: null, sub_reasons: [] },
    ],
    existing_reverses: [],
    address_step: { mode: "confirm", missing_fields: [], missing_customer_fields: [] },
    ...overrides,
  };
}

function createdReverse(overrides = {}) {
  return {
    created: true,
    reverse_order_id: "3137c99b-c4cf-46bd-b0ed-d21bd3824263",
    ecommerce_number: "1000000000001-01",
    outcome: "approved_with_shipping",
    status_id: 2,
    status: "Aguardando Envio",
    auto_approved: true,
    price: 50,
    refund_value: 0,
    exchange_value: 50,
    retention: { applied: false, level: null, credit_instead_of_refund: false },
    items: [{ sku: "SKU-1", description: "Tênis Teste 40", quantity: 1, is_exchange: true }],
    shipping: {
      shipping_company_id: 2,
      courier_company: "Correios PAC",
      courier_tracking_code: null,
      posting_code: "AP123456789BR",
      is_collect: false,
      tracking_status: null,
      tracking_url: null,
      posting_address: null,
      label_in_email: true,
      posting_due_date: "2026-11-20",
    },
    replaced_order_ecommerce_number: null,
    next_step: "The store approved the request.",
    ...overrides,
  };
}

const IDENTITY = { order_number: "#1000000000001-01", customer_identifier: "000.000.000-00" };

module.exports = { preparedOrder, createdReverse, IDENTITY };
