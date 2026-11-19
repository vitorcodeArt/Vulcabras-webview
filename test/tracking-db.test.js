const test = require("node:test");
const assert = require("node:assert/strict");
const { createTrackingDb, installTrackingDb, buildInsert, COLUMNS } = require("../lib/tracking-db");
const { buildRecord, track, setSink } = require("../lib/tracking");

const SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const silent = { error() {} };
const noSleep = async () => {};

function record(n, extra = {}) {
  return buildRecord({ event: "step_viewed", step: "items", session_id: SESSION, conversation_id: "c1", brand: "mizuno", seq: n, ...extra });
}

// Banco falso: guarda as consultas; `failures` define quantas falham antes de dar certo
function fakeDb({ failures = 0, error } = {}) {
  const calls = [];
  let left = failures;
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error("valor secreto na mensagem"), { code: error || "08006" });
      }
      return { rowCount: 1 };
    },
  };
}

test("insert em lote é parametrizado e na ordem das colunas", () => {
  const { text, params } = buildInsert([
    ["2026-11-19T12:00:00.000Z", SESSION, null, "c1", "mizuno", "catalog", "client", null, 1, "items", "step_viewed", 10, null, '{"a":1}'],
    ["2026-11-19T12:00:01.000Z", null, null, null, null, null, "server", null, null, null, "completed", null, null, null],
  ]);
  assert.match(text, /^insert into flow_events \(ts, session_id, send_id, conversation_id, brand, flow, source, channel, seq, step, event, duration_ms, error_code, meta\) values/);
  assert.ok(text.includes("$14::jsonb") && text.includes("$28::jsonb"));
  assert.equal(params.length, COLUMNS.length * 2);
  assert.ok(!text.includes("c1") && !text.includes("mizuno"), "valores não podem entrar no texto do SQL");
});

test("grava em lote de 50 linhas sem esperar o relógio", async () => {
  const db = fakeDb();
  const writer = createTrackingDb({ db, logger: silent });
  for (let i = 0; i < 50; i += 1) writer.enqueue(record(i));
  await writer.flush();
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].params.length, 50 * COLUMNS.length);
  assert.deepEqual(writer.stats(), { queued: 0, dropped: 0, written: 50 });
});

test("flush grava a fila parcial e divide em lotes de 50", async () => {
  const db = fakeDb();
  const writer = createTrackingDb({ db, logger: silent, options: { maxBatch: 50 } });
  writer.enqueue(record(1));
  await writer.flush();
  assert.equal(db.calls.length, 1);

  for (let i = 0; i < 120; i += 1) writer.enqueue(record(i));
  await writer.flush();
  const rows = db.calls.slice(1).reduce((sum, c) => sum + c.params.length / COLUMNS.length, 0);
  assert.equal(rows, 120);
  assert.ok(db.calls.slice(1).every((c) => c.params.length / COLUMNS.length <= 50));
});

test("tenta 3 vezes com espera crescente e depois grava", async () => {
  const db = fakeDb({ failures: 2 });
  const waits = [];
  const writer = createTrackingDb({ db, logger: silent, sleepFn: async (ms) => waits.push(ms), options: { backoffMs: 100 } });
  writer.enqueue(record(1));
  await writer.flush();
  assert.equal(db.calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(writer.stats().written, 1);
});

test("falhou nas 3 tentativas: o lote volta para a fila e a rodada seguinte grava", async () => {
  const db = fakeDb({ failures: 3 });
  const writer = createTrackingDb({ db, logger: silent, sleepFn: noSleep });
  writer.enqueue(record(1));
  await writer.flush();
  assert.equal(db.calls.length, 3);
  assert.deepEqual(writer.stats(), { queued: 1, dropped: 0, written: 0 });

  await writer.flush();
  assert.deepEqual(writer.stats(), { queued: 0, dropped: 0, written: 1 });
});

test("erro de dado (SQLSTATE 22/23) descarta o lote em vez de repetir", async () => {
  const db = fakeDb({ failures: 5, error: "22003" });
  const writer = createTrackingDb({ db, logger: silent, sleepFn: noSleep });
  writer.enqueue(record(1));
  await writer.flush();
  assert.equal(db.calls.length, 1);
  assert.deepEqual(writer.stats(), { queued: 0, dropped: 1, written: 0 });
});

test("fila cheia descarta as mais antigas e conta", async () => {
  const db = fakeDb();
  const logs = [];
  const writer = createTrackingDb({ db, logger: { error: (m) => logs.push(m) }, options: { maxQueue: 5000, maxBatch: 100000 } });
  for (let i = 0; i < 5003; i += 1) writer.enqueue(record(i));
  assert.deepEqual(writer.stats(), { queued: 5000, dropped: 3, written: 0 });
  assert.equal(logs.length, 1);

  await writer.flush();
  const seqs = db.calls[0].params.filter((_, i) => i % COLUMNS.length === COLUMNS.indexOf("seq"));
  assert.equal(seqs[0], 3, "as 3 mais antigas (seq 0..2) saíram");
});

test("banco fora do ar não deixa a fila crescer além do limite", async () => {
  const db = fakeDb({ failures: 1000 });
  const writer = createTrackingDb({ db, logger: silent, sleepFn: noSleep, options: { maxQueue: 10, maxBatch: 4 } });
  for (let i = 0; i < 25; i += 1) writer.enqueue(record(i));
  await writer.flush();
  assert.ok(writer.stats().queued <= 10);
});

test("close grava o que sobrou e para o relógio", async () => {
  const db = fakeDb();
  const writer = createTrackingDb({ db, logger: silent });
  writer.start();
  writer.enqueue(record(1));
  writer.enqueue(record(2));
  await writer.close();
  assert.deepEqual(writer.stats(), { queued: 0, dropped: 0, written: 2 });
});

test("close com o banco fora não trava e conta o descarte", async () => {
  const db = fakeDb({ failures: 1000 });
  const writer = createTrackingDb({ db, logger: silent, sleepFn: noSleep, options: { shutdownTimeoutMs: 200 } });
  writer.enqueue(record(1));
  await writer.close();
  assert.deepEqual(writer.stats(), { queued: 0, dropped: 1, written: 0 });
});

test("erro do banco nunca vai para o log com valores", async () => {
  const db = fakeDb({ failures: 3 });
  const logs = [];
  const writer = createTrackingDb({ db, logger: { error: (m) => logs.push(m) }, sleepFn: noSleep, options: { maxQueue: 1 } });
  writer.enqueue(record(1, { meta: { reason: "Defeito" } }));
  writer.enqueue(record(2));
  await writer.flush();
  assert.ok(logs.every((m) => !m.includes("secreto") && !m.includes("Defeito")));
});

test("linha leva só os campos do contrato (sem IP, user-agent ou texto livre)", async () => {
  const db = fakeDb();
  const writer = createTrackingDb({ db, logger: silent });
  writer.enqueue(buildRecord({
    event: "step_viewed", step: "items", source: "client", session_id: SESSION, send_id: SESSION, flow: "catalog",
    conversation_id: "c1", brand: "mizuno", ip: "1.2.3.4", user_agent: "x", comment: "texto livre",
    meta: { reason: "Defeito", cpf: "1" },
  }));
  await writer.flush();
  const { text, params } = db.calls[0];
  assert.ok(!/ip|user_agent|comment/i.test(text.replace(/ts, session_id.*meta\)/, "")));
  assert.equal(params.length, COLUMNS.length);
  assert.ok(!params.includes("1.2.3.4") && !params.includes("texto livre"));
  assert.equal(params[COLUMNS.indexOf("source")], "client");
  assert.equal(params[COLUMNS.indexOf("flow")], "catalog");
  assert.equal(params[COLUMNS.indexOf("meta")], '{"reason":"Defeito"}');
});

test("sem DATABASE_URL o sink não é instalado", () => {
  const db = { getPool: () => null };
  assert.equal(installTrackingDb({ db }), null);
});

test("instalado: continua no stdout e enfileira; SIGTERM grava e sai", async (t) => {
  const db = { ...fakeDb(), getPool: () => ({}), closed: false, async close() { this.closed = true; } };
  const handlers = {};
  let exitCode;
  const processRef = { once: (sig, fn) => (handlers[sig] = fn), exit: (c) => (exitCode = c) };

  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  t.after(() => {
    console.log = originalLog;
    setSink(null);
  });

  const writer = installTrackingDb({ db, processRef, logger: silent });
  assert.ok(writer);
  track({ event: "completed", session_id: SESSION });
  console.log = originalLog;

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "completed");
  assert.equal(writer.stats().queued, 1);

  await handlers.SIGTERM();
  assert.equal(db.calls.length, 1);
  assert.equal(db.closed, true);
  assert.equal(exitCode, 0);
  assert.ok(handlers.SIGINT);
});
