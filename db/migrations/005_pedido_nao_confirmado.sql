-- Número do pedido digitado pelo cliente, mesmo quando o Troque não o localiza.
--
-- verified = true  -> o Troque confirmou o pedido (comportamento anterior).
-- verified = false -> número digitado e ainda não confirmado (não encontrado ou falha
--                     na consulta). Nunca substitui um pedido confirmado da mesma sessão.
--                     Valores que parecem CPF ou CNPJ não são gravados.
--
-- Pode rodar mais de uma vez.

alter table flow_session_orders add column if not exists verified boolean not null default true;
