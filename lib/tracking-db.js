// ======================================================
// GRAVAÇÃO DOS EVENTOS NO POSTGRES (sink em lote)
// ======================================================
// Os eventos entram numa fila em memória e vão para flow_events em lote: a cada
// 2 s ou quando a fila chega a 50 linhas. O stdout continua recebendo cada
// evento (gravação dupla). Sem DATABASE_URL nada disso é ligado.
//
// - Fila máxima de 5000: ao estourar, descarta as mais antigas e conta.
// - Falha ao gravar: 3 tentativas com espera crescente; se ainda falhar, o lote
//   volta para o início da fila e a próxima rodada tenta de novo. Erro de dado
//   (SQLSTATE 22/23) descarta o lote, para uma linha ruim não travar o resto.
// - Nunca grava IP, user-agent nem texto livre: só o que buildRecord já filtrou.
// - Nunca vai para o log: parâmetros, mensagem de erro nem string de conexão.

const { setSink } = require("./tracking");

const COLUMNS = [
  "ts", "session_id", "send_id", "conversation_id", "brand", "flow", "source",
  "channel", "seq", "step", "event", "duration_ms", "error_code", "meta",
];

const DEFAULTS = {
  intervalMs: 2000,
  maxBatch: 50,
  maxQueue: 5000,
  attempts: 3,
  backoffMs: 250,
  shutdownTimeoutMs: 5000,
  dropLogEveryMs: 10000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordToRow(record) {
  return [
    record.ts,
    record.session_id ?? null,
    record.send_id ?? null,
    record.conversation_id ?? null,
    record.brand ?? null,
    record.flow ?? null,
    record.source === "client" ? "client" : "server",
    record.channel ?? null,
    record.seq ?? null,
    record.step ?? null,
    record.event,
    record.duration_ms ?? null,
    record.error_code ?? null,
    record.meta ? JSON.stringify(record.meta) : null,
  ];
}

// INSERT parametrizado de várias linhas (valores nunca entram no texto do SQL)
function buildInsert(rows) {
  const width = COLUMNS.length;
  const params = [];
  const tuples = rows.map((row, i) => {
    params.push(...row);
    const marks = row.map((_, j) => {
      const n = i * width + j + 1;
      return j === width - 1 ? `$${n}::jsonb` : `$${n}`;
    });
    return `(${marks.join(", ")})`;
  });
  return { text: `insert into flow_events (${COLUMNS.join(", ")}) values ${tuples.join(", ")}`, params };
}

// Erro de dado ou de integridade: repetir não adianta
function isPermanentError(error) {
  const code = String(error?.code || "");
  return code.startsWith("22") || code.startsWith("23");
}

function createTrackingDb({ db, options = {}, sleepFn = sleep, logger = console } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let queue = [];
  let dropped = 0;
  let written = 0;
  let flushing = null;
  let timer = null;
  let lastDropLog = 0;

  function noteDrop(count) {
    dropped += count;
    const now = Date.now();
    if (now - lastDropLog >= cfg.dropLogEveryMs) {
      lastDropLog = now;
      logger.error(`Rastreamento DB: ${dropped} evento(s) descartado(s) no total`);
    }
  }

  function trim() {
    const excess = queue.length - cfg.maxQueue;
    if (excess > 0) {
      queue = queue.slice(excess);
      noteDrop(excess);
    }
  }

  // Grava um lote com até `attempts` tentativas; true se gravou ou descartou de vez
  async function writeBatch(batch) {
    const { text, params } = buildInsert(batch.map(recordToRow));
    for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
      try {
        await db.query(text, params);
        written += batch.length;
        return true;
      } catch (error) {
        if (isPermanentError(error)) {
          noteDrop(batch.length);
          return true;
        }
        if (attempt < cfg.attempts) await sleepFn(cfg.backoffMs * 2 ** (attempt - 1));
      }
    }
    return false;
  }

  async function drain() {
    while (queue.length > 0) {
      const batch = queue.splice(0, cfg.maxBatch);
      const ok = await writeBatch(batch);
      if (!ok) {
        // Devolve o lote ao início da fila e espera a próxima rodada
        queue = batch.concat(queue);
        trim();
        return;
      }
    }
  }

  // Uma rodada por vez; chamadas durante uma rodada esperam por ela
  function flush() {
    if (flushing) return flushing;
    flushing = drain()
      .catch(() => {})
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  function enqueue(record) {
    queue.push(record);
    trim();
    if (queue.length >= cfg.maxBatch && !flushing) flush();
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (queue.length > 0) flush();
    }, cfg.intervalMs);
    timer.unref?.();
  }

  // Para o relógio e grava o que sobrou (limitado por shutdownTimeoutMs)
  async function close() {
    if (timer) clearInterval(timer);
    timer = null;
    let timeout;
    const limit = new Promise((resolve) => {
      timeout = setTimeout(resolve, cfg.shutdownTimeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          while (queue.length > 0 || flushing) {
            const before = queue.length;
            await flush();
            if (queue.length >= before && queue.length > 0) break; // sem progresso (banco fora)
          }
        })(),
        limit,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (queue.length > 0) noteDrop(queue.length);
    queue = [];
  }

  return {
    enqueue,
    flush,
    start,
    close,
    stats: () => ({ queued: queue.length, dropped, written }),
  };
}

// Liga a gravação dupla (stdout + Postgres). Devolve null sem DATABASE_URL.
function installTrackingDb({ db = require("./db"), options, processRef = process, logger = console } = {}) {
  if (!db.getPool()) return null;

  const writer = createTrackingDb({ db, options, logger });
  writer.start();
  setSink((record) => {
    console.log(JSON.stringify(record)); // stdout continua igual
    writer.enqueue(record);
  });

  let closing = false;
  const onSignal = async (signal) => {
    if (closing) return;
    closing = true;
    try {
      await writer.close();
      await db.close();
    } catch {
      // desligando: nada a fazer
    }
    // Registrar o ouvinte tira o encerramento padrão do sinal: sair aqui
    processRef.exit(signal === "SIGINT" ? 130 : 0);
  };
  processRef.once("SIGTERM", () => onSignal("SIGTERM"));
  processRef.once("SIGINT", () => onSignal("SIGINT"));

  return writer;
}

module.exports = { createTrackingDb, installTrackingDb, buildInsert, recordToRow, isPermanentError, COLUMNS, DEFAULTS };
