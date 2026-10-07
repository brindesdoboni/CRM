import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ROLE_HOME } from '../lib/roles.js';
import { requireLogin, requireRole } from '../middleware.js';

export const paginasRouter = Router();

paginasRouter.get('/', requireLogin, (req, res) => {
  res.redirect(ROLE_HOME[req.user!.role]);
});

paginasRouter.get('/inicio', requireRole('admin'), async (_req, res) => {
  const { rows: recentes } = await pool.query(
    `SELECT e.created_at, e.description, u.name AS author
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT 15`,
  );
  res.render('inicio', { title: 'Início', recentes });
});

// Telas que ainda serão construídas nas próximas etapas
const emBreve = (title: string, etapa: string, texto: string) => (_req: unknown, res: import('express').Response) =>
  res.render('em-breve', { title, etapa, texto });

paginasRouter.get('/leads', requireRole('lead'), emBreve('Leads', 'Etapa 3', 'Aqui ficarão a tela "Novo lead" e a lista dos leads que você criou.'));
paginasRouter.get('/financeiro', requireRole('financeiro'), emBreve('Financeiro', 'Etapa 5', 'Aqui ficarão as filas "Pix solicitados" e "Comprovantes".'));
paginasRouter.get('/producao', requireRole('producao'), emBreve('Produção', 'Etapa 6', 'Aqui ficará o painel de produção com as OPs.'));
