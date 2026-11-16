const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { createConversationClient } = require("../lib/zendesk/conversation");
const { handoffMessage } = require("../lib/reverse/messages");

function fakeHttp() {
  const calls = [];
  return { calls, post: async (url, data, config) => (calls.push({ url, data, config }), { data: { messages: [{ id: "m1" }] } }) };
}

test.beforeEach((t) => {
  t.restoreEnv = useFakeEnv({ ZENDESK_SUBDOMAIN: "exemplo", ZENDESK_APP_ID: "app", ZENDESK_KEY_ID: "key", ZENDESK_SECRET: "segredo-falso", REVERSE_HANDOFF_BUTTON_TYPE: undefined, REVERSE_HANDOFF_BUTTON_TEXT: undefined, REVERSE_HANDOFF_PAYLOAD: undefined });
});
test.afterEach((t) => t.restoreEnv());

test("postHandoff: botão de resposta rápida por padrão", async () => {
  const http = fakeHttp();
  await createConversationClient({ http }).postHandoff("conv1", "texto");
  const { url, data } = http.calls[0];
  assert.match(url, /\/sc\/v2\/apps\/app\/conversations\/conv1\/messages$/);
  assert.deepEqual(data.content.actions, [{ type: "reply", text: "Falar com atendente", payload: "REVERSE_HANDOFF" }]);
  assert.equal(data.author.type, "business");
});

test("postHandoff: tipo, texto e payload configuráveis; tipo inválido volta ao padrão", async () => {
  process.env.REVERSE_HANDOFF_BUTTON_TYPE = "postback";
  process.env.REVERSE_HANDOFF_BUTTON_TEXT = "Quero um atendente";
  process.env.REVERSE_HANDOFF_PAYLOAD = "ESCALAR";
  const http = fakeHttp();
  await createConversationClient({ http }).postHandoff("conv1", "texto");
  assert.deepEqual(http.calls[0].data.content.actions, [{ type: "postback", text: "Quero um atendente", payload: "ESCALAR" }]);

  process.env.REVERSE_HANDOFF_BUTTON_TYPE = "link";
  await createConversationClient({ http }).postHandoff("conv1", "texto");
  assert.equal(http.calls[1].data.content.actions[0].type, "reply");
});

test("handoffMessage: texto por motivo, com pedido opcional", () => {
  assert.match(handoffMessage("PHOTO_REQUIRED"), /fotos/);
  assert.match(handoffMessage("DESCONHECIDO"), /não foi possível concluir/i);
  assert.match(handoffMessage("REASON", { orderNumber: "1000-01" }), /Pedido: 1000-01\./);
  assert.doesNotMatch(handoffMessage("REASON"), /Pedido:/);
});

// ---------- Imagens do cliente (bot do WhatsApp) ----------

function message(id, type, received, content = {}) {
  return { id, author: { type }, received: new Date(received).toISOString(), content };
}

test("listCustomerImages: só imagens do cliente desde o pedido, paginando para trás", async () => {
  const since = Date.parse("2026-11-16T12:00:00Z");
  const pages = [
    {
      messages: [
        message("a", "user", since + 1000, { type: "image", mediaUrl: "https://exemplo.zendesk.com/a.jpg", mediaType: "image/jpeg" }),
        message("b", "business", since + 2000, { type: "image", mediaUrl: "https://exemplo.zendesk.com/b.jpg" }),
        message("c", "user", since + 3000, { type: "text", text: "pronto" }),
        message("d", "user", since + 4000, { type: "file", mediaUrl: "https://exemplo.zendesk.com/d.png", mediaType: "image/png" }),
      ],
      meta: { hasMore: true, beforeCursor: "cur1" },
    },
    {
      messages: [
        message("velha", "user", since - 5000, { type: "image", mediaUrl: "https://exemplo.zendesk.com/velha.jpg" }),
        message("e", "user", since + 500, { type: "image", mediaUrl: "https://exemplo.zendesk.com/e.jpg" }),
      ],
      meta: { hasMore: true, beforeCursor: "cur2" },
    },
  ];
  const calls = [];
  const http = { get: async (url, config) => (calls.push({ url, config }), { data: pages[calls.length - 1] }) };

  const images = await createConversationClient({ http }).listCustomerImages("conv1", { sinceMs: since });

  assert.deepEqual(images.map((i) => i.id), ["e", "a", "d"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].config.params, { "page[before]": "cur1" });
  assert.deepEqual(calls[0].config.auth, { username: "key", password: "segredo-falso" });
});

test("downloadMedia: sem credencial primeiro; credencial só no próprio subdomínio", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  const calls = [];
  const denied = Object.assign(new Error("401"), { response: { status: 401 } });
  const http = {
    get: async (url, config) => {
      calls.push({ url, auth: config.auth || null });
      if (!config.auth) throw denied;
      return { status: 200, data: jpeg };
    },
  };
  const client = createConversationClient({ http });

  assert.deepEqual(await client.downloadMedia("https://exemplo.zendesk.com/sc/attachments/x.jpg"), jpeg);
  assert.equal(calls[0].auth, null);
  assert.deepEqual(calls[1].auth, { username: "key", password: "segredo-falso" });

  // Outro domínio: a credencial nunca é enviada
  calls.length = 0;
  await assert.rejects(client.downloadMedia("https://outro-site.com/x.jpg"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, null);
});

test("downloadMedia: redirecionamento depois da credencial segue sem ela", async () => {
  const calls = [];
  const http = {
    get: async (url, config) => {
      calls.push({ url, auth: config.auth || null });
      if (url.includes("zendesk") && !config.auth) throw Object.assign(new Error("403"), { response: { status: 403 } });
      if (config.auth) return { status: 302, headers: { location: "https://armazenamento.exemplo.com/x.jpg?assinado=1" }, data: Buffer.alloc(0) };
      return { status: 200, data: Buffer.from("ok") };
    },
  };
  const result = await createConversationClient({ http }).downloadMedia("https://exemplo.zendesk.com/sc/attachments/x.jpg");
  assert.equal(result.toString(), "ok");
  assert.equal(calls[2].url, "https://armazenamento.exemplo.com/x.jpg?assinado=1");
  assert.equal(calls[2].auth, null);
});
