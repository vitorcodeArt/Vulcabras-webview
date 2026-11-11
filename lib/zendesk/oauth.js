// ======================================================
// TOKEN DE ACESSO À API DE TICKETS DO ZENDESK (OAuth 2.0)
// ======================================================
// Grant "client_credentials" (cliente OAuth confidencial): o servidor pede um
// token com o ID e o segredo do cliente sempre que precisa. Não há refresh
// token para guardar, então não precisamos de banco de dados. Os tickets saem
// em nome do usuário associado ao cliente OAuth (recomendado: agente de
// serviço dedicado).
//
// O token é segredo: só em memória, nunca em log nem em resposta.

const axios = require("axios");

// Renova um pouco antes de expirar
const EXPIRY_MARGIN_MS = 60 * 1000;

function readConfig() {
  const { ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_CLIENT_ID, ZENDESK_OAUTH_CLIENT_SECRET, ZENDESK_OAUTH_SCOPES } = process.env;
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_OAUTH_CLIENT_ID || !ZENDESK_OAUTH_CLIENT_SECRET) return null;
  return {
    subdomain: ZENDESK_SUBDOMAIN,
    clientId: ZENDESK_OAUTH_CLIENT_ID,
    clientSecret: ZENDESK_OAUTH_CLIENT_SECRET,
    scope: ZENDESK_OAUTH_SCOPES || "read write",
  };
}

function isOAuthConfigured() {
  return readConfig() !== null;
}

function oauthError(code, httpStatus = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function createTokenProvider({ http = axios, now = () => Date.now() } = {}) {
  let cached = null; // { token, expiresAt }
  let pending = null; // renovação em andamento (uma por vez)

  async function requestToken() {
    const config = readConfig();
    if (!config) throw oauthError("ZENDESK_OAUTH_NOT_CONFIGURED");

    let response;
    try {
      response = await http.post(
        `https://${config.subdomain}.zendesk.com/oauth/tokens`,
        {
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: config.scope,
        },
        { headers: { "Content-Type": "application/json" }, timeout: 15000, validateStatus: () => true },
      );
    } catch {
      throw oauthError("ZENDESK_OAUTH_NETWORK_ERROR");
    }

    if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
      // Sem o corpo da resposta no erro: pode ecoar dados do cliente OAuth
      throw oauthError("ZENDESK_OAUTH_FAILED", response.status);
    }

    const expiresIn = Number(response.data.expires_in);
    return {
      token: response.data.access_token,
      // Sem expires_in o token não expira: fica até um 401
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 - EXPIRY_MARGIN_MS : Infinity,
    };
  }

  // forceRefresh: depois de um 401, descarta o token em cache
  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.token;
    if (!pending) {
      pending = requestToken()
        .then((result) => {
          cached = result;
          return result.token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return { getAccessToken };
}

module.exports = { createTokenProvider, isOAuthConfigured };
