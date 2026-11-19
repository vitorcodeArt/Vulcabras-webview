// Banco de acompanhamento: pool falso, nenhuma conexão real
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createDb } = require("../lib/db");
const { createHealthRouter } = require("../routes/health");
const { runMigrations, listMigrations, describeError } = require("../scripts/migrate");

function fakePoolClass(log = []) {
  return class FakePool {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      log.push(options);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    async query() {
      return { rows: [{ "?column?": 1 }] };
    }
    async end() {}
  };
}

test("sem DATABASE_URL o pool é null e a consulta avisa que o banco está desligado", async () => {
  const created = [];
  const db = createDb({ env: {}, PoolClass: fakePoolClass(created) });
  assert.equal(db.getPool(), null);
  assert.equal(created.length, 0);
  await assert.rejects(() => db.query("select 1"), { code: "DB_DISABLED" });
  await assert.rejects(() => db.ping(), { code: "DB_DISABLED" });
});

test("com DATABASE_URL cria um pool só, com os limites e o SSL combinados", () => {
  const created = [];
  const db = createDb({ env: { DATABASE_URL: "postgres://usuario:senha-falsa@exemplo.invalid:6543/db" }, PoolClass: fakePoolClass(created) });
  const pool = db.getPool();
  assert.equal(db.getPool(), pool);
  assert.equal(created.length, 1);
  assert.equal(created[0].max, 5);
  assert.equal(created[0].idleTimeoutMillis, 30000);
  assert.equal(created[0].connectionTimeoutMillis, 8000);
  assert.deepEqual(created[0].ssl, { rejectUnauthorized: false });
  assert.equal(typeof pool.handlers.error, "function");
});

test("falha na consulta loga só o código, sem parâmetros nem string de conexão", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const Failing = class extends fakePoolClass() {
    async query() {
      throw Object.assign(new Error('duplicate key value "11122233344" postgres://usuario:senha-falsa@exemplo.invalid'), { code: "23505" });
    }
  };
  const db = createDb({ env: { DATABASE_URL: "postgres://usuario:senha-falsa@exemplo.invalid/db" }, PoolClass: Failing });
  await assert.rejects(() => db.query("insert into t values ($1)", ["11122233344"]), { code: "23505" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /23505/);
  assert.doesNotMatch(logs[0], /11122233344|senha-falsa|exemplo\.invalid/);
});

test("ping devolve os milissegundos e dá erro de tempo esgotado em 3 s", async (t) => {
  const ok = createDb({ env: { DATABASE_URL: "x" }, PoolClass: fakePoolClass() });
  assert.equal(typeof (await ok.ping()), "number");

  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const Hanging = class extends fakePoolClass() {
    query() {
      return new Promise(() => {});
    }
  };
  const slow = createDb({ env: { DATABASE_URL: "x" }, PoolClass: Hanging });
  const pending = slow.ping();
  const assertion = assert.rejects(pending, { code: "DB_TIMEOUT" });
  t.mock.timers.tick(3000);
  await assertion;
});

function tempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migracoes-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

// Pool falso que registra as instruções e simula schema_migrations
function migrationPool({ applied = [], failOn = null } = {}) {
  const statements = [];
  const registered = new Set(applied);
  const client = {
    async query(sql, params) {
      statements.push(sql.trim().split("\n")[0]);
      if (failOn && sql.includes(failOn)) throw Object.assign(new Error("erro de sintaxe"), { code: "42601" });
      if (/^insert into schema_migrations/.test(sql)) registered.add(params[0]);
      return { rows: [] };
    },
    release() {
      statements.push("release");
    },
  };
  return {
    statements,
    registered,
    async query(sql) {
      statements.push(sql.trim().split("\n")[0]);
      if (/^select name from schema_migrations/.test(sql)) return { rows: [...registered].map((name) => ({ name })) };
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
}

test("migrate aplica só o que falta, em ordem alfabética, e registra", async () => {
  const dir = tempMigrations({ "002_b.sql": "create table b ();", "001_a.sql": "create table a ();", "leia-me.txt": "ignorado" });
  const pool = migrationPool({ applied: ["001_a.sql"] });
  const logs = [];
  const result = await runMigrations({ pool, dir, log: (line) => logs.push(line) });

  assert.deepEqual(listMigrations(dir), ["001_a.sql", "002_b.sql"]);
  assert.deepEqual(result.applied, ["002_b.sql"]);
  assert.deepEqual(result.skipped, ["001_a.sql"]);
  assert.deepEqual([...pool.registered].sort(), ["001_a.sql", "002_b.sql"]);
  assert.ok(logs.includes("Aplicada: 002_b.sql"));
  assert.ok(logs.includes("Já aplicada: 001_a.sql"));
  // Uma transação por arquivo, e só do arquivo que faltava
  assert.deepEqual(
    pool.statements.filter((s) => ["begin", "commit", "rollback", "create table a ();", "create table b ();"].includes(s)),
    ["begin", "create table b ();", "commit"],
  );

  // Segunda execução: nada a fazer
  const again = await runMigrations({ pool, dir, log: () => {} });
  assert.deepEqual(again.applied, []);
});

test("migrate: falha desfaz a transação, não registra e propaga o erro com o nome do arquivo", async () => {
  const dir = tempMigrations({ "001_a.sql": "create table a ();", "002_ruim.sql": "isto nao e sql" });
  const pool = migrationPool({ failOn: "isto nao e sql" });
  await assert.rejects(
    () => runMigrations({ pool, dir, log: () => {} }),
    (error) => error.migration === "002_ruim.sql" && error.code === "42601",
  );
  assert.deepEqual([...pool.registered], ["001_a.sql"]);
  assert.ok(pool.statements.includes("rollback"));
  assert.equal(pool.statements.at(-1), "release");
});

test("migrate sem pasta de migrações não faz nada; mensagens de erro de rede não vazam o host", async () => {
  const pool = migrationPool();
  const result = await runMigrations({ pool, dir: path.join(os.tmpdir(), "nao-existe-migracoes"), log: () => {} });
  assert.deepEqual(result.applied, []);

  assert.match(describeError(Object.assign(new Error("syntax"), { code: "42601" })), /^42601: syntax$/);
  assert.equal(describeError(Object.assign(new Error("getaddrinfo ENOTFOUND db.exemplo.invalid"), { code: "ENOTFOUND" })), "ENOTFOUND");
});

async function listen(t, db, extra = {}) {
  const app = express();
  app.use(createHealthRouter({ db, ...extra }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("/health/db devolve 503 sem banco, sem detalhes", async (t) => {
  const base = await listen(t, createDb({ env: {}, PoolClass: fakePoolClass() }));
  const res = await fetch(`${base}/health/db`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("/health/db devolve ok e ms com banco, e reaproveita o resultado por alguns segundos", async (t) => {
  let pings = 0;
  let time = 1000;
  const db = {
    ping: async () => {
      pings += 1;
      return 7;
    },
  };
  const base = await listen(t, db, { now: () => time });

  const first = await fetch(`${base}/health/db`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, ms: 7 });
  await fetch(`${base}/health/db`);
  assert.equal(pings, 1);

  time += 6000;
  await fetch(`${base}/health/db`);
  assert.equal(pings, 2);
});

test("forget: chama forget_conversation com o ID como parâmetro e recusa ID inválido sem tocar no banco", async () => {
  const { forgetConversation } = require("../scripts/forget-conversation");
  const calls = [];
  const query = async (text, params) => calls.push({ text, params });

  await forgetConversation({ query, conversationId: "6afb6952894e2697327c02a3" });
  assert.deepEqual(calls, [{ text: "select forget_conversation($1)", params: ["6afb6952894e2697327c02a3"] }]);

  for (const bad of ["", "id com espaço", "x'; drop table t; --"]) {
    await assert.rejects(() => forgetConversation({ query, conversationId: bad }), { code: "INVALID_ID" });
  }
  assert.equal(calls.length, 1);
});
