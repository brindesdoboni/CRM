import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { INTEGRATION_CHANNELS, findIntegrationByToken, readLeadPayload } from '../lib/integrations.js';
import { findOpenLead, formatPhone, listOrigins, upsertCustomer, validPhone, whatsappLink } from '../lib/leads.js';
import { parseIsoDate, todayIso, addCalendarDays } from '../lib/dates.js';
import { classify, collectAnswers, leadSummary, listQuestions, scoreOf, type Answer } from '../lib/sdr.js';
import { getSettings } from '../lib/settings.js';
import { notifyWhoCan } from '../lib/notifications.js';

/** Entrada automática de leads (site, ManyChat…). Sem login: cada integração usa sua chave secreta. */
export const apiRouter = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ ok: false, erro: 'Muitas requisições. Tente de novo em um minuto.' }); },
});

/** Campos de controle (não viram observação). */
const RESERVED = new Set(['sair', 'opt_out', 'recontato_dias', 'recontato_data', 'recontato_consentimento', 'recontato_obs']);

function isYes(v: string): boolean {
  return /^(sim|s|yes|y|true|1|on)$/i.test(v.trim());
}

/** Recontato pedido pelo cliente: precisa de data (ou dias) E do consentimento registrado. */
function readRecontact(extra: Record<string, string>): { date: string; consent: string; note: string | null } | null {
  const consent = (extra.recontato_consentimento ?? '').trim();
  if (!consent || /^(nao|não|no|false|0)$/i.test(consent)) return null;
  let date: string | null = null;
  const days = Number.parseInt(extra.recontato_dias ?? '', 10);
  if (Number.isInteger(days) && days > 0 && days <= 365) date = addCalendarDays(todayIso(), days);
  const raw = (extra.recontato_data ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  date ??= parseIsoDate(br ? `${br[3]}-${br[2]}-${br[1]}` : raw);
  if (!date || date <= todayIso()) return null;
  return { date, consent: consent.slice(0, 500), note: extra.recontato_obs?.slice(0, 1000) || null };
}

function tokenFrom(req: Request): string {
  const auth = req.get('authorization') ?? '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.get('x-crm-token') ?? req.query.token ?? '').trim();
}

apiRouter.post('/api/leads', limiter, async (req, res) => {
  const integration = await findIntegrationByToken(tokenFrom(req));
  if (!integration || !integration.active) {
    return res.status(401).json({ ok: false, erro: 'Chave da integração inválida ou desativada.' });
  }
  const p = readLeadPayload(req.body);
  const phone = validPhone(p.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, erro: 'Telefone obrigatório, com DDD (10 ou 11 números).' });
  }
  const origins = await listOrigins();
  const origin = origins.find((o) => p.origin && o.name.toLowerCase() === p.origin.toLowerCase())
    ?? origins.find((o) => o.id === integration.origin_id)
    ?? (await listOrigins(false)).find((o) => o.id === integration.origin_id)!;
  const parsedQty = Number.parseInt(/\d+/.exec(p.quantity.replace(/\.(?=\d{3})/g, ''))?.[0] ?? '', 10);
  const quantity = Number.isInteger(parsedQty) && parsedQty > 0 && parsedQty < 1_000_000 ? parsedQty : null;
  const via = INTEGRATION_CHANNELS[integration.channel];

  const [questions, settings] = await Promise.all([listQuestions(), getSettings()]);
  const fields: Record<string, string> = { ...p.extra, produto: p.product, quantidade: p.quantity };
  const optOut = isYes(p.extra.sair ?? p.extra.opt_out ?? '');
  const recontato = readRecontact(p.extra);
  const limits = {
    quente: Number(settings.sdr_nota_quente) || 60, morno: Number(settings.sdr_nota_morno) || 35, atacado: Number(settings.limite_atacado) || 20,
  };
  const extraNotes = Object.entries(p.extra)
    .filter(([k]) => !questions.some((q) => q.key === k) && !RESERVED.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  const notes = [p.message, ...extraNotes].filter(Boolean).join('\n') || null;

  const result = await withTransaction(async (db) => {
    await db.query('UPDATE integrations SET last_used_at = now() WHERE id = $1', [integration.id]);
    const { customer } = await upsertCustomer(phone, p.name || null, null, db);
    if (p.email && !customer.email) await db.query('UPDATE customers SET email = $2 WHERE id = $1', [customer.id, p.email.slice(0, 200)]);
    const who = customer.name || formatPhone(customer.phone);

    // Anti-duplicidade: o cliente já tem um lead em aberto recente? O novo contato entra nele.
    const before = await findOpenLead<{ score: number | null; classification: string | null; quantity: number | null; product: string | null; data: { qualificacao?: Record<string, Answer> } }>(
      customer.id, 'l.score, l.classification, l.quantity, l.product, l.data', db,
    ) ?? undefined;
    const answers = collectAnswers(questions, fields, before?.data?.qualificacao ?? {});
    const score = Object.keys(answers).length ? scoreOf(answers) : null;
    const finalQty = before?.quantity ?? quantity;
    const classification = classify(answers, score ?? 0, finalQty, limits);

    let leadId: number;
    if (before) {
      leadId = before.id;
      await db.query(
        `UPDATE leads SET last_contact_at = now(), updated_at = now(),
                product = COALESCE(product, $2), quantity = COALESCE(quantity, $3),
                notes = CASE WHEN $4::text IS NULL THEN notes ELSE concat_ws(E'\n\n', notes, $4::text) END,
                score = $5, classification = $6, data = jsonb_set(data, '{qualificacao}', $7::jsonb)
          WHERE id = $1`,
        [leadId, p.product || null, quantity, notes ? `[${via}] ${notes}` : null, score, classification, JSON.stringify(answers)],
      );
      await recordEvent({
        userId: null, entityType: 'lead', entityId: leadId, action: 'novo_contato',
        description: `${who} mandou novas informações (${integration.name})${score !== null ? `; pontuação ${score}` : ''}`,
        data: { integration: integration.name, payload: p }, ip: req.ip,
      }, db);
    } else {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO leads (customer_id, origin_id, channel, product, quantity, notes, integration_id, score, classification, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [customer.id, origin.id, integration.channel, p.product || null, quantity, notes, integration.id, score, classification,
          { email: p.email || undefined, external_id: p.externalId || undefined, qualificacao: answers }],
      );
      leadId = rows[0].id;
      await recordEvent({
        userId: null, entityType: 'lead', entityId: leadId, action: 'criado',
        description: `Lead ${who} chegou pelo ${integration.name} (${origin.name})${score !== null ? `; pontuação ${score}` : ''}`,
        data: { integration: integration.name, payload: p }, ip: req.ip,
      }, db);
    }
    if (p.externalId) {
      await db.query(`UPDATE leads SET data = jsonb_set(data, '{external_id}', to_jsonb($2::text)) WHERE id = $1`, [leadId, p.externalId]);
    }

    // Avisos: lead quente vira alerta especial para o comercial (só na primeira vez que fica quente)
    const ficouQuente = classification === 'quente' && before?.classification !== 'quente';
    if (ficouQuente) {
      await notifyWhoCan('funil', `🔥 Lead quente (${score} pontos): ${who} · ${origin.name}`, `/leads/${leadId}`, {}, db);
    } else if (!before) {
      await notifyWhoCan('funil', `Novo lead: ${who} · ${origin.name} (${integration.name})`, `/leads/${leadId}`, {}, db);
    }

    if (optOut) {
      await db.query('UPDATE leads SET opt_out_at = COALESCE(opt_out_at, now()) WHERE customer_id = $1', [customer.id]);
      await db.query(`UPDATE recontacts r SET status = 'cancelado' FROM leads l WHERE r.lead_id = l.id AND l.customer_id = $1 AND r.status = 'agendado'`, [customer.id]);
      await recordEvent({ userId: null, entityType: 'lead', entityId: leadId, action: 'opt_out', description: `${who} pediu para não ser mais chamado; recontatos cancelados`, ip: req.ip }, db);
    } else if (recontato) {
      await db.query(
        'INSERT INTO recontacts (lead_id, due_date, note, consent_text) VALUES ($1, $2, $3, $4)',
        [leadId, recontato.date, recontato.note, recontato.consent],
      );
      await recordEvent({
        userId: null, entityType: 'lead', entityId: leadId, action: 'recontato_agendado',
        description: `Recontato agendado para ${recontato.date.split('-').reverse().join('/')} a pedido do cliente ("${recontato.consent}")`, ip: req.ip,
      }, db);
    }

    const order = questions.map((q) => q.key);
    const ordered = Object.fromEntries(Object.entries(answers).sort(([a], [b]) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999)));
    const summary = leadSummary({ name: customer.name, phone: customer.phone, product: before?.product ?? (p.product || null), quantity: finalQty }, ordered, score);
    return { leadId, duplicado: !!before, score, classification, summary };
  });

  const comercial = validPhone(settings.whatsapp_comercial);
  res.status(result.duplicado ? 200 : 201).json({
    ok: true,
    lead_id: result.leadId,
    duplicado: result.duplicado,
    pontuacao: result.score,
    classificacao: result.classification,
    // Para o ManyChat: link que leva o cliente ao WhatsApp da Laura já com o resumo
    link_whatsapp_comercial: comercial ? whatsappLink(comercial, result.summary) : null,
    mensagem_varejo: result.classification === 'varejo' ? settings.sdr_mensagem_varejo : null,
  });
});

/** Teste rápido da chave (GET), útil ao configurar a ferramenta. */
apiRouter.get('/api/leads', async (req, res) => {
  const integration = await findIntegrationByToken(tokenFrom(req));
  if (!integration || !integration.active) return res.status(401).json({ ok: false, erro: 'Chave da integração inválida ou desativada.' });
  res.json({ ok: true, integracao: integration.name, mensagem: 'Chave válida. Envie os leads com POST neste mesmo endereço.' });
});

