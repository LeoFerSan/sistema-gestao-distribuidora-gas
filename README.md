# MOS Campinho

Sistema de gestão operacional da Distribuidora de Gás Campinho (MOS — Manual Operacional e Sistema de Gestão).
Esta é a versão MVP: pedidos e despacho (M3/M4) e estoque (M5) funcionando; os demais módulos aparecem no menu, sem ações.

## Arquitetura

| Camada | Tecnologia |
|---|---|
| Hospedagem e API | Cloudflare Workers (`src/index.js`) |
| Banco de dados | Cloudflare D1 (SQLite), esquema em `migrations/` |
| Front-end | HTML, CSS e JavaScript sem framework (`public/`) |

## Segurança implementada

- Senhas com PBKDF2-SHA256 (100 mil iterações) e sal individual; nunca gravadas em texto.
- Sessão no servidor: cookie `HttpOnly`, `Secure`, `SameSite=Strict`. O banco guarda só o hash do token.
- Sessão expira após 15 min sem uso e, no máximo, após 12 h.
- 5 senhas erradas bloqueiam o usuário por 15 min.
- Senha provisória: troca obrigatória no primeiro acesso (mínimo de 10 caracteres, com letras e números).
- Proteção contra requisições de outros sites (verificação de origem + JSON obrigatório).
- Cabeçalhos de segurança: CSP restrita, HSTS, proibição de exibição em iframe.
- Trilha de auditoria (`audit_log`) para login, falhas, bloqueios, troca de senha e ajustes de estoque.
- Histórico por pedido (`order_events`) e por movimento de estoque (`stock_moves`).

## Primeira publicação

Pré-requisitos: Node.js 20 ou superior e uma conta Cloudflare.

```bash
npm install
npx wrangler login                     # abre o navegador para autorizar sua conta Cloudflare
npx wrangler d1 create mos-db          # copie o database_id exibido para o wrangler.toml
npm run db:migrate:remote              # cria as tabelas no banco de produção
npm run deploy                         # publica em https://mos-campinho.<sua-conta>.workers.dev
```

Crie os usuários (a senha é pedida no terminal e vale só para o primeiro acesso):

```bash
npm run user:create -- ceo "Leonardo" ceo --remote
npm run user:create -- alessandra "Alessandra" fundadora --remote
npm run user:create -- janine "Janine" atendimento --remote
```

O mesmo comando redefine a senha de quem esqueceu ou desbloqueia um usuário.

Depois do primeiro acesso, lance os saldos reais de água e acessórios na tela **Estoque → Ajustar** (o banco começa com as referências do MOS para GLP e zero para os demais).

## Desenvolvimento local

```bash
npm run db:migrate:local
npm run user:create -- ceo "CEO" ceo   # sem --remote = banco local
npm run dev                              # http://localhost:8787
```

## Domínio próprio (mos.lbhorizon.com.br)

1. No painel da Cloudflare, **Add a site** → `lbhorizon.com.br` (plano Free).
2. A Cloudflare mostra dois nameservers. No **Registro.br**, em *DNS → Alterar servidores DNS*, troque pelos dois da Cloudflare.
   Antes, confira se a Cloudflare importou todos os registros atuais (e-mail/MX, site), para nada sair do ar.
3. Quando o domínio aparecer como *Active*, descomente o bloco `routes` no `wrangler.toml` e rode `npm run deploy`.
   A Cloudflare cria o certificado HTTPS automaticamente.

## Estrutura

```
migrations/0001_inicial.sql   tabelas e dados de partida (produtos, estoque, entregadores)
scripts/create-user.mjs       criação e redefinição de usuários
src/index.js                  API, autenticação e regras de negócio
public/                       telas (index.html, app.js, styles.css)
```

## API

| Método | Rota | Uso |
|---|---|---|
| POST | `/api/login` · `/api/logout` | entrar / sair |
| GET | `/api/me` | usuário da sessão |
| POST | `/api/me/password` | trocar senha |
| GET | `/api/board` | pedidos abertos e entregues hoje, estoque, catálogos |
| POST | `/api/orders` | registrar pedido |
| GET | `/api/orders/:id` | pedido com histórico |
| POST | `/api/orders/:id/prepare` · `dispatch` · `deliver` · `cancel` | avançar etapa |
| POST | `/api/stock/:key/adjust` | ajuste de saldo com justificativa |

## Próximos passos sugeridos

- Tela de Equipe e permissões (criar usuários, desbloquear, consultar auditoria) para dispensar o terminal.
- Backups: o D1 tem recuperação de até 30 dias (*Time Travel*); avaliar exportação semanal adicional.
- Cadastro de entregadores pela interface.
- Módulo M6 (Compras) usando os alertas de estoque mínimo que já existem.
