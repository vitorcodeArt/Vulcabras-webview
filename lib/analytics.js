// ======================================================
// CONSULTAS DA API DE ACOMPANHAMENTO (/api/analytics)
// ======================================================
// Segue docs/api-contract.md. Só lê: v_sends, v_flow_sessions e flow_events.
// Toda consulta é parametrizada ($1, $2...): valores do usuário nunca entram no
// texto do SQL. Datas em America/Sao_Paulo (from/to inclusivos).

const { normalizeBrandKey } = require("./brands");
const { FLOWS } = require("./session");
const { sanitizeMeta, maskSensitive, hashOrderNumber, trackSearchTerms } = require("./tracking");
const { normalizeOrderNumber } = require("./reverse/validation");
const labels = require("./analytics-labels");

const TZ = "America/Sao_Paulo";
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RAW_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const MAX_EXPORT_ROWS = 50000;
const TOP_LIMIT = 20;
const SMALL_TOP_LIMIT = 10;
const MAX_EVENTS = 1000;

const REVERSE_STEPS = ["start", "identify", "items", "reasons", "address", "retention", "shipping", "refund", "summary", "result"];
const CATALOG_STEPS = ["categories", "products", "details"];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new ApiError(400, "BAD_REQUEST", message);
const notFound = (message = "Não encontrado") => new ApiError(404, "NOT_FOUND", message);

// ---------- Parâmetros ----------

function todayInSp(nowMs) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

function dayToUtcMs(day) {
  const [y, m, d] = day.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  // Recusa datas que não existem (2026-02-31)
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? ms : null;
}

const msToDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Parâmetro repetido (?from=a&from=b ou from[]=a) não é aceito
function one(value) {
  if (Array.isArray(value)) throw badRequest("Parâmetro repetido.");
  return value;
}

function parsePeriod(query, nowMs) {
  const rawFrom = one(query.from);
  const rawTo = one(query.to);
  const today = todayInSp(nowMs);

  const to = rawTo === undefined || rawTo === "" ? today : rawTo;
  if (typeof to !== "string" || !DAY.test(to) || dayToUtcMs(to) === null) throw badRequest("Data final inválida. Use AAAA-MM-DD.");
  const toMs = dayToUtcMs(to);

  let from = rawFrom;
  if (from === undefined || from === "") {
    from = msToDay(toMs - (DEFAULT_RANGE_DAYS - 1) * 86400000);
  } else if (typeof from !== "string" || !DAY.test(from) || dayToUtcMs(from) === null) {
    throw badRequest("Data inicial inválida. Use AAAA-MM-DD.");
  }
  const fromMs = dayToUtcMs(from);

  if (fromMs > toMs) throw badRequest("A data inicial não pode ser depois da final.");
  if ((toMs - fromMs) / 86400000 + 1 > MAX_RANGE_DAYS) throw badRequest(`O período máximo é de ${MAX_RANGE_DAYS} dias.`);
  return { from, to, fromMs, toMs };
}

function parseBrand(query) {
  const raw = one(query.brand);
  if (raw === undefined || raw === "") return null;
  const key = typeof raw === "string" ? normalizeBrandKey(raw) : null;
  if (!key) throw badRequest("Marca inválida.");
  return key;
}

function parseFlow(query, { required = false, allowed = FLOWS } = {}) {
  const raw = one(query.flow);
  if (raw === undefined || raw === "") {
    if (required) throw badRequest("O parâmetro flow é obrigatório.");
    return null;
  }
  if (typeof raw !== "string" || !allowed.includes(raw)) throw badRequest("Fluxo inválido.");
  return raw;
}

function parseEnum(query, name, values) {
  const raw = one(query[name]);
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !values.includes(raw)) throw badRequest(`Parâmetro ${name} inválido.`);
  return raw;
}

function parseLimit(query) {
  const raw = one(query.limit);
  if (raw === undefined || raw === "") return 50;
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n < 1 || n > 100) throw badRequest("limit deve estar entre 1 e 100.");
  return n;
}

// ---------- Cursor (sent_at com microssegundos + send_id) ----------

function encodeCursor(raw, id) {
  return Buffer.from(JSON.stringify([raw, id])).toString("base64url");
}

function decodeCursor(value) {
  try {
    const [raw, id] = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof raw === "string" && RAW_TS.test(raw) && typeof id === "string" && UUID.test(id)) return { raw, id };
  } catch {
    // cai no erro abaixo
  }
  throw badRequest("Cursor inválido.");
}

// ---------- Formatação ----------

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);
const int = (value) => (value === null || value === undefined ? null : Number(value));
const rate = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Status mostrado: no rastreamento não existe etapa final, então a sessão aberta
// (que o banco marca como em andamento/abandonou) conta como concluída (contrato, seção 2)
const EFF_STATUS = `case when v.flow = 'tracking' and v.click_status = 'clicked' and v.session_status in ('in_progress', 'abandoned') then 'completed' else v.session_status end`;

function mapSend(row) {
  const status = row.click_status === "clicked" ? row.eff_status : row.click_status;
  return {
    send_id: row.send_id,
    sent_at: iso(row.sent_at),
    conversation_id: row.conversation_id,
    customer_name: row.customer_name ?? null,
    brand: row.brand,
    flow: row.flow,
    click_status: row.click_status,
    session_id: row.session_id ?? null,
    session_status: row.eff_status ?? null,
    status_label: labels.statusLabel(status),
    last_step: row.last_step ?? null,
    last_step_label: labels.stepLabel(row.last_step),
    last_event_at: iso(row.last_event_at),
    duration_seconds: int(row.duration_seconds),
    outcome: row.outcome ?? null,
    outcome_label: labels.outcomeLabel(row.outcome),
    request_type: row.request_type ?? null,
    reason: row.reason ?? null,
    ticket_id: int(row.ticket_id),
    error_count: int(row.error_count) ?? 0,
    products_viewed: int(row.products_viewed) ?? 0,
    cart_clicks: int(row.cart_clicks) ?? 0,
  };
}

function mapOrderItem(item) {
  return { title: item.title, sku: item.sku ?? null, size: item.size ?? null, image_url: item.image_url ?? null };
}

function mapEvent(row) {
  // Aviso de recusa não é "erro": o rótulo do evento diz o que o cliente viu
  const refusal = row.event === "error_shown" && labels.INELIGIBLE_ERROR_CODES.includes(row.error_code);
  return {
    id: int(row.id),
    ts: iso(row.ts),
    source: row.source,
    step: row.step ?? null,
    step_label: labels.stepLabel(row.step),
    event: row.event,
    event_label: refusal ? "Viu o aviso de pedido não elegível" : labels.eventLabel(row.event),
    duration_ms: int(row.duration_ms),
    error_code: row.error_code ?? null,
    error_label: labels.errorLabel(row.error_code),
    meta: sanitizeMeta(row.meta) || null,
  };
}

// Códigos diferentes do mesmo motivo somam juntos; o texto bruto passa pela máscara
function groupRefusals(rows) {
  const groups = new Map();
  for (const row of rows) {
    const raw = row.key === "desconhecido" ? "" : maskSensitive(String(row.key));
    const { key, label } = labels.ineligibilityReason(raw);
    const group = groups.get(key) || { key, label, count: 0 };
    group.count += Number(row.count) || 0;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// Mantém as maiores N chaves e junta o resto em "outros"
function topWithOthers(rows, limit, extra = (r) => ({})) {
  const sorted = rows.map((r) => ({ key: r.key, count: Number(r.count), ...extra(r) }));
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((sum, r) => sum + r.count, 0);
  return [...head, { key: "outros", count: rest }];
}

function totalsFromRow(row) {
  const sends = int(row.sends) || 0;
  const failed = int(row.send_failed) || 0;
  const clicked = int(row.clicked) || 0;
  const completed = int(row.completed) || 0;
  const delivered = sends - failed;
  return {
    sends,
    send_failed: failed,
    clicked,
    not_clicked: int(row.not_clicked) || 0,
    click_rate: rate(clicked, delivered),
    completed,
    completion_rate_of_clicked: rate(completed, clicked),
    completion_rate_of_sent: rate(completed, delivered),
    handoff: int(row.handoff) || 0,
    errors: int(row.errors) || 0,
    not_eligible: int(row.not_eligible) || 0,
    avg_duration_seconds: int(row.avg_duration_seconds),
  };
}

const TOTALS_SQL = `
  count(*)::int as sends,
  count(*) filter (where click_status = 'send_failed')::int as send_failed,
  count(*) filter (where click_status = 'clicked')::int as clicked,
  count(*) filter (where click_status = 'not_clicked')::int as not_clicked,
  count(*) filter (where click_status = 'clicked' and eff_status = 'completed')::int as completed,
  count(*) filter (where click_status = 'clicked' and eff_status = 'handoff')::int as handoff,
  count(*) filter (where click_status = 'clicked' and error_count > 0 and eff_status <> 'not_eligible')::int as errors,
  count(*) filter (where click_status = 'clicked' and eff_status = 'not_eligible')::int as not_eligible,
  round(avg(duration_seconds) filter (where click_status = 'clicked'))::int as avg_duration_seconds`;

// Filtro por período (sent_at/opened_at) e filtros comuns; devolve o trecho do WHERE
function buildWhere(column, params, { period, brand, flow, extra = [] }) {
  const conditions = [];
  params.push(period.from);
  const f = params.length;
  params.push(period.to);
  const t = params.length;
  conditions.push(`${column} >= ($${f}::date)::timestamp at time zone '${TZ}'`);
  conditions.push(`${column} < ($${t}::date + 1)::timestamp at time zone '${TZ}'`);
  if (brand) {
    params.push(brand);
    conditions.push(`${column.split(".")[0]}.brand = $${params.length}`);
  }
  if (flow) {
    params.push(flow);
    conditions.push(`${column.split(".")[0]}.flow = $${params.length}`);
  }
  return [...conditions, ...extra].join(" and ");
}

function createAnalytics({ db = require("./db"), now = () => Date.now() } = {}) {
  const query = async (text, params) => (await db.query(text, params)).rows;

  // v_sends no período, já com o status mostrado (eff_status)
  function sendsCte(params, { period, brand, flow, extra }) {
    const where = buildWhere("v.sent_at", params, { period, brand, flow, extra });
    return `with s as (select v.*, ${EFF_STATUS} as eff_status from v_sends v where ${where})`;
  }

  // v_flow_sessions de um fluxo no período
  function sessionsCte(params, { period, brand, flow }) {
    const where = buildWhere("v.opened_at", params, { period, brand, flow: null, extra: [`v.flow = '${flow}'`] });
    return `with ss as (select v.* from v_flow_sessions v where ${where})`;
  }

  // ---------- /health ----------
  async function health() {
    const started = Date.now();
    await db.query("select 1");
    return { db: "ok", ms: Date.now() - started };
  }

  // ---------- /summary ----------
  async function summary(q) {
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const flow = parseFlow(q);
    const run = (select, tail = "") => {
      const params = [];
      const cte = sendsCte(params, { period, brand, flow });
      return query(`${cte} select ${select} from s ${tail}`, params);
    };

    const [totals, byFlow, byBrand, daily] = await Promise.all([
      run(TOTALS_SQL),
      run(`flow, ${TOTALS_SQL}`, "group by flow order by flow"),
      run(`brand, ${TOTALS_SQL}`, "group by brand order by brand"),
      run(
        `to_char((sent_at at time zone '${TZ}')::date, 'YYYY-MM-DD') as date,
         count(*)::int as sends,
         count(*) filter (where click_status = 'clicked')::int as clicked,
         count(*) filter (where click_status = 'clicked' and eff_status = 'completed')::int as completed`,
        "group by 1 order by 1",
      ),
    ]);

    const byDate = new Map(daily.map((r) => [r.date, r]));
    const days = [];
    for (let ms = period.fromMs; ms <= period.toMs; ms += 86400000) {
      const date = msToDay(ms);
      const r = byDate.get(date);
      days.push({ date, sends: r ? r.sends : 0, clicked: r ? r.clicked : 0, completed: r ? r.completed : 0 });
    }

    return {
      period,
      data: {
        totals: totalsFromRow(totals[0] || {}),
        by_flow: byFlow.map((r) => ({ flow: r.flow, ...totalsFromRow(r) })),
        by_brand: byBrand.map((r) => ({ brand: r.brand, ...totalsFromRow(r) })),
        daily: days,
      },
    };
  }

  // ---------- /funnel ----------
  async function funnel(q) {
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const flow = parseFlow(q, { required: true, allowed: ["reverse", "catalog"] });
    const steps = flow === "reverse" ? REVERSE_STEPS : CATALOG_STEPS;

    const totalsParams = [];
    const totalsCte = sendsCte(totalsParams, { period, brand, flow });
    const viewedParams = [];
    const viewedCte = sendsCte(viewedParams, { period, brand, flow });
    viewedParams.push(steps);
    const durationParams = [];
    const durationCte = sendsCte(durationParams, { period, brand, flow });
    durationParams.push(steps);

    // sessions = quem viu a etapa (step_viewed); a média de tempo vem de step_completed
    const [totalsRows, viewedRows, stepRows] = await Promise.all([
      query(`${totalsCte} select ${TOTALS_SQL} from s`, totalsParams),
      query(
        `${viewedCte}
         select e.step, count(distinct e.session_id)::int as sessions
           from s join flow_events e on e.session_id = s.session_id
          where e.event = 'step_viewed' and e.step = any($${viewedParams.length}::text[])
          group by e.step`,
        viewedParams,
      ),
      query(
        `${durationCte}
         select e.step, round(avg(e.duration_ms))::int as avg_duration_ms
           from s join flow_events e on e.session_id = s.session_id
          where e.event = 'step_completed' and e.duration_ms is not null and e.step = any($${durationParams.length}::text[])
          group by e.step`,
        durationParams,
      ),
    ]);

    const totals = totalsFromRow(totalsRows[0] || {});
    const viewed = new Map(viewedRows.map((r) => [r.step, r.sessions]));
    const durations = new Map(stepRows.map((r) => [r.step, int(r.avg_duration_ms)]));

    const rows = [
      { key: "sent", label: "Enviados", sessions: totals.sends - totals.send_failed },
      { key: "opened", label: "Abriram", sessions: totals.clicked },
      ...steps.map((step) => {
        const row = { key: step, label: labels.stepLabel(step), sessions: viewed.get(step) || 0 };
        if (durations.get(step) !== undefined && durations.get(step) !== null) row.avg_duration_ms = durations.get(step);
        return row;
      }),
      { key: "completed", label: "Concluíram", sessions: totals.completed },
    ];

    // Queda em relação à linha anterior; etapas puladas (ex.: endereço) não geram valor negativo
    const result = rows.map((row, i) => {
      if (i === 0) return { ...row, drop_off_rate: null };
      const prev = rows[i - 1].sessions;
      const drop = prev > 0 ? Math.max(0, Math.round((1 - row.sessions / prev) * 10000) / 10000) : null;
      return { ...row, drop_off_rate: drop };
    });

    return { period, data: { flow, steps: result } };
  }

  // ---------- /sends ----------
  const SEND_COLUMNS = `s.send_id, s.sent_at, s.sent_at::text as sent_at_raw, s.conversation_id, s.customer_name, s.brand, s.flow,
    s.click_status, s.session_id, s.eff_status, s.last_step, s.last_event_at, s.duration_seconds, s.outcome,
    s.request_type, s.reason, s.ticket_id, s.error_count, s.products_viewed, s.cart_clicks`;

  // Condições de filtro de /sends e do export (q, click_status, status)
  function sendFilters(q, params) {
    const extra = [];
    const clickStatus = parseEnum(q, "click_status", ["clicked", "not_clicked", "send_failed"]);
    const status = parseEnum(q, "status", ["completed", "handoff", "error", "not_eligible", "abandoned", "in_progress"]);
    if (clickStatus) {
      params.push(clickStatus);
      extra.push(`v.click_status = $${params.length}`);
    }
    if (status) {
      params.push(status);
      extra.push(`v.click_status = 'clicked' and (${EFF_STATUS}) = $${params.length}`);
    }

    const term = one(q.q);
    if (term !== undefined && term !== "") {
      if (typeof term !== "string" || term.length > 120) throw badRequest("Busca inválida.");
      const text = term.trim();
      const options = [];
      params.push(text);
      options.push(`v.conversation_id = $${params.length}`);
      const normalized = normalizeOrderNumber(text);
      const hash = normalized ? hashOrderNumber(normalized) : null;
      if (hash) {
        params.push(hash);
        options.push(`exists (select 1 from flow_sessions fs where fs.send_id = v.send_id and fs.order_hash = $${params.length})`);
      }
      if (text.length >= 3) {
        params.push(`%${escapeLike(text)}%`);
        options.push(`v.customer_name ilike $${params.length} escape '\\'`);
      }
      extra.push(`(${options.join(" or ")})`);
    }
    return extra;
  }

  async function sends(q) {
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const flow = parseFlow(q);
    const limit = parseLimit(q);
    const params = [];
    const extra = sendFilters(q, params);

    const cursor = one(q.cursor);
    if (cursor !== undefined && cursor !== "") {
      const c = decodeCursor(cursor);
      params.push(c.raw, c.id);
      extra.push(`(v.sent_at, v.send_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    // As posições dos parâmetros de filtro precedem o período: o CTE monta o resto
    const cte = sendsCte(params, { period, brand, flow, extra });
    params.push(limit + 1);
    const rows = await query(`${cte} select ${SEND_COLUMNS} from s order by s.sent_at desc, s.send_id desc limit $${params.length}`, params);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      period,
      data: {
        items: page.map(mapSend),
        next_cursor: rows.length > limit && last ? encodeCursor(last.sent_at_raw, last.send_id) : null,
      },
    };
  }

  async function sessionEvents(sessionId) {
    const rows = await query(
      `select id, ts, source, step, event, duration_ms, error_code, meta
         from flow_events where session_id = $1 order by ts, id limit ${MAX_EVENTS}`,
      [sessionId],
    );
    return rows.map(mapEvent);
  }

  async function sendById(sendId) {
    if (!UUID.test(sendId)) throw badRequest("Identificador inválido.");
    const rows = await query(`select ${SEND_COLUMNS} from (select v.*, ${EFF_STATUS} as eff_status from v_sends v where v.send_id = $1) s`, [sendId]);
    return rows[0] || null;
  }

  async function sendDetail(sendId) {
    const row = await sendById(sendId);
    if (!row) throw notFound("Envio não encontrado.");
    const events = row.session_id ? await sessionEvents(row.session_id) : [];
    // Pedido e produtos: só neste endpoint, na troca/devolução e depois do clique
    const order = row.flow === "reverse" && row.session_id ? await orderDetails(row) : null;
    return { period: null, data: { ...mapSend(row), ...order, events } };
  }

  // Se o cliente reabriu o botão, vale a sessão que tem produtos (a mais recente)
  async function orderDetails(row) {
    let rows;
    try {
      rows = await query(
        `select order_number, items from flow_session_orders
          where send_id = $1 or session_id = $2
          order by (jsonb_array_length(items) > 0) desc, updated_at desc limit 1`,
        [row.send_id, row.session_id],
      );
    } catch (error) {
      if (error.code === "42P01") return null; // migração 003 ainda não aplicada
      throw error;
    }
    const found = rows[0];
    if (!found?.order_number) return { order_number: null, items: [] };
    return { order_number: found.order_number, items: Array.isArray(found.items) ? found.items.map(mapOrderItem) : [] };
  }

  // ---------- /sessions/:sessionId ----------
  async function sessionDetail(sessionId) {
    if (!UUID.test(sessionId)) throw badRequest("Identificador inválido.");
    const rows = await query(`select * from v_flow_sessions where session_id = $1`, [sessionId]);
    if (!rows[0]) throw notFound("Sessão não encontrada.");
    const row = rows[0];

    const sendRows = await query(
      `select ${SEND_COLUMNS} from (select v.*, ${EFF_STATUS} as eff_status from v_sends v where v.session_id = $1) s limit 1`,
      [sessionId],
    );
    const events = await sessionEvents(sessionId);

    const status = row.flow === "tracking" && ["in_progress", "abandoned"].includes(row.status) ? "completed" : row.status;
    const session = { ...row, status, status_label: labels.statusLabel(status), last_step_label: labels.stepLabel(row.last_step), outcome_label: labels.outcomeLabel(row.outcome) };
    for (const key of ["opened_at", "last_event_at", "completed_at", "handoff_at"]) session[key] = iso(row[key]);
    session.ticket_id = int(row.ticket_id);

    return { period: null, data: { session, send: sendRows[0] ? mapSend(sendRows[0]) : null, events } };
  }

  // ---------- /reports/reverse ----------
  async function reverseReport(q) {
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const run = (select, tail = "") => {
      const params = [];
      const cte = sessionsCte(params, { period, brand, flow: "reverse" });
      return query(`${cte} select ${select} from ss ${tail}`, params);
    };
    const group = (column) => run(`${column} as key, count(*)::int as count`, `where ${column} is not null group by 1 order by 2 desc, 1`);
    const events = (select, where) => {
      const params = [];
      const cte = sessionsCte(params, { period, brand, flow: "reverse" });
      return query(`${cte} select ${select} from ss join flow_events e on e.session_id = ss.session_id where ${where}`, params);
    };
    const hasEvent = (cond) => `exists (select 1 from flow_events e where e.session_id = ss.session_id and ${cond})`;

    const refusalCodes = labels.INELIGIBLE_ERROR_CODES.map((c) => `'${c}'`).join(", ");

    const [totals, byType, byReason, byOutcome, retention, handoff, errors, byBrand, refusals] = await Promise.all([
      run(`count(*)::int as sessions,
           count(*) filter (where status = 'completed')::int as completed,
           count(*) filter (where status = 'handoff')::int as handoff,
           count(*) filter (where error_count > 0 and status <> 'not_eligible')::int as errors,
           count(*) filter (where status = 'not_eligible')::int as not_eligible,
           round(avg(extract(epoch from completed_at - opened_at)) filter (where completed_at is not null))::int as avg_s,
           round((percentile_cont(0.9) within group (order by extract(epoch from completed_at - opened_at)) filter (where completed_at is not null))::numeric)::int as p90_s`),
      group("request_type"),
      group("reason"),
      group("outcome"),
      run(`count(*) filter (where ${hasEvent("e.event = 'step_viewed' and e.step = 'retention'")})::int as offered,
           count(*) filter (where ${hasEvent("e.event = 'reverse_created' and e.meta->>'retention_accepted' = 'true'")})::int as accepted,
           count(*) filter (where ${hasEvent("e.event = 'photo_added'")} or ${hasEvent("e.event = 'ticket_created' and (case when (e.meta->>'photos') ~ '^[0-9]{1,9}$' then (e.meta->>'photos')::int else 0 end) > 0")})::int as with_photos`),
      // O serviço grava o motivo da transferência em handoff_reason (o contrato cita reason): aceita os dois
      events(`coalesce(e.meta->>'handoff_reason', e.meta->>'reason', 'outros') as key, count(*)::int as count`, `e.event = 'handoff_requested' group by 1 order by 2 desc, 1`),
      events(`coalesce(e.error_code, 'desconhecido') as key, count(*)::int as count`, `e.event = 'error_shown' and ss.status <> 'not_eligible' and coalesce(e.error_code, '') not in (${refusalCodes}) group by 1 order by 2 desc, 1`),
      run(`brand as key, count(*)::int as sessions, count(*) filter (where status = 'completed')::int as completed`, "group by brand order by brand"),
      // Motivo da última recusa de cada sessão não elegível
      run(
        `coalesce(refusal.code, 'desconhecido') as key, count(*)::int as count`,
        `left join lateral (
           -- código do Troque; sem ele (recusa no envio), a mensagem mostrada ao cliente
           select case when e.error_code = 'NO_REASONS_FOR_TYPE' then e.error_code
                       else coalesce(e.meta->>'ineligibility_code', e.meta->>'detail', e.error_code) end as code
             from flow_events e
            where e.session_id = ss.session_id
              and ((e.event = 'step_completed' and e.meta->>'eligible' = 'false') or (e.event = 'error_shown' and e.error_code in (${refusalCodes})))
            -- primeiro quem diz o motivo; entre eles, o mais recente
            order by (e.error_code is not distinct from 'NO_REASONS_FOR_TYPE'
                      or coalesce(e.meta->>'ineligibility_code', e.meta->>'detail') is not null) desc,
                     e.ts desc, e.id desc
            limit 1
         ) refusal on true
         where ss.status = 'not_eligible' group by 1 order by 2 desc, 1`,
      ),
    ]);

    const t = totals[0] || {};
    const r = retention[0] || {};
    return {
      period,
      data: {
        totals: {
          sessions: int(t.sessions) || 0,
          completed: int(t.completed) || 0,
          handoff: int(t.handoff) || 0,
          errors: int(t.errors) || 0,
          not_eligible: int(t.not_eligible) || 0,
          avg_seconds_to_complete: int(t.avg_s),
          p90_seconds_to_complete: int(t.p90_s),
        },
        by_type: topWithOthers(byType, TOP_LIMIT),
        by_reason: topWithOthers(byReason, TOP_LIMIT),
        by_outcome: byOutcome.map((x) => ({ key: x.key, label: labels.outcomeLabel(x.key), count: Number(x.count) })),
        retention: { offered: int(r.offered) || 0, accepted: int(r.accepted) || 0, accept_rate: rate(int(r.accepted) || 0, int(r.offered) || 0) },
        photos: { sessions_with_photos: int(r.with_photos) || 0 },
        handoff_by_reason: topWithOthers(handoff, TOP_LIMIT),
        errors_by_code: topWithOthers(errors, TOP_LIMIT, (x) => ({ label: labels.errorLabel(x.key) })),
        by_brand: byBrand.map((x) => ({ key: x.key, sessions: int(x.sessions), completed: int(x.completed) })),
        not_eligible_by_reason: groupRefusals(refusals),
      },
    };
  }

  // ---------- /reports/catalog ----------
  async function catalogReport(q) {
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const run = (select, tail = "") => {
      const params = [];
      const cte = sessionsCte(params, { period, brand, flow: "catalog" });
      return query(`${cte} select ${select} from ss ${tail}`, params);
    };
    const events = (select, where, tail = "") => {
      const params = [];
      const cte = sessionsCte(params, { period, brand, flow: "catalog" });
      return query(`${cte} select ${select} from ss join flow_events e on e.session_id = ss.session_id where ${where} ${tail}`, params);
    };
    const results = `(case when (e.meta->>'results_count') ~ '^[0-9]{1,9}$' then (e.meta->>'results_count')::int end)`;

    const [totals, categories, products, variations, searches, terms, byBrand] = await Promise.all([
      run(`count(*)::int as sessions,
           count(*) filter (where products_viewed > 0)::int as with_product_view,
           count(*) filter (where cart_clicks > 0)::int as with_cart_click`),
      events(`e.meta->>'category' as key, count(*)::int as count`, `e.event = 'category_selected' and e.meta->>'category' is not null`, `group by 1 order by 2 desc, 1 limit ${SMALL_TOP_LIMIT}`),
      events(
        `e.meta->>'product_id' as product_id, max(e.meta->>'product_title') as title,
         count(*) filter (where e.event = 'product_viewed')::int as views,
         count(*) filter (where e.event = 'add_to_cart_clicked')::int as cart_clicks`,
        `e.event in ('product_viewed', 'add_to_cart_clicked') and e.meta->>'product_id' is not null`,
        `group by 1 order by 3 desc, 4 desc, 1 limit ${SMALL_TOP_LIMIT}`,
      ),
      events(`e.meta->>'size' as size, e.meta->>'color' as color, count(*)::int as count`, `e.event = 'variation_selected'`, `group by 1, 2 order by 3 desc, 1, 2 limit ${SMALL_TOP_LIMIT}`),
      events(`count(*)::int as total, count(*) filter (where ${results} = 0)::int as no_results`, `e.event = 'search_performed'`),
      events(
        `e.meta->>'query' as term, count(*)::int as count, count(*) filter (where ${results} = 0)::int as no_results_count`,
        `e.event = 'search_performed' and e.meta->>'query' is not null`,
        `group by 1 order by 2 desc, 1 limit ${SMALL_TOP_LIMIT}`,
      ),
      run(`brand as key, count(*)::int as sessions, count(*) filter (where cart_clicks > 0)::int as with_cart_click`, "group by brand order by brand"),
    ]);

    const t = totals[0] || {};
    const s = searches[0] || {};
    const sessions = int(t.sessions) || 0;
    const withCart = int(t.with_cart_click) || 0;
    return {
      period,
      data: {
        totals: { sessions, with_product_view: int(t.with_product_view) || 0, with_cart_click: withCart, cart_rate: rate(withCart, sessions) },
        top_categories: categories.map((x) => ({ key: x.key, count: Number(x.count) })),
        top_products: products.map((x) => ({ product_id: x.product_id, title: x.title ?? null, views: Number(x.views), cart_clicks: Number(x.cart_clicks) })),
        top_variations: variations.map((x) => ({ size: x.size ?? null, color: x.color ?? null, count: Number(x.count) })),
        searches: {
          total: int(s.total) || 0,
          no_results: int(s.no_results) || 0,
          top_terms: trackSearchTerms() ? terms.map((x) => ({ term: x.term, count: Number(x.count), no_results_count: Number(x.no_results_count) })) : [],
        },
        by_brand: byBrand.map((x) => ({ key: x.key, sessions: int(x.sessions), with_cart_click: int(x.with_cart_click) })),
      },
    };
  }

  // ---------- /export.csv ----------
  async function exportRows(q) {
    const report = parseEnum(q, "report", ["sends", "reverse_sessions", "catalog_products"]);
    if (!report) throw badRequest("Informe report: sends, reverse_sessions ou catalog_products.");
    const period = parsePeriod(q, now());
    const brand = parseBrand(q);
    const flow = parseFlow(q);

    if (report === "sends") {
      const params = [];
      const extra = sendFilters(q, params);
      const cte = sendsCte(params, { period, brand, flow, extra });
      const rows = await query(`${cte} select ${SEND_COLUMNS} from s order by s.sent_at desc, s.send_id desc limit ${MAX_EXPORT_ROWS}`, params);
      return {
        header: ["ID do envio", "Enviado em", "ID da conversa", "Cliente", "Marca", "Fluxo", "Situação", "Última etapa", "Resultado", "Tipo", "Motivo", "Ticket", "Erros", "Duração (s)", "Produtos vistos", "Cliques no carrinho"],
        rows: rows.map(mapSend).map((x) => [x.send_id, x.sent_at, x.conversation_id, x.customer_name, x.brand, x.flow, x.status_label, x.last_step_label, x.outcome_label, x.request_type, x.reason, x.ticket_id, x.error_count, x.duration_seconds, x.products_viewed, x.cart_clicks]),
        dateColumns: [1],
        name: "envios",
      };
    }

    if (report === "reverse_sessions") {
      const params = [];
      const cte = sessionsCte(params, { period, brand, flow: "reverse" });
      const rows = await query(`${cte} select * from ss order by opened_at desc, session_id limit ${MAX_EXPORT_ROWS}`, params);
      return {
        header: ["ID da sessão", "Aberta em", "ID da conversa", "Cliente", "Marca", "Situação", "Última etapa", "Resultado", "Tipo", "Motivo", "Ticket", "Erros", "Duração (s)"],
        rows: rows.map((x) => [x.session_id, iso(x.opened_at), x.conversation_id, x.customer_name, x.brand, labels.statusLabel(x.status), labels.stepLabel(x.last_step), labels.outcomeLabel(x.outcome), x.request_type, x.reason, int(x.ticket_id), int(x.error_count), int(x.duration_seconds)]),
        dateColumns: [1],
        name: "troca-devolucao",
      };
    }

    const params = [];
    const cte = sessionsCte(params, { period, brand, flow: "catalog" });
    const rows = await query(
      `${cte}
       select e.meta->>'product_id' as product_id, max(e.meta->>'product_title') as title,
              count(*) filter (where e.event = 'product_viewed')::int as views,
              count(*) filter (where e.event = 'add_to_cart_clicked')::int as cart_clicks
         from ss join flow_events e on e.session_id = ss.session_id
        where e.event in ('product_viewed', 'add_to_cart_clicked') and e.meta->>'product_id' is not null
        group by 1 order by 3 desc, 4 desc, 1 limit ${MAX_EXPORT_ROWS}`,
      params,
    );
    return {
      header: ["ID do produto", "Produto", "Visualizações", "Cliques no carrinho"],
      rows: rows.map((x) => [x.product_id, x.title, int(x.views), int(x.cart_clicks)]),
      dateColumns: [],
      name: "produtos-catalogo",
    };
  }

  return { health, summary, funnel, sends, sendDetail, sessionDetail, reverseReport, catalogReport, exportRows };
}

// ---------- CSV ----------

const spFormatter = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Texto que começa com = + - @ vira texto literal no Excel/Planilhas (apóstrofo na frente)
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv({ header, rows, dateColumns = [] }) {
  const lines = [header.map(csvCell).join(";")];
  for (const row of rows) {
    lines.push(
      row
        .map((value, i) => csvCell(dateColumns.includes(i) && value ? spFormatter.format(new Date(value)) : value))
        .join(";"),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

module.exports = { createAnalytics, ApiError, parsePeriod, toCsv, csvCell, escapeLike, REVERSE_STEPS, CATALOG_STEPS, MAX_EXPORT_ROWS, TZ };
