-- Sessão que termina na tela final de erro passa a ter status "error".
--
-- Antes: "error" só quando o último evento era error_shown. Na prática o webview
-- registra mais eventos depois do erro (step_completed e step_viewed da tela "error"),
-- então essas sessões apareciam como "abandoned" (ou "in_progress" nos primeiros 30 min).
--
-- Agora: também é "error" quando a última etapa registrada é "error" (a tela final de
-- erro/transferência). Concluída e "pediu atendente" continuam com prioridade.
-- Mesmas colunas da versão anterior; v_sends só lê a coluna status, nada mais a ajustar.

create or replace view v_flow_sessions with (security_invoker = true) as
select
  s.*,
  c.display_name as customer_name,
  case
    when s.completed_at is not null              then 'completed'
    when s.handoff_at is not null                then 'handoff'
    when s.last_event = 'error_shown'            then 'error'
    when s.last_step = 'error'                   then 'error'
    when s.last_event = 'abandoned'              then 'abandoned'
    when s.last_event_at < now() - interval '30 minutes' then 'abandoned'
    else 'in_progress'
  end as status,
  extract(epoch from (s.last_event_at - s.opened_at))::int as duration_seconds
from flow_sessions s
left join conversation_contacts c on c.conversation_id = s.conversation_id;
