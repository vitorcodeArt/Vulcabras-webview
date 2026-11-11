const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { detectImageType, groupFiles } = require("../lib/reverse/photos");
const { createTokenProvider } = require("../lib/zendesk/oauth");
const { createTicketsClient } = require("../lib/zendesk/tickets");
const { createZendeskAttachmentStorage } = require("../lib/storage/zendeskAttachments");
const { getBrand } = require("../lib/brands");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.from("RIFF0000WEBPVP8 ", "ascii");

test.beforeEach((t) => {
  t.restoreEnv = useFakeEnv({
    ZENDESK_SUBDOMAIN: "exemplo",
    ZENDESK_OAUTH_CLIENT_ID: "cliente-falso",
    ZENDESK_OAUTH_CLIENT_SECRET: "segredo-falso",
    ZENDESK_OAUTH_SCOPES: undefined,
    ZENDESK_TICKET_FORM_ID_UNDERARMOUR: "58511545091099",
    ZENDESK_TICKET_ASSIGNEE_ID: undefined,
    ZENDESK_TICKET_SUBJECT: undefined,
    REVERSE_PHOTOS_ENABLED: "true",
  });
});
test.afterEach((t) => t.restoreEnv());

test("tipo da imagem pela assinatura, não pelo nome", () => {
  assert.equal(detectImageType(JPEG), "image/jpeg");
  assert.equal(detectImageType(PNG), "image/png");
  assert.equal(detectImageType(WEBP), "image/webp");
  assert.equal(detectImageType(Buffer.from("<svg onload=alert(1)>  ")), null);
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
});

test("groupFiles: agrupa por item, recusa campo estranho, arquivo inválido e excesso", () => {
  const grouped = groupFiles([
    { fieldname: "photos_0", buffer: JPEG },
    { fieldname: "photos_0", buffer: PNG },
    { fieldname: "photos_1", buffer: WEBP },
  ]);
  assert.deepEqual(Object.keys(grouped), ["0", "1"]);
  assert.equal(grouped[0][1].mime, "image/png");

  assert.throws(() => groupFiles([{ fieldname: "outro", buffer: JPEG }]), { code: "PHOTO_INVALID" });
  assert.throws(() => groupFiles([{ fieldname: "photos_0", buffer: Buffer.from("texto qualquer!") }]), { code: "PHOTO_INVALID", field: "items[0].photos" });
  assert.throws(() => groupFiles(Array.from({ length: 11 }, () => ({ fieldname: "photos_0", buffer: JPEG }))), { code: "PHOTO_INVALID" });
});

test("oauth: client_credentials, cache, renovação única em paralelo e forceRefresh", async () => {
  let time = 0;
  const posts = [];
  const http = {
    post: async (url, data) => {
      posts.push({ url, data });
      return { status: 200, data: { access_token: `tok${posts.length}`, expires_in: 1800 } };
    },
  };
  const provider = createTokenProvider({ http, now: () => time });

  const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  assert.equal(a, "tok1");
  assert.equal(b, "tok1");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://exemplo.zendesk.com/oauth/tokens");
  assert.deepEqual(posts[0].data, { grant_type: "client_credentials", client_id: "cliente-falso", client_secret: "segredo-falso", scope: "read write" });

  assert.equal(await provider.getAccessToken(), "tok1");
  time = 1800 * 1000; // passou da validade (com margem)
  assert.equal(await provider.getAccessToken(), "tok2");
  assert.equal(await provider.getAccessToken({ forceRefresh: true }), "tok3");
});

test("oauth: falha não expõe o corpo da resposta", async () => {
  const http = { post: async () => ({ status: 400, data: { error: "invalid_client", detail: "segredo-falso" } }) };
  await assert.rejects(createTokenProvider({ http }).getAccessToken(), (error) => error.code === "ZENDESK_OAUTH_FAILED" && !error.message.includes("segredo"));
});

function fakeTicketsHttp(responses) {
  const calls = [];
  return {
    calls,
    request: async (config) => {
      calls.push(config);
      const next = responses.shift();
      return typeof next === "function" ? next(config) : next;
    },
  };
}

test("tickets: 401 renova o token uma vez; ticket resolvido com formulário, marca, nota interna e tags", async () => {
  const tokens = [];
  const tokenProvider = { getAccessToken: async ({ forceRefresh }) => (tokens.push(forceRefresh), forceRefresh ? "novo" : "velho") };
  const http = fakeTicketsHttp([{ status: 401, data: {} }, { status: 201, data: { ticket: { id: 99 } } }]);
  const client = createTicketsClient({ http, tokenProvider });

  const { ticketId } = await client.createTicket({ brandKey: "underarmour", body: "texto", uploadToken: "up1", idempotencyKey: "k1" });
  assert.equal(ticketId, 99);
  assert.deepEqual(tokens, [false, true]);

  const { url, data, headers } = http.calls[1];
  assert.equal(url, "https://exemplo.zendesk.com/api/v2/tickets");
  assert.equal(headers.Authorization, "Bearer novo");
  assert.equal(headers["Idempotency-Key"], "k1");
  assert.equal(data.ticket.status, "solved");
  assert.equal(data.ticket.ticket_form_id, 58511545091099);
  assert.equal(data.ticket.brand_id, getBrand("underarmour").zendeskBrandId);
  assert.deepEqual(data.ticket.comment, { body: "texto", public: false, uploads: ["up1"] });
  assert.deepEqual(data.ticket.tags, ["troca_devolucao_webview", "marca_underarmour"]);
  assert.equal(data.ticket.subject, "Troca/Devolução via webview");
});

test("tickets: marca sem brand_id não cria nada", async () => {
  const http = fakeTicketsHttp([]);
  const client = createTicketsClient({ http, tokenProvider: { getAccessToken: async () => "t" } });
  await assert.rejects(client.createTicket({ brandKey: "mizuno", body: "x" }), { code: "ZENDESK_BRAND_NOT_CONFIGURED" });
  assert.equal(http.calls.length, 0);
});

test("armazenamento: uploads encadeados, ticket e URLs ligadas ao SKU pelo nome do arquivo", async () => {
  const calls = [];
  const tickets = {
    upload: async ({ filename, token }) => (calls.push(["upload", filename, token]), { token: "up1" }),
    discardUpload: async () => {},
    createTicket: async (input) => (calls.push(["ticket", input.uploadToken]), { ticketId: 7 }),
    firstCommentAttachments: async () => [
      { file_name: "SKU_1-1.jpg", content_url: "https://exemplo.zendesk.com/attachments/a" },
      { file_name: "SKU_1-2.png", content_url: "https://exemplo.zendesk.com/attachments/b" },
    ],
    addInternalNote: async () => {},
  };
  const storage = createZendeskAttachmentStorage({ tickets });
  assert.equal(storage.isEnabled(getBrand("underarmour")), true);

  const result = await storage.store({
    brandKey: "underarmour",
    ticketBody: "x",
    photosBySku: { "SKU/1": [{ buffer: JPEG, mime: "image/jpeg" }, { buffer: PNG, mime: "image/png" }] },
  });
  assert.deepEqual(calls, [["upload", "SKU_1-1.jpg", null], ["upload", "SKU_1-2.png", "up1"], ["ticket", "up1"]]);
  assert.deepEqual(result, { ticketId: 7, urlsBySku: { "SKU/1": ["https://exemplo.zendesk.com/attachments/a", "https://exemplo.zendesk.com/attachments/b"] } });
});

test("armazenamento: desligado sem a flag, sem OAuth ou sem brand_id", () => {
  const storage = createZendeskAttachmentStorage({ tickets: {} });
  process.env.REVERSE_PHOTOS_ENABLED = "false";
  assert.equal(storage.isEnabled(getBrand("underarmour")), false);
  process.env.REVERSE_PHOTOS_ENABLED = "true";
  assert.equal(storage.isEnabled(getBrand("mizuno")), false);
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  assert.equal(storage.isEnabled(getBrand("underarmour")), false);
});
