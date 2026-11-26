// ======================================================
// RÓTULOS EM PORTUGUÊS DA API DE ACOMPANHAMENTO
// ======================================================
// Contrato (seção 4): a API devolve o label junto da chave. O label é só para
// exibição; a lógica sempre usa a key. Chave desconhecida mostra a própria chave.

const STEP_LABELS = {
  start: "Início",
  identify: "Identificação",
  items: "Itens",
  reasons: "Motivo",
  address: "Endereço",
  retention: "Vale-compras",
  shipping: "Envio",
  refund: "Reembolso",
  summary: "Resumo",
  result: "Resultado",
  categories: "Categorias",
  products: "Produtos",
  details: "Detalhe do produto",
  // Telas que não são etapas do fluxo, mas aparecem nos eventos
  submit: "Envio da solicitação",
  error: "Tela final",
};

const EVENT_LABELS = {
  webview_opened: "Abriu a webview",
  step_viewed: "Viu a etapa",
  step_completed: "Concluiu a etapa",
  step_back: "Voltou",
  validation_error: "Erro de preenchimento",
  error_shown: "Viu um erro",
  api_call: "Chamada a serviço",
  photo_added: "Adicionou foto",
  photo_removed: "Removeu foto",
  ticket_created: "Ticket criado",
  reverse_created: "Solicitação criada",
  completed: "Concluiu",
  handoff_requested: "Pediu atendente",
  abandoned: "Saiu da webview",
  category_selected: "Escolheu categoria",
  search_performed: "Pesquisou",
  product_viewed: "Viu produto",
  variation_selected: "Escolheu tamanho/cor",
  add_to_cart_clicked: "Clicou em adicionar ao carrinho",
};

const ERROR_LABELS = {
  TEMPORARY_FAILURE: "Falha temporária no Troque",
  ORDER_NOT_FOUND: "Pedido não encontrado",
  ORDER_NOT_ELIGIBLE: "Pedido não elegível",
  NO_REASONS_FOR_TYPE: "Sem opção de troca ou devolução",
  TOO_MANY_ATTEMPTS: "Muitas tentativas de localizar o pedido",
  UNKNOWN_ERROR: "Erro com código não reconhecido",
  VALIDATION_FAILED: "Dados inválidos",
  PHOTO_REQUIRED: "Foto obrigatória",
  PHOTO_UPLOAD_FAILED: "Falha ao enviar foto",
  SESSION_EXPIRED: "Sessão expirada",
  UNAUTHORIZED: "Token do Troque inválido",
  RATE_LIMITED: "Limite de uso",
  CREATION_UNCONFIRMED: "Criação não confirmada",
  MESSAGE_NOT_POSTED: "Mensagem final não postada",
  HANDOFF_REQUIRED: "Motivo vai para atendente",
};

const OUTCOME_LABELS = {
  approved_with_shipping: "Aprovada, com envio",
  approved_without_shipping: "Aprovada, sem envio contratado",
  pending_analysis: "Em análise",
  approved_shipping_failed: "Aprovada, envio falhou",
};

const STATUS_LABELS = {
  completed: "Concluído",
  handoff: "Pediu atendente",
  error: "Terminou com erro",
  not_eligible: "Não elegível",
  abandoned: "Abandonou",
  in_progress: "Em andamento",
  not_clicked: "Sem clique",
  send_failed: "Falha no envio",
};

// Erros que são recusa por regra de negócio, não falha
const INELIGIBLE_ERROR_CODES = ["ORDER_NOT_ELIGIBLE", "NO_REASONS_FOR_TYPE"];

// Motivos de recusa conhecidos. O Troque manda ora um código, ora uma frase no mesmo campo.
const INELIGIBILITY_REASONS = [
  { key: "active_request", match: /alreadyHaveActive\w*Request/i, label: "Já tem solicitação em andamento" },
  { key: "marketplace", match: /marketplace/i, label: "Compra feita em marketplace" },
  { key: "order_situation", match: /orderUnauthorizedSituation/i, label: "Situação do pedido não permite troca" },
  { key: "deadline", match: /expired\w*Deadline/i, label: "Prazo de troca encerrado" },
  { key: "no_reasons", match: /NO_REASONS_FOR_TYPE/, label: "Sem opção de troca ou devolução" },
  { key: "not_eligible", match: /^ORDER_NOT_ELIGIBLE$/, label: "Pedido não elegível" },
];

// Motivo desconhecido: a própria chave vira o rótulo
function ineligibilityReason(raw) {
  const found = INELIGIBILITY_REASONS.find((r) => r.match.test(raw || ""));
  return found ? { key: found.key, label: found.label } : { key: raw || "desconhecido", label: raw || "Sem motivo informado" };
}

// Chave sem rótulo conhecido: devolve a própria chave (ou null se vazia)
function labelOf(table, key) {
  if (key === null || key === undefined || key === "") return null;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : String(key);
}

module.exports = {
  STEP_LABELS,
  EVENT_LABELS,
  ERROR_LABELS,
  OUTCOME_LABELS,
  STATUS_LABELS,
  INELIGIBLE_ERROR_CODES,
  ineligibilityReason,
  stepLabel: (key) => labelOf(STEP_LABELS, key),
  eventLabel: (key) => labelOf(EVENT_LABELS, key),
  errorLabel: (key) => labelOf(ERROR_LABELS, key),
  outcomeLabel: (key) => labelOf(OUTCOME_LABELS, key),
  statusLabel: (key) => labelOf(STATUS_LABELS, key),
};
