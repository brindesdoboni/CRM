import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { findOpenLead, formatPhone, listOrigins, upsertCustomer, validPhone } from '../lib/leads.js';
import { sendWelcome } from '../lib/manychat.js';
import { notifyWhoCan } from '../lib/notifications.js';
import { getSettings } from '../lib/settings.js';

/**
 * Formulário público "Peça seu orçamento" (o site mostra este endereço num botão ou num iframe).
 * Sem login. Só envia com o consentimento marcado; o SDR responde pelo WhatsApp em seguida.
 */
export const formularioRouter = Router();

export const CONSENT_TEXT = 'Autorizo a Brindes do Boni a entrar em contato pelo WhatsApp sobre meu pedido.';
const SITE_ORIGIN = 'site brindes doboni';

interface SiteForm { nome: string; whatsapp: string; email: string; produto: string; quantidade: string; mensagem: string; consentimento: boolean }
const emptyForm: SiteForm = { nome: '', whatsapp: '', email: '', produto: '', quantidade: '', mensagem: '', consentimento: false };

function readForm(req: Request): SiteForm {
  const s = (k: string, max: number) => String(req.body?.[k] ?? '').trim().slice(0, max);
  return {
    nome: s('nome', 120), whatsapp: s('whatsapp', 20), email: s('email', 200), produto: s('produto', 200),
    quantidade: s('quantidade', 10), mensagem: s('mensagem', 2000), consentimento: req.body?.consentimento === 'sim',
  };
}

/** Deixa o site colocar esta página dentro dele (iframe); o resto do CRM continua bloqueado para isso. */
function allowEmbedding(res: Response) {
  res.removeHeader('X-Frame-Options');
  const csp = String(res.getHeader('Content-Security-Policy') ?? '');
  if (csp) res.setHeader('Content-Security-Policy', csp.replace(/frame-ancestors [^;]*/, 'frame-ancestors *'));
}

function render(res: Response, status: number, data: { form?: SiteForm; error?: string | null; enviado?: boolean; nome?: string }) {
  allowEmbedding(res);
  res.status(status).render('formulario', { form: emptyForm, error: null, enviado: false, nome: '', consentText: CONSENT_TEXT, ...data });
}

// Proteção contra spam: no máximo 5 envios por hora vindos do mesmo IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => render(res, 429, { form: readForm(req), error: 'Recebemos muitos envios deste aparelho. Tente de novo mais tarde ou chame a gente no WhatsApp.' }),
});

formularioRouter.get('/formulario', (_req, res) => render(res, 200, {}));

formularioRouter.post('/formulario', limiter, async (req, res) => {
  const form = readForm(req);
  // Campo escondido preenchido = robô. Responde como se tivesse dado certo e não grava nada.
  if (String(req.body?.site ?? '').trim()) return render(res, 200, { enviado: true });

  const phone = validPhone(form.whatsapp);
  const quantity = form.quantidade ? Number(form.quantidade) : null;
  let error: string | null = null;
  if (!form.nome) error = 'Informe seu nome.';
  else if (!phone) error = 'Informe o WhatsApp com DDD (10 ou 11 números).';
  else if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) error = 'O e-mail parece incompleto. Confira ou deixe em branco.';
  else if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) error = 'A quantidade precisa ser um número inteiro maior que zero.';
  else if (!form.consentimento) error = 'Para enviar, marque a autorização de contato pelo WhatsApp.';
  if (error) return render(res, 400, { form, error });

  const origins = await listOrigins(false);
  const origin = origins.find((o) => o.name.toLowerCase() === SITE_ORIGIN)
    ?? origins.find((o) => o.active && /site/i.test(o.name)) ?? origins.find((o) => o.active) ?? origins[0];
  const notes = [form.mensagem, form.email ? `E-mail: ${form.email}` : ''].filter(Boolean).join('\n') || null;

  const lead = await withTransaction(async (db) => {
    const { customer } = await upsertCustomer(phone!, form.nome, null, db);
    if (form.email && !customer.email) await db.query('UPDATE customers SET email = $2 WHERE id = $1', [customer.id, form.email]);
    const who = customer.name || formatPhone(customer.phone);
    const before = await findOpenLead<{ welcome_sent_at: Date | null; product: string | null }>(customer.id, 'l.welcome_sent_at, l.product', db);

    let id: number;
    if (before) {
      id = before.id;
      // O cliente mandou o formulário de novo: entra no lead em aberto, com o consentimento novo.
      await db.query(
        `UPDATE leads SET last_contact_at = now(), updated_at = now(), opt_out_at = NULL,
                product = COALESCE(product, $2), quantity = COALESCE(quantity, $3),
                notes = CASE WHEN $4::text IS NULL THEN notes ELSE concat_ws(E'\n\n', notes, $4::text) END,
                consent_text = $5, consent_at = now(), consent_ip = $6
          WHERE id = $1`,
        [id, form.produto || null, quantity, notes ? `[Formulário do site] ${notes}` : null, CONSENT_TEXT, req.ip ?? null],
      );
      await recordEvent({
        userId: null, entityType: 'lead', entityId: id, action: 'novo_contato',
        description: `${who} mandou o formulário do site de novo e autorizou contato pelo WhatsApp`, data: { form: { ...form } }, ip: req.ip,
      }, db);
      await notifyWhoCan('funil', `${who} mandou o formulário do site de novo`, `/leads/${id}`, {}, db);
    } else {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO leads (customer_id, origin_id, channel, product, quantity, notes, consent_text, consent_at, consent_ip, data)
         VALUES ($1, $2, 'site', $3, $4, $5, $6, now(), $7, $8) RETURNING id`,
        [customer.id, origin.id, form.produto || null, quantity, notes, CONSENT_TEXT, req.ip ?? null, { email: form.email || undefined }],
      );
      id = rows[0].id;
      await recordEvent({
        userId: null, entityType: 'lead', entityId: id, action: 'criado',
        description: `Lead ${who} chegou pelo formulário do site (${origin.name}) e autorizou contato pelo WhatsApp`, data: { form: { ...form } }, ip: req.ip,
      }, db);
      await notifyWhoCan('funil', `Novo lead do site: ${who}${form.produto ? ` · ${form.produto}` : ''}`, `/leads/${id}`, {}, db);
    }
    return { id, who, welcomeSent: !!before?.welcome_sent_at, product: form.produto || before?.product || null };
  });

  // SDR: boas-vindas pelo WhatsApp (ManyChat). Se falhar, o comercial é avisado para chamar à mão.
  if (!lead.welcomeSent) {
    const settings = await getSettings();
    const result = await sendWelcome({
      phone: phone!, name: form.nome, email: form.email || null, product: lead.product, consent: CONSENT_TEXT, flowNs: settings.manychat_flow_boas_vindas,
    });
    if (result.ok) {
      await pool.query(
        `UPDATE leads SET welcome_sent_at = now(), data = jsonb_set(data, '{external_id}', to_jsonb($2::text)) WHERE id = $1`,
        [lead.id, result.subscriberId],
      );
      await recordEvent({ userId: null, entityType: 'lead', entityId: lead.id, action: 'boas_vindas', description: `O SDR mandou a boas-vindas para ${lead.who} no WhatsApp (ManyChat)` });
    } else {
      await recordEvent({ userId: null, entityType: 'lead', entityId: lead.id, action: 'boas_vindas_falhou', description: `A boas-vindas pelo WhatsApp não foi enviada: ${result.reason}` });
      await notifyWhoCan('funil', `⚠️ A boas-vindas não chegou para ${lead.who} (site): ${result.reason}. Chame pelo WhatsApp.`, `/leads/${lead.id}`);
    }
  }

  render(res, 201, { enviado: true, nome: form.nome.split(/\s+/)[0] });
});
