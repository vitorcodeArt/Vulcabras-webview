// ======================================================
// MIGRAÇÕES DO BANCO (npm run migrate)
// ======================================================
// Aplica, em ordem alfabética, cada arquivo de db/migrations/*.sql que ainda
// não está em schema_migrations, um por transação. Pode rodar quantas vezes
// quiser: o que já foi aplicado é pulado. Nunca imprime DATABASE_URL.
// Sem advisory lock (o pooler em modo transação não segura lock de sessão): se
// duas execuções colidirem, a chave primária de schema_migrations faz uma
// delas falhar e desfazer a transação.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIR = path.join(__dirname, "..", "db", "migrations");

function listMigrations(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".sql")).sort();
}

// Erros do servidor (SQLSTATE de 5 caracteres) trazem uma mensagem útil e sem
// dado do cliente; os demais (rede, DNS) podem citar o host, então só o código
function describeError(error) {
  const code = error?.code || error?.name || "erro";
  return /^[0-9A-Z]{5}$/.test(String(error?.code)) ? `${code}: ${error.message}` : code;
}

async function runMigrations({ pool, dir = DEFAULT_DIR, log = console.log }) {
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");

  const files = listMigrations(dir);
  if (files.length === 0) {
    log("Nenhuma migração encontrada em db/migrations.");
    return { applied: [], skipped: [] };
  }

  const done = new Set((await pool.query("select name from schema_migrations")).rows.map((row) => row.name));
  const applied = [];
  const skipped = [];

  for (const name of files) {
    if (done.has(name)) {
      skipped.push(name);
      log(`Já aplicada: ${name}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [name]);
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // a conexão já caiu: o servidor desfaz a transação sozinho
      }
      error.migration = name;
      throw error;
    } finally {
      client.release();
    }
    applied.push(name);
    log(`Aplicada: ${name}`);
  }

  log(`Pronto: ${applied.length} aplicada(s), ${skipped.length} já estava(m) aplicada(s).`);
  return { applied, skipped };
}

async function main() {
  require("dotenv").config();
  const db = require("../lib/db");
  const pool = db.getPool();
  if (!pool) {
    console.error("DATABASE_URL não definida: nada a fazer.");
    process.exit(1);
  }
  try {
    await runMigrations({ pool });
  } catch (error) {
    console.error(`Falha${error.migration ? ` em ${error.migration}` : ""}: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { runMigrations, listMigrations, describeError };
