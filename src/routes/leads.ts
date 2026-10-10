import { Router, type Request } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { saveUploadedFile } from '../lib/files.js';
import { addCalendarDays as addDays, parseIsoDate, todayIso } from '../lib/dates.js';
import { CLASSIFICATION_LABELS, leadSummary, listQuestions, type Answer } from '../lib/sdr.js';
import { getSettings } from '../lib/settings.js';
import {
  CHANNEL_LABELS, STAGES, findCustomerByPhone, formatPhone, isStage, listOrigins, stageLabel, upsertCustomer, validPhone, whatsappLink,
} from '../lib/leads.js';
import { notifyWhoCan } from '../lib/notifications.js';
import { can } from '../lib/permissions.js';
import { flash, requirePermission } from '../middleware.js';

export const leadsRouter = Router();
leadsRouter.use('/leads', requirePermission('leads'));

const helpers = { formatPhone, stageLabel, whatsappLink, CHANNEL_LABELS, STAGES, CLASSIFICATION_LABELS };

interface LeadForm { phone: string; name: string; originId: string; product: string; quantity: string; notes: string }

function readForm(req: Request): LeadForm {
  const s = (k: string) => String(req.body[k] ?? '').trim();
  return { phone: s('telefone'), name: s('nome'), originId: s('origem'), product: s('produto'), quantity: s('quantidade'), notes: s('observacoes') };
}

const emptyForm: LeadForm = { phone: '', name: '', originId: '', product: '', quantity: '', notes: '' };

/** Quem vê o funil vê todos os leads; os outros (ex.: Danielson) só os que criaram. */
async function loadLeads(req: Request) {
  const all = can(req.user!, 'funil');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (!all) add('l.created_by = ?', req.user!.id);
  const f = {
    origem: String(req.query.origem ?? ''),
    etapa: String(req.query.etapa ?? ''),
    classe: String(req.query.classe ?? ''),
    busca: String(req.query.busca ?? '').trim(),
    periodo: String(req.query.periodo ?? ''),
  };
  if (all) {
    if (/^\d+$/.test(f.origem)) add('l.origin_id = ?', Number(f.origem));
    if (isStage(f.etapa)) add('l.stage = ?', f.etapa);
    if (f.classe in CLASSIFICATION_LABELS) add('l.classification = ?', f.classe);
    if (f.periodo === 'hoje') where.push('l.created_at >= current_date');
    else if (f.periodo === '7') where.push(`l.created_at >= current_date - interval '6 days'`);
    else if (f.periodo === '30') where.push(`l.created_at >= current_date - interval '29 days'`);
    if (f.busca) {
      const digits = f.busca.replace(/\D/g, '');
      params.push(`%${f.busca}%`);
      const n = params.length;
      if (digits.length >= 4) {
        params.push(`%${digits}%`);
        where.push(`(c.name ILIKE $${n} OR l.product ILIKE $${n} OR c.phone LIKE $${params.length})`);
      } else {
        where.push(`(c.name ILIKE $${n} OR l.product ILIKE $${n})`);
      }
    }
  }
  const { rows } = await pool.query(
    `SELECT l.id, l.stage, l.product, l.quantity, l.channel, l.created_at, l.print_file_id, l.score, l.classification,
            c.phone, c.name AS customer_name, o.name AS origin, COALESCE(u.name, i.name) AS creator, a.name AS assignee
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN origins o ON o.id = l.origin_id
       LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN integrations i ON i.id = l.integration_id
       LEFT JOIN users a ON a.id = l.assigned_to
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC
      LIMIT 200`,
    params,
  );
  return { leads: rows, all, filtros: f };
}

async function renderPage(req: Request, res: import('express').Response, form: LeadForm, error: string | null, status = 200) {
  const { leads, all, filtros } = await loadLeads(req);
  res.status(status).render('leads/lista', {
    ...helpers, title: all ? 'Leads' : 'Novo lead', form, error, leads, all, filtros, origins: await listOrigins(),
  });
}

leadsRouter.get('/leads', async (req, res) => {
  await renderPage(req, res, emptyForm, null);
});

/** Aviso ao digitar o telefone: já existe cliente com este número? */
leadsRouter.get('/leads/telefone', async (req, res) => {
  const phone = validPhone(String(req.query.tel ?? ''));
  if (!phone) return res.json({ valido: false });
  const c = await findCustomerByPhone(phone);
  res.json({ valido: true, existe: !!c, nome: c?.name ?? null });
});

leadsRouter.post('/leads', async (req, res) => {
  const form = readForm(req);
  const phone = validPhone(form.phone);
  const origins = await listOrigins();
  const origin = origins.find((o) => String(o.id) === form.originId);
  const quantity = form.quantity ? Number(form.quantity) : null;
  let error: string | null = null;
  if (!phone) error = 'Informe o telefone com DDD (10 ou 11 números).';
  else if (!origin) error = 'Escolha a loja de origem.';
  else if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) error = 'A quantidade precisa ser um número inteiro maior que zero.';
  if (error) return renderPage(req, res, form, error, 400);

  const user = req.user!;
  const result = await withTransaction(async (db) => {
    const file = await saveUploadedFile(req, 'print_lead', db);
    if (file.error) return { error: file.error };
    const { customer, existed } = await upsertCustomer(phone!, form.name || null, user.id, db);
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO leads (customer_id, origin_id, channel, product, quantity, notes, print_file_id, created_by)
       VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7) RETURNING id`,
      [customer.id, origin!.id, form.product || null, quantity, form.notes || null, file.id, user.id],
    );
    const leadId = rows[0].id;
    const who = customer.name || formatPhone(customer.phone);
    await recordEvent({
      userId: user.id, entityType: 'lead', entityId: leadId, action: 'criado',
      description: `Cadastrou o lead ${who} (${origin!.name})${existed ? ' — telefone já cadastrado, ligado ao cliente existente' : ''}`,
      data: { customer_id: customer.id, origin: origin!.name, product: form.product, quantity }, ip: req.ip,
    }, db);
    await notifyWhoCan('funil', `Novo lead: ${who} · ${origin!.name} (por ${user.name})`, `/leads/${leadId}`, { exceptUserId: user.id }, db);
    return { leadId, existed, who };
  });
  if ('error' in result) return renderPage(req, res, form, result.error!, 400);
  flash(req, 'sucesso', result.existed
    ? `Lead salvo. Atenção: o telefone já estava cadastrado (${result.who}); o lead foi ligado a esse cliente.`
    : 'Lead salvo e avisado ao comercial.');
  res.redirect('/leads');
});

async function loadLead(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(
    `SELECT l.*, c.phone, c.email, c.name AS customer_name, o.name AS origin, COALESCE(u.name, i.name) AS creator, a.name AS assignee
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN origins o ON o.id = l.origin_id
       LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN integrations i ON i.id = l.integration_id
       LEFT JOIN users a ON a.id = l.assigned_to
      WHERE l.id = $1`,
    [id],
  );
  const lead = rows[0];
  if (!lead) return null;
  if (!can(req.user!, 'funil') && lead.created_by !== req.user!.id) return null;
  return lead;
}

const notFound = { title: 'Não encontrado', message: 'Lead não encontrado.', backUrl: '/leads' };

leadsRouter.get('/leads/:id', async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  const [{ rows: history }, { rows: outros }, { rows: recontatos }, settings] = await Promise.all([
    pool.query(
      `SELECT e.created_at, e.description, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.entity_type = 'lead' AND e.entity_id = $1 ORDER BY e.created_at DESC LIMIT 50`,
      [String(lead.id)],
    ),
    pool.query(
      `SELECT l.id, l.created_at, l.product, l.stage, o.name AS origin FROM leads l JOIN origins o ON o.id = l.origin_id
        WHERE l.customer_id = $1 AND l.id <> $2 AND ($3::int IS NULL OR l.created_by = $3) ORDER BY l.created_at DESC`,
      // Quem não vê o funil (ex.: Danielson) só enxerga os leads que ele mesmo cadastrou
      [lead.customer_id, lead.id, can(req.user!, 'funil') ? null : req.user!.id],
    ),
    pool.query(
      `SELECT r.*, u.name AS done_by_name FROM recontacts r LEFT JOIN users u ON u.id = r.done_by
        WHERE r.lead_id = $1 ORDER BY r.due_date DESC`,
      [lead.id],
    ),
    getSettings(),
  ]);
  // Mostra as respostas na ordem das perguntas (o banco guarda em ordem alfabética)
  const order = (await listQuestions(false)).map((q) => q.key);
  const raw: Record<string, Answer> = lead.data?.qualificacao ?? {};
  const answers = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999)));
  const resumo = leadSummary({ name: lead.customer_name, phone: lead.phone, product: lead.product, quantity: lead.quantity }, answers, lead.score);
  res.render('leads/ficha', { ...helpers, title: `Lead ${lead.customer_name || formatPhone(lead.phone)}`, lead, history, outros, recontatos, answers, resumo, amanha: addDays(todayIso(), 1), comercialPhone: validPhone(settings.whatsapp_comercial), canManage: can(req.user!, 'funil'), canSell: can(req.user!, 'pedidos') });
});

leadsRouter.post('/leads/:id/etapa', requirePermission('funil'), async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  const stage = String(req.body.etapa ?? '');
  const reason = String(req.body.motivo ?? '').trim();
  if (!isStage(stage)) {
    flash(req, 'erro', 'Escolha uma etapa.');
    return res.redirect(`/leads/${lead.id}`);
  }
  if (stage === 'perdido' && !reason) {
    flash(req, 'erro', 'Para marcar como Perdido, informe o motivo.');
    return res.redirect(`/leads/${lead.id}`);
  }
  if (stage !== lead.stage) {
    await pool.query(
      'UPDATE leads SET stage = $2, lost_reason = $3, updated_at = now() WHERE id = $1',
      [lead.id, stage, stage === 'perdido' ? reason : null],
    );
    await recordEvent({
      userId: req.user!.id, entityType: 'lead', entityId: lead.id, action: 'etapa_alterada',
      description: `Mudou a etapa: ${stageLabel(lead.stage)} → ${stageLabel(stage)}${stage === 'perdido' ? ` (motivo: ${reason})` : ''}`,
      data: { de: lead.stage, para: stage, motivo: reason || undefined }, ip: req.ip,
    });
    flash(req, 'sucesso', 'Etapa atualizada.');
  }
  res.redirect(`/leads/${lead.id}`);
});

leadsRouter.post('/leads/:id/assumir', requirePermission('funil'), async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  const user = req.user!;
  await pool.query(
    `UPDATE leads SET assigned_to = $2, stage = CASE WHEN stage = 'novo_lead' THEN 'atendimento' ELSE stage END, updated_at = now() WHERE id = $1`,
    [lead.id, user.id],
  );
  await recordEvent({
    userId: user.id, entityType: 'lead', entityId: lead.id, action: 'assumido',
    description: `Assumiu o atendimento${lead.stage === 'novo_lead' ? ' (etapa: Atendimento)' : ''}`, ip: req.ip,
  });
  flash(req, 'sucesso', 'Você assumiu este lead.');
  res.redirect(`/leads/${lead.id}`);
});

/** Recontato só com consentimento do cliente registrado (regra de ouro: o SDR nunca inicia contato). */
leadsRouter.post('/leads/:id/recontato', requirePermission('funil'), async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  const date = parseIsoDate(req.body.data);
  const consent = String(req.body.consentimento ?? '').trim();
  const note = String(req.body.obs ?? '').trim();
  let error: string | null = null;
  if (lead.opt_out_at) error = 'Este cliente pediu para não ser chamado. Não é possível agendar recontato.';
  else if (!date || date <= todayIso()) error = 'Escolha uma data futura para o recontato.';
  else if (req.body.autorizou !== 'on' || !consent) error = 'Só agende se o cliente pediu ou autorizou. Marque a caixa e escreva o que ele disse.';
  if (error) {
    flash(req, 'erro', error);
    return res.redirect(`/leads/${lead.id}`);
  }
  await pool.query(
    'INSERT INTO recontacts (lead_id, due_date, note, consent_text, created_by) VALUES ($1, $2, $3, $4, $5)',
    [lead.id, date, note || null, consent.slice(0, 500), req.user!.id],
  );
  await recordEvent({
    userId: req.user!.id, entityType: 'lead', entityId: lead.id, action: 'recontato_agendado',
    description: `Agendou recontato para ${date!.split('-').reverse().join('/')} (cliente disse: "${consent}")`, ip: req.ip,
  });
  flash(req, 'sucesso', 'Recontato agendado. No dia, o comercial recebe um aviso.');
  res.redirect(`/leads/${lead.id}`);
});

leadsRouter.post('/leads/:id/recontato/:rid', requirePermission('funil'), async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  const status = req.body.acao === 'feito' ? 'feito' : 'cancelado';
  const { rowCount } = await pool.query(
    `UPDATE recontacts SET status = $3, done_at = now(), done_by = $4 WHERE id = $1 AND lead_id = $2 AND status = 'agendado'`,
    [Number(req.params.rid) || 0, lead.id, status, req.user!.id],
  );
  if (rowCount) {
    await recordEvent({ userId: req.user!.id, entityType: 'lead', entityId: lead.id, action: `recontato_${status}`, description: status === 'feito' ? 'Marcou o recontato como feito' : 'Cancelou o recontato', ip: req.ip });
  }
  res.redirect(`/leads/${lead.id}`);
});

/** Cliente pediu para sair: nunca mais recebe recontato. */
leadsRouter.post('/leads/:id/sair', requirePermission('funil'), async (req, res) => {
  const lead = await loadLead(req);
  if (!lead) return res.status(404).render('erro', notFound);
  await withTransaction(async (db) => {
    await db.query('UPDATE leads SET opt_out_at = COALESCE(opt_out_at, now()) WHERE customer_id = $1', [lead.customer_id]);
    await db.query(`UPDATE recontacts r SET status = 'cancelado' FROM leads l WHERE r.lead_id = l.id AND l.customer_id = $1 AND r.status = 'agendado'`, [lead.customer_id]);
    await recordEvent({ userId: req.user!.id, entityType: 'lead', entityId: lead.id, action: 'opt_out', description: 'Registrou que o cliente não quer mais ser chamado (recontatos cancelados)', ip: req.ip }, db);
  });
  flash(req, 'sucesso', 'Registrado: este cliente não recebe mais recontatos.');
  res.redirect(`/leads/${lead.id}`);
});
