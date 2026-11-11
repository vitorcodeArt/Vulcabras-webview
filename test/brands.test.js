const test = require("node:test");
const assert = require("node:assert/strict");
const { useFakeEnv } = require("./helpers");
const { getBrand, normalizeBrandKey, toPublicBrand, getBrandStatus, logBrandStatus } = require("../lib/brands");

test("normaliza a chave da marca", () => {
  assert.equal(normalizeBrandKey(" UnderArmour "), "underarmour");
  assert.equal(normalizeBrandKey("mizuno"), "mizuno");
  assert.equal(normalizeBrandKey("adidas"), null);
  assert.equal(normalizeBrandKey(undefined), null);
  assert.equal(normalizeBrandKey("__proto__"), null);
});

test("lê token do Troque e brand_id do Zendesk do ambiente", (t) => {
  t.after(useFakeEnv());
  const brand = getBrand("underarmour");
  assert.equal(brand.label, "Under Armour");
  assert.equal(brand.troqueToken, "token-falso-underarmour");
  assert.equal(brand.zendeskBrandId, 123);
  assert.equal(brand.zendeskTag, "marca_underarmour");

  const mizuno = getBrand("mizuno");
  assert.equal(mizuno.troqueToken, null);
  assert.equal(mizuno.zendeskBrandId, null);
});

test("brand_id não numérico é tratado como ausente", (t) => {
  t.after(useFakeEnv({ ZENDESK_BRAND_ID_UNDERARMOUR: "abc" }));
  assert.equal(getBrand("underarmour").zendeskBrandId, null);
});

test("versão pública não expõe segredos", (t) => {
  t.after(useFakeEnv());
  assert.deepEqual(toPublicBrand(getBrand("underarmour")), { key: "underarmour", label: "Under Armour" });
  assert.equal(toPublicBrand(null), null);
});

test("log de inicialização não mostra valores", (t) => {
  t.after(useFakeEnv());
  const lines = [];
  logBrandStatus({ log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("token-falso"));
  assert.ok(!lines[0].includes("123"));
  assert.ok(lines[0].includes("underarmour (troque: ok"));
  assert.deepEqual(getBrandStatus().find((s) => s.brand === "mizuno"), { brand: "mizuno", troque: false, zendeskBrandId: false });
});
