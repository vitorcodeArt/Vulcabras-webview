const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { useFakeEnv } = require("./helpers");
const { createAnalyticsRouter } = require("../routes/analytics");
const { toCsv, csvCell, parsePeriod, escapeLike } = require("../lib/analytics");
const labels = require("../lib/analytics-labels");

const SECRET = "segredo-analytics-de-teste";
const NOW = Date.parse("2026-11-19T15:00:00Z");
const SEND_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SESSION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

// Banco falso: guarda as consultas e responde pelo trecho do SQL
function fakeDb(handler = () => []) {
  const calls = [];
  return {
    calls,
    getPool: () => ({}),
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: handler(text, params) };
    },
  };
}

async function start(t, { db = fakeDb(), env = { ANALYTICS_API_SECRET: SECRET }, now = () => NOW } = {}) {
  const app = express();
  app.use("/api/analytics", createAnalyticsRouter({ db, env, now }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/analytics`;
  const get = (path, { token = SECRET, headers = {} } = {}) =>
    fetch(`${base}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  return { get, db };
}

const sendRow = (extra = {}) => ({
  send_id: SEND_ID,
  sent_at: new Date("2026-11-19T12:00:00Z"),
  sent_at_raw: "2026-11-19 12:00:00.123456+00",
  conversation_id: "abc123",
  customer_name: "Maria S.",
  brand: "mizuno",
  flow: "reverse",
  click_status: "clicked",
  session_id: SESSION_ID,
  eff_status: "completed",
  last_step: "summary",
  last_event_at: new Date("2026-11-19T12:05:00Z"),
  duration_seconds: 214,
  outcome: "approved_with_shipping",
  request_type: "troca",
  reason: "Defeito",
  ticket_id: "123456",
  error_count: 0,
  products_viewed: 0,
  cart_clicks: 0,
  ...extra,
});

// ---------- autenticação, limite e erros ----------

test("sem segredo no servidor: 503; sem Bearer ou errado: 401; certo: 200", async (t) => {
  const off = await start(t, { env: {} });
  const r1 = await off.get("/health");
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).code, "SERVICE_UNAVAILABLE");

  const { get } = await start(t);
  assert.equal((await get("/health", { token: null })).status, 401);
  const wrong = await get("/health", { token: "errado" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { success: false, code: "UNAUTHORIZED", error: "Não autorizado." });
  // O header do bot não vale aqui: só Bearer
  assert.equal((await get("/health", { token: null, headers: { "X-Api-Secret": SECRET } })).status, 401);

  const ok = await get("/health");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.success, true);
  assert.equal(body.data.db, "ok");
  assert.equal(body.meta.timezone, "America/Sao_Paulo");
});

test("sem CORS aberto e sem cache", async (t) => {
  const { get } = await start(t);
  const res = await get("/health", { headers: { Origin: "https://outro.exemplo" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("61ª requisição no minuto: 429 RATE_LIMITED", async (t) => {
  const { get } = await start(t);
  for (let i = 0; i < 60; i += 1) assert.equal((await get("/health")).status, 200);
  const res = await get("/health");
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "RATE_LIMITED");
  assert.ok(res.headers.get("retry-after"));
});

test("erro do banco vira 503 genérico, sem SQL nem mensagem", async (t) => {
  const db = fakeDb(() => {
    throw Object.assign(new Error("select * from v_sends where conversation_id = 'segredo-no-sql'"), { code: "42P01" });
  });
  const logs = [];
  const original = console.error;
  console.error = (m) => logs.push(String(m));
  t.after(() => (console.error = original));

  const { get } = await start(t, { db });
  const res = await get("/summary");
  const text = await res.text();
  assert.equal(res.status, 503);
  assert.ok(!/select|segredo-no-sql|v_sends|stack/i.test(text));
  assert.equal(JSON.parse(text).code, "SERVICE_UNAVAILABLE");
  assert.ok(logs.every((m) => !m.includes("segredo-no-sql")));
});

test("sem banco configurado: 503; rota inexistente: 404", async (t) => {
  const { get } = await start(t, { db: { getPool: () => null, query: async () => ({ rows: [] }) } });
  assert.equal((await get("/summary")).status, 503);

  const ok = await start(t);
  const res = await ok.get("/nada");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "NOT_FOUND");
});

// ---------- período e filtros ----------

test("período: padrão 7 dias com hoje incluído (fuso de São Paulo)", () => {
  assert.deepEqual(parsePeriod({}, NOW), { from: "2026-11-13", to: "2026-11-19", fromMs: Date.parse("2026-11-13"), toMs: Date.parse("2026-11-19") });
  // 01:00 UTC ainda é o dia anterior em São Paulo
  assert.equal(parsePeriod({}, Date.parse("2026-11-20T01:00:00Z")).to, "2026-11-19");
});

test("período inválido, invertido ou acima de 366 dias vira 400", async (t) => {
  const { get } = await start(t);
  for (const q of ["from=2026-02-31", "from=ontem", "from=2026-11-10&to=2026-11-01", "from=2025-01-01&to=2026-11-19", "brand=nike", "flow=outro", "from=2026-11-01&from=2026-11-02"]) {
    const res = await get(`/summary?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).code, "BAD_REQUEST");
  }
  assert.equal((await get("/summary?from=2025-11-19&to=2026-11-19")).status, 200); // 366 dias
  assert.equal((await get("/funnel")).status, 400);
  assert.equal((await get("/funnel?flow=tracking")).status, 400);
});

// ---------- /summary ----------

test("summary: taxas, dias sem envio preenchidos e SQL parametrizado", async (t) => {
  const totals = { sends: 320, send_failed: 7, clicked: 190, not_clicked: 123, completed: 45, handoff: 22, errors: 21, avg_duration_seconds: 214 };
  const db = fakeDb((text) => {
    if (text.includes("group by flow")) return [{ flow: "reverse", ...totals }];
    if (text.includes("group by brand")) return [{ brand: "mizuno", ...totals }];
    if (text.includes("YYYY-MM-DD")) return [{ date: "2026-11-18", sends: 40, clicked: 24, completed: 6 }];
    return [totals];
  });
  const { get } = await start(t, { db });
  const res = await get("/summary?from=2026-11-17&to=2026-11-19&brand=mizuno");
  const { data, meta } = await res.json();

  assert.equal(data.totals.click_rate, 0.607);
  assert.equal(data.totals.completion_rate_of_clicked, 0.2368);
  assert.equal(data.totals.completion_rate_of_sent, 0.1438);
  assert.equal(data.by_flow[0].flow, "reverse");
  assert.equal(data.by_brand[0].brand, "mizuno");
  assert.deepEqual(data.daily.map((d) => d.date), ["2026-11-17", "2026-11-18", "2026-11-19"]);
  assert.deepEqual(data.daily[0], { date: "2026-11-17", sends: 0, clicked: 0, completed: 0 });
  assert.equal(data.daily[1].sends, 40);
  assert.deepEqual([meta.from, meta.to], ["2026-11-17", "2026-11-19"]);

  for (const { text, params } of db.calls) {
    assert.ok(text.includes("America/Sao_Paulo"));
    assert.ok(!text.includes("mizuno") && !text.includes("2026-11"), "valores só como parâmetro");
    assert.ok(params.includes("mizuno"));
  }
});

test("summary: taxas viram null quando o denominador é zero", async (t) => {
  const { get } = await start(t, { db: fakeDb(() => [{ sends: 0, send_failed: 0, clicked: 0, not_clicked: 0, completed: 0, handoff: 0, errors: 0, avg_duration_seconds: null }]) });
  const { data } = await (await get("/summary")).json();
  assert.equal(data.totals.click_rate, null);
  assert.equal(data.totals.completion_rate_of_clicked, null);
  assert.equal(data.totals.avg_duration_seconds, null);
  assert.equal(data.daily.length, 7);
});

// ---------- /funnel ----------

test("funnel: enviados, abriram, etapas e concluíram, com queda sem valor negativo", async (t) => {
  const db = fakeDb((text) => {
    if (text.includes("count(distinct")) return [{ step: "start", sessions: 100 }, { step: "identify", sessions: 92 }, { step: "items", sessions: 95 }];
    if (text.includes("avg(e.duration_ms)")) return [{ step: "identify", avg_duration_ms: 31000 }];
    return [{ sends: 170, send_failed: 6, clicked: 100, not_clicked: 64, completed: 21, handoff: 0, errors: 0, avg_duration_seconds: 1 }];
  });
  const { get } = await start(t, { db });
  const { data } = await (await get("/funnel?flow=reverse")).json();
  const by = Object.fromEntries(data.steps.map((s) => [s.key, s]));

  assert.deepEqual(data.steps.slice(0, 2).map((s) => s.key), ["sent", "opened"]);
  assert.equal(by.sent.sessions, 164);
  assert.equal(by.sent.drop_off_rate, null);
  assert.equal(by.opened.drop_off_rate, 0.3902);
  assert.equal(by.identify.drop_off_rate, 0.08);
  assert.equal(by.identify.avg_duration_ms, 31000);
  assert.equal(by.items.drop_off_rate, 0); // etapa com mais sessões que a anterior: sem queda negativa
  assert.equal(by.completed.label, "Concluíram");
  assert.equal(data.steps.at(-1).key, "completed");
});

// ---------- /sends ----------

test("sends: item do contrato, rótulos e paginação por cursor", async (t) => {
  const rows = [sendRow(), sendRow({ send_id: "11111111-2222-4333-8444-555555555555", sent_at_raw: "2026-11-19 11:00:00.5+00" }), sendRow({ send_id: "22222222-2222-4333-8444-555555555555" })];
  const db = fakeDb(() => rows);
  const { get } = await start(t, { db });

  const res = await get("/sends?limit=2");
  const { data } = await res.json();
  assert.equal(data.items.length, 2);
  const item = data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "brand", "cart_clicks", "click_status", "conversation_id", "customer_name", "duration_seconds", "error_count", "flow", "last_event_at",
    "last_step", "last_step_label", "outcome", "outcome_label", "products_viewed", "reason", "request_type", "send_id", "sent_at", "session_id",
    "session_status", "status_label", "ticket_id",
  ]);
  assert.equal(item.outcome_label, "Aprovada, com envio");
  assert.equal(item.status_label, "Concluído");
  assert.equal(item.ticket_id, 123456);
  assert.equal(item.sent_at, "2026-11-19T12:00:00.000Z");
  assert.ok(data.next_cursor);
  assert.equal(db.calls[0].params.at(-1), 3, "busca limit + 1");

  // O cursor volta como (sent_at, send_id) com o texto de microssegundos
  await get(`/sends?limit=2&cursor=${data.next_cursor}`);
  const cursorCall = db.calls[1];
  assert.ok(cursorCall.text.includes("(v.sent_at, v.send_id) <"));
  assert.ok(cursorCall.params.includes("2026-11-19 11:00:00.5+00"));

  const last = await (await get("/sends?limit=3")).json();
  assert.equal(last.data.next_cursor, null);
});

test("sends: limit, cursor e filtros inválidos viram 400", async (t) => {
  const { get } = await start(t);
  for (const q of ["limit=0", "limit=101", "limit=abc", "cursor=lixo", "click_status=x", "status=x", `q=${"a".repeat(121)}`]) {
    assert.equal((await get(`/sends?${q}`)).status, 400, q);
  }
  assert.equal((await get("/sends?limit=100")).status, 200);
});

test("sends: busca q por conversa, hash do pedido e nome (com % e _ escapados)", async (t) => {
  const restore = useFakeEnv();
  t.after(restore);
  const db = fakeDb();
  const { get } = await start(t, { db });

  await get(`/sends?q=${encodeURIComponent("# 1664284820905-01")}`);
  const { hashOrderNumber } = require("../lib/tracking");
  const byOrder = db.calls[0];
  assert.ok(byOrder.text.includes("order_hash ="));
  assert.ok(byOrder.params.includes(hashOrderNumber("1664284820905-01")));
  assert.ok(!byOrder.text.includes("1664284820905") && !byOrder.params.includes("1664284820905-01"));

  await get(`/sends?q=${encodeURIComponent("50%_x")}`);
  const byName = db.calls[1];
  assert.ok(byName.text.includes("v.conversation_id ="));
  assert.ok(byName.text.includes("ilike"));
  assert.ok(byName.params.includes("%50\\%\\_x%"));

  await get("/sends?q=ab"); // menos de 3 caracteres: só conversa exata
  assert.ok(!db.calls[2].text.includes("ilike"));
  assert.equal(escapeLike("a%b_c\\"), "a\\%b\\_c\\\\");
});

// ---------- detalhes ----------

test("sends/:id: valida o uuid, 404 e eventos da sessão com meta filtrada", async (t) => {
  const db = fakeDb((text, params) => {
    if (text.includes("from flow_events")) {
      return [
        { id: "1", ts: new Date("2026-11-19T12:00:00Z"), source: "client", step: "identify", event: "step_viewed", duration_ms: null, error_code: null, meta: { reason: "Defeito", cpf: "123", email: "a@b.c" } },
        { id: "2", ts: new Date("2026-11-19T12:01:00Z"), source: "server", step: "submit", event: "error_shown", duration_ms: 10, error_code: "PHOTO_REQUIRED", meta: null },
      ];
    }
    return params[0] === SEND_ID ? [sendRow()] : [];
  });
  const { get } = await start(t, { db });

  assert.equal((await get("/sends/nao-uuid")).status, 400);
  assert.equal((await get("/sends/11111111-2222-4333-8444-555555555555")).status, 404);

  const { data } = await (await get(`/sends/${SEND_ID}`)).json();
  assert.equal(data.send_id, SEND_ID);
  assert.equal(data.events.length, 2);
  assert.equal(data.events[0].step_label, "Identificação");
  assert.equal(data.events[0].event_label, "Viu a etapa");
  assert.deepEqual(data.events[0].meta, { reason: "Defeito" });
  assert.equal(data.events[1].error_label, "Foto obrigatória");
  assert.ok(db.calls.at(-1).text.includes("order by ts, id"));
});

test("sends/:id sem clique devolve lista de eventos vazia", async (t) => {
  const db = fakeDb(() => [sendRow({ click_status: "not_clicked", session_id: null, eff_status: null, last_step: null })]);
  const { get } = await start(t, { db });
  const { data } = await (await get(`/sends/${SEND_ID}`)).json();
  assert.deepEqual(data.events, []);
  assert.equal(data.status_label, "Sem clique");
  assert.equal(db.calls.length, 1);
});

test("sessions/:id: sessão, envio e eventos", async (t) => {
  const db = fakeDb((text) => {
    if (text.includes("from v_flow_sessions")) {
      return [{ session_id: SESSION_ID, flow: "tracking", status: "abandoned", opened_at: new Date("2026-11-19T12:00:00Z"), last_event_at: new Date("2026-11-19T12:00:05Z"), completed_at: null, handoff_at: null, last_step: null, outcome: null, ticket_id: null, customer_name: "Maria S.", error_count: 0 }];
    }
    if (text.includes("from flow_events")) return [];
    return [sendRow({ flow: "tracking" })];
  });
  const { get } = await start(t, { db });
  assert.equal((await get("/sessions/x")).status, 400);
  const { data } = await (await get(`/sessions/${SESSION_ID}`)).json();
  assert.equal(data.session.status, "completed"); // rastreamento: sessão aberta = concluído
  assert.equal(data.session.status_label, "Concluído");
  assert.equal(data.send.send_id, SEND_ID);
  assert.deepEqual(data.events, []);

  const empty = await start(t, { db: fakeDb(() => []) });
  assert.equal((await empty.get(`/sessions/${SESSION_ID}`)).status, 404);
});

// ---------- relatórios ----------

test("reports/reverse: monta o contrato, top 20 + outros e motivo da transferência nos dois campos", async (t) => {
  const manyReasons = Array.from({ length: 23 }, (_, i) => ({ key: `Motivo ${i}`, count: 30 - i }));
  const db = fakeDb((text) => {
    if (text.includes("handoff_requested")) return [{ key: "Solicitação fora do prazo", count: 11 }];
    if (text.includes("error_shown")) return [{ key: "TEMPORARY_FAILURE", count: 7 }];
    if (text.includes("as offered")) return [{ offered: 14, accepted: 6, with_photos: 9 }];
    if (text.includes("percentile_cont")) return [{ sessions: 100, completed: 21, handoff: 22, errors: 21, avg_s: 305, p90_s: 640 }];
    if (text.includes("request_type as key")) return [{ key: "troca", count: 12 }];
    if (text.includes("reason as key")) return manyReasons;
    if (text.includes("outcome as key")) return [{ key: "approved_with_shipping", count: 8 }];
    if (text.includes("brand as key")) return [{ key: "mizuno", sessions: 40, completed: 9 }];
    return [];
  });
  const { get } = await start(t, { db });
  const { data } = await (await get("/reports/reverse")).json();

  assert.deepEqual(data.totals, { sessions: 100, completed: 21, handoff: 22, errors: 21, avg_seconds_to_complete: 305, p90_seconds_to_complete: 640 });
  assert.deepEqual(data.retention, { offered: 14, accepted: 6, accept_rate: 0.4286 });
  assert.deepEqual(data.photos, { sessions_with_photos: 9 });
  assert.deepEqual(data.by_outcome[0], { key: "approved_with_shipping", label: "Aprovada, com envio", count: 8 });
  assert.deepEqual(data.errors_by_code[0], { key: "TEMPORARY_FAILURE", label: "Falha temporária no Troque", count: 7 });
  assert.equal(data.by_reason.length, 21);
  assert.deepEqual(data.by_reason.at(-1), { key: "outros", count: 27 });
  assert.ok(db.calls.some((c) => c.text.includes("coalesce(e.meta->>'handoff_reason', e.meta->>'reason'")));
});

test("reports/catalog: monta o contrato e respeita TRACK_SEARCH_TERMS", async (t) => {
  const restore = useFakeEnv({ TRACK_SEARCH_TERMS: undefined });
  t.after(restore);
  const db = fakeDb((text) => {
    if (text.includes("as with_product_view")) return [{ sessions: 97, with_product_view: 70, with_cart_click: 16 }];
    if (text.includes("category_selected")) return [{ key: "Calçados", count: 31 }];
    if (text.includes("as views")) return [{ product_id: "1004", title: "Produto X", views: 18, cart_clicks: 5 }];
    if (text.includes("as size")) return [{ size: "40", color: "Preto", count: 7 }];
    if (text.includes("as term")) return [{ term: "tenis corrida", count: 9, no_results_count: 0 }];
    if (text.includes("as no_results")) return [{ total: 44, no_results: 6 }];
    if (text.includes("brand as key")) return [{ key: "mizuno", sessions: 30, with_cart_click: 6 }];
    return [];
  });
  const { get } = await start(t, { db });
  const { data } = await (await get("/reports/catalog")).json();
  assert.deepEqual(data.totals, { sessions: 97, with_product_view: 70, with_cart_click: 16, cart_rate: 0.1649 });
  assert.deepEqual(data.top_products[0], { product_id: "1004", title: "Produto X", views: 18, cart_clicks: 5 });
  assert.deepEqual(data.searches, { total: 44, no_results: 6, top_terms: [{ term: "tenis corrida", count: 9, no_results_count: 0 }] });

  process.env.TRACK_SEARCH_TERMS = "false";
  const off = await (await get("/reports/catalog")).json();
  assert.deepEqual(off.data.searches.top_terms, []);
});

// ---------- CSV ----------

test("CSV: BOM, separador ;, aspas e proteção contra fórmula", () => {
  const csv = toCsv({
    header: ["A", "B"],
    rows: [
      ["=1+1", "+cmd"],
      ["-2", "@soma"],
      ["texto;com;ponto-e-vírgula", 'aspas "x"'],
      ["linha\nquebrada", null],
      [-5, 3],
    ],
  });
  assert.ok(csv.startsWith("﻿A;B\r\n"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[1], "'=1+1;'+cmd");
  assert.equal(lines[2], "'-2;'@soma");
  assert.equal(lines[3], '"texto;com;ponto-e-vírgula";"aspas ""x"""');
  assert.equal(csvCell(-5), "-5", "número negativo não leva apóstrofo");
  assert.equal(csvCell(null), "");
});

test("export.csv: cabeçalho em português, tipo, nome do arquivo e 400 sem report", async (t) => {
  const db = fakeDb(() => [sendRow({ customer_name: "=HIPERLINK()" })]);
  const { get } = await start(t, { db });
  const res = await get("/export.csv?report=sends&from=2026-11-19&to=2026-11-19");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="envios-2026-11-19\.csv"/);
  const bytes = Buffer.from(await res.clone().arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
  const text = await res.text(); // o fetch remove o BOM ao decodificar
  assert.ok(text.startsWith("ID do envio;Enviado em;ID da conversa;Cliente;"));
  assert.ok(text.includes("'=HIPERLINK()"));
  assert.ok(text.includes("2026-11-19 09:00:00"), "data no fuso de São Paulo");
  assert.ok(!/cpf|e-mail|telefone/i.test(text.split("\r\n")[0]));
  assert.ok(db.calls[0].text.includes("limit 50000"));

  assert.equal((await get("/export.csv")).status, 400);
  assert.equal((await get("/export.csv?report=outro")).status, 400);
  assert.equal((await get("/export.csv?report=reverse_sessions")).status, 200);
  assert.equal((await get("/export.csv?report=catalog_products")).status, 200);
});

// ---------- rótulos ----------

test("rótulos do contrato e código desconhecido mostra o próprio código", () => {
  assert.equal(labels.stepLabel("retention"), "Vale-compras");
  assert.equal(labels.stepLabel("details"), "Detalhe do produto");
  assert.equal(labels.eventLabel("add_to_cart_clicked"), "Clicou em adicionar ao carrinho");
  assert.equal(labels.errorLabel("HANDOFF_REQUIRED"), "Motivo vai para atendente");
  assert.equal(labels.errorLabel("CODIGO_NOVO"), "CODIGO_NOVO");
  assert.equal(labels.outcomeLabel("approved_shipping_failed"), "Aprovada, envio falhou");
  assert.equal(labels.statusLabel("send_failed"), "Falha no envio");
  assert.equal(labels.stepLabel(null), null);
  assert.equal(labels.stepLabel("constructor"), "constructor", "não herda de Object.prototype");
});

test("rótulos: etapas submit e error têm nome em português; chave desconhecida mostra a própria chave", () => {
  const labels = require("../lib/analytics-labels");
  assert.equal(labels.stepLabel("error"), "Tela de erro");
  assert.equal(labels.stepLabel("submit"), "Envio da solicitação");
  assert.equal(labels.stepLabel("etapa_nova"), "etapa_nova");
  assert.equal(labels.errorLabel("UNKNOWN_ERROR"), "Erro com código não reconhecido");
  assert.equal(labels.errorLabel("NO_REASONS_FOR_TYPE"), "Sem opção de troca ou devolução");
});
