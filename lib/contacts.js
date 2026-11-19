// ======================================================
// NOME DE EXIBIÇÃO DO CLIENTE ("Maria S.")
// ======================================================
// Único dado pessoal do esquema de acompanhamento. Guarda só o primeiro nome e
// a inicial do sobrenome, em conversation_contacts, por conversa:
//   1) Sunshine Conversations (fonte preferida; sobrescreve);
//   2) Troque, no passo de identificação, só se ainda não houver nome.
// Tudo é best-effort: falha aqui nunca afeta o envio nem o fluxo, e o log leva
// só o código do erro (nunca o nome, a resposta da API nem a conversa).
//
// Sunshine Conversations API v2 (mesma base e credenciais do envio do botão):
//   GET /sc/v2/apps/{appId}/conversations/{conversationId}/participants
//   GET /sc/v2/apps/{appId}/users/{userIdOrExternalId}  ->  user.profile.givenName / surname

const defaultAxios = require("axios");

const TIMEOUT_MS = 4000;
const MAX_PARTICIPANTS = 5;
const MAX_NAME = 40;

function errorLabel(error) {
  return error?.code || error?.response?.status || error?.name || "erro";
}

function cleanPart(value) {
  if (typeof value !== "string") return "";
  // Só letras (com acento), apóstrofo e hífen; primeira palavra
  const word = value.trim().split(/\s+/)[0] || "";
  return word.replace(/[^\p{L}'-]/gu, "").slice(0, MAX_NAME);
}

function capitalize(word) {
  return word ? word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1).toLocaleLowerCase("pt-BR") : "";
}

// "maria", "silva souza" -> "Maria S."; sem sobrenome -> "Maria"; sem nome -> null
function formatDisplayName(givenName, surname) {
  const first = capitalize(cleanPart(givenName));
  if (!first) return null;
  const last = cleanPart(surname);
  return last ? `${first} ${last.charAt(0).toLocaleUpperCase("pt-BR")}.` : first;
}

function sunshineConfig(env) {
  const { ZENDESK_SUBDOMAIN, ZENDESK_APP_ID, ZENDESK_KEY_ID, ZENDESK_SECRET } = env;
  if (!ZENDESK_SUBDOMAIN || !ZENDESK_APP_ID || !ZENDESK_KEY_ID || !ZENDESK_SECRET) return null;
  return {
    base: `https://${ZENDESK_SUBDOMAIN}.zendesk.com/sc/v2/apps/${encodeURIComponent(ZENDESK_APP_ID)}`,
    auth: { username: ZENDESK_KEY_ID, password: ZENDESK_SECRET },
  };
}

// Nome do cliente na Sunshine; null se não achar. Lança só erro de rede/HTTP.
async function fetchSunshineName(conversationId, { axios = defaultAxios, env = process.env } = {}) {
  const config = sunshineConfig(env);
  if (!config) return null;
  const options = { auth: config.auth, timeout: TIMEOUT_MS };

  const list = await axios.get(`${config.base}/conversations/${encodeURIComponent(conversationId)}/participants`, options);
  const participants = Array.isArray(list.data?.participants) ? list.data.participants.slice(0, MAX_PARTICIPANTS) : [];

  for (const participant of participants) {
    const userRef = participant?.userId || participant?.userExternalId;
    if (!userRef) continue;
    const response = await axios.get(`${config.base}/users/${encodeURIComponent(userRef)}`, options);
    const profile = response.data?.user?.profile;
    const name = formatDisplayName(profile?.givenName, profile?.surname);
    if (name) return name;
  }
  return null;
}

// source "sunshine": grava ou atualiza. source "troque": só se ainda não houver nome.
async function saveContactName({ conversationId, displayName, source }, { db = require("./db") } = {}) {
  if (!displayName || !db.getPool()) return false;
  if (source === "sunshine") {
    await db.query(
      `insert into conversation_contacts (conversation_id, display_name, name_source)
       values ($1, $2, 'sunshine')
       on conflict (conversation_id) do update
         set display_name = excluded.display_name, name_source = 'sunshine', updated_at = now()`,
      [conversationId, displayName],
    );
    return true;
  }
  await db.query(
    `insert into conversation_contacts (conversation_id, display_name, name_source)
     values ($1, $2, 'troque')
     on conflict (conversation_id) do update
       set display_name = excluded.display_name, name_source = 'troque', updated_at = now()
       where conversation_contacts.display_name is null`,
    [conversationId, displayName],
  );
  return true;
}

// Sunshine: busca e grava. Nunca rejeita; devolve true se gravou.
async function rememberSunshineName(conversationId, { axios, env, db = require("./db") } = {}) {
  try {
    if (!db.getPool()) return false;
    const displayName = await fetchSunshineName(conversationId, { axios, env });
    return await saveContactName({ conversationId, displayName, source: "sunshine" }, { db });
  } catch (error) {
    console.error(`Contato: nome via Sunshine indisponível (${errorLabel(error)})`);
    return false;
  }
}

// Troque: primeiro nome do pedido, só se a conversa ainda não tiver nome
async function rememberTroqueName(conversationId, firstName, { db = require("./db") } = {}) {
  try {
    const displayName = formatDisplayName(firstName, null);
    return await saveContactName({ conversationId, displayName, source: "troque" }, { db });
  } catch (error) {
    console.error(`Contato: nome via Troque não gravado (${errorLabel(error)})`);
    return false;
  }
}

module.exports = { formatDisplayName, fetchSunshineName, saveContactName, rememberSunshineName, rememberTroqueName };
