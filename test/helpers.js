// Utilitários dos testes: ambiente com valores fictícios (nunca segredos reais)

const FAKE_ENV = {
  FLOW_SESSION_SECRET: "segredo-de-teste-com-mais-de-32-caracteres",
  FLOW_SESSION_TTL_MINUTES: "60",
  FLOW_HASH_SALT: "sal-de-teste",
  TROQUE_UNDERARMOUR_TOKEN: "token-falso-underarmour",
  TROQUE_MIZUNO_TOKEN: "",
  TROQUE_OLYMPIKUS_TOKEN: "",
  ZENDESK_BRAND_ID_UNDERARMOUR: "123",
  ZENDESK_BRAND_ID_MIZUNO: "",
  ZENDESK_BRAND_ID_OLYMPIKUS: "",
};

// Aplica o ambiente fictício e devolve uma função que restaura o original
function useFakeEnv(overrides = {}) {
  const values = { ...FAKE_ENV, ...overrides };
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

module.exports = { useFakeEnv };
