# CRM Brindes DoBoni

Sistema interno de vendas e produção dos pedidos **diretos** da Brindes DoBoni.
As regras completas do projeto estão em [CLAUDE.md](CLAUDE.md).

## Situação

- [x] **Etapa 1** — estrutura, banco, login e perfis (Admin, Lead, Financeiro, Produção), permissões por pessoa (o Admin escolhe o que cada um vê), histórico de eventos
- [x] **Semana 1, D1-2** — painel único (Início com leads de todas as origens), perfil Comercial (Laura),
      tela "Novo lead" do Danielson (com print e aviso de telefone repetido), vendas para a produção,
      painel da Jô (OPs por prazo, arte, nomes, checklist, peso/medidas, CSV do LightBurn, "Tenho um problema"),
      sininho de avisos, origens editáveis
- [x] **Semana 1, D3** — entrada automática de leads (`POST /api/leads`) para o formulário do site e o ManyChat,
      com chave por integração (Configurações → Integrações), origem obrigatória e anti-duplicidade por telefone
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

## Entrada automática de leads (site, ManyChat)

Em **Cadastros e configurações → Integrações**, crie uma integração e copie o endereço com a chave.
A ferramenta manda `POST /api/leads` (JSON ou formulário) com a chave no cabeçalho `X-CRM-Token`
(ou `Authorization: Bearer …`, ou `?token=` no endereço). Campos: `telefone` (obrigatório), `nome`, `email`,
`produto`, `quantidade`, `mensagem`; outros campos vão para as observações. Se o cliente já tem um lead em
aberto nos últimos 30 dias, o novo contato entra nele em vez de criar outro.
