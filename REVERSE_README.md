# Troca e devolução (webview `/reverse`)

Webview em que o cliente troca, devolve ou acompanha uma solicitação pelo chat da Zendesk, para Mizuno, Olympikus e Under Armour. O backend fala com o TroqueCommerce (MCP), cria o ticket com as fotos no Zendesk e posta mensagens na conversa pelo Sunshine Conversations.

Nada de segredo neste repositório: tokens e senhas ficam só em variáveis de ambiente (`.env` local e Render).

## Como funciona

1. O bot chama `POST /api/send-webview` com `type: "reverse"` e a marca.
2. O servidor posta na conversa um botão com a URL `/reverse?store=<marca>&t=<sessão assinada>`.
3. A sessão é um token HMAC com conversa, marca e validade. Todas as chamadas da webview exigem esse token.
4. A webview conduz as etapas:
   1. tipo;
   2. identificação;
   3. itens;
   4. motivo (com fotos, quando o motivo pede);
   5. endereço;
   6. retenção;
   7. envio;
   8. reembolso;
   9. resumo.
5. Na confirmação, o servidor valida tudo de novo. Se houver fotos, envia ao Zendesk e cria o ticket. Depois cria a reversa no Troque e posta a mensagem final na conversa.

```
public/pages/reverse.html        página (Tailwind e Lucide por CDN, versões fixadas)
public/js/reverse/               módulos ES: main, flow (roteador), state, api, ui, photos, tracking, session
public/js/reverse/screens/       uma tela por etapa (start ... error)
routes/reverse.js                rotas, limites por IP e por conversa, montagem da URL da webview
lib/session.js                   sessão assinada e tokens assinados (opção de envio, nova tentativa de fotos)
lib/troque.js                    cliente JSON-RPC do Troque (JSON ou SSE, erros tipados, novas tentativas, freio de 60 req/10 s)
lib/reverse/service.js           orquestração (prepare, retention, quote, submit, track, finish, handoff)
lib/reverse/validation.js        validação de toda a entrada no servidor
lib/reverse/mappers.js           respostas do Troque reduzidas ao que a tela precisa
lib/reverse/errors.js            código -> mensagem em português + ação da tela
lib/reverse/messages.js          mensagens postadas na conversa
lib/reverse/photos.js            multipart (multer), validação por assinatura do arquivo
lib/reverse/ticket.js            texto do ticket (dados mascarados)
lib/storage/zendeskAttachments.js  armazenamento das fotos como anexo de ticket (interface trocável)
lib/zendesk/oauth.js             token OAuth (client_credentials, só em memória)
lib/zendesk/tickets.js           upload, ticket, comentários, nota interna
lib/zendesk/conversation.js      mensagens e botão de atendente no Sunshine
lib/tracking.js                  eventos da jornada em JSON no log
lib/rateLimit.js                 limites em memória e freio das chamadas ao Troque
lib/apiAuth.js                   segredo opcional do POST /api/send-webview
```

## Abrir a webview numa conversa

```bash
curl -X POST https://<app>.onrender.com/api/send-webview \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: <segredo, se WEBVIEW_API_SECRET estiver definido>" \
  -d '{"conversationId": "<id da conversa>", "type": "reverse", "store": "underarmour"}'
```

- **Opcionais:** `customText` e `buttonText`.
- **Resposta:** `{"success": true, "data": {"messageId": "..."}}`. O link assinado não volta na resposta.
- **Marca:** só funciona para marca com `TROQUE_<MARCA>_TOKEN` definido.

## Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `TROQUE_MCP_URL` | URL do MCP (homologação e produção usam a mesma; o token decide a loja) |
| `TROQUE_MIZUNO_TOKEN`, `TROQUE_OLYMPIKUS_TOKEN`, `TROQUE_UNDERARMOUR_TOKEN` | Token do Troque de cada marca |
| `ZENDESK_SUBDOMAIN`, `ZENDESK_APP_ID`, `ZENDESK_KEY_ID`, `ZENDESK_SECRET` | Sunshine Conversations (mensagens na conversa), as mesmas do `send-webview` |
| `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET`, `ZENDESK_OAUTH_SCOPES` | API de tickets (cliente OAuth confidencial, grant `client_credentials`) |
| `ZENDESK_BRAND_ID_<MARCA>` | Marca do ticket no Zendesk |
| `ZENDESK_TICKET_FORM_ID_<MARCA>` | Formulário do ticket (vazio = padrão da marca) |
| `ZENDESK_TICKET_SUBJECT` | Assunto padrão do ticket |
| `ZENDESK_TICKET_ASSIGNEE_ID` | Opcional: responsável do ticket, se o Zendesk exigir para "resolvido" |
| `REVERSE_PHOTOS_ENABLED` | `true` libera o envio de fotos. Desligado, motivos com foto vão para atendente |
| `REVERSE_HANDOFF_REASONS` | Motivos que vão para atendente (texto exato, separados por `\|`) |
| `REVERSE_HANDOFF_BUTTON_TYPE`, `_TEXT`, `_PAYLOAD` | Botão "Falar com atendente" postado na conversa (`reply` ou `postback`) |
| `FLOW_SESSION_SECRET` | Segredo da sessão (mínimo 32 caracteres) |
| `FLOW_SESSION_TTL_MINUTES` | Validade da sessão (padrão 60) |
| `FLOW_HASH_SALT` | Sal do hash do número do pedido no rastreamento (não trocar depois de em uso) |
| `WEBVIEW_API_SECRET` | Protege o `send-webview`. Cadastre o header no bot antes de definir |
| `BOT_API_SECRET` | Liga e protege a API do bot (`/api/bot/reverse/*`). Vazio = API desligada |
| `BOT_TICKET_TAG` | Tag de canal do ticket com fotos vindo do bot (padrão `canal_whatsapp`) |
| `TRUST_PROXY_HOPS` | Proxies na frente do app (padrão 1, o do Render), para os limites por IP |

## Endpoints

| Rota | Uso |
| --- | --- |
| `GET /reverse` | Página da webview |
| `POST /api/reverse/session` | Valida a sessão; devolve marca e recursos liberados (`features.photos`) |
| `POST /api/reverse/prepare` | Identifica o pedido (motivos, itens, endereço, reversas existentes) |
| `POST /api/reverse/retention` | Oferta de vale-compras (só devolução) |
| `POST /api/reverse/quote` | Opções de envio, cada uma com token assinado |
| `POST /api/reverse/submit` | Cria a reversa (JSON, ou multipart com fotos) |
| `POST /api/reverse/track` | Status das solicitações |
| `POST /api/reverse/finish` | Mensagem de fim do acompanhamento |
| `POST /api/reverse/handoff` | Mensagem com o botão "Falar com atendente" |
| `POST /api/flow/events` | Eventos de rastreamento do navegador |

- **Sessão:** todos os `POST` exigem `X-Flow-Token`. O `sendBeacon` de saída manda `_token` no corpo.
- **Erros:** vêm como `{success: false, code, error, action}`. `error` é o texto para o cliente; `action` diz o que a tela oferece: `retry`, `fix_input`, `track`, `refresh_retention`, `requote`, `retry_without_address`, `handoff` ou `close`.

## API do bot (WhatsApp)

Para o agente de IA do Zendesk montar o fluxo sem webview. Usa o mesmo serviço do webview (mesmas regras), mas responde em JSON plano para o Ultimate mapear em variáveis.

- **Autenticação:** header `X-Api-Secret: <BOT_API_SECRET>`. Sem a variável, a API responde 503.
- **Sempre HTTP 200**, com `{ok, next, code?, field?, message?}`. O fluxo decide pelo `next`: `continue`, `retry`, `fix_input` (perguntar de novo o `field`), `handoff` (com `handoff_reason`), `track`, `quote`, `retention`, `summary`, `address` ou `close`. Só 401 (segredo errado), 503 (API desligada) e 400 (JSON inválido) fogem disso.
- **Nada fica no servidor:** cada chamada leva o corpo base mais as escolhas acumuladas.
- **Escolhas por número:** `item_option`, `reason_option`, `sub_reason_option`, `shipping_option` e `pix_type` aceitam `2` ou `"2"` (posição na lista numerada da etapa anterior).
- **Nada é postado na conversa:** quem responde ao cliente é o bot, com o `message` ou os campos `*_text`.
- **Limites desta versão:** um produto por solicitação; reembolso só por PIX; pedido sem CPF ou e-mail no cadastro vai para atendente. Motivo com foto segue pelo bot quando as fotos estão ligadas (`REVERSE_PHOTOS_ENABLED`); desligadas, vai para atendente.

Corpo base de todas as rotas: `conversation_id`, `store` (`mizuno`, `olympikus`, `underarmour`), `order_number`, `customer_identifier` (CPF, CNPJ ou e-mail).

| Rota `POST /api/bot/reverse/...` | Corpo além do base | Principais campos da resposta |
| --- | --- | --- |
| `lookup` | nada | `eligible`, `first_name`, `items_count`, `items_text`, `item_N_name`, `existing_count`, `existing_text`, `address_mode` (`none`, `confirm`, `ask_full_address`), `address_text`, `is_bank_transfer`, `pix_types_text` |
| `reasons` | `type` (`troca`/`devolução` ou `exchange`/`refund`), `item_option` | `reasons_count`, `reasons_text`, `item_max_quantity` |
| `reason_detail` | + `reason_option` | `goes_to_agent`, `requires_photo`, `has_sub_reasons`, `sub_reasons_text`, `requires_comment`. Com foto: `next: "photos"`, `photo_text`, `photo_token` |
| `photos` | + `photo_token` | `photos_count` (imagens recebidas desde o pedido). Nenhuma: `PHOTO_REQUIRED` |
| `retention` | + `sub_reason_option`, `comment`, `quantity` | `available`, `mode`, `must_choose`, `offer_text`, `has_better_offer`, `better_offer_text`, `needs_pix_if_declined` |
| `quote` | + endereço (abaixo), `retention_accepted` | `options_count`, `options_text` |
| `summary` | + `shipping_option`, `retention_level`, `pix_type`, `pix_key`, `address_confirmed` | `summary_text`, `confirmation_token` |
| `submit` | tudo do `summary` + `confirmation_token` (+ `photo_resume` numa nova tentativa) | `reverse_order_id`, `message`, `posting_code`, `posting_due_date`, `carrier`, `tracking_url`, `replayed` |
| `track` | nada | `reverses_count`, `track_text` |

- **Endereço:** se `address_mode` for `confirm`, mostrar `address_text` e perguntar. Se o cliente confirmar, envie `address_confirmed: "sim"`. Se não (ou em `ask_full_address`), envie `address_zipcode`, `address_street`, `address_number`, `address_neighborhood`, `address_city`, `address_state` e, opcionalmente, `address_complement`.
- **Fotos:** o cliente manda as imagens na própria conversa. O servidor lista as mensagens pelo Sunshine e usa as imagens do cliente enviadas depois do `photo_token` (até 10, as mais recentes). Nada é baixado nem enviado antes do `submit`; aí o servidor baixa, confere se é JPEG, PNG ou WebP e segue o caminho do webview (ticket resolvido com a tag `canal_whatsapp`, URLs no `image_url`). Se a criação falhar depois do ticket, o erro traz `photo_resume`: envie de volta no próximo `submit` para não duplicar ticket nem fotos. Todas as chamadas depois do pedido de foto levam o `photo_token`.
- **Confirmação:** o `submit` só cria com o `confirmation_token` do `summary`. Se qualquer escolha mudou depois do resumo, ele responde `CONFIRMATION_REQUIRED` com `next: "summary"`. Repetir o `submit` devolve a mesma solicitação (`replayed: true`).

## Regras que não podem mudar

- **Prazos:** nunca recalcular os de 10 e 30 dias. Motivo listado pelo Troque é motivo que o cliente pode usar.
- **Ferramentas proibidas:** nunca usar `list_reverse_orders`, `get_reverse_order`, `create_order_exception` nem `resend_shipping_email`.
- **Criação:** só depois da confirmação do cliente, e nunca repetida às cegas. Resposta incerta (`CREATION_UNCONFIRMED`): comparar `existing_reverses` antes e depois.
- **Fotos:** só sobem na confirmação final, junto com a criação do ticket.
- **Textos do Troque:** nunca mostrar ao cliente a `message` nem o `next_step`.
- **Dados pessoais:** nunca em log, URL, ticket público, README ou testes. CPF e e-mail ficam só na memória do navegador.

## Fotos e ticket

- **Interface:** o armazenamento das fotos (ImageStorage) fica em `lib/storage/zendeskAttachments.js`. Para trocar por um bucket (S3 ou R2), basta outra implementação com `isEnabled`, `store` e `addNote`.
- **Ticket:**
  - já nasce resolvido, com nota interna;
  - leva o formulário e a marca configurados, e as tags `troca_devolucao_webview` e `marca_<marca>`;
  - dados do cliente mascarados: primeiro nome, documento e e-mail como o Troque devolve.
- **URL das fotos:** sai dos anexos do primeiro comentário do ticket e vai ao Troque em `image_url`. Depois da criação, uma segunda nota registra o resultado ou o código do erro.
- **Falha na criação:** o navegador recebe `photo_resume`, um token assinado com o ticket e as URLs. A nova tentativa não reenvia as fotos nem cria outro ticket.

## Limites

| Escopo | Limite |
| --- | --- |
| Por IP, todo o fluxo | 300 requisições / 5 min |
| Por conversa: consulta (`prepare`, `track`) | 30 / 10 min |
| Por conversa: retenção e cotação | 30 / 10 min |
| Por conversa: envio (`submit`) | 10 / 10 min |
| Por conversa: mensagens (`finish`, `handoff`) | 10 / 10 min |
| Por conversa: sessão e eventos | 30 e 200 / 10 min |
| Pedido não encontrado | 5 por conversa / 30 min |
| Chamadas ao Troque (todas as marcas) | 60 / 10 s (o Troque aceita 70 por IP) |

Os contadores ficam em memória. Com mais de uma instância, cada uma conta separado: para escalar, troque por Redis.

## Rastreamento

Cada evento é uma linha JSON no log com `"kind":"flow_event"`. Para ver uma jornada no Render, filtre por `flow_event` e pelo `session_id`.

- **Campos:** `ts`, `source` (client ou server), `session_id`, `conversation_id`, `brand`, `seq`, `step`, `event`, `duration_ms`, `error_code` e `meta`.
- **Eventos:**
  - `webview_opened`, `step_viewed`, `step_completed`, `step_back`;
  - `validation_error`, `api_call`, `photo_added`, `photo_removed`;
  - `ticket_created`, `reverse_created`, `completed`;
  - `handoff_requested`, `abandoned`, `error_shown`.
- **Privacidade:**
  - o número do pedido vai só como hash (`order_hash`);
  - chaves de `meta` com nome de dado pessoal (cpf, email, nome, endereço, pix, banco, comentário, token...) são descartadas.

## Operação

- **Ligar ou desligar fotos:** `REVERSE_PHOTOS_ENABLED`.
- **Mandar um motivo para o atendente:** acrescente o texto em `REVERSE_HANDOFF_REASONS`. Vale sem deploy de código, só reinício.
- **Nova marca no Troque:** defina `TROQUE_<MARCA>_TOKEN`, `ZENDESK_BRAND_ID_<MARCA>` e, se quiser, `ZENDESK_TICKET_FORM_ID_<MARCA>`.
- **Token do Troque inválido:** o log mostra `falhou com UNAUTHORIZED (marca ...)`, e o cliente é levado ao atendente.
- **Ticket recusado por falta de responsável:** defina `ZENDESK_TICKET_ASSIGNEE_ID`.
- **Plano gratuito do Render:** o serviço dorme sem acesso, e o primeiro acesso demora cerca de 50 s. Os contadores em memória zeram a cada reinício.

## Testes

```bash
npm test
```

Os testes usam só valores fictícios (`test/helpers.js`) e um Troque, um Zendesk e um Sunshine falsos. Nenhum teste chama serviço externo.

### Checklist por canal (manual, antes de cada liberação)

| Verificação | Widget web | App iOS (SDK) | App Android (SDK) | WhatsApp (link fallback no navegador) |
| --- | --- | --- | --- | --- |
| Botão abre a webview no tamanho alto | | | | abre no navegador |
| Título e botão voltar no cabeçalho | | | | |
| Troca completa até o resultado | | | | |
| Devolução com retenção e PIX | | | | |
| Foto pela câmera (Tirar foto) | | | | |
| Foto pela galeria (várias de uma vez) | | | | |
| Foto em HEIC (iPhone) chega como JPEG | | | | |
| Mensagem final aparece na conversa | | | | volta ao app e confere |
| "Fechar" fecha a webview | | | | mostra "pode fechar esta página" |
| "Falar com atendente" posta o botão e o bot transfere | | | | |
| Sessão vencida (60 min) mostra aviso e não quebra | | | | |
| Funil da sessão aparece no log (`flow_event`) | | | | |
