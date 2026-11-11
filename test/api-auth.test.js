const test = require("node:test");
const assert = require("node:assert/strict");
const { requireApiSecret } = require("../lib/apiAuth");

function run(headers = {}) {
  const req = { get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };
  let passed = false;
  requireApiSecret("TEST_API_SECRET")(req, res, () => (passed = true));
  return { passed, status: res.statusCode };
}

test("sem a variável definida, o endpoint continua aberto (compatibilidade)", () => {
  delete process.env.TEST_API_SECRET;
  assert.equal(run().passed, true);
});

test("com a variável definida, exige o segredo no header", (t) => {
  process.env.TEST_API_SECRET = "segredo-do-bot";
  t.after(() => delete process.env.TEST_API_SECRET);

  assert.deepEqual(run(), { passed: false, status: 401 });
  assert.deepEqual(run({ "x-api-secret": "errado" }), { passed: false, status: 401 });
  assert.equal(run({ "x-api-secret": "segredo-do-bot" }).passed, true);
  assert.equal(run({ authorization: "Bearer segredo-do-bot" }).passed, true);
});
