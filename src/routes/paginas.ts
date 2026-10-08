import { Router, type Response } from 'express';
import { pool } from '../db/pool.js';
import { homePath } from '../lib/permissions.js';
import { requireLogin, requirePermission } from '../middleware.js';

export const paginasRouter = Router();

paginasRouter.get('/', requireLogin, (req, res) => {
  res.redirect(homePath(req.user!));
});

paginasRouter.get('/inicio', requirePermission('inicio'), async (_req, res) => {
  const { rows: recentes } = await pool.query(
    `SELECT e.created_at, e.description, u.name AS author
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT 15`,
  );
  res.render('inicio', { title: 'Início', recentes });
});

// Telas que ainda serão construídas nas próximas etapas
const emBreve = (title: string, etapa: string, texto: string) => (_req: unknown, res: Response) =>
  res.render('em-breve', { title, etapa, texto });

paginasRouter.get('/leads', requirePermission('leads'), emBreve('Novo lead', 'Etapa 3', 'Aqui ficarão a tela "Novo lead" e a lista dos leads que você criou.'));
paginasRouter.get('/funil', requirePermission('funil'), emBreve('Funil de vendas', 'Etapa 3', 'Aqui ficarão o funil em colunas e a aba Prospecção.'));
paginasRouter.get('/clientes', requirePermission('clientes'), emBreve('Clientes', 'Etapa 2', 'Aqui ficarão as fichas dos clientes.'));
paginasRouter.get('/orcamentos', requirePermission('orcamentos'), emBreve('Orçamentos', 'Etapa 4', 'Aqui ficarão os orçamentos e o link para o cliente.'));
paginasRouter.get('/pedidos', requirePermission('pedidos'), emBreve('Pedidos', 'Etapa 5', 'Aqui ficarão os pedidos, pagamento e confirmação.'));
paginasRouter.get('/financeiro', requirePermission('financeiro'), emBreve('Financeiro', 'Etapa 5', 'Aqui ficarão as filas "Pix solicitados" e "Comprovantes".'));
paginasRouter.get('/producao', requirePermission('producao'), emBreve('Produção', 'Etapa 6', 'Aqui ficará o painel de produção com as OPs.'));
paginasRouter.get('/configuracoes', requirePermission('configuracoes'), emBreve('Cadastros e configurações', 'Etapa 2', 'Aqui ficarão produtos, origens, formas de pagamento, regras e textos prontos.'));
