const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { buildReverseWebview } = require("../routes/reverse");
const { verifySessionToken } = require("../lib/session");

const BASE = "https://exemplo.onrender.com";

test("monta a URI da webview com marca e sessão assinada", (t) => {
  t.after(useFakeEnv());
  const result = buildReverseWebview({ baseUrl: BASE, conversationId: "conv1", store: "underarmour" });
  assert.equal(result.ok, true);
  assert.equal(result.label, "Under Armour");
  assert.equal(result.buttonText, "Trocar ou devolver");

  const url = new URL(result.uri);
  assert.equal(url.origin + url.pathname, `${BASE}/reverse`);
  assert.equal(url.searchParams.get("store"), "underarmour");
  // conversationId não vai em claro na URL, só dentro do token
  assert.equal(url.searchParams.get("conversationId"), null);

  const session = verifySessionToken(url.searchParams.get("t"));
  assert.equal(session.ok, true);
  assert.equal(session.session.conversationId, "conv1");
});

test("respeita textos personalizados", (t) => {
  t.after(useFakeEnv());
  const result = buildReverseWebview({ baseUrl: BASE, conversationId: "conv1", store: "underarmour", customText: "Oi", buttonText: "Abrir" });
  assert.equal(result.text, "Oi");
  assert.equal(result.buttonText, "Abrir");
});

test("erros claros para marca inválida, marca sem token e conversa inválida", (t) => {
  t.after(useFakeEnv());
  assert.equal(buildReverseWebview({ baseUrl: BASE, conversationId: "conv1", store: "adidas" }).status, 400);
  assert.equal(buildReverseWebview({ baseUrl: BASE, conversationId: "a/b", store: "underarmour" }).status, 400);

  const semToken = buildReverseWebview({ baseUrl: BASE, conversationId: "conv1", store: "mizuno" });
  assert.equal(semToken.ok, false);
  assert.equal(semToken.status, 500);
});

test("sem segredo de sessão, nada é gerado", (t) => {
  t.after(useFakeEnv({ FLOW_SESSION_SECRET: undefined }));
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const result = buildReverseWebview({ baseUrl: BASE, conversationId: "conv1", store: "underarmour" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});
