import { Router, type Request } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { notifyWhoCan } from '../lib/notifications.js';
import { CHECKLIST, SALE_STATUS_LABELS, lightburnCsv, parseNames, parsePositive } from '../lib/sales.js';
import { flash, requirePermission } from '../middleware.js';

export const producaoRouter = Router();
producaoRouter.use('/producao', requirePermission('producao'));

producaoRouter.get('/producao', async (req, res) => {
  const concluidas = req.query.situacao === 'concluidas';
  const { rows: sales } = await pool.query(
    `SELECT s.id, s.code, s.customer_name, s.product, s.product_code, s.color, s.quantity, s.due_date, s.status, s.pause_reason,
            s.art_file_id, s.completed_at,
            s.due_date < current_date AS atrasada, s.due_date = current_date AS vence_hoje,
            (SELECT count(*)::int FROM sale_checklist k WHERE k.sale_id = s.id) AS feitos
       FROM sales s
      WHERE s.customer_approved AND ${concluidas ? `s.status = 'concluida'` : `s.status <> 'concluida'`}
      ORDER BY ${concluidas ? 's.completed_at DESC' : 's.due_date, s.id'}
      LIMIT 300`,
  );
  const resumo = {
    atrasadas: sales.filter((s) => !concluidas && s.atrasada).length,
    hoje: sales.filter((s) => !concluidas && s.vence_hoje).length,
    pausadas: sales.filter((s) => s.status === 'pausada').length,
  };
  res.render('producao/lista', { title: 'Produção', sales, concluidas, resumo, SALE_STATUS_LABELS });
});

/** A produção só enxerga vendas aprovadas pelo cliente, e nunca frete, pagamento ou custos. */
async function loadSale(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(
    `SELECT s.id, s.code, s.customer_name, s.lead_id, s.origin_id, s.product, s.product_code, s.color, s.quantity, s.font, s.names,
            s.art_file_id, s.notes, s.due_date, s.status, s.pause_reason, s.weight_kg, s.height_cm, s.width_cm, s.length_cm,
            s.completed_at, s.completed_by, s.created_at, s.updated_at, o.name AS origin, f.mime AS art_mime, s.due_date < current_date AS atrasada, s.due_date = current_date AS vence_hoje,
            cb.name AS completed_by_name
       FROM sales s JOIN origins o ON o.id = s.origin_id
       LEFT JOIN files f ON f.id = s.art_file_id
       LEFT JOIN users cb ON cb.id = s.completed_by
      WHERE s.id = $1 AND s.customer_approved`,
    [id],
  );
  return rows[0] ?? null;
}

const notFound = { title: 'Não encontrada', message: 'OP não encontrada.', backUrl: '/producao' };

producaoRouter.get('/producao/:id', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  const [{ rows: checks }, { rows: history }] = await Promise.all([
    pool.query(
      `SELECT k.item, k.done_at, u.name FROM sale_checklist k JOIN users u ON u.id = k.done_by WHERE k.sale_id = $1`,
      [sale.id],
    ),
    pool.query(
      `SELECT e.created_at, e.description, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.entity_type = 'venda' AND e.entity_id = $1 AND e.action NOT IN ('comercial', 'pdf') ORDER BY e.created_at DESC LIMIT 50`,
      [String(sale.id)],
    ),
  ]);
  const done = new Map(checks.map((c) => [c.item as number, c]));
  res.render('producao/op', {
    title: `OP ${sale.code}`, sale, names: parseNames(sale.names), CHECKLIST, done, history, SALE_STATUS_LABELS,
  });
});

function back(req: Request, res: import('express').Response) {
  res.redirect(`/producao/${req.params.id}`);
}

producaoRouter.post('/producao/:id/checklist', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  const item = Number(req.body.item);
  if (sale.status === 'concluida' || sale.status === 'pausada' || !Number.isInteger(item) || item < 1 || item > 8) {
    flash(req, 'erro', sale.status === 'pausada' ? 'A OP está pausada. Clique em "Retomar produção" primeiro.' : 'Não foi possível marcar este item.');
    return back(req, res);
  }
  const user = req.user!;
  if (item === 8 && req.body.marcar === '1' && !(sale.weight_kg && sale.height_cm && sale.width_cm && sale.length_cm)) {
    flash(req, 'erro', 'Preencha o peso e as medidas da embalagem antes de marcar o item 8.');
    return back(req, res);
  }
  await withTransaction(async (db) => {
    if (req.body.marcar === '1') {
      const { rowCount } = await db.query(
        'INSERT INTO sale_checklist (sale_id, item, done_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sale.id, item, user.id],
      );
      if (!rowCount) return;
      if (sale.status === 'aguardando') {
        await db.query(`UPDATE sales SET status = 'em_producao', updated_at = now() WHERE id = $1`, [sale.id]);
        if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'em_producao', updated_at = now() WHERE id = $1`, [sale.lead_id]);
      }
      await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'checklist', description: `Marcou "${item}. ${CHECKLIST[item - 1]}"`, ip: req.ip }, db);
    } else {
      const { rowCount } = await db.query('DELETE FROM sale_checklist WHERE sale_id = $1 AND item = $2', [sale.id, item]);
      if (rowCount) await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'checklist', description: `Desmarcou "${item}. ${CHECKLIST[item - 1]}"`, ip: req.ip }, db);
    }
  });
  back(req, res);
});

producaoRouter.post('/producao/:id/medidas', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  if (sale.status === 'concluida') return back(req, res);
  const v = {
    peso: parsePositive(req.body.peso), altura: parsePositive(req.body.altura),
    largura: parsePositive(req.body.largura), comprimento: parsePositive(req.body.comprimento),
  };
  if (Object.values(v).some((x) => x === null)) {
    flash(req, 'erro', 'Preencha peso (kg), altura, largura e comprimento (cm) com números maiores que zero.');
    return back(req, res);
  }
  await pool.query(
    'UPDATE sales SET weight_kg = $2, height_cm = $3, width_cm = $4, length_cm = $5, updated_at = now() WHERE id = $1',
    [sale.id, v.peso, v.altura, v.largura, v.comprimento],
  );
  await recordEvent({
    userId: req.user!.id, entityType: 'venda', entityId: sale.id, action: 'medidas',
    description: `Informou peso ${v.peso} kg e medidas ${v.altura} × ${v.largura} × ${v.comprimento} cm`, data: v, ip: req.ip,
  });
  flash(req, 'sucesso', 'Peso e medidas salvos.');
  back(req, res);
});

/** "Produção concluída" é sempre manual: só com os itens 1 a 8 marcados e peso + medidas preenchidos. */
producaoRouter.post('/producao/:id/concluir', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  if (sale.status === 'concluida') return back(req, res);
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sale_checklist WHERE sale_id = $1 AND item BETWEEN 1 AND 8', [sale.id]);
  if (sale.status === 'pausada') {
    flash(req, 'erro', 'A OP está pausada. Retome a produção antes de concluir.');
    return back(req, res);
  }
  if (rows[0].n < 8 || !(sale.weight_kg && sale.height_cm && sale.width_cm && sale.length_cm)) {
    flash(req, 'erro', 'Para concluir, marque os itens 1 a 8 do checklist e preencha peso e medidas.');
    return back(req, res);
  }
  const user = req.user!;
  await withTransaction(async (db) => {
    await db.query('INSERT INTO sale_checklist (sale_id, item, done_by) VALUES ($1, 9, $2) ON CONFLICT DO NOTHING', [sale.id, user.id]);
    await db.query(`UPDATE sales SET status = 'concluida', completed_at = now(), completed_by = $2, updated_at = now() WHERE id = $1`, [sale.id, user.id]);
    if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'aguardando_etiqueta', updated_at = now() WHERE id = $1`, [sale.lead_id]);
    await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'concluida', description: 'Concluiu a produção', ip: req.ip }, db);
    await notifyWhoCan('pedidos', `Produção concluída: ${sale.code} (${sale.customer_name}) — pronta para etiqueta`, `/pedidos/${sale.id}`, { exceptUserId: user.id }, db);
  });
  flash(req, 'sucesso', `Produção da ${sale.code} concluída.`);
  res.redirect('/producao');
});

producaoRouter.post('/producao/:id/problema', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  const reason = String(req.body.motivo ?? '').trim();
  if (!reason) {
    flash(req, 'erro', 'Escreva qual é o problema.');
    return back(req, res);
  }
  if (sale.status === 'concluida') return back(req, res);
  const user = req.user!;
  await withTransaction(async (db) => {
    await db.query(`UPDATE sales SET status = 'pausada', pause_reason = $2, updated_at = now() WHERE id = $1`, [sale.id, reason]);
    if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'pausado', updated_at = now() WHERE id = $1`, [sale.lead_id]);
    await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'pausada', description: `Pausou a produção: ${reason}`, ip: req.ip }, db);
    await notifyWhoCan('pedidos', `Problema na produção da ${sale.code}: ${reason}`, `/producao/${sale.id}`, { exceptUserId: user.id }, db);
  });
  flash(req, 'sucesso', 'Produção pausada. O comercial foi avisado.');
  back(req, res);
});

producaoRouter.post('/producao/:id/retomar', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  if (sale.status !== 'pausada') return back(req, res);
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sale_checklist WHERE sale_id = $1', [sale.id]);
  const status = rows[0].n > 0 ? 'em_producao' : 'aguardando';
  await withTransaction(async (db) => {
    await db.query('UPDATE sales SET status = $2, pause_reason = NULL, updated_at = now() WHERE id = $1', [sale.id, status]);
    if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'em_producao', updated_at = now() WHERE id = $1`, [sale.lead_id]);
    await recordEvent({ userId: req.user!.id, entityType: 'venda', entityId: sale.id, action: 'retomada', description: 'Retomou a produção', ip: req.ip }, db);
  });
  back(req, res);
});

producaoRouter.get('/producao/:id/lightburn.csv', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  const file = `${String(sale.code).replace(/[^\w-]+/g, '_')}-nomes.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${file}"`);
  res.send(lightburnCsv(parseNames(sale.names), sale.font));
});
