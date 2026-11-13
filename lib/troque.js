// ======================================================
// CLIENTE MCP DO TROQUECOMMERCE (JSON-RPC 2.0, método tools/call)
// ======================================================
// Fonte de verdade: docs/troque-mcp-openapi.json
//
// - Só as 5 ferramentas de atendimento ao consumidor são permitidas.
// - Aceita resposta em JSON ou em SSE (linhas "data:").
// - Erro de ferramenta (isError) vira TroqueError com o error_code.
// - Retry curto em falha temporária e em 429. A criação da reversa nunca é
//   repetida às cegas: tempo esgotado ou falha de rede viram CREATION_UNCONFIRMED.
// - O token e a "message" da API (em inglês, pode repetir dados enviados) nunca
//   vão para log nem para o navegador.

const axios = require("axios");
const { track } = require("./tracking");
const { createOutboundThrottle } = require("./rateLimit");

const DEFAULT_URL = "https://www.troquecommerce.com.br/api/mcp";

const ALLOWED_TOOLS = new Set(["prepare_reverse_order", "get_retention_offer", "quote_return_shipping", "create_reverse_order", "track_reverse_order"]);

// A cotação e a criação são lentas (cotam transportadoras ao vivo)
const TIMEOUTS_MS = {
  quote_return_shipping: 60000,
  create_reverse_order: 60000,
};
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5000;

// Campos do JSON de erro que o fluxo usa para decidir o próximo passo
const ERROR_DETAIL_KEYS = ["created", "missing_address_fields", "missing_customer_fields", "reverse_order_id"];

class TroqueError extends Error {
  constructor(code, { httpStatus = null, created, details = {}, tool = null } = {}) {
    super(code);
    this.name = "TroqueError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.created = created;
    this.details = details;
    this.tool = tool;
  }
}

// Lê um corpo SSE e devolve a última mensagem JSON-RPC com result ou error
function parseSse(text) {
  const messages = [];
  let data = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.trim() === "" && data.length) {
      messages.push(data.join("\n"));
      data = [];
    }
  }
  if (data.length) messages.push(data.join("\n"));

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    try {
      const message = JSON.parse(messages[i]);
      if (message && (message.result || message.error)) return message;
    } catch {
      // linha de SSE que não é JSON: ignora
    }
  }
  return null;
}

function parseBody(raw, contentType) {
  if (raw && typeof raw === "object") return raw;
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();

  if (/text\/event-stream/i.test(contentType || "") || (!trimmed.startsWith("{") && /^(event|data|id):/m.test(text))) {
    return parseSse(text);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// O resultado vem em structuredContent; o mesmo JSON vem em texto em content[0].text
function extractPayload(result) {
  if (result && result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = Array.isArray(result?.content) ? result.content.find((c) => c && c.type === "text")?.text : null;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

function pickDetails(payload) {
  const details = {};
  if (!payload || typeof payload !== "object") return details;
  for (const key of ERROR_DETAIL_KEYS) {
    if (payload[key] !== undefined) details[key] = payload[key];
  }
  return details;
}

// Converte a resposta HTTP em payload ou TroqueError
function interpretResponse(tool, response) {
  const status = response.status;

  if (status === 401) throw new TroqueError("UNAUTHORIZED", { httpStatus: status, tool });
  if (status === 429) {
    const error = new TroqueError("RATE_LIMITED", { httpStatus: status, tool });
    const retryAfter = Number(response.headers?.["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1000;
    throw error;
  }
  if (status >= 500) throw new TroqueError("TEMPORARY_FAILURE", { httpStatus: status, tool });
  if (status < 200 || status >= 300) throw new TroqueError("PROTOCOL_ERROR", { httpStatus: status, tool });

  const body = parseBody(response.data, response.headers?.["content-type"]);
  if (!body) throw new TroqueError("PROTOCOL_ERROR", { httpStatus: status, tool });

  // Erro do protocolo (ex.: argumento com formato inválido, recusado antes da ferramenta)
  if (body.error) {
    const code = body.error.code === -32602 ? "INVALID_PARAMS" : "PROTOCOL_ERROR";
    throw new TroqueError(code, { httpStatus: status, tool });
  }

  const result = body.result;
  const payload = extractPayload(result);

  if (result && result.isError === true) {
    const code = payload && typeof payload.error_code === "string" ? payload.error_code : "TOOL_ERROR";
    throw new TroqueError(code, {
      httpStatus: status,
      tool,
      created: payload && payload.created !== undefined ? payload.created : undefined,
      details: pickDetails(payload),
    });
  }

  if (!payload) throw new TroqueError("PROTOCOL_ERROR", { httpStatus: status, tool });
  return payload;
}

function toNetworkError(tool, error) {
  if (error instanceof TroqueError) return error;
  const isTimeout = error && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || /timeout/i.test(error.message || ""));
  return new TroqueError(isTimeout ? "TIMEOUT" : "NETWORK_ERROR", { tool });
}

function shouldRetry(tool, error) {
  if (error.code === "RATE_LIMITED") return true;
  if (tool === "create_reverse_order") return false;
  return error.code === "TEMPORARY_FAILURE" || error.code === "NETWORK_ERROR";
}

function retryDelay(error, attempt) {
  if (error.code === "RATE_LIMITED") {
    return Math.min(error.retryAfterMs ?? 1500, MAX_RETRY_AFTER_MS);
  }
  return 500 * attempt;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cria o cliente. "http" e "sleep" podem ser trocados nos testes.
function createTroqueClient({ http = axios, sleep = defaultSleep, now = () => Date.now(), throttle = null } = {}) {
  let requestId = 0;
  // Fica abaixo do limite do Troque (70 a cada 10 s por IP)
  const waitTurn = throttle || createOutboundThrottle({ now, sleep });

  async function callOnce(name, args, token, timeout) {
    requestId += 1;
    const url = process.env.TROQUE_MCP_URL || DEFAULT_URL;
    await waitTurn();
    let response;
    try {
      response = await http.post(
        url,
        { jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          timeout,
          responseType: "text",
          transformResponse: [(data) => data],
          validateStatus: () => true,
          maxContentLength: 5 * 1024 * 1024,
        },
      );
    } catch (error) {
      throw toNetworkError(name, error);
    }
    return interpretResponse(name, response);
  }

  // context: { sessionId, conversationId, brand, step } (só IDs técnicos, para o rastreamento)
  async function callTool(name, args, { token, context = {} } = {}) {
    if (!ALLOWED_TOOLS.has(name)) throw new TroqueError("TOOL_NOT_ALLOWED", { tool: name });
    if (!token) throw new TroqueError("UNAUTHORIZED", { tool: name });

    const timeout = TIMEOUTS_MS[name] || DEFAULT_TIMEOUT_MS;

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = now();
      try {
        const payload = await callOnce(name, args, token, timeout);
        trackCall(context, name, attempt, now() - startedAt, null);
        return payload;
      } catch (rawError) {
        let error = toNetworkError(name, rawError);
        trackCall(context, name, attempt, now() - startedAt, error);

        // Criação sem resposta conclusiva: pode ter sido criada. Quem chama confere existing_reverses.
        if (name === "create_reverse_order" && ["TIMEOUT", "NETWORK_ERROR", "TEMPORARY_FAILURE", "PROTOCOL_ERROR"].includes(error.code) && error.created !== false) {
          error = new TroqueError("CREATION_UNCONFIRMED", { httpStatus: error.httpStatus, tool: name, created: null });
        }

        if (attempt > MAX_RETRIES || !shouldRetry(name, error)) throw error;
        await sleep(retryDelay(error, attempt));
      }
    }
  }

  return { callTool };
}

function trackCall(context, tool, attempt, durationMs, error) {
  track({
    event: "api_call",
    session_id: context.sessionId,
    conversation_id: context.conversationId,
    brand: context.brand,
    step: context.step,
    duration_ms: durationMs,
    error_code: error ? error.code : null,
    meta: { service: "troque", tool, ok: !error, attempt, http_status: error?.httpStatus ?? null },
  });
}

module.exports = {
  ALLOWED_TOOLS,
  TroqueError,
  createTroqueClient,
  parseSse,
  interpretResponse,
};
