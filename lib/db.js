// ======================================================
// BANCO DE ACOMPANHAMENTO (Postgres do Supabase, via pg)
// ======================================================
// Compatível com o pooler em modo transação (porta 6543): sem prepared
// statements nomeados, sem SET de sessão, sem LISTEN/NOTIFY e sem advisory
// locks de sessão. Sem DATABASE_URL o pool não existe (getPool() = null) e o
// resto do app segue normal: o rastreamento fica só no console.
// Nunca vai para o log: a string de conexão, os parâmetros nem a mensagem do
// erro (o pg pode repetir valores da consulta nela). Só o código do erro.

const { Pool } = require("pg");

const PING_TIMEOUT_MS = 3000;

class DbDisabledError extends Error {
  constructor() {
    super("Banco não configurado");
    this.code = "DB_DISABLED";
  }
}

function errorLabel(error) {
  return error?.code || error?.name || "erro";
}

// PoolClass e env existem para os testes injetarem um pool falso
function createDb({ env = process.env, PoolClass = Pool } = {}) {
  let pool; // undefined = ainda não criado; null = sem DATABASE_URL

  function getPool() {
    if (pool !== undefined) return pool;
    const connectionString = env.DATABASE_URL;
    if (!connectionString) {
      pool = null;
      return pool;
    }
    pool = new PoolClass({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    });
    // Sem este ouvinte, uma conexão ociosa derrubada pelo servidor matava o processo
    pool.on("error", (error) => console.error(`DB: erro em conexão ociosa (${errorLabel(error)})`));
    return pool;
  }

  async function query(text, params) {
    const current = getPool();
    if (!current) throw new DbDisabledError();
    try {
      return await current.query(text, params);
    } catch (error) {
      console.error(`DB: falha na consulta (${errorLabel(error)})`);
      throw error;
    }
  }

  // select 1 com limite de 3 s; devolve os milissegundos gastos
  async function ping() {
    const started = Date.now();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Tempo esgotado"), { code: "DB_TIMEOUT" })), PING_TIMEOUT_MS);
    });
    try {
      await Promise.race([query("select 1"), timeout]);
      return Date.now() - started;
    } finally {
      clearTimeout(timer);
    }
  }

  async function close() {
    const current = pool;
    pool = undefined;
    if (current) await current.end();
  }

  return { getPool, query, ping, close };
}

const defaultDb = createDb();

module.exports = { ...defaultDb, createDb, DbDisabledError };
