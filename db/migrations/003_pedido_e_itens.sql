-- Número do pedido e produtos selecionados na troca/devolução.
--
-- Única exceção à regra "pedido só como hash" (ver docs/api-contract.md, seção 5.5):
-- estes dados saem somente em GET /sends/:sendId. Não entram em flow_events.meta,
-- na lista de envios, no CSV nem em logs.
--
-- O número do pedido, junto do nome do cliente, pode ser dado pessoal: por isso a
-- tabela é isolada e entra no apagamento por conversa e na retenção de 12 meses.
-- Pode rodar mais de uma vez: os comandos são idempotentes.

create table if not exists flow_session_orders (
  session_id      uuid        primary key,
  send_id         uuid,
  conversation_id text        not null,
  order_number    text        not null,
  items           jsonb       not null default '[]'::jsonb, -- só os produtos selecionados: title, sku, size, image_url
  updated_at      timestamptz not null default now()
);

create index if not exists flow_session_orders_send_idx    on flow_session_orders (send_id);
create index if not exists flow_session_orders_conv_idx    on flow_session_orders (conversation_id);
create index if not exists flow_session_orders_updated_idx on flow_session_orders (updated_at);

alter table flow_session_orders enable row level security;
revoke all on flow_session_orders from anon, authenticated;

create or replace function purge_old_flow_data(retention interval default interval '12 months')
returns void language plpgsql as $$
begin
  delete from flow_session_orders where updated_at < now() - retention;
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
  delete from flow_session_orders   where conversation_id = p_conversation_id;
  delete from flow_events           where conversation_id = p_conversation_id;
  delete from flow_sessions         where conversation_id = p_conversation_id;
  delete from webview_sends         where conversation_id = p_conversation_id;
  delete from conversation_contacts where conversation_id = p_conversation_id;
end;
$$;
