# Contrato: API de acompanhamento (webview) ⇄ app Zendesk

Este documento é a fonte única do que o **backend do webview** (repositório `Vulcabras-webview`) expõe e do que o **app da Zendesk** (repositório `Vulcabras-Acompanhamento`) consome. Copie-o para os dois repositórios como `docs/api-contract.md`. Se algo aqui precisar mudar, mude nos dois ao mesmo tempo.

## 1. Convenções

- **Base:** `https://<app-do-webview>.onrender.com/api/analytics`. Só `GET`.
- **Autenticação:** `Authorization: Bearer <ANALYTICS_API_SECRET>` (comparação em tempo constante). Segredo ausente no servidor: `503`. Errado ou faltando: `401`.
- **Resposta de sucesso:** `{ "success": true, "data": ..., "meta": { "generated_at": "ISO-8601", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "timezone": "America/Sao_Paulo" } }`
- **Resposta de erro:** `{ "success": false, "code": "BAD_REQUEST | UNAUTHORIZED | NOT_FOUND | RATE_LIMITED | SERVICE_UNAVAILABLE", "error": "texto curto em português" }`. Nunca expor SQL, stack, segredos nem dados pessoais.
- **Período:** `from` e `to` em `YYYY-MM-DD`, **inclusivos**, no fuso `America/Sao_Paulo`. Padrão: últimos 7 dias (hoje incluído). Máximo de 366 dias.
- **Filtros comuns:** `brand` = `mizuno | olympikus | underarmour`; `flow` = `catalog | reverse | tracking`. Omitidos = todos.
- **Taxas:** números de 0 a 1 (ou `null` se o denominador for 0). O app formata em %.
- **Paginação:** por cursor (`limit` de 1 a 100, padrão 50; `next_cursor` opaco ou `null`).
- **Limite de uso:** 60 requisições por minuto por segredo (`429 RATE_LIMITED`).
- **Sem dados pessoais** além de `customer_name`. Pedido só como hash, com uma única exceção: o número do pedido em `GET /sends/:sendId` (seção 5.5).

## 2. Definições

| Termo | Definição |
|---|---|
| **Envio** | Um botão postado na conversa (`webview_sends`). Falha de envio (`ok = false`) conta à parte e não entra nas taxas. |
| **Clique** | Existe uma sessão (`flow_sessions`) ligada ao `send_id`: a webview abriu e carregou. |
| **Sem clique** | Envio bem-sucedido sem sessão. |
| **Concluído** | `reverse`: evento `completed` (reversa criada). `catalog`: primeiro `add_to_cart_clicked`. `tracking`: sessão aberta (não há etapa final). |
| **Status da sessão** | `completed`, `handoff` (pediu atendente), `not_eligible` (recusa por regra de negócio: o último veredito da sessão foi `eligible = false` ou aviso `ORDER_NOT_ELIGIBLE`/`NO_REASONS_FOR_TYPE`, sem falha de serviço depois; **não é erro**), `error` (último evento foi `error_shown` ou a sessão terminou na tela final de erro, `last_step = error`), `abandoned` (último evento `abandoned` ou parada há mais de 30 min), `in_progress`. |
| **Carrinho** | Clique no link de adicionar ao carrinho da VTEX. **Não** confirma que o item ficou no carrinho nem compra. |
| **Taxa de clique** | `clicados / (enviados com sucesso)`. |
| **Taxa de conclusão** | duas versões: sobre clicados e sobre enviados. |

## 3. Eventos (catálogo comum a banco, webview e app)

Chaves de `meta` **nunca** contêm `cpf, cnpj, document, email, mail, phone, name, nome, address, street, zip, pix, bank, account, identifier, comment, token, secret` (o `lib/tracking.js` descarta). Por isso use `product_title`, `category` etc., e nunca `product_name`.

| Evento | Fluxo | Origem | `step` | `meta` principal |
|---|---|---|---|---|
| `webview_sent` | todos | servidor | – | vai para `webview_sends`, não para `flow_events` |
| `webview_opened` | todos | navegador | primeira tela | – |
| `step_viewed`, `step_completed`, `step_back` | todos | navegador | tela | `step_completed`: `duration_ms` |
| `validation_error`, `error_shown` | todos | ambos | tela | `error_code`; em `error_shown` também `detail` (texto curto do erro, mascarado) e, quando o pedido não é elegível, `ineligibility_code` (código bruto do Troque, mascarado) |
| `api_call` | reverse | servidor | etapa | `service`, `ok`, `tool`, `duration_ms`, `attempt`, `http_status`; com falha também `upstream_code` (código bruto da integração, mascarado). Nunca o corpo da resposta nem os argumentos |
| `photo_added`, `photo_removed` | reverse | navegador | `reasons` | `count` |
| `ticket_created` | reverse | servidor | `submit` | `ticket_id`, `photos` |
| `reverse_created` | reverse | servidor | `submit` | `outcome`, `type`, `reverse_order_id`, `ticket_id`, `order_hash`, `retention_accepted` |
| `completed` | reverse | servidor | `submit` | `outcome` |
| `handoff_requested` | reverse | servidor | etapa | `reason` |
| `abandoned` | todos | navegador | – | – |
| `category_selected` | catalog | navegador | `categories` | `category` |
| `search_performed` | catalog | navegador | `categories` | `query` (60 car., minúsculas), `results_count` |
| `product_viewed` | catalog | navegador | `details` | `product_id`, `product_title` |
| `variation_selected` | catalog | navegador | `details` | `sku`, `size`, `color` |
| `add_to_cart_clicked` | catalog | navegador | `details` | `sku`, `product_id` |

Etapas do `reverse` (ordem): `start, identify, items, reasons, address, retention, shipping, refund, summary, result`. Etapas do `catalog`: `categories, products, details`. Confirme os nomes reais no código (`public/js/reverse/flow.js` e `catalog.js`) e ajuste este quadro se houver diferença.

**Mascaramento (campos `detail`, `upstream_code`, `ineligibility_code`):** antes de gravar, o backend troca e-mails por `[e-mail]`, links por `[link]`, qualquer sequência de 6 ou mais dígitos (CPF, CNPJ, telefone, pedido, CEP) e códigos opacos de 20 ou mais caracteres com letras e números por `•••`, e corta em 120 caracteres. Não reconhece nomes próprios: por isso só entram textos do sistema, nunca texto digitado pelo cliente. Um `error_code` fora do formato (espaço ou mais de 40 caracteres) é gravado como `UNKNOWN_ERROR`.

## 4. Rótulos em português (a API devolve `label` junto da chave)

- **Etapas:** `start` Início · `identify` Identificação · `items` Itens · `reasons` Motivo · `address` Endereço · `retention` Vale-compras · `shipping` Envio · `refund` Reembolso · `summary` Resumo · `result` Resultado · `categories` Categorias · `products` Produtos · `details` Detalhe do produto · `submit` Envio da solicitação · `error` Tela final (tela que encerra o fluxo com um aviso, erro ou transferência).
- **Eventos:** `webview_opened` Abriu a webview · `step_viewed` Viu a etapa · `step_completed` Concluiu a etapa · `step_back` Voltou · `validation_error` Erro de preenchimento · `error_shown` Viu um erro · `api_call` Chamada a serviço · `photo_added` Adicionou foto · `photo_removed` Removeu foto · `ticket_created` Ticket criado · `reverse_created` Solicitação criada · `completed` Concluiu · `handoff_requested` Pediu atendente · `abandoned` Saiu da webview · `category_selected` Escolheu categoria · `search_performed` Pesquisou · `product_viewed` Viu produto · `variation_selected` Escolheu tamanho/cor · `add_to_cart_clicked` Clicou em adicionar ao carrinho.
- **Erros** (`error_code`): `TEMPORARY_FAILURE` Falha temporária no Troque · `ORDER_NOT_FOUND` Pedido não encontrado · `ORDER_NOT_ELIGIBLE` Pedido não elegível · `VALIDATION_FAILED` Dados inválidos · `PHOTO_REQUIRED` Foto obrigatória · `PHOTO_UPLOAD_FAILED` Falha ao enviar foto · `SESSION_EXPIRED` Sessão expirada · `UNAUTHORIZED` Token do Troque inválido · `RATE_LIMITED` Limite de uso · `CREATION_UNCONFIRMED` Criação não confirmada · `MESSAGE_NOT_POSTED` Mensagem final não postada · `HANDOFF_REQUIRED` Motivo vai para atendente · `NO_REASONS_FOR_TYPE` Sem opção de troca ou devolução · `TOO_MANY_ATTEMPTS` Muitas tentativas de localizar o pedido · `UNKNOWN_ERROR` Erro com código não reconhecido (o texto original segue mascarado em `meta.upstream_code`/`meta.detail`) · código desconhecido: mostrar o próprio código.
- **Resultados** (`outcome`): `approved_with_shipping` Aprovada, com envio · `approved_without_shipping` Aprovada, sem envio contratado · `pending_analysis` Em análise · `approved_shipping_failed` Aprovada, envio falhou.
- **Status:** `completed` Concluído · `handoff` Pediu atendente · `error` Terminou com erro · `not_eligible` Não elegível · `abandoned` Abandonou · `in_progress` Em andamento · `not_clicked` Sem clique · `send_failed` Falha no envio.

## 5. Endpoints

### 5.1 `GET /health`
`data`: `{ "db": "ok", "ms": 12 }`. Usado para acordar o servidor (o plano gratuito do Render dorme) e para a rotina que evita a pausa do banco.

### 5.2 `GET /summary?from&to&brand&flow`
```json
{
  "totals": {
    "sends": 320, "send_failed": 7, "clicked": 190, "not_clicked": 123,
    "click_rate": 0.607, "completed": 45,
    "completion_rate_of_clicked": 0.237, "completion_rate_of_sent": 0.144,
    "handoff": 22, "errors": 21, "not_eligible": 9, "avg_duration_seconds": 214
  },
  "by_flow":  [ { "flow": "reverse", "...mesmos campos de totals": 0 } ],
  "by_brand": [ { "brand": "mizuno", "...mesmos campos de totals": 0 } ],
  "daily":    [ { "date": "2026-11-18", "sends": 40, "clicked": 24, "completed": 6 } ]
}
```
Base de cálculo: `v_sends` filtrado por `sent_at` no período. `errors` conta sessões com algum erro e **exclui** as de status `not_eligible`, contadas à parte em `not_eligible`.

### 5.3 `GET /funnel?flow=reverse|catalog&from&to&brand`
`flow` é obrigatório. Primeiras duas linhas são sempre "Enviados" e "Abriram".
```json
{
  "flow": "reverse",
  "steps": [
    { "key": "sent",     "label": "Enviados", "sessions": 164, "drop_off_rate": null },
    { "key": "opened",   "label": "Abriram",  "sessions": 100, "drop_off_rate": 0.39 },
    { "key": "identify", "label": "Identificação", "sessions": 92, "drop_off_rate": 0.08, "avg_duration_ms": 31000 },
    { "key": "completed","label": "Concluíram", "sessions": 21, "drop_off_rate": 0.4 }
  ]
}
```
`sessions` em cada etapa = sessões que chegaram nela (evento `step_viewed` da etapa). `drop_off_rate` = queda em relação à linha anterior.

### 5.4 `GET /sends?from&to&brand&flow&click_status&status&q&limit&cursor`
Lista principal para os analistas: **todo botão enviado**, com o que aconteceu depois.
- `click_status`: `clicked | not_clicked | send_failed`. `status`: status da sessão (seção 2).
- `q`: ID da conversa exato, **ou** número do pedido (o servidor calcula o mesmo hash e compara com `order_hash`), **ou** parte do nome do cliente (mínimo 3 caracteres).
```json
{
  "items": [
    {
      "send_id": "uuid", "sent_at": "ISO", "conversation_id": "abc123", "customer_name": "Maria S.",
      "brand": "mizuno", "flow": "reverse",
      "click_status": "clicked", "session_id": "uuid", "session_status": "completed",
      "last_step": "summary", "last_event_at": "ISO", "duration_seconds": 214,
      "outcome": "approved_with_shipping", "outcome_label": "Aprovada, com envio",
      "request_type": "troca", "reason": "Defeito", "ticket_id": 123456, "error_count": 0,
      "products_viewed": 0, "cart_clicks": 0
    }
  ],
  "next_cursor": "opaco-ou-null"
}
```
Campos de troca (`outcome`, `request_type`, `reason`, `ticket_id`) vêm `null` no catálogo; campos de catálogo (`products_viewed`, `cart_clicks`) vêm `0` na troca.

### 5.5 `GET /sends/:sendId`
Mesmo item de 5.4 mais `events` da sessão (lista vazia se não houve clique). O app abre este detalhe para qualquer linha da lista.

Na troca/devolução (`flow = reverse`), a resposta também traz o pedido e os produtos que o cliente selecionou:
```json
{
  "...item de 5.4": null,
  "order_number": "1234567890",
  "items": [
    { "title": "Tênis Demo Preto", "sku": "0000000-001-37", "size": "37", "image_url": "https://exemplo.com/produto.jpg" }
  ],
  "events": []
}
```

| Campo | Tipo | Regra |
|---|---|---|
| `order_number` | texto ou `null` | Número do pedido que o cliente selecionou. |
| `items` | lista | Somente os produtos selecionados pelo cliente, não o pedido inteiro. |
| `items[].title` | texto | Obrigatório em cada item. |
| `items[].sku` | texto ou `null` | |
| `items[].size` | texto ou `null` | Só o valor (`"37"`); o app acrescenta o rótulo. |
| `items[].image_url` | texto ou `null` | URL `https://` pública, sem token nem dado do cliente. Outros formatos são ignorados pelo app. |

- Os campos são opcionais: ausentes, `null` ou lista vazia (outros fluxos, sem clique, pedido ainda não identificado, nenhum item selecionado ou envios anteriores a esta mudança), o app não mostra o bloco.
- `order_number` e `items` existem **somente** neste endpoint. Não entram em 5.4, 5.6, no CSV (5.9), no `meta` dos eventos nem em logs. No `meta`, o pedido continua só como `order_hash`.

### 5.6 `GET /sessions/:sessionId`
```json
{
  "session": { "...campos de v_flow_sessions": null },
  "send": { "...item de 5.4": null },
  "events": [
    { "id": 1, "ts": "ISO", "source": "client", "step": "identify", "step_label": "Identificação",
      "event": "step_viewed", "event_label": "Viu a etapa", "duration_ms": null,
      "error_code": null, "error_label": null, "meta": { "reason": "Defeito" } }
  ]
}
```
Eventos em ordem cronológica (`ts`, depois `id`). `meta` já sem chaves bloqueadas.

### 5.7 `GET /reports/reverse?from&to&brand`
```json
{
  "totals": { "sessions": 100, "completed": 21, "handoff": 22, "errors": 21, "not_eligible": 9, "avg_seconds_to_complete": 305, "p90_seconds_to_complete": 640 },
  "by_type":    [ { "key": "troca", "count": 12 } ],
  "by_reason":  [ { "key": "Defeito", "count": 9 } ],
  "by_outcome": [ { "key": "approved_with_shipping", "label": "Aprovada, com envio", "count": 8 } ],
  "retention":  { "offered": 14, "accepted": 6, "accept_rate": 0.43 },
  "photos":     { "sessions_with_photos": 9 },
  "handoff_by_reason": [ { "key": "Solicitação fora do prazo", "count": 11 } ],
  "errors_by_code": [ { "key": "TEMPORARY_FAILURE", "label": "Falha temporária no Troque", "count": 7 } ],
  "by_brand":   [ { "key": "mizuno", "sessions": 40, "completed": 9 } ],
  "not_eligible_by_reason": [ { "key": "active_request", "label": "Já tem solicitação em andamento", "count": 5 } ]
}
```
`not_eligible_by_reason`: motivo da recusa das sessões `not_eligible`. Chaves conhecidas: `active_request` Já tem solicitação em andamento · `marketplace` Compra feita em marketplace · `order_situation` Situação do pedido não permite troca · `deadline` Prazo de troca encerrado · `no_reasons` Sem opção de troca ou devolução · `not_eligible` Pedido não elegível · `desconhecido` Sem motivo informado · motivo novo: a própria chave (mascarada). `errors_by_code` não inclui recusas.

Nos eventos, um `error_shown` com `ORDER_NOT_ELIGIBLE` ou `NO_REASONS_FOR_TYPE` vem com `event_label` "Viu o aviso de pedido não elegível".

Lista `reasons` e códigos podem crescer: devolva as 20 maiores e agrupe o resto em `"key": "outros"`.

### 5.8 `GET /reports/catalog?from&to&brand`
```json
{
  "totals": { "sessions": 97, "with_product_view": 70, "with_cart_click": 16, "cart_rate": 0.165 },
  "top_categories": [ { "key": "Calçados", "count": 31 } ],
  "top_products":   [ { "product_id": "1004", "title": "Produto X", "views": 18, "cart_clicks": 5 } ],
  "top_variations": [ { "size": "40", "color": "Preto", "count": 7 } ],
  "searches": { "total": 44, "no_results": 6, "top_terms": [ { "term": "tenis corrida", "count": 9, "no_results_count": 0 } ] },
  "by_brand": [ { "key": "mizuno", "sessions": 30, "with_cart_click": 6 } ]
}
```

### 5.9 `GET /export.csv?report=sends|reverse_sessions|catalog_products&from&to&brand&flow`
CSV em UTF-8 **com BOM**, separador `;`, cabeçalho em português, até 50 mil linhas. **Proteção contra injeção de fórmula:** qualquer célula de texto que comece com `=`, `+`, `-` ou `@` recebe um apóstrofo na frente. Inclui `customer_name`; nunca inclui CPF, e-mail ou telefone. O app baixa como texto (`dataType: "text"`) e entrega como arquivo.

## 6. Compatibilidade

- Campos novos podem ser **acrescentados** às respostas sem aviso; o app deve ignorar o que não conhece. Remover ou renomear campo exige combinar nos dois repositórios.
- Todo `label` é só para exibição. A lógica usa a `key`.
