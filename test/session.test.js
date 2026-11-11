const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { createSessionToken, verifySessionToken, parseFlowSessionId, requireSession, isSessionConfigured } = require("../lib/session");

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

test("gera e valida um token", (t) => {
  t.after(useFakeEnv());
  const token = createSessionToken({ conversationId: "abc123def456", store: "UnderArmour" }, NOW);
  const result = verifySessionToken(token, NOW + 1000);
  assert.equal(result.ok, true);
  assert.equal(result.session.conversationId, "abc123def456");
  assert.equal(result.session.store, "underarmour");
  assert.equal(result.session.expiresAt, Math.floor(NOW / 1000) + 3600);
});

test("recusa token expirado", (t) => {
  t.after(useFakeEnv({ FLOW_SESSION_TTL_MINUTES: "1" }));
  const token = createSessionToken({ conversationId: "abc", store: "mizuno" }, NOW);
  assert.deepEqual(verifySessionToken(token, NOW + 61 * 1000), { ok: false, reason: "expired" });
});

test("recusa token adulterado ou assinado com outro segredo", (t) => {
  t.after(useFakeEnv());
  const token = createSessionToken({ conversationId: "abc", store: "mizuno" }, NOW);
  const [body, sig] = token.split(".");

  // Troca a marca no payload mantendo a assinatura
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.s = "olympikus";
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
  assert.equal(verifySessionToken(forged, NOW).reason, "bad_signature");

  process.env.FLOW_SESSION_SECRET = "outro-segredo-tambem-com-mais-de-32-caracteres";
  assert.equal(verifySessionToken(token, NOW).reason, "bad_signature");
});

test("recusa entradas malformadas", (t) => {
  t.after(useFakeEnv());
  assert.equal(verifySessionToken(undefined).reason, "missing");
  assert.equal(verifySessionToken("").reason, "missing");
  assert.equal(verifySessionToken("a".repeat(2000)).reason, "missing");
  assert.equal(verifySessionToken("semponto").reason, "malformed");
  assert.equal(verifySessionToken("a.b.c").reason, "malformed");
});

test("valida conversationId e marca na criação", (t) => {
  t.after(useFakeEnv());
  assert.throws(() => createSessionToken({ conversationId: "../x", store: "mizuno" }));
  assert.throws(() => createSessionToken({ conversationId: "abc", store: "adidas" }));
});

test("exige segredo de pelo menos 32 caracteres", (t) => {
  t.after(useFakeEnv({ FLOW_SESSION_SECRET: "curto" }));
  assert.equal(isSessionConfigured(), false);
  assert.throws(() => createSessionToken({ conversationId: "abc", store: "mizuno" }));
});

test("aceita só UUID como session_id", () => {
  assert.equal(parseFlowSessionId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(parseFlowSessionId("qualquer"), null);
  assert.equal(parseFlowSessionId(undefined), null);
});

// Simula req/res do Express
function run(middleware, { headers = {}, body = {} } = {}) {
  const req = { body, get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

test("middleware aceita token no header e preenche req.flow", (t) => {
  t.after(useFakeEnv());
  const token = createSessionToken({ conversationId: "conv1", store: "underarmour" });
  const { req, nextCalled } = run(requireSession, {
    headers: { "x-flow-token": token, "x-flow-session": "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
  });
  assert.equal(nextCalled, true);
  assert.equal(req.flow.conversationId, "conv1");
  assert.equal(req.flow.brand.key, "underarmour");
  assert.equal(req.flow.sessionId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
});

test("middleware aceita token no corpo (sendBeacon)", (t) => {
  t.after(useFakeEnv());
  const token = createSessionToken({ conversationId: "conv1", store: "mizuno" });
  const { nextCalled } = run(requireSession, { body: { _token: token } });
  assert.equal(nextCalled, true);
});

test("middleware responde 401 sem token e 503 sem segredo", (t) => {
  t.after(useFakeEnv());
  const missing = run(requireSession);
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.res.statusCode, 401);
  assert.equal(missing.res.payload.code, "SESSION_INVALID");

  delete process.env.FLOW_SESSION_SECRET;
  const noSecret = run(requireSession, { headers: { "x-flow-token": "a.b" } });
  assert.equal(noSecret.res.statusCode, 503);
});
