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
