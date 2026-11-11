// Teste HTTP de ponta a ponta das rotas, com o serviço do Troque falso
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { createReverseRouter } = require("../routes/reverse");
const { createSessionToken } = require("../lib/session");
const { ReverseError } = require("../lib/reverse/errors");

async function startServer(service) {
  const app = express();
  app.use(express.json());
  app.use(createReverseRouter({ service }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("endpoints exigem sessão e devolvem erro amigável", async (t) => {
  t.after(useFakeEnv());
  const seen = [];
  const service = {
    prepare: async (flow, body) => {
      seen.push({ flow, body });
      return { eligible: true };
    },
    retention: async () => {
      throw new ReverseError("INVALID_INPUT", { field: "items" });
    },
    quote: async () => ({}),
    track: async () => ({}),
    submit: async () => ({}),
    finish: async () => ({}),
  };
  const { server, base } = await startServer(service);
  t.after(() => server.close());

  const noSession = await fetch(`${base}/api/reverse/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noSession.status, 401);
  assert.equal(seen.length, 0);

  const token = createSessionToken({ conversationId: "conv1", store: "underarmour" });
  const headers = { "Content-Type": "application/json", "X-Flow-Token": token };

  const ok = await fetch(`${base}/api/reverse/prepare`, { method: "POST", headers, body: JSON.stringify({ order_number: "1" }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, eligible: true });
  assert.equal(seen[0].flow.conversationId, "conv1");
  assert.equal(seen[0].flow.brand.key, "underarmour");

  const bad = await fetch(`${base}/api/reverse/retention`, { method: "POST", headers, body: "{}" });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(body.field, "items");
  assert.equal(body.action, "fix_input");
});
