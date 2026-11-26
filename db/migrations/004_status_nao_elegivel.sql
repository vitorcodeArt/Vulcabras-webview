-- Recusa por regra de negócio deixa de ser erro: status "not_eligible".
--
-- Exemplos: já existe solicitação em andamento, compra feita em marketplace, prazo
-- encerrado, situação do pedido não permite, sem opção de troca ou devolução.
--
-- Vale o ÚLTIMO veredito da sessão entre:
--   - resultado da consulta de elegibilidade (step_completed do servidor, meta.eligible)
--   - aviso ao cliente com ORDER_NOT_ELIGIBLE ou NO_REASONS_FOR_TYPE
--   - falha numa chamada a serviço (api_call com meta.ok = false)
-- Assim, quem recebe a recusa, tenta outro pedido e então sofre uma falha continua
-- como "error", e quem tenta outro pedido elegível volta ao status normal.
-- Concluída e "pediu atendente" continuam com prioridade. Vale também para o histórico.
--
-- Mesmas colunas da versão anterior; v_sends só lê a coluna status.

create or replace view v_flow_sessions with (security_invoker = true) as
select
  s.*,
  c.display_name as customer_name,
  case
    when s.completed_at is not null              then 'completed'
    when s.handoff_at is not null                then 'handoff'
    when verdict.result = 'not_eligible'         then 'not_eligible'
    when s.last_event = 'error_shown'            then 'error'
    when s.last_step = 'error'                   then 'error'
    when s.last_event = 'abandoned'              then 'abandoned'
    when s.last_event_at < now() - interval '30 minutes' then 'abandoned'
    else 'in_progress'
  end as status,
  extract(epoch from (s.last_event_at - s.opened_at))::int as duration_seconds
from flow_sessions s
left join conversation_contacts c on c.conversation_id = s.conversation_id
left join lateral (
  select case
      when e.event = 'api_call'            then 'failure'
      when e.event = 'error_shown'         then 'not_eligible'
      when e.meta->>'eligible' = 'false'   then 'not_eligible'
      else 'eligible'
    end as result
  from flow_events e
  where e.session_id = s.session_id
    and (
         (e.event = 'step_completed' and e.source = 'server' and e.meta->>'eligible' in ('true', 'false'))
      or (e.event = 'error_shown' and e.error_code in ('ORDER_NOT_ELIGIBLE', 'NO_REASONS_FOR_TYPE'))
      or (e.event = 'api_call' and e.meta->>'ok' = 'false')
    )
  order by e.ts desc, e.id desc
  limit 1
) verdict on true;
