-- =====================================================================
-- ACOMPANHAMENTO DAS WEBVIEWS (catálogo, troca/devolução, rastreamento)
-- Migração 001 · PostgreSQL (Supabase)
--
-- Como rodar: Supabase > SQL Editor > colar tudo > Run.
-- Pode rodar mais de uma vez: os comandos são idempotentes.
--
-- Privacidade: nada de CPF, e-mail, telefone, endereço, chave PIX ou dados
-- bancários. O pedido entra só como hash (order_hash). O único dado pessoal
-- é o nome de exibição, isolado em conversation_contacts para poder ser
-- apagado por conversa (veja purge_old_flow_data e o script forget-conversation).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Envios do botão da webview (um por mensagem enviada ao cliente)
-- ---------------------------------------------------------------------
create table if not exists webview_sends (
  send_id         uuid primary key default gen_random_uuid(),
  sent_at         timestamptz not null default now(),
  conversation_id text        not null,
  brand           text        not null,
  flow            text        not null check (flow in ('catalog', 'reverse', 'tracking')),
  message_id      text,
  ok              boolean     not null default true,
  error_code      text,
  channel         text        not null default 'ultimate'
);

create index if not exists webview_sends_conversation_idx on webview_sends (conversation_id, sent_at desc);
create index if not exists webview_sends_filter_idx       on webview_sends (sent_at desc, brand, flow);

-- ---------------------------------------------------------------------
-- 2. Nome de exibição por conversa (único dado pessoal do esquema)
-- ---------------------------------------------------------------------
create table if not exists conversation_contacts (
  conversation_id text primary key,
  display_name    text,
  name_source     text check (name_source in ('sunshine', 'troque')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Eventos da jornada (um por linha; fonte da verdade)
-- ---------------------------------------------------------------------
create table if not exists flow_events (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  session_id      uuid,
  send_id         uuid,
  conversation_id text,
  brand           text,
  flow            text check (flow in ('catalog', 'reverse', 'tracking')),
  source          text not null default 'server' check (source in ('client', 'server')),
  channel         text,
  seq             integer,
  step            text,
  event           text not null,
  duration_ms     integer,
  error_code      text,
  meta            jsonb
);

create index if not exists flow_events_session_idx on flow_events (session_id, ts, id);
create index if not exists flow_events_ts_idx      on flow_events (ts desc);
create index if not exists flow_events_kind_idx    on flow_events (flow, event, ts desc);
create index if not exists flow_events_conv_idx    on flow_events (conversation_id, ts desc);

-- ---------------------------------------------------------------------
-- 4. Sessões (uma por abertura da webview), mantidas por trigger
-- ---------------------------------------------------------------------
create table if not exists flow_sessions (
  session_id       uuid primary key,
  send_id          uuid,
  conversation_id  text,
  brand            text,
  flow             text,
  channel          text        not null default 'webview',
  opened_at        timestamptz not null,
  last_event_at    timestamptz not null,
  last_event       text,
  last_step        text,
  event_count      integer     not null default 0,
  error_count      integer     not null default 0,
  completed_at     timestamptz,   -- reverse: evento "completed"; catálogo: 1º "add_to_cart_clicked"
  handoff_at       timestamptz,   -- pediu atendente
  outcome          text,          -- reverse: resultado da reversa
  request_type     text,          -- reverse: troca ou devolução
  reason           text,          -- reverse: último motivo escolhido
  ticket_id        bigint,        -- reverse: ticket criado pelo fluxo (quando há fotos)
  reverse_order_id text,
  order_hash       text,
  products_viewed  integer     not null default 0,
  cart_clicks      integer     not null default 0
);

create index if not exists flow_sessions_send_idx      on flow_sessions (send_id);
create index if not exists flow_sessions_conv_idx      on flow_sessions (conversation_id, opened_at desc);
create index if not exists flow_sessions_filter_idx    on flow_sessions (opened_at desc, brand, flow);
create index if not exists flow_sessions_order_idx     on flow_sessions (order_hash) where order_hash is not null;

-- Atualiza a sessão a cada evento. Tolera eventos fora de ordem (lote do
-- navegador chegando junto com eventos do servidor).
create or replace function apply_flow_event() returns trigger
language plpgsql as $$
declare
  v_ticket bigint;
begin
  if NEW.session_id is null then
    return NEW;
  end if;

  if (NEW.meta->>'ticket_id') ~ '^[0-9]{1,18}$' then
    v_ticket := (NEW.meta->>'ticket_id')::bigint;
  end if;

  insert into flow_sessions as s (
    session_id, send_id, conversation_id, brand, flow, channel,
    opened_at, last_event_at, last_event, last_step,
    event_count, error_count, completed_at, handoff_at,
    outcome, request_type, reason, ticket_id, reverse_order_id, order_hash,
    products_viewed, cart_clicks
  ) values (
    NEW.session_id, NEW.send_id, NEW.conversation_id, NEW.brand, NEW.flow, coalesce(NEW.channel, 'webview'),
    NEW.ts, NEW.ts, NEW.event, NEW.step,
    1, (NEW.event = 'error_shown')::int,
    case when NEW.event in ('completed', 'add_to_cart_clicked') then NEW.ts end,
    case when NEW.event = 'handoff_requested' then NEW.ts end,
    NEW.meta->>'outcome',
    coalesce(NEW.meta->>'type', NEW.meta->>'request_type'),
    NEW.meta->>'reason',
    v_ticket,
    NEW.meta->>'reverse_order_id',
    NEW.meta->>'order_hash',
    (NEW.event = 'product_viewed')::int,
    (NEW.event = 'add_to_cart_clicked')::int
  )
  on conflict (session_id) do update set
    send_id          = coalesce(s.send_id, excluded.send_id),
    conversation_id  = coalesce(s.conversation_id, excluded.conversation_id),
    brand            = coalesce(s.brand, excluded.brand),
    flow             = coalesce(s.flow, excluded.flow),
    opened_at        = least(s.opened_at, excluded.opened_at),
    last_event_at    = greatest(s.last_event_at, excluded.last_event_at),
    last_event       = case when excluded.last_event_at >= s.last_event_at then excluded.last_event else s.last_event end,
    last_step        = case when excluded.last_event_at >= s.last_event_at then coalesce(excluded.last_step, s.last_step) else s.last_step end,
    event_count      = s.event_count + 1,
    error_count      = s.error_count + excluded.error_count,
    completed_at     = coalesce(s.completed_at, excluded.completed_at),
    handoff_at       = coalesce(s.handoff_at, excluded.handoff_at),
    outcome          = coalesce(excluded.outcome, s.outcome),
    request_type     = coalesce(excluded.request_type, s.request_type),
    reason           = coalesce(excluded.reason, s.reason),
    ticket_id        = coalesce(excluded.ticket_id, s.ticket_id),
    reverse_order_id = coalesce(excluded.reverse_order_id, s.reverse_order_id),
    order_hash       = coalesce(excluded.order_hash, s.order_hash),
    products_viewed  = s.products_viewed + excluded.products_viewed,
    cart_clicks      = s.cart_clicks + excluded.cart_clicks;

  return NEW;
end;
$$;

drop trigger if exists flow_events_apply on flow_events;
create trigger flow_events_apply
  after insert on flow_events
  for each row execute function apply_flow_event();

-- ---------------------------------------------------------------------
-- 5. Visões usadas pela API de consulta
-- ---------------------------------------------------------------------

-- Sessões com nome do cliente e status calculado.
-- Status: completed | handoff | error | abandoned | in_progress
--   abandoned = último evento "abandoned" ou parada há mais de 30 minutos.
create or replace view v_flow_sessions with (security_invoker = true) as
select
  s.*,
  c.display_name as customer_name,
  case
    when s.completed_at is not null              then 'completed'
    when s.handoff_at is not null                then 'handoff'
    when s.last_event = 'error_shown'            then 'error'
    when s.last_event = 'abandoned'              then 'abandoned'
    when s.last_event_at < now() - interval '30 minutes' then 'abandoned'
    else 'in_progress'
  end as status,
  extract(epoch from (s.last_event_at - s.opened_at))::int as duration_seconds
from flow_sessions s
left join conversation_contacts c on c.conversation_id = s.conversation_id;

-- Todos os botões enviados, com o que aconteceu depois.
-- click_status: send_failed | clicked | not_clicked
create or replace view v_sends with (security_invoker = true) as
select
  d.send_id,
  d.sent_at,
  d.conversation_id,
  d.brand,
  d.flow,
  d.ok,
  d.error_code,
  d.channel,
  c.display_name as customer_name,
  case
    when d.ok is false             then 'send_failed'
    when s.session_id is not null  then 'clicked'
    else 'not_clicked'
  end as click_status,
  s.session_id,
  s.opened_at,
  s.last_step,
  s.last_event_at,
  s.status        as session_status,
  s.outcome,
  s.request_type,
  s.reason,
  s.ticket_id,
  s.reverse_order_id,
  s.error_count,
  s.products_viewed,
  s.cart_clicks,
  s.duration_seconds
from webview_sends d
left join conversation_contacts c on c.conversation_id = d.conversation_id
left join lateral (
  select v.*
  from v_flow_sessions v
  where v.send_id = d.send_id
  order by v.opened_at
  limit 1
) s on true;

-- ---------------------------------------------------------------------
-- 6. Retenção (12 meses) e apagamento por conversa
-- ---------------------------------------------------------------------
create or replace function purge_old_flow_data(retention interval default interval '12 months')
returns void language plpgsql as $$
begin
  delete from flow_events  where ts < now() - retention;
  delete from flow_sessions where last_event_at < now() - retention;
  delete from webview_sends where sent_at < now() - retention;
  delete from conversation_contacts c
   where not exists (select 1 from webview_sends w where w.conversation_id = c.conversation_id)
     and not exists (select 1 from flow_sessions f where f.conversation_id = c.conversation_id);
end;
$$;

create or replace function forget_conversation(p_conversation_id text)
returns void language plpgsql as $$
begin
  delete from flow_events           where conversation_id = p_conversation_id;
  delete from flow_sessions         where conversation_id = p_conversation_id;
  delete from webview_sends         where conversation_id = p_conversation_id;
  delete from conversation_contacts where conversation_id = p_conversation_id;
end;
$$;

-- Agendamento diário (opcional). Ative a extensão em Database > Extensions > pg_cron
-- e então rode:
--   select cron.schedule('purge-flow-data', '15 6 * * *', $$select purge_old_flow_data()$$);

-- ---------------------------------------------------------------------
-- 7. Segurança: a API do Supabase (PostgREST) NÃO deve enxergar nada daqui.
--    O backend conecta direto no Postgres (usuário do pooler), que ignora RLS.
-- ---------------------------------------------------------------------
alter table webview_sends         enable row level security;
alter table conversation_contacts enable row level security;
alter table flow_events           enable row level security;
alter table flow_sessions         enable row level security;

revoke all on webview_sends, conversation_contacts, flow_events, flow_sessions, v_flow_sessions, v_sends from anon, authenticated;

revoke execute on function apply_flow_event()            from public, anon, authenticated;
revoke execute on function purge_old_flow_data(interval) from public, anon, authenticated;
revoke execute on function forget_conversation(text)     from public, anon, authenticated;