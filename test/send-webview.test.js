// Envio do botão da webview: send_id, token assinado e gravação em webview_sends
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { createSendWebviewRouter } = require("../routes/sendWebview");
const { createSessionToken, verifySessionToken, requireSession, requireFlow, signData } = require("../lib/session");
const { recordWebviewSend, sendErrorCode } = require("../lib/webview-sends");

const SEND_ID = "11111111-2222-4333-8444-555555555555";
const CONVERSATION = "conv-envio-1";
const ZENDESK_ENV = { ZENDESK_SUBDOMAIN: "exemplo", ZENDESK_APP_ID: "app-falso", ZENDESK_KEY_ID: "key-falsa", ZENDESK_SECRET: "segredo-falso", WEBVIEW_URL: "https://app.exemplo.invalid/webview", WEBVIEW_API_SECRET: undefined };
const VTEX = { mizuno: { label: "Mizuno" }, underarmour: { label: "Under Armour" } };

function fakeDb({ pool = true, fail = false, hang = false } = {}) {
  const rows = [];
  return {
    rows,
    getPool: () => (pool ? {} : null),
    query: (text, params) => {
      if (hang) return new Promise(() => {});
      if (fail) return Promise.reject(Object.assign(new Error("erro com dado (cpf)=(111)"), { code: "XX000" }));
      rows.push({ text, params });
      return Promise.resolve({ rows: [] });
    },
  };
}

function fakeAxios(result, { participants = [], profile = null } = {}) {
  const calls = [];
  return {
    calls,
    // Consulta do nome do cliente (Sunshine): sem participante, nada é gravado
    get: async (url) => {
      if (url.endsWith("/participants")) return { data: { participants } };
      return { data: { user: { profile } } };
    },
    post: async (url, payload) => {
      calls.push({ url, payload });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function start(t, { db, axios, restore = useFakeEnv(ZENDESK_ENV) } = {}) {
  t.after(restore);
  const app = express();
  app.use(express.json());
  app.use(createSendWebviewRouter({ getVtexStores: () => VTEX, axios, db, randomUUID: () => SEND_ID }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: async (body) => {
      const res = await fetch(`${base}/api/send-webview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
  };
}

const OK = { data: { messages: [{ id: "msg-1" }] } };
const sentUrl = (axios) => new URL(axios.calls[0].payload.content.actions[0].uri);

test("token novo carrega send_id e flow; token antigo continua valendo", (t) => {
  t.after(useFakeEnv());
  const novo = verifySessionToken(createSessionToken({ conversationId: CONVERSATION, store: "mizuno", sendId: SEND_ID, flow: "catalog" }));
  assert.equal(novo.ok, true);
  assert.equal(novo.session.sendId, SEND_ID);
  assert.equal(novo.session.flow, "catalog");

  const antigo = verifySessionToken(createSessionToken({ conversationId: CONVERSATION, store: "mizuno" }));
  assert.equal(antigo.ok, true);
  assert.equal(antigo.session.sendId, undefined);
  assert.equal(antigo.session.flow, undefined);

  assert.throws(() => createSessionToken({ conversationId: CONVERSATION, store: "mizuno", sendId: "nao-e-uuid" }), /sendId/);
  assert.throws(() => createSessionToken({ conversationId: CONVERSATION, store: "mizuno", flow: "outro" }), /flow/);
});

test("requireSession expõe sendId e flow; requireFlow barra token de outro fluxo e aceita o antigo como reverse", (t) => {
  t.after(useFakeEnv());
  const run = (token, middleware) => {
    let status = null;
    let nextCalled = false;
    const req = { get: (name) => (name === "X-Flow-Token" ? token : undefined), body: {} };
    const res = { status: (code) => ((status = code), res), json: () => res };
    requireSession(req, res, () => (nextCalled = true));
    if (nextCalled && middleware) {
      nextCalled = false;
      middleware(req, res, () => (nextCalled = true));
    }
    return { req, status, nextCalled };
  };

  const catalog = run(createSessionToken({ conversationId: CONVERSATION, store: "mizuno", sendId: SEND_ID, flow: "catalog" }), requireFlow("reverse"));
  assert.equal(catalog.req.flow.sendId, SEND_ID);
  assert.equal(catalog.req.flow.flow, "catalog");
  assert.equal(catalog.status, 401);
  assert.equal(catalog.nextCalled, false);

  const antigo = run(createSessionToken({ conversationId: CONVERSATION, store: "mizuno" }), requireFlow("reverse"));
  assert.equal(antigo.nextCalled, true);

  const reverse = run(createSessionToken({ conversationId: CONVERSATION, store: "mizuno", sendId: SEND_ID, flow: "reverse" }), requireFlow("reverse"));
  assert.equal(reverse.nextCalled, true);

  // Dado assinado de outro tipo nunca vale como sessão
  const forged = run(signData("botphoto", { c: CONVERSATION }, 60), null);
  assert.equal(forged.status, 401);
});

test("catálogo: URL mantém conversationId e store e ganha o token; grava webview_sends", async (t) => {
  const axios = fakeAxios(OK);
  const db = fakeDb();
  const api = await start(t, { axios, db });

  const res = await api.post({ conversationId: CONVERSATION, type: "catalog", store: "mizuno" });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.sendId, SEND_ID);
  assert.deepEqual(res.body.data, OK.data);

  const url = sentUrl(axios);
  assert.equal(url.pathname, "/catalog");
  assert.equal(url.searchParams.get("conversationId"), CONVERSATION);
  assert.equal(url.searchParams.get("store"), "mizuno");
  const session = verifySessionToken(url.searchParams.get("t")).session;
  assert.equal(session.sendId, SEND_ID);
  assert.equal(session.flow, "catalog");
  assert.equal(session.conversationId, CONVERSATION);

  assert.equal(db.rows.length, 1);
  assert.deepEqual(db.rows[0].params, [SEND_ID, CONVERSATION, "mizuno", "catalog", "msg-1", true, null]);
});

test("rastreamento: link antigo continua, com token a mais", async (t) => {
  const axios = fakeAxios(OK);
  const db = fakeDb();
  const api = await start(t, { axios, db });

  const res = await api.post({ conversationId: CONVERSATION, type: "tracking", store: "underarmour" });
  assert.equal(res.body.sendId, SEND_ID);
  const url = sentUrl(axios);
  assert.equal(url.pathname, "/webview");
  assert.equal(url.searchParams.get("conversationId"), CONVERSATION);
  assert.equal(verifySessionToken(url.searchParams.get("t")).session.flow, "tracking");
  assert.equal(db.rows[0].params[3], "tracking");
  assert.equal(db.rows[0].params[2], "underarmour");
});

test("rastreamento com marca fora da lista sai sem token, como antes", async (t) => {
  const axios = fakeAxios(OK);
  const api = await start(t, { axios, db: fakeDb() });
  const res = await api.post({ conversationId: CONVERSATION, type: "tracking", store: "marca-x" });
  assert.equal(res.body.success, true);
  assert.equal(sentUrl(axios).searchParams.get("t"), null);
});

test("troca e devolução: token com send_id e flow reverse; resposta só com o messageId", async (t) => {
  const axios = fakeAxios(OK);
  const db = fakeDb();
  const api = await start(t, { axios, db });

  const res = await api.post({ conversationId: CONVERSATION, type: "reverse", store: "underarmour" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { messageId: "msg-1" });
  assert.equal(res.body.sendId, SEND_ID);
  const session = verifySessionToken(sentUrl(axios).searchParams.get("t")).session;
  assert.equal(session.sendId, SEND_ID);
  assert.equal(session.flow, "reverse");
  assert.equal(db.rows[0].params[3], "reverse");
  assert.doesNotMatch(JSON.stringify(res.body), /eyJ/); // o token não sai na resposta
});

test("falha na Sunshine: grava ok=false com código curto (sem o corpo) e mantém o status", async (t) => {
  const error = Object.assign(new Error("Request failed"), { response: { status: 404, data: { errors: [{ detail: "corpo com dado pessoal" }] } } });
  const db = fakeDb();
  const api = await start(t, { axios: fakeAxios(error), db });

  const res = await api.post({ conversationId: CONVERSATION, type: "catalog", store: "mizuno" });
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.sendId, SEND_ID);
  assert.equal(db.rows.length, 1);
  assert.deepEqual(db.rows[0].params, [SEND_ID, CONVERSATION, "mizuno", "catalog", null, false, "HTTP_404"]);
  assert.doesNotMatch(JSON.stringify(db.rows[0].params), /dado pessoal/);
});

test("validação e configuração que falham antes de postar não gravam nada", async (t) => {
  const db = fakeDb();
  const axios = fakeAxios(OK);
  const api = await start(t, { axios, db });
  assert.equal((await api.post({ type: "catalog" })).status, 400);
  assert.equal((await api.post({ conversationId: CONVERSATION, type: "catalog", store: "inexistente" })).status, 400);
  assert.equal((await api.post({ conversationId: "id inválido!", type: "reverse", store: "underarmour" })).status, 400);
  assert.equal(axios.calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test("banco com erro, travado ou desligado não derruba nem atrasa o envio", async (t) => {
  for (const [nome, db] of [["erro", fakeDb({ fail: true })], ["desligado", fakeDb({ pool: false })]]) {
    const api = await start(t, { axios: fakeAxios(OK), db });
    const res = await api.post({ conversationId: CONVERSATION, type: "catalog", store: "mizuno" });
    assert.equal(res.status, 200, nome);
    assert.equal(res.body.success, true, nome);
  }

  // Travado: a gravação desiste em ~1 s, e o envio responde com sucesso
  const hanging = fakeDb({ hang: true });
  const started = Date.now();
  const saved = await recordWebviewSend({ sendId: SEND_ID, conversationId: CONVERSATION, brand: "mizuno", flow: "catalog", ok: true }, { db: hanging, timeoutMs: 50 });
  assert.equal(saved, false);
  assert.ok(Date.now() - started < 1000);
});

test("código de erro do envio é curto e sem corpo de resposta", () => {
  assert.equal(sendErrorCode({ response: { status: 403, data: "segredo" } }), "HTTP_403");
  assert.equal(sendErrorCode({ code: "ECONNABORTED" }), "ECONNABORTED");
  assert.equal(sendErrorCode(null), "UNKNOWN");
  assert.equal(sendErrorCode({ code: "a b!c".repeat(30) }).length <= 40, true);
});

test("guarda o nome do cliente (Maria S.) em segundo plano depois do envio", async (t) => {
  const axios = fakeAxios(OK, { participants: [{ userId: "u1" }], profile: { givenName: "maria", surname: "silva" } });
  const db = fakeDb();
  const api = await start(t, { axios, db });

  const res = await api.post({ conversationId: CONVERSATION, type: "catalog", store: "mizuno" });
  assert.equal(res.status, 200);

  // A gravação do nome roda depois da resposta
  for (let i = 0; i < 20 && db.rows.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const contact = db.rows.find((row) => row.text.includes("conversation_contacts"));
  assert.ok(contact);
  assert.deepEqual(contact.params, [CONVERSATION, "Maria S."]);
});

test("falha ao buscar o nome não afeta o envio", async (t) => {
  const axios = fakeAxios(OK);
  axios.get = async () => {
    throw Object.assign(new Error("indisponível"), { code: "ECONNRESET" });
  };
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  const api = await start(t, { axios, db: fakeDb() });

  const res = await api.post({ conversationId: CONVERSATION, type: "catalog", store: "mizuno" });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});
