const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { createRateLimiter, createOutboundThrottle } = require("../lib/rateLimit");
const { createReverseRouter, reverseErrorHandler } = require("../routes/reverse");
const { createSessionToken } = require("../lib/session");

test("limitador: janela fixa por chave, com Retry-After", () => {
  let time = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => time });
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);
  const third = limiter.hit("a");
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterS, 1);
  assert.equal(limiter.hit("b").allowed, true); // outra chave, outra conta
  time = 1000;
  assert.equal(limiter.hit("a").allowed, true); // nova janela
});

test("freio do Troque: espera quando passa do limite e nunca mais que o teto", async () => {
  let time = 0;
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    time += ms;
  };
  const throttle = createOutboundThrottle({ max: 2, windowMs: 10000, maxWaitMs: 5000, now: () => time, sleep });
  await throttle();
  await throttle();
  await throttle(); // terceira: espera até o teto de 5 s
  assert.deepEqual(waits, [5000]);
  time = 20000;
  await throttle(); // janela limpa: sem espera
  assert.deepEqual(waits, [5000]);
});

async function startServer(service) {
  const app = express();
  app.use(express.json());
  app.use(createReverseRouter({ service }));
  app.use(reverseErrorHandler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const okService = { prepare: async () => ({}), retention: async () => ({}), quote: async () => ({}), track: async () => ({}), submit: async () => ({}), finish: async () => ({}), handoff: async () => ({ message_posted: true }), features: () => ({}) };

test("HTTP: envio limitado por conversa (10 a cada 10 min) com 429 amigável", async (t) => {
  t.after(useFakeEnv());
  const { server, base } = await startServer(okService);
  t.after(() => server.close());

  const headers = { "Content-Type": "application/json", "X-Flow-Token": createSessionToken({ conversationId: "conv-limite", store: "underarmour" }) };
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const response = await fetch(`${base}/api/reverse/submit`, { method: "POST", headers, body: "{}" });
    statuses.push(response.status);
    if (response.status === 429) {
      const body = await response.json();
      assert.equal(body.code, "RATE_LIMITED");
      assert.equal(body.action, "retry");
      assert.ok(Number(response.headers.get("retry-after")) > 0);
    }
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);

  // Outra conversa não é afetada
  const other = { ...headers, "X-Flow-Token": createSessionToken({ conversationId: "conv-outra", store: "underarmour" }) };
  assert.equal((await fetch(`${base}/api/reverse/submit`, { method: "POST", headers: other, body: "{}" })).status, 200);
});

test("HTTP: JSON malformado vira 400 amigável, sem expor o corpo", async (t) => {
  t.after(useFakeEnv());
  const { server, base } = await startServer(okService);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/reverse/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"customer_identifier": "000.000.000-00", quebrado',
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.ok(!text.includes("000.000.000-00"));
  assert.equal(JSON.parse(text).code, "INVALID_INPUT");
});
