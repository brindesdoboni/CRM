import { Router, type Response } from 'express';
import { pool } from '../db/pool.js';
import { formatPhone, stageLabel, whatsappLink } from '../lib/leads.js';
import { homePath } from '../lib/permissions.js';
import { requireLogin, requirePermission } from '../middleware.js';

export const paginasRouter = Router();

paginasRouter.get('/', requireLogin, (req, res) => {
  res.redirect(homePath(req.user!));
});

/** Painel único: tudo o que entrou, de todas as origens, numa página só. */
paginasRouter.get('/inicio', requirePermission('inicio'), async (_req, res) => {
  const [contadores, porOrigem, ultimos, producao, recentes, recontatos] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE created_at >= current_date)::int AS hoje,
              count(*) FILTER (WHERE created_at >= current_date - interval '6 days')::int AS semana,
              count(*) FILTER (WHERE stage = 'novo_lead')::int AS sem_atendimento,
              count(*) FILTER (WHERE stage = 'novo_lead' AND created_at < now() - interval '2 hours')::int AS esperando,
              count(*) FILTER (WHERE classification = 'quente' AND stage IN ('novo_lead', 'atendimento'))::int AS quentes
         FROM leads`,
    ),
    pool.query(
      `SELECT o.id, o.name, count(l.id)::int AS n
         FROM origins o LEFT JOIN leads l ON l.origin_id = o.id AND l.created_at >= current_date - interval '29 days'
        GROUP BY o.id, o.name, o.position HAVING count(l.id) > 0 ORDER BY n DESC, o.position`,
    ),
    pool.query(
      `SELECT l.id, l.stage, l.product, l.quantity, l.created_at, l.classification, l.score, c.phone, c.name AS customer_name, o.name AS origin, a.name AS assignee
         FROM leads l JOIN customers c ON c.id = l.customer_id JOIN origins o ON o.id = l.origin_id
         LEFT JOIN users a ON a.id = l.assigned_to
        ORDER BY l.created_at DESC LIMIT 12`,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status <> 'concluida')::int AS abertas,
              count(*) FILTER (WHERE status <> 'concluida' AND due_date < current_date)::int AS atrasadas,
              count(*) FILTER (WHERE status <> 'concluida' AND due_date = current_date)::int AS hoje,
              count(*) FILTER (WHERE status = 'pausada')::int AS pausadas
         FROM sales`,
    ),
    pool.query(
      `SELECT e.created_at, e.description, u.name AS author
         FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.action NOT IN ('login', 'logout', 'login_falhou')
        ORDER BY e.created_at DESC LIMIT 15`,
    ),
    pool.query(
      `SELECT r.id, r.due_date, r.note, r.consent_text, r.sent_auto_at, l.id AS lead_id, c.name, c.phone
         FROM recontacts r JOIN leads l ON l.id = r.lead_id JOIN customers c ON c.id = l.customer_id
        WHERE r.status = 'agendado' AND r.due_date <= current_date AND l.opt_out_at IS NULL
        ORDER BY r.due_date LIMIT 20`,
    ),
  ]);
  res.render('inicio', {
    title: 'Início', c: contadores.rows[0], porOrigem: porOrigem.rows, ultimos: ultimos.rows, prod: producao.rows[0],
    recentes: recentes.rows, recontatos: recontatos.rows, formatPhone, stageLabel, whatsappLink,
  });
});

// Telas que ainda serão construídas nas próximas etapas
const emBreve = (title: string, etapa: string, texto: string) => (_req: unknown, res: Response) =>
  res.render('em-breve', { title, etapa, texto });

paginasRouter.get('/funil', requirePermission('funil'), emBreve('Funil de vendas', 'Semana 2', 'Aqui ficarão o funil em colunas (arrastar muda a etapa) e a aba Prospecção. Por enquanto, mude a etapa na ficha de cada lead.'));
paginasRouter.get('/clientes', requirePermission('clientes'), emBreve('Clientes', 'Semana 2', 'Aqui ficarão as fichas dos clientes.'));
paginasRouter.get('/orcamentos', requirePermission('orcamentos'), emBreve('Orçamentos', 'Semana 2', 'Aqui ficarão os orçamentos e o link para o cliente.'));
paginasRouter.get('/financeiro', requirePermission('financeiro'), emBreve('Financeiro', 'Semana 2', 'Aqui ficarão as filas "Pix solicitados" e "Comprovantes".'));
