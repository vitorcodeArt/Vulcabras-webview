// ======================================================
// ERROS DO FLUXO: código curto + mensagem amigável para o cliente
// ======================================================
// Nunca repassar ao navegador a "message" ou o "next_step" do Troque. O
// navegador recebe só: code (curto), error (texto em português) e action
// (o que a tela deve oferecer a seguir).

class ReverseError extends Error {
  constructor(code, { field = null, details = {} } = {}) {
    super(code);
    this.name = "ReverseError";
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

const RETRY_LATER = "Não conseguimos falar com o sistema de trocas agora. Tente novamente em instantes.";
const UNAVAILABLE = "A troca e devolução está indisponível no momento. Volte ao chat para falar com um atendente.";

// action: retry | fix_input | track | refresh_retention | requote | retry_without_address | handoff | close
const ERRORS = {
  INVALID_INPUT: { status: 400, action: "fix_input", message: "Confira os dados informados e tente novamente." },
  ORDER_NOT_FOUND: { status: 404, action: "fix_input", message: "Não encontramos um pedido com esses dados. Confira o número do pedido e o CPF, CNPJ ou e-mail usado na compra." },
  TOO_MANY_ATTEMPTS: { status: 429, action: "handoff", message: "Não foi possível localizar o pedido após algumas tentativas. Volte ao chat para falar com um atendente." },
  ORDER_NOT_ELIGIBLE: { status: 422, action: "close", message: "Este pedido não pode ser trocado ou devolvido no momento." },
  VALIDATION_FAILED: { status: 422, action: "fix_input", message: "Alguns dados não foram aceitos. Revise as informações e tente novamente." },
  ADDRESS_NOT_EDITABLE: { status: 422, action: "retry_without_address", message: "Não é possível alterar o endereço deste pedido. Vamos usar o endereço da compra." },
  ALREADY_HAS_ACTIVE_REVERSE: { status: 409, action: "track", message: "Este pedido já tem uma solicitação em andamento. Você pode acompanhar o status dela." },
  DUPLICATE_SUSPECTED: { status: 409, action: "track", message: "Recebemos uma solicitação deste pedido há poucos minutos. Confira o status antes de enviar outra." },
  RETENTION_NOT_AVAILABLE: { status: 409, action: "refresh_retention", message: "A condição do vale-compras mudou. Confira a nova oferta." },
  RETENTION_LEVEL_NOT_AVAILABLE: { status: 409, action: "refresh_retention", message: "A condição do vale-compras mudou. Confira a nova oferta." },
  RETENTION_OFFER_CHANGED: { status: 409, action: "refresh_retention", message: "Com a forma de envio escolhida, a condição do vale-compras muda. Confira a nova oferta." },
  QUOTE_EXPIRED: { status: 409, action: "requote", message: "As opções de envio precisam ser atualizadas. Escolha a forma de envio novamente." },
  CREATION_UNCONFIRMED: { status: 202, action: "track", message: "Não conseguimos confirmar se sua solicitação foi registrada. Não envie de novo: em alguns minutos, confira em Acompanhar solicitação." },
  HANDOFF_REQUIRED: { status: 422, action: "handoff", message: "Para este motivo, um atendente precisa analisar sua solicitação." },
  PHOTO_REQUIRED: { status: 422, action: "handoff", message: "Este motivo precisa de foto, e o envio de fotos ainda não está disponível por aqui. Volte ao chat para falar com um atendente." },
  SUBMIT_IN_PROGRESS: { status: 409, action: "retry", message: "Sua solicitação já está sendo enviada. Aguarde alguns segundos." },
  BRAND_NOT_CONFIGURED: { status: 503, action: "handoff", message: UNAVAILABLE },
  TEMPORARY_FAILURE: { status: 503, action: "retry", message: RETRY_LATER },
  NETWORK_ERROR: { status: 503, action: "retry", message: RETRY_LATER },
  TIMEOUT: { status: 504, action: "retry", message: RETRY_LATER },
  RATE_LIMITED: { status: 503, action: "retry", message: RETRY_LATER },
};

const FALLBACK = { status: 502, action: "handoff", message: UNAVAILABLE };

// Detalhes que podem ir ao navegador (listas de nomes de campos, sem valores)
const SAFE_DETAIL_KEYS = ["missing_address_fields", "missing_customer_fields", "ineligibility_message", "ineligibility_code"];

function describeError(error) {
  const code = error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  const known = ERRORS[code];
  const base = known || FALLBACK;

  const body = { success: false, code: known ? code : "SERVICE_ERROR", error: base.message, action: base.action };
  if (error && error.field) body.field = error.field;

  const details = error && error.details ? error.details : {};
  for (const key of SAFE_DETAIL_KEYS) {
    if (details[key] !== undefined) body[key] = details[key];
  }
  if (code === "ORDER_NOT_ELIGIBLE" && typeof details.ineligibility_message === "string") {
    body.error = details.ineligibility_message;
  }

  return { status: base.status, body, internalCode: code };
}

module.exports = {
  ReverseError,
  describeError,
};
