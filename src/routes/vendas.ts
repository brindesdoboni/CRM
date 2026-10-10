import { Router, type Request, type Response } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { addBusinessDays, parseIsoDate, todayIso } from '../lib/dates.js';
import { recordEvent } from '../lib/events.js';
import { saveUploadedFile } from '../lib/files.js';
import { formatPhone, listOrigins, upsertCustomer, validPhone } from '../lib/leads.js';
import { notifyWhoCan } from '../lib/notifications.js';
import {
  DEFAULT_PRODUCTION_DAYS, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, SALE_STATUS_LABELS, computePayment, formatCep, parseCep, parseMoney,
  parseNames, parsePositive,
} from '../lib/sales.js';
import { getSettings } from '../lib/settings.js';
import { quoteFreight, superfreteConfigured } from '../lib/superfrete.js';
import { saleSummaryPdf } from '../lib/resumo-pdf.js';
import { flash, requirePermission } from '../middleware.js';
import type { User } from '../lib/users.js';

export const vendasRouter = Router();
vendasRouter.use('/pedidos', requirePermission('pedidos'));

/** Custo real do frete e margem: só o Admin vê e altera (conferido aqui no servidor). */
const seesCost = (user: User) => user.role === 'admin';

interface SaleForm {
  code: string; customerName: string; phone: string; originId: string; product: string; productCode: string;
  color: string; quantity: string; font: string; names: string; notes: string; dueDate: string; leadId: string;
  shippingService: string; shippingPrice: string; shippingDays: string; shippingCep: string; trackingCode: string; shippingCost: string;
  unitPrice: string; discount: string; paymentMethod: string; installments: string; interestFree: string; installmentValue: string;
  downPayment: string; paymentStatus: string; approved: string;
}

const FIELDS: Record<keyof SaleForm, string> = {
  code: 'codigo', customerName: 'cliente', phone: 'telefone', originId: 'origem', product: 'produto', productCode: 'codigo_produto',
  color: 'cor', quantity: 'quantidade', font: 'fonte', names: 'nomes', notes: 'observacoes', dueDate: 'prazo', leadId: 'lead',
  shippingService: 'frete_servico', shippingPrice: 'frete_valor', shippingDays: 'frete_prazo', shippingCep: 'frete_cep',
  trackingCode: 'rastreio', shippingCost: 'frete_custo', unitPrice: 'valor_unitario', discount: 'desconto',
  paymentMethod: 'forma_pagamento', installments: 'parcelas', interestFree: 'sem_juros', installmentValue: 'valor_parcela',
  downPayment: 'entrada', paymentStatus: 'status_pagamento', approved: 'aprovado',
};

/** Campos que a produção usa: só mudanças neles avisam a Jô. */
const PRODUCTION_LABELS: Partial<Record<keyof SaleForm, string>> = {
  code: 'código', customerName: 'cliente', phone: 'telefone', product: 'produto', productCode: 'código do produto', color: 'cor',
  quantity: 'quantidade', font: 'fonte', names: 'nomes', notes: 'observações', dueDate: 'prazo', originId: 'origem',
};

/** Frete e pagamento: ficam num histórico à parte, que a produção não vê. */
const COMMERCIAL_LABELS: Partial<Record<keyof SaleForm, string>> = {
  shippingService: 'serviço de frete', shippingPrice: 'frete cobrado', shippingDays: 'prazo de entrega', shippingCep: 'CEP de destino',
  trackingCode: 'rastreio', shippingCost: 'custo real do frete', unitPrice: 'valor unitário', discount: 'desconto',
  paymentMethod: 'forma de pagamento', installments: 'parcelas', interestFree: 'sem juros', installmentValue: 'valor da parcela',
  downPayment: 'entrada', paymentStatus: 'status do pagamento',
};

const moneyInput = (n: number | string | null | undefined) => (n === null || n === undefined || n === '' ? '' : Number(n).toFixed(2).replace('.', ','));

function readForm(req: Request): SaleForm {
  const form = {} as SaleForm;
  for (const [k, field] of Object.entries(FIELDS)) form[k as keyof SaleForm] = String(req.body[field] ?? '').trim();
  return form;
}

function emptyForm(): SaleForm {
  return {
    code: '', customerName: '', phone: '', originId: '', product: '', productCode: '', color: '', quantity: '',
    font: '', names: '', notes: '', dueDate: addBusinessDays(todayIso(), DEFAULT_PRODUCTION_DAYS), leadId: '',
    shippingService: '', shippingPrice: '', shippingDays: '', shippingCep: '', trackingCode: '', shippingCost: '',
    unitPrice: '', discount: '', paymentMethod: 'pix', installments: '1', interestFree: 'sim', installmentValue: '',
    downPayment: '', paymentStatus: 'pendente', approved: 'nao',
  };
}

/** Valida e devolve os valores prontos para gravar. */
async function validate(form: SaleForm, exceptId?: number) {
  const origins = await listOrigins(false);
  const origin = origins.find((o) => String(o.id) === form.originId);
  const quantity = Number(form.quantity);
  const due = parseIsoDate(form.dueDate);
  const phone = form.phone ? validPhone(form.phone) : null;
  const money = {
    shippingPrice: parseMoney(form.shippingPrice), shippingCost: parseMoney(form.shippingCost), unitPrice: parseMoney(form.unitPrice),
    discount: parseMoney(form.discount), installmentValue: parseMoney(form.installmentValue), downPayment: parseMoney(form.downPayment),
  };
  const shippingDays = form.shippingDays ? Number(form.shippingDays) : null;
  const installments = form.installments ? Number(form.installments) : 1;
  const cep = parseCep(form.shippingCep);
  const interestFree = form.interestFree !== 'nao';
  let error: string | null = null;
  if (!form.customerName) error = 'Informe o nome do cliente.';
  else if (form.phone && !phone) error = 'Telefone inválido: use DDD + número (10 ou 11 números).';
  else if (!origin) error = 'Escolha a origem da venda.';
  else if (!form.product) error = 'Informe o produto.';
  else if (!Number.isInteger(quantity) || quantity <= 0) error = 'A quantidade precisa ser um número inteiro maior que zero.';
  else if (!due) error = 'Informe o prazo da produção.';
  else if (Object.values(money).some((v) => Number.isNaN(v))) error = 'Confira os valores em R$: use números como 35 ou 1.234,50.';
  else if (shippingDays !== null && (!Number.isInteger(shippingDays) || shippingDays < 0)) error = 'O prazo de entrega precisa ser um número de dias úteis.';
  else if (cep === '') error = 'CEP de destino inválido: use 8 números.';
  else if (form.paymentMethod && !(form.paymentMethod in PAYMENT_METHODS)) error = 'Escolha a forma de pagamento.';
  else if (!Number.isInteger(installments) || installments < 1 || installments > 24) error = 'O número de parcelas vai de 1 a 24.';
  else if (form.paymentStatus && !(form.paymentStatus in PAYMENT_STATUS_LABELS)) error = 'Escolha o status do pagamento.';
  else if (form.code) {
    const { rowCount } = await pool.query('SELECT 1 FROM sales WHERE lower(code) = lower($1) AND id <> $2', [form.code, exceptId ?? 0]);
    if (rowCount) error = `Já existe uma venda com o código ${form.code}.`;
  }
  const payment = computePayment({
    unitPrice: money.unitPrice ?? null, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    shippingPrice: money.shippingPrice ?? null, discount: money.discount ?? 0, downPayment: money.downPayment ?? 0,
    installments: Number.isInteger(installments) && installments >= 1 ? installments : 1, interestFree,
    installmentValue: money.installmentValue ?? null,
  });
  if (!error && payment.error) error = payment.error;
  if (!error && payment.total === null && (money.discount || money.downPayment || installments > 1)) {
    error = 'Informe o valor unitário do produto para calcular o total e as parcelas.';
  }
  return { error, origin, quantity, due, phone, money, shippingDays, installments, cep, interestFree, payment, approved: form.approved === 'sim' };
}

async function renderForm(req: Request, res: Response, opts: { form: SaleForm; editing: Record<string, unknown> | null; error: string | null; status?: number }) {
  const admin = seesCost(req.user!);
  if (!admin) opts.form.shippingCost = '';
  res.status(opts.status ?? 200).render('vendas/form', {
    title: opts.editing ? `Venda ${opts.editing.code}` : 'Nova venda', origins: await listOrigins(!opts.editing), ...opts,
    seesCost: admin, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, superfrete: superfreteConfigured(),
  });
}

vendasRouter.get('/pedidos', async (req, res) => {
  const situacao = String(req.query.situacao ?? 'abertas');
  const { rows: sales } = await pool.query(
    `SELECT s.id, s.code, s.customer_name, s.product, s.color, s.quantity, s.due_date, s.status, s.created_at, s.customer_approved,
            s.total, s.payment_status, o.name AS origin, s.due_date < current_date AS atrasada
       FROM sales s JOIN origins o ON o.id = s.origin_id
      WHERE ${situacao === 'concluidas' ? `s.status = 'concluida'` : `s.status <> 'concluida'`}
      ORDER BY ${situacao === 'concluidas' ? 's.completed_at DESC' : 's.customer_approved, s.due_date, s.id'}
      LIMIT 300`,
  );
  res.render('vendas/lista', { title: 'Vendas', sales, situacao, SALE_STATUS_LABELS, PAYMENT_STATUS_LABELS });
});

vendasRouter.get('/pedidos/nova', async (req, res) => {
  const form = emptyForm();
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
  await renderForm(req, res, { form, editing: null, error: null });
});

/** Cotação na SuperFrete (botão "Cotar na SuperFrete" da venda). Devolve JSON. */
vendasRouter.post('/pedidos/frete/cotar', async (req, res) => {
  const settings = await getSettings();
  const from = parseCep(settings.frete_cep_origem);
  const to = parseCep(req.body.cep);
  const pkg = {
    weightKg: parsePositive(String(req.body.peso ?? '')), heightCm: parsePositive(String(req.body.altura ?? '')),
    widthCm: parsePositive(String(req.body.largura ?? '')), lengthCm: parsePositive(String(req.body.comprimento ?? '')),
  };
  if (!from) return res.status(400).json({ erro: 'Falta o CEP de origem em Cadastros e configurações. Peça ao Lucas para preencher, ou digite o valor do frete.' });
  if (!to) return res.status(400).json({ erro: 'Informe o CEP de destino com 8 números.' });
  if (Object.values(pkg).some((v) => v === null)) return res.status(400).json({ erro: 'Informe peso (kg) e medidas (cm) do pacote.' });
  const result = await quoteFreight({ fromCep: from, toCep: to, ...(pkg as Record<keyof typeof pkg, number>) });
  if (result.error) return res.status(502).json({ erro: result.error });
  res.json({ opcoes: result.options.map((o) => ({ servico: o.service, valor: o.price, prazo: o.days })) });
});

vendasRouter.post('/pedidos', async (req, res) => {
  const form = readForm(req);
  const v = await validate(form);
  if (v.error) return renderForm(req, res, { form, editing: null, error: v.error, status: 400 });
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
                          art_file_id, notes, due_date, created_by,
                          shipping_service, shipping_price, shipping_days, shipping_cep, tracking_code, shipping_cost,
                          unit_price, discount, payment_method, installments, interest_free, installment_value, down_payment, total, payment_status,
                          customer_approved, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
               $31, CASE WHEN $31 THEN now() END, CASE WHEN $31 THEN $15::int END) RETURNING id`,
      [form.code || `tmp-${Date.now()}-${Math.random()}`, customerId, form.customerName, leadId, v.origin!.id, form.product,
        form.productCode || null, form.color || null, v.quantity, form.font || null, form.names || null, file.id, form.notes || null, v.due, user.id,
        form.shippingService || null, v.money.shippingPrice ?? null, v.shippingDays, v.cep, form.trackingCode || null,
        seesCost(user) ? v.money.shippingCost ?? null : null,
        v.money.unitPrice ?? null, v.money.discount ?? 0, form.paymentMethod || null, v.installments, v.interestFree, v.payment.installmentValue,
        v.money.downPayment ?? 0, v.payment.total, form.paymentStatus || 'pendente', v.approved],
    );
    const id = rows[0].id;
    let code = form.code;
    if (!code) {
      code = `V-${String(id).padStart(4, '0')}`;
      await db.query('UPDATE sales SET code = $2 WHERE id = $1', [id, code]);
    }
    if (leadId) {
      await db.query('UPDATE leads SET stage = $2, updated_at = now() WHERE id = $1', [leadId, v.approved ? 'em_producao' : 'aguardando_aprovacao']);
      await recordEvent({
        userId: user.id, entityType: 'lead', entityId: leadId, action: 'virou_venda',
        description: v.approved ? `Virou a venda ${code} e foi para a produção` : `Virou a venda ${code} (aguardando aprovação do cliente)`, ip: req.ip,
      }, db);
    }
    await recordEvent({
      userId: user.id, entityType: 'venda', entityId: id, action: 'criada',
      description: `Cadastrou a venda ${code} (${form.customerName}: ${v.quantity}× ${form.product})`,
      data: { code, quantity: v.quantity, product: form.product, color: form.color, nomes: parseNames(form.names).length }, ip: req.ip,
    }, db);
    if (v.approved) {
      await recordEvent({ userId: user.id, entityType: 'venda', entityId: id, action: 'aprovada', description: 'Registrou: pedido aprovado pelo cliente', ip: req.ip }, db);
      await notifyWhoCan('producao', `Nova venda para produzir: ${code} · ${v.quantity}× ${form.product}`, `/producao/${id}`, { exceptUserId: user.id }, db);
    }
    return { id, code };
  });
  if ('error' in result) return renderForm(req, res, { form, editing: null, error: result.error!, status: 400 });
  flash(req, 'sucesso', v.approved
    ? `Venda ${result.code} cadastrada e enviada para a produção.`
    : `Venda ${result.code} cadastrada. Ela vai para a produção quando você marcar "Pedido aprovado pelo cliente".`);
  res.redirect(`/pedidos/${result.id}`);
});

async function loadSale(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(
    `SELECT s.*, c.phone, ab.name AS approved_by_name,
            (SELECT count(*)::int FROM sale_checklist k WHERE k.sale_id = s.id) AS feitos
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users ab ON ab.id = s.approved_by
      WHERE s.id = $1`,
    [id],
  );
  const sale = rows[0];
  if (!sale) return null;
  // Quem não é Admin nem recebe o custo real do frete
  if (!seesCost(req.user!)) delete sale.shipping_cost;
  return sale;
}

function toForm(s: Record<string, any>): SaleForm {
  return {
    code: s.code, customerName: s.customer_name, phone: formatPhone(s.phone), originId: String(s.origin_id), product: s.product,
    productCode: s.product_code ?? '', color: s.color ?? '', quantity: String(s.quantity), font: s.font ?? '', names: s.names ?? '',
    notes: s.notes ?? '', dueDate: todayIso(s.due_date), leadId: s.lead_id ? String(s.lead_id) : '',
    shippingService: s.shipping_service ?? '', shippingPrice: moneyInput(s.shipping_price), shippingDays: s.shipping_days == null ? '' : String(s.shipping_days),
    shippingCep: formatCep(s.shipping_cep), trackingCode: s.tracking_code ?? '', shippingCost: moneyInput(s.shipping_cost),
    unitPrice: moneyInput(s.unit_price), discount: Number(s.discount) ? moneyInput(s.discount) : '', paymentMethod: s.payment_method ?? '',
    installments: String(s.installments ?? 1), interestFree: s.interest_free === false ? 'nao' : 'sim',
    installmentValue: moneyInput(s.installment_value), downPayment: Number(s.down_payment) ? moneyInput(s.down_payment) : '',
    paymentStatus: s.payment_status ?? 'pendente', approved: s.customer_approved ? 'sim' : 'nao',
  };
}

const notFound = { title: 'Não encontrada', message: 'Venda não encontrada.', backUrl: '/pedidos' };

vendasRouter.get('/pedidos/:id', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  await renderForm(req, res, { form: toForm(sale), editing: sale, error: null });
});

/** PDF "Resumo do pedido" para o cliente conferir e aprovar. Nunca leva custo, margem ou lucro. */
vendasRouter.get('/pedidos/:id/pdf', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  delete sale.shipping_cost;
  const [settings, art] = await Promise.all([
    getSettings(),
    sale.art_file_id ? pool.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM files WHERE id = $1', [sale.art_file_id]) : null,
  ]);
  const pdf = await saleSummaryPdf(sale, settings, art?.rows[0] ?? null);
  await recordEvent({ userId: req.user!.id, entityType: 'venda', entityId: sale.id, action: 'pdf', description: 'Baixou o PDF "Resumo do pedido"', ip: req.ip });
  const file = `Resumo-pedido-${String(sale.code).replace(/[^\w-]+/g, '_')}.pdf`;
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${req.query.ver ? 'inline' : 'attachment'}; filename="${file}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(pdf);
});

vendasRouter.post('/pedidos/:id', async (req, res) => {
  const sale = await loadSale(req);
  if (!sale) return res.status(404).render('erro', notFound);
  if (sale.status === 'concluida') {
    flash(req, 'erro', 'Esta venda já teve a produção concluída e não pode mais ser alterada.');
    return res.redirect(`/pedidos/${sale.id}`);
  }
  const user = req.user!;
  const admin = seesCost(user);
  const form = readForm(req);
  if (!form.code) form.code = sale.code;
  // Quem não é Admin não altera o custo real (mesmo que mande o campo)
  if (!admin) form.shippingCost = '';
  const v = await validate(form, sale.id);
  if (v.error) return renderForm(req, res, { form, editing: sale, error: v.error, status: 400 });
  const wasApproved = !!sale.customer_approved;
  if (wasApproved && !v.approved && (sale.status !== 'aguardando' || sale.feitos > 0)) {
    return renderForm(req, res, {
      form, editing: sale, status: 400,
      error: 'A produção já começou: não dá para desfazer a aprovação. Se precisar parar, peça para a produção usar "Tenho um problema".',
    });
  }
  const before = toForm(sale);
  if (!admin) before.shippingCost = '';
  const result = await withTransaction(async (db) => {
    const file = await saveUploadedFile(req, 'arte_venda', db);
    if (file.error) return { error: file.error };
    const customerId = v.phone ? (await upsertCustomer(v.phone, form.customerName, user.id, db)).customer.id : null;
    await db.query(
      `UPDATE sales SET code = $2, customer_id = $3, customer_name = $4, origin_id = $5, product = $6, product_code = $7, color = $8,
              quantity = $9, font = $10, names = $11, art_file_id = COALESCE($12, art_file_id), notes = $13, due_date = $14,
              shipping_service = $15, shipping_price = $16, shipping_days = $17, shipping_cep = $18, tracking_code = $19,
              shipping_cost = CASE WHEN $20 THEN $21 ELSE shipping_cost END,
              unit_price = $22, discount = $23, payment_method = $24, installments = $25, interest_free = $26, installment_value = $27,
              down_payment = $28, total = $29, payment_status = $30,
              customer_approved = $31,
              approved_at = CASE WHEN $31 AND NOT customer_approved THEN now() WHEN $31 THEN approved_at END,
              approved_by = CASE WHEN $31 AND NOT customer_approved THEN $32::int WHEN $31 THEN approved_by END,
              updated_at = now()
        WHERE id = $1`,
      [sale.id, form.code, customerId, form.customerName, v.origin!.id, form.product, form.productCode || null, form.color || null,
        v.quantity, form.font || null, form.names || null, file.id, form.notes || null, v.due,
        form.shippingService || null, v.money.shippingPrice ?? null, v.shippingDays, v.cep, form.trackingCode || null,
        admin, v.money.shippingCost ?? null,
        v.money.unitPrice ?? null, v.money.discount ?? 0, form.paymentMethod || null, v.installments, v.interestFree, v.payment.installmentValue,
        v.money.downPayment ?? 0, v.payment.total, form.paymentStatus || 'pendente', v.approved, user.id],
    );
    const after = toForm({ ...sale, ...{
      code: form.code, customer_name: form.customerName, phone: v.phone, origin_id: v.origin!.id, product: form.product,
      product_code: form.productCode || null, color: form.color || null, quantity: v.quantity, font: form.font || null, names: form.names || null,
      notes: form.notes || null, due_date: new Date(`${v.due}T12:00:00`), shipping_service: form.shippingService || null, shipping_price: v.money.shippingPrice ?? null,
      shipping_days: v.shippingDays, shipping_cep: v.cep, tracking_code: form.trackingCode || null,
      shipping_cost: admin ? v.money.shippingCost ?? null : null, unit_price: v.money.unitPrice ?? null, discount: v.money.discount ?? 0,
      payment_method: form.paymentMethod || null, installments: v.installments, interest_free: v.interestFree, installment_value: v.payment.installmentValue,
      down_payment: v.money.downPayment ?? 0, payment_status: form.paymentStatus || 'pendente', customer_approved: v.approved,
    } });
    const diff = (labels: Partial<Record<keyof SaleForm, string>>) =>
      (Object.keys(labels) as (keyof SaleForm)[]).filter((k) => before[k] !== after[k]).map((k) => labels[k]!);
    const changed = diff(PRODUCTION_LABELS);
    if (file.id) changed.push('arte');
    if (changed.length) {
      await recordEvent({
        userId: user.id, entityType: 'venda', entityId: sale.id, action: 'alterada',
        description: `Alterou a venda ${form.code} (${changed.join(', ')})`, ip: req.ip,
      }, db);
      if (wasApproved && v.approved && sale.status !== 'aguardando') {
        await notifyWhoCan('producao', `Atenção: a venda ${form.code} foi alterada (${changed.join(', ')})`, `/producao/${sale.id}`, { exceptUserId: user.id }, db);
      }
    }
    const commercial = diff(COMMERCIAL_LABELS);
    if (commercial.length) {
      // Ação "comercial": fica fora do histórico que a produção vê na OP
      await recordEvent({
        userId: user.id, entityType: 'venda', entityId: sale.id, action: 'comercial',
        description: `Atualizou frete/pagamento da venda ${form.code} (${commercial.join(', ')})`, ip: req.ip,
      }, db);
    }
    if (!wasApproved && v.approved) {
      if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'em_producao', updated_at = now() WHERE id = $1`, [sale.lead_id]);
      await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'aprovada', description: 'Registrou: pedido aprovado pelo cliente', ip: req.ip }, db);
      await notifyWhoCan('producao', `Nova venda para produzir: ${form.code} · ${v.quantity}× ${form.product}`, `/producao/${sale.id}`, { exceptUserId: user.id }, db);
    } else if (wasApproved && !v.approved) {
      if (sale.lead_id) await db.query(`UPDATE leads SET stage = 'aguardando_aprovacao', updated_at = now() WHERE id = $1`, [sale.lead_id]);
      await recordEvent({ userId: user.id, entityType: 'venda', entityId: sale.id, action: 'aprovacao_desfeita', description: 'Desfez a aprovação do cliente (saiu da fila da produção)', ip: req.ip }, db);
      await notifyWhoCan('producao', `A venda ${form.code} saiu da fila: aguardando nova aprovação do cliente`, '/producao', { exceptUserId: user.id }, db);
    }
    return { ok: true };
  });
  if ('error' in result) return renderForm(req, res, { form, editing: sale, error: result.error!, status: 400 });
  flash(req, 'sucesso', !wasApproved && v.approved ? 'Venda salva e enviada para a produção.' : 'Venda salva.');
  res.redirect(`/pedidos/${sale.id}`);
});
