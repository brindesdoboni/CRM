# CRM Brindes DoBoni

Sistema interno de vendas e produção dos pedidos **diretos** da Brindes DoBoni.
As regras completas do projeto estão em [CLAUDE.md](CLAUDE.md).

## Situação

- [x] **Etapa 1** — estrutura, banco, login e perfis (Admin, Lead, Financeiro, Produção), permissões por pessoa (o Admin escolhe o que cada um vê), histórico de eventos
- [ ] Etapa 2 — cadastros/configurações e clientes
- [ ] Etapa 3 — novo lead, funil e prospecção
- [ ] Etapa 4 — orçamento + página pública
- [ ] Etapa 5 — pedido, financeiro, confirmação versionada + PDF
- [ ] Etapa 6 — painel de produção
- [ ] Etapa 7 — cotação SuperFrete (Sandbox)

## Tecnologia

Node.js 22 + TypeScript, Express, PostgreSQL, telas em EJS (geradas no servidor).
Senhas com hash bcrypt; sessão guardada no banco; proteção CSRF nos formulários;
limite de tentativas de login. Fuso America/Sao_Paulo.

## Variáveis de ambiente (Railway → serviço → Variables)

| Variável | Para quê |
| --- | --- |
| `DATABASE_URL` | Endereço do PostgreSQL. No Railway use `${{Postgres.DATABASE_URL}}` |
| `SESSION_SECRET` | Frase secreta longa (32+ caracteres) para proteger o login |
| `NODE_ENV` | `production` |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Criam o primeiro Admin quando o banco está vazio. Depois do primeiro acesso, troque a senha em "Minha conta" e pode apagar `ADMIN_PASSWORD` |

## Rodando no computador (para quem programa)

```bash
cp .env.example .env      # preencha os valores
npm install
npm run dev               # http://localhost:3000
npm test                  # usa o banco postgres://crm:crm@localhost:5432/crm_test
```

As mudanças no banco ficam em `migrations/*.sql` e são aplicadas sozinhas quando o sistema inicia.
