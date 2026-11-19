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
  abandoned: "Abandonou",
  in_progress: "Em andamento",
  not_clicked: "Sem clique",
  send_failed: "Falha no envio",
};

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
  stepLabel: (key) => labelOf(STEP_LABELS, key),
  eventLabel: (key) => labelOf(EVENT_LABELS, key),
  errorLabel: (key) => labelOf(ERROR_LABELS, key),
  outcomeLabel: (key) => labelOf(OUTCOME_LABELS, key),
  statusLabel: (key) => labelOf(STATUS_LABELS, key),
};
