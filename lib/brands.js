// ======================================================
// MARCAS (Mizuno, Olympikus, Under Armour)
// ======================================================
// Mapeia o parâmetro ?store= para o rótulo da marca, o token do Troque e o
// brand_id do Zendesk. Os valores são lidos do ambiente a cada chamada, para
// que os testes possam ajustar process.env sem recarregar o módulo.

const BRAND_DEFINITIONS = {
  mizuno: { label: "Mizuno", envPrefix: "MIZUNO", tag: "marca_mizuno" },
  olympikus: { label: "Olympikus", envPrefix: "OLYMPIKUS", tag: "marca_olympikus" },
  underarmour: { label: "Under Armour", envPrefix: "UNDERARMOUR", tag: "marca_underarmour" },
};

const BRAND_KEYS = Object.keys(BRAND_DEFINITIONS);

// Normaliza o valor recebido (ex.: "Mizuno " -> "mizuno"); devolve null se inválido
function normalizeBrandKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BRAND_DEFINITIONS, key) ? key : null;
}

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Configuração completa da marca (contém segredos: uso exclusivo do servidor)
function getBrand(value) {
  const key = normalizeBrandKey(value);
  if (!key) return null;

  const def = BRAND_DEFINITIONS[key];
  const zendeskBrandId = readEnv(`ZENDESK_BRAND_ID_${def.envPrefix}`);

  return {
    key,
    label: def.label,
    zendeskTag: def.tag,
    troqueToken: readEnv(`TROQUE_${def.envPrefix}_TOKEN`),
    zendeskBrandId: zendeskBrandId && /^\d+$/.test(zendeskBrandId) ? Number(zendeskBrandId) : null,
  };
}

// Versão segura para enviar ao navegador (sem tokens nem IDs internos)
function toPublicBrand(brand) {
  return brand ? { key: brand.key, label: brand.label } : null;
}

// Resumo do que está configurado por marca, sem expor valores
function getBrandStatus() {
  return BRAND_KEYS.map((key) => {
    const brand = getBrand(key);
    return {
      brand: key,
      troque: Boolean(brand.troqueToken),
      zendeskBrandId: Boolean(brand.zendeskBrandId),
    };
  });
}

function logBrandStatus(logger = console) {
  const status = getBrandStatus()
    .map((s) => `${s.brand} (troque: ${s.troque ? "ok" : "ausente"}, zendesk brand_id: ${s.zendeskBrandId ? "ok" : "ausente"})`)
    .join("; ");
  logger.log(`Troca/Devolução - marcas: ${status}`);
}

module.exports = {
  BRAND_KEYS,
  normalizeBrandKey,
  getBrand,
  toPublicBrand,
  getBrandStatus,
  logBrandStatus,
};
