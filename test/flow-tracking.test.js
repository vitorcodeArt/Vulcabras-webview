// Rastreamento do catálogo e do rastreamento de pedido: servidor e script do navegador
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { buildRecord, sanitizeMeta, setSink, ingestClientEvents, trackSearchTerms, EVENTS } = require("../lib/tracking");
const { createSessionToken } = require("../lib/session");
const { createReverseRouter } = require("../routes/reverse");

const SEND_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_SEND = "99999999-2222-4333-8444-555555555555";

function capture(t) {
  const records = [];
  setSink((record) => records.push(record));
  t.after(() => setSink(null));
  return records;
}

test("os eventos do catálogo passam no filtro", () => {
  for (const event of ["webview_opened", "step_viewed", "category_selected", "search_performed", "product_viewed", "variation_selected", "add_to_cart_clicked", "abandoned"]) {
    assert.ok(EVENTS.has(event), event);
    assert.equal(buildRecord({ event }).event, event);
  }
});

test("chaves proibidas são descartadas: product_name some, product_title fica", () => {
  const meta = sanitizeMeta({ product_name: "Tênis", product_title: "Tênis Flash", product_id: "123", sku: "SKU-1", size: "38", color: "Cinza", category: "Masculino", results_count: 4 });
  assert.deepEqual(meta, { product_title: "Tênis Flash", product_id: "123", sku: "SKU-1", size: "38", color: "Cinza", category: "Masculino", results_count: 4 });
});

test("o registro leva flow e send_id; valores inválidos viram null", () => {
  const ok = buildRecord({ event: "webview_opened", flow: "catalog", send_id: SEND_ID });
  assert.equal(ok.flow, "catalog");
  assert.equal(ok.send_id, SEND_ID);
  const bad = buildRecord({ event: "webview_opened", flow: "inventado", send_id: "nao-e-uuid" });
  assert.equal(bad.flow, null);
  assert.equal(bad.send_id, null);
});

test("lote do navegador usa flow e send_id do token, nunca do corpo", (t) => {
  const records = capture(t);
  const flow = { conversationId: "conv-1", store: "mizuno", sessionId: SESSION_ID, sendId: SEND_ID, flow: "catalog" };
  const result = ingestClientEvents([{ event: "category_selected", seq: 1, meta: { category: "Masculino" }, flow: "reverse", send_id: OTHER_SEND, conversation_id: "outra", brand: "underarmour" }], flow);
  assert.deepEqual(result, { accepted: 1, rejected: 0 });
  assert.equal(records[0].flow, "catalog");
  assert.equal(records[0].send_id, SEND_ID);
  assert.equal(records[0].conversation_id, "conv-1");
  assert.equal(records[0].brand, "mizuno");
  assert.equal(records[0].source, "client");
});

test("token antigo (sem fluxo) conta como reverse nos eventos", (t) => {
  const records = capture(t);
  ingestClientEvents([{ event: "step_viewed", step: "start" }], { conversationId: "conv-1", store: "mizuno", sessionId: SESSION_ID });
  assert.equal(records[0].flow, "reverse");
  assert.equal(records[0].send_id, null);
});

test("busca: termo em minúsculas e cortado em 60; sem TRACK_SEARCH_TERMS=false ele vai, com false some", (t) => {
  const records = capture(t);
  const flow = { conversationId: "conv-1", store: "mizuno", sessionId: SESSION_ID, flow: "catalog" };
  const longTerm = `  TÊNIS Corrida ${"X".repeat(100)}  `;

  t.after(useFakeEnv({ TRACK_SEARCH_TERMS: undefined }));
  assert.equal(trackSearchTerms(), true);
  ingestClientEvents([{ event: "search_performed", meta: { query: longTerm, results_count: 3 } }], flow);
  assert.equal(records[0].meta.query.length, 60);
  assert.equal(records[0].meta.query, records[0].meta.query.toLowerCase());
  assert.equal(records[0].meta.results_count, 3);

  process.env.TRACK_SEARCH_TERMS = "false";
  assert.equal(trackSearchTerms(), false);
  ingestClientEvents([{ event: "search_performed", meta: { query: "tenis", results_count: 3 } }], flow);
  assert.deepEqual(records[1].meta, { results_count: 3 });

  // Outros eventos não são mexidos
  ingestClientEvents([{ event: "category_selected", meta: { category: "Kids" } }], flow);
  assert.deepEqual(records[2].meta, { category: "Kids" });
});

async function startEvents(t) {
  const restore = useFakeEnv({ TRACK_SEARCH_TERMS: undefined });
  t.after(restore);
  const app = express();
  app.use(express.json());
  app.use(createReverseRouter({ service: { features: () => ({}) } }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    events: async (token, body) => {
      const res = await fetch(`${base}/api/flow/events`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Flow-Token": token } : {}), "X-Flow-Session": SESSION_ID }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    config: async () => (await fetch(`${base}/api/flow/config`)).json(),
  };
}

test("/api/flow/events aceita token de catálogo e de rastreamento e grava flow e send_id do token", async (t) => {
  const records = capture(t);
  const api = await startEvents(t);

  for (const flow of ["catalog", "tracking"]) {
    const token = createSessionToken({ conversationId: "conv-ev", store: "mizuno", sendId: SEND_ID, flow });
    const res = await api.events(token, { events: [{ event: "webview_opened", step: "categories" }] });
    assert.equal(res.status, 202);
    assert.equal(res.body.accepted, 1);
  }
  assert.deepEqual(records.map((r) => r.flow), ["catalog", "tracking"]);
  assert.ok(records.every((r) => r.send_id === SEND_ID && r.conversation_id === "conv-ev"));

  assert.equal((await api.events(null, { events: [] })).status, 401);
  assert.equal((await api.events("lixo.lixo", { events: [] })).status, 401);
});

test("/api/flow/config diz se o termo da busca pode ser enviado", async (t) => {
  const api = await startEvents(t);
  assert.deepEqual(await api.config(), { success: true, trackSearchTerms: true });
  process.env.TRACK_SEARCH_TERMS = "false";
  assert.deepEqual(await api.config(), { success: true, trackSearchTerms: false });
});

// ---------- Script do navegador (public/js/shared/tracking.js) ----------

function loadClient({ search = "?conversationId=conv-1&store=mizuno&t=TOKEN123", config = { trackSearchTerms: true } } = {}) {
  const calls = { fetch: [], beacons: [], timers: [], replace: [] };
  const listeners = { window: {}, document: {} };
  const timers = [];
  const win = {
    location: { search, pathname: "/catalog" },
    history: { replaceState: (...args) => calls.replace.push(args) },
    crypto: { randomUUID: () => SESSION_ID },
    navigator: { sendBeacon: (url, blob) => (calls.beacons.push({ url, blob }), true) },
    addEventListener: (name, fn) => (listeners.window[name] = fn),
    document: { visibilityState: "visible", addEventListener: (name, fn) => (listeners.document[name] = fn) },
  };
  const context = {
    window: win,
    URLSearchParams,
    Blob,
    Uint8Array,
    Array,
    JSON,
    Boolean,
    clearTimeout: () => {},
    setTimeout: (fn) => (timers.push(fn), timers.length),
    fetch: (url, options) => {
      calls.fetch.push({ url, options });
      const isConfig = String(url).includes("/api/flow/config");
      return Promise.resolve({ ok: true, json: async () => (isConfig ? config : {}) });
    },
  };
  win.window = win;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "js", "shared", "tracking.js"), "utf8"), context);
  return { tracking: win.FlowTracking, calls, listeners, timers, win };
}

// Objetos criados dentro do vm têm outro Object: comparar por JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const sentEvents = (calls) => calls.fetch.filter((c) => String(c.url).includes("/api/flow/events")).flatMap((c) => JSON.parse(c.options.body).events);

test("cliente: tira o token da URL, usa o header e agrupa em 20 eventos", () => {
  const { tracking, calls } = loadClient();
  assert.equal(calls.replace.length, 1);
  assert.equal(calls.replace[0][2], "/catalog?conversationId=conv-1&store=mizuno");

  for (let i = 0; i < 19; i += 1) tracking.track("step_viewed", { step: "categories" });
  assert.equal(sentEvents(calls).length, 0);
  tracking.track("step_viewed", { step: "products" });
  const sent = calls.fetch.find((c) => String(c.url).includes("/api/flow/events"));
  assert.equal(sent.options.headers["X-Flow-Token"], "TOKEN123");
  assert.equal(sent.options.headers["X-Flow-Session"], SESSION_ID);
  assert.equal(sentEvents(calls).length, 20);
});

test("cliente: pagehide manda abandoned por sendBeacon, uma vez só, com o token no corpo", () => {
  const { tracking, calls, listeners } = loadClient();
  tracking.track("webview_opened", { step: "categories" });
  listeners.window.pagehide();
  listeners.window.pagehide();
  assert.equal(calls.beacons.length, 1);
});

test("cliente: depois de add_to_cart_clicked não há abandoned", async () => {
  const { tracking, calls, listeners } = loadClient();
  tracking.track("add_to_cart_clicked", { meta: { sku: "SKU-1", product_id: "1" } });
  listeners.window.pagehide();
  assert.equal(calls.beacons.length, 1);
  const body = JSON.parse(await calls.beacons[0].blob.text());
  assert.deepEqual(body.events.map((e) => e.event), ["add_to_cart_clicked"]);
  assert.equal(body._token, "TOKEN123");
  assert.equal(body._session, SESSION_ID);
});

test("cliente: sem token (link antigo) nada é enviado", () => {
  const { tracking, calls, listeners } = loadClient({ search: "?conversationId=conv-1&store=mizuno" });
  tracking.track("webview_opened", { step: "categories" });
  listeners.window.pagehide();
  assert.equal(calls.beacons.length, 0);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.replace.length, 0);
});

test("cliente: o termo da busca só é enviado se o servidor permitir; sem a config, só a contagem", async () => {
  const on = loadClient({ config: { trackSearchTerms: true } });
  assert.deepEqual(plain(on.tracking.searchMeta("  Tênis ", 4)), { results_count: 4 }); // config ainda não respondeu
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(on.tracking.searchMeta("  Tênis ", 4)), { results_count: 4, query: "tênis" });
  assert.equal(on.tracking.searchMeta("x".repeat(100), 1).query.length, 60);

  const off = loadClient({ config: { trackSearchTerms: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(off.tracking.searchMeta("tênis", 4)), { results_count: 4 });
});
