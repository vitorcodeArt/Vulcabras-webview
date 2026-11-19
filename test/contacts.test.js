const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDisplayName, fetchSunshineName, saveContactName, rememberSunshineName, rememberTroqueName } = require("../lib/contacts");

const ENV = { ZENDESK_SUBDOMAIN: "sub", ZENDESK_APP_ID: "app1", ZENDESK_KEY_ID: "kid", ZENDESK_SECRET: "sec" };

function fakeDb() {
  const calls = [];
  return { calls, getPool: () => ({}), async query(text, params) { calls.push({ text, params }); return { rows: [] }; } };
}

test("nome de exibição: primeiro nome e inicial do sobrenome", () => {
  assert.equal(formatDisplayName("maria", "silva souza"), "Maria S.");
  assert.equal(formatDisplayName("  JOÃO  ", "álvares"), "João Á.");
  assert.equal(formatDisplayName("Ana", ""), "Ana");
  assert.equal(formatDisplayName("Ana Paula", null), "Ana");
  assert.equal(formatDisplayName("", "Silva"), null);
  assert.equal(formatDisplayName(undefined, undefined), null);
  assert.equal(formatDisplayName("Maria<script>", "S1lva"), "Mariascript S.");
  assert.equal(formatDisplayName("x".repeat(200), null).length, 40);
});

test("Sunshine: lista os participantes e lê givenName/surname do usuário", async () => {
  const urls = [];
  const axios = {
    async get(url, options) {
      urls.push({ url, options });
      if (url.endsWith("/participants")) return { data: { participants: [{ id: "p0" }, { userId: "u1" }] } };
      return { data: { user: { profile: { givenName: "maria", surname: "silva" } } } };
    },
  };
  const name = await fetchSunshineName("conv_1", { axios, env: ENV });
  assert.equal(name, "Maria S.");
  assert.equal(urls[0].url, "https://sub.zendesk.com/sc/v2/apps/app1/conversations/conv_1/participants");
  assert.equal(urls[1].url, "https://sub.zendesk.com/sc/v2/apps/app1/users/u1");
  assert.deepEqual(urls[0].options.auth, { username: "kid", password: "sec" });
  assert.ok(urls[0].options.timeout > 0);
});

test("Sunshine: sem credenciais ou sem participante com id devolve null", async () => {
  const axios = { get: async () => ({ data: { participants: [{ id: "p0" }] } }) };
  assert.equal(await fetchSunshineName("c", { axios, env: {} }), null);
  assert.equal(await fetchSunshineName("c", { axios, env: ENV }), null);
});

test("gravação: Sunshine sobrescreve; Troque só preenche se não houver nome", async () => {
  const db = fakeDb();
  await saveContactName({ conversationId: "c1", displayName: "Maria S.", source: "sunshine" }, { db });
  await saveContactName({ conversationId: "c1", displayName: "Maria", source: "troque" }, { db });
  assert.match(db.calls[0].text, /name_source = 'sunshine'/);
  assert.ok(!/where conversation_contacts\.display_name is null/.test(db.calls[0].text));
  assert.match(db.calls[1].text, /where conversation_contacts\.display_name is null/);
  assert.deepEqual(db.calls[0].params, ["c1", "Maria S."]);
  assert.ok(!db.calls[0].text.includes("Maria"), "nome só como parâmetro");

  assert.equal(await saveContactName({ conversationId: "c1", displayName: null, source: "sunshine" }, { db }), false);
  assert.equal(await saveContactName({ conversationId: "c1", displayName: "Ana", source: "troque" }, { db: { getPool: () => null } }), false);
  assert.equal(db.calls.length, 2);
});

test("best-effort: falha não lança e o log não leva nome nem resposta da API", async (t) => {
  const logs = [];
  const original = console.error;
  console.error = (m) => logs.push(String(m));
  t.after(() => (console.error = original));

  const db = fakeDb();
  const axios = { get: async () => { throw Object.assign(new Error("Maria Silva 123"), { code: "ECONNRESET", response: { data: { nome: "Maria" } } }); } };
  assert.equal(await rememberSunshineName("c1", { axios, env: ENV, db }), false);
  assert.equal(db.calls.length, 0);

  const failing = { getPool: () => ({}), query: async () => { throw Object.assign(new Error("Maria Silva"), { code: "08006" }); } };
  assert.equal(await rememberTroqueName("c1", "Maria", { db: failing }), false);
  assert.ok(logs.length >= 2 && logs.every((m) => !/Maria|Silva|123/.test(m)));

  // sem banco, nem consulta a Sunshine
  let called = false;
  assert.equal(await rememberSunshineName("c1", { axios: { get: async () => { called = true; } }, env: ENV, db: { getPool: () => null } }), false);
  assert.equal(called, false);
});

test("Troque: primeiro nome vira nome de exibição sem sobrenome", async () => {
  const db = fakeDb();
  assert.equal(await rememberTroqueName("c1", "carlos", { db }), true);
  assert.deepEqual(db.calls[0].params, ["c1", "Carlos"]);
  assert.equal(await rememberTroqueName("c1", null, { db }), false);
});
