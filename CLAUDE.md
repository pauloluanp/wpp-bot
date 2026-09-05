# wpp-bot — back-end / core do SaaS

Núcleo do SaaS. **Node (ESM) + Express + Drizzle ORM (Postgres/Neon)**. Gerencia usuários,
planos, pastas e **sessões de WhatsApp** (via Baileys), com integração ao **Telegram**.
Consumido pelo front [`robo-promos`](../robo-promos/CLAUDE.md).

## Comandos

```bash
npm run dev          # sobe a API em http://localhost:3001 (server.js, PORT fixa = 3001)
npm run start        # idem (produção)
npm run db:repair    # corrige/ajusta o schema (usar este, não o push)
npm run db:seed      # popula dados iniciais (ex.: planos)
npm run db:set-plan  # aplica plano a um usuário (troca de plano é feita por admin)
npm run db:generate  # drizzle-kit generate (gera migration a partir do schema)
```

> ⚠️ **Banco**: prefira `db:repair` / `db:seed` / `db:set-plan`. **Não** rode
> `drizzle-kit push` sem TTY (trava pedindo confirmação interativa). O banco de **produção é
> separado do de dev** e já esteve com schema defasado — cuidado ao mexer em migrations.

## Arquitetura (modular por domínio)

Cada módulo em `src/modules/<dominio>/` segue o padrão
`controller` → `service` → `repository`, montado por um `*.module.js` (factory):

- `users/` — cadastro, login, perfil, troca de senha.
- `plans/` — listagem de planos.
- `folders/` — pastas para organizar sessões/margens.
- `session/` — CRUD de sessões de WhatsApp, start/stop, QR Code, config, mensagens pendentes.

Outros pontos:
- `src/routes.js` — todas as rotas Express e onde o `authMiddleware` (JWT) é aplicado.
- `src/manager.js` — orquestra as conexões Baileys (WhatsApp) + bots Telegram em memória
  (Maps de sessões, QR codes, status, agendamento). Regras de envio: `MSG_PER_WINDOW`,
  `WINDOW_MS`, `DEFAULT_DELAY_MS`.

### Dois disparos manuais, com caminhos diferentes

- **Promoção** (`POST /sessions/:id/send` → `sendPromoMessage`): publica no grupo de
  **origem** e deixa o fluxo normal (`messages.upsert`) repassar, com conversão de link,
  convite da margem e agendamento anti-ban.
- **Aviso** (`POST /sessions/:id/send-notice` → `sendNoticeMessage`): vai **direto** aos
  grupos de destino. Não pode passar pela origem porque o repasse (a) descarta a mensagem
  em margem de conversão (sem link do ML/Shopee) e (b) `removeExistingGroupInvite` apagaria
  a linha do `chat.whatsapp.com`, que é o ponto central do aviso. Como não passa pelo
  agendador, tem ritmo próprio: `AVISO_TYPING_*` e `AVISO_GAP_*`.
  O card de convite é montado à mão (`montarLinkPreviewDeConvite`) — `link-preview-js` não
  é dependência do projeto, então texto puro **nunca** gera preview automático.
- `src/middlewares/auth.middleware.js` — valida JWT.
- `src/db/` — `schema.js` (tabelas: `plans`, `users`, `folders`, `sessions`), `index.js`
  (conexão), `repair-schema.js`, `seed.js`, `set-user-plan.js`.
- `drizzle/` — migrations geradas. `sessions/` — credenciais de auth do Baileys por sessão
  (arquivos locais; **não versionar/expor**).

## Planos e pagamento

- Planos: `básico`, `pro`, `premium`.
- **Troca de plano NÃO é self-service**: o pagamento vem antes; o usuário é encaminhado ao
  WhatsApp e o plano é aplicado por admin via `db:set-plan`. Não implemente upgrade
  automático sem alinhar isso.

## Config (.env)

Chaves esperadas (ver `.env.example`): `DB_HOST/USER/PASSWORD/NAME/PORT/SSL` (Neon),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_POLLING`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
`BCRYPT_SALT_ROUNDS`.

- `SHOPEE_APP_ID` / `SHOPEE_SECRET`: credenciais **globais** da Open API de afiliados da
  Shopee. Sem elas, a conversão de links da Shopee fica desligada (no-op). **Com elas, os
  links da Shopee são convertidos em TODAS as margens, independente do `convert_link`**
  (que continua sendo o gate só do Mercado Livre): margem fora do modo conversão troca o
  link da Shopee e repassa o resto da mensagem normalmente; produto Shopee fora do programa
  de afiliados não é enviado (fica só no log). Migração para credenciais por margem (como
  `ml_credentials` do Mercado Livre) está pendente. Opcionais com default:
  `SHOPEE_REQUEST_TIMEOUT`, `SHOPEE_CACHE_TTL_MS`, `SHOPEE_USER_AGENT`,
  `SHOPEE_SHORTLINK_HOSTS`, `SHOPEE_GRAPHQL_ENDPOINT`.
- Conversão de link do Mercado Livre (`src/lib/mercadoLivre/`) usa `ml_credentials` por
  margem; aceita tuners opcionais `ML_CACHE_TTL_MS`, `ML_USER_AGENT`, `ML_REQUEST_TIMEOUT`,
  `ML_AGGREGATOR_HOSTS`, `ML_IMAGE_HOSTS`.

## Produção

VPS em `sos.hyperpromos.com.br`. Banco de PROD é separado do de dev. Ao alterar schema,
lembre que PROD pode estar defasado (causa histórica de erros 502).
