import { Router, type Request, type Response } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { addBusinessDays, parseIsoDate, todayIso } from '../lib/dates.js';
import { recordEvent } from '../lib/events.js';
import { saveUploadedFile } from '../lib/files.js';
import { formatPhone, listOrigins, upsertCustomer, validPhone } from '../lib/leads.js';
import { notifyWhoCan } from '../lib/notifications.js';
import { DEFAULT_PRODUCTION_DAYS, SALE_STATUS_LABELS, parseNames } from '../lib/sales.js';
import { flash, requirePermission } from '../middleware.js';

export const vendasRouter = Router();
vendasRouter.use('/pedidos', requirePermission('pedidos'));

interface SaleForm {
  code: string; customerName: string; phone: string; originId: string; product: string; productCode: string;
  color: string; quantity: string; font: string; names: string; notes: string; dueDate: string; leadId: string;
}

const FIELDS: Record<keyof SaleForm, string> = {
  code: 'codigo', customerName: 'cliente', phone: 'telefone', originId: 'origem', product: 'produto', productCode: 'codigo_produto',
  color: 'cor', quantity: 'quantidade', font: 'fonte', names: 'nomes', notes: 'observacoes', dueDate: 'prazo', leadId: 'lead',
};

function readForm(req: Request): SaleForm {
  const form = {} as SaleForm;
  for (const [k, field] of Object.entries(FIELDS)) form[k as keyof SaleForm] = String(req.body[field] ?? '').trim();
  return form;
}

/** Valida e devolve os valores prontos para gravar. */
async function validate(form: SaleForm, exceptId?: number) {
  const origins = await listOrigins(false);
  const origin = origins.find((o) => String(o.id) === form.originId);
  const quantity = Number(form.quantity);
  const due = parseIsoDate(form.dueDate);
  const phone = form.phone ? validPhone(form.phone) : null;
  let error: string | null = null;
  if (!form.customerName) error = 'Informe o nome do cliente.';
  else if (form.phone && !phone) error = 'Telefone inválido: use DDD + número (10 ou 11 números).';
  else if (!origin) error = 'Escolha a origem da venda.';
  else if (!form.product) error = 'Informe o produto.';
  else if (!Number.isInteger(quantity) || quantity <= 0) error = 'A quantidade precisa ser um número inteiro maior que zero.';
  else if (!due) error = 'Informe o prazo da produção.';
  else if (form.code) {
    const { rowCount } = await pool.query('SELECT 1 FROM sales WHERE lower(code) = lower($1) AND id <> $2', [form.code, exceptId ?? 0]);
    if (rowCount) error = `Já existe uma venda com o código ${form.code}.`;
  }
  return { error, origin, quantity, due, phone };
}

async function renderForm(res: Response, opts: { form: SaleForm; editing: Record<string, unknown> | null; error: string | null; status?: number }) {
  res.status(opts.status ?? 200).render('vendas/form', {
    title: opts.editing ? `Venda ${opts.editing.code}` : 'Nova venda', origins: await listOrigins(!opts.editing), ...opts,
  });
}

vendasRouter.get('/pedidos', async (req, res) => {
  const situacao = String(req.query.situacao ?? 'abertas');
  const { rows: sales } = await pool.query(
    `SELECT s.id, s.code, s.customer_name, s.product, s.color, s.quantity, s.due_date, s.status, s.created_at,
            o.name AS origin, s.due_date < current_date AS atrasada
       FROM sales s JOIN origins o ON o.id = s.origin_id
      WHERE ${situacao === 'concluidas' ? `s.status = 'concluida'` : `s.status <> 'concluida'`}
      ORDER BY ${situacao === 'concluidas' ? 's.completed_at DESC' : 's.due_date, s.id'}
      LIMIT 300`,
  );
  res.render('vendas/lista', { title: 'Vendas', sales, situacao, SALE_STATUS_LABELS });
});

vendasRouter.get('/pedidos/nova', async (req, res) => {
  const form: SaleForm = {
    code: '', customerName: '', phone: '', originId: '', product: '', productCode: '', color: '', quantity: '',
    font: '', names: '', notes: '', dueDate: addBusinessDays(todayIso(), DEFAULT_PRODUCTION_DAYS), leadId: '',
  };
  // "Virou venda" a partir de um lead: já preenche cliente, origem, produto e quantidade
  if (/^\d+$/.test(String(req.query.lead ?? ''))) {
    const { rows } = await pool.query(
      `SELECT l.id, l.origin_id, l.product, l.quantity, c.name, c.phone FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`,
      [Number(req.query.lead)],
    );
    const l = rows[0];
    if (l) {
      Object.assign(form, {
        leadId: String(l.id), customerName: l.name ?? '', phone: formatPhone(l.phone), originId: String(l.origin_id),
        product: l.product ?? '', quantity: l.quantity ? String(l.quantity) : '',
      });
    }
  }
  await renderForm(res, { form, editing: null, error: null });
});

vendasRouter.post('/pedidos', async (req, res) => {
  const form = readForm(req);
  const v = await validate(form);
  if (v.error) return renderForm(res, { form, editing: null, error: v.error, status: 400 });
  const user = req.user!;
  const result = await withTransaction(async (db) => {
    const file = await saveUploadedFile(req, 'arte_venda', db);
    if (file.error) return { error: file.error };
    const customerId = v.phone ? (await upsertCustomer(v.phone, form.customerName, user.id, db)).customer.id : null;
    let leadId: number | null = null;
    if (/^\d+$/.test(form.leadId)) {
      const { rowCount } = await db.query('SELECT 1 FROM leads WHERE id = $1', [Number(form.leadId)]);
      if (rowCount) leadId = Number(form.leadId);
    }
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO sales (code, customer_id, customer_name, lead_id, origin_id, product, product_code, color, quantity, font, names,
                          art_file_id, notes, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [form.code || `tmp-${Date.now()}-${Math.random()}`, customerId, form.customerName, leadId, v.origin!.id, form.product,
        form.productCode || null, form.color || null, v.quantity, form.font || null, form.names || null, file.id, form.notes || null, v.due, user.id],
    );
    const id = rows[0].id;
    let code = form.code;
    if (!code) {
      code = `V-${String(id).padStart(4, '0')}`;
      await db.query('UPDATE sales SET code = $2 WHERE id = $1', [id, code]);
    }
    if (leadId) {
      await db.query(`UPDATE leads SET stage = 'em_producao', updated_at = now() WHERE id = $1`, [leadId]);
      await recordEvent({ userId: user.id, entityType: 'lead', entityId: leadId, action: 'virou_venda', description: `Virou a venda ${code} e foi para a produção`, ip: req.ip }, db);
    }
    await recordEvent({
      userId: user.id, entityType: 'venda', entityId: id, action: 'criada',
      description: `Cadastrou a venda ${code} (${form.customerName}: ${v.quantity}× ${form.product}) e mandou para a produção`,
      data: { code, quantity: v.quantity, product: form.product, color: form.color, nomes: parseNames(form.names).length }, ip: req.ip,
    }, db);
    await notifyWhoCan('producao', `Nova venda para produzir: ${code} · ${v.quantity}× ${form.product}`, `/producao/${id}`, { exceptUserId: user.id }, db);
    return { id, code };
  });
  if ('error' in result) return renderForm(res, { form, editing: null, error: result.error!, status: 400 });
  flash(req, 'sucesso', `Venda ${result.code} cadastrada e enviada para a produção.`);
  res.redirect('/pedidos');
});

async function loadSale(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(`SELECT s.*, c.phone FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

function toForm(s: Record<string, any>): SaleForm {
  return {
    code: s.code, customerName: s.customer_name, phone: formatPhone(s.phone), originId: String(s.origin_id), product: s.product,
    productCode: s.product_code ?? '', color: s.color ?? '', quantity: String(s.quantity), font: s.font ?? '', names: s.names ?? '',
    notes: s.notes ?? '', dueDate: todayIso(s.due_date), leadId: s.lead_id ? String(s.lead_id) : '',
  };
}

const notFound = { title: 'Não encontrada', message: 'Venda não encontrada.', backUrl: '/pedidos' };

vendasRouter.get('/pedidos/:id', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  await renderForm(res, { form: toForm(sale), editing: sale, error: null });
});

vendasRouter.post('/pedidos/:id', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  if (sale.status === 'concluida') {
    flash(req, 'erro', 'Esta venda já teve a produção concluída e não pode mais ser alterada.');
    return res.redirect(`/pedidos/${sale.id}`);
  }
  const form = readForm(req);
  if (!form.code) form.code = sale.code;
  const v = await validate(form, sale.id);
  if (v.error) return renderForm(res, { form, editing: sale, error: v.error, status: 400 });
  const user = req.user!;
  const before = toForm(sale);
  const result = await withTransaction(async (db) => {
    const file = await saveUploadedFile(req, 'arte_venda', db);
    if (file.error) return { error: file.error };
    const customerId = v.phone ? (await upsertCustomer(v.phone, form.customerName, user.id, db)).customer.id : null;
    await db.query(
      `UPDATE sales SET code = $2, customer_id = $3, customer_name = $4, origin_id = $5, product = $6, product_code = $7, color = $8,
              quantity = $9, font = $10, names = $11, art_file_id = COALESCE($12, art_file_id), notes = $13, due_date = $14, updated_at = now()
        WHERE id = $1`,
      [sale.id, form.code, customerId, form.customerName, v.origin!.id, form.product, form.productCode || null, form.color || null,
        v.quantity, form.font || null, form.names || null, file.id, form.notes || null, v.due],
    );
    const labels: Partial<Record<keyof SaleForm, string>> = {
      code: 'código', customerName: 'cliente', phone: 'telefone', product: 'produto', productCode: 'código do produto', color: 'cor',
      quantity: 'quantidade', font: 'fonte', names: 'nomes', notes: 'observações', dueDate: 'prazo', originId: 'origem',
    };
    const changed = (Object.keys(labels) as (keyof SaleForm)[]).filter((k) => {
      const after = k === 'phone' ? formatPhone(v.phone) : form[k];
      return before[k] !== after;
    }).map((k) => labels[k]!);
    if (file.id) changed.push('arte');
    if (changed.length) {
      await recordEvent({
        userId: user.id, entityType: 'venda', entityId: sale.id, action: 'alterada',
        description: `Alterou a venda ${form.code} (${changed.join(', ')})`, data: { antes: before, depois: form }, ip: req.ip,
      }, db);
      if (sale.status !== 'aguardando') {
        await notifyWhoCan('producao', `Atenção: a venda ${form.code} foi alterada (${changed.join(', ')})`, `/producao/${sale.id}`, { exceptUserId: user.id }, db);
      }
    }
    return { ok: true };
  });
  if ('error' in result) return renderForm(res, { form, editing: sale, error: result.error!, status: 400 });
  flash(req, 'sucesso', 'Venda salva.');
  res.redirect('/pedidos');
});
