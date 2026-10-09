import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { INTEGRATION_CHANNELS, findIntegrationByToken, readLeadPayload } from '../lib/integrations.js';
import { formatPhone, listOrigins, upsertCustomer, validPhone } from '../lib/leads.js';
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

/** Etapas em que o lead ainda está "em aberto": um novo contato entra nele em vez de criar outro. */
const OPEN_STAGES = ['novo_lead', 'atendimento', 'aguardando_informacoes', 'orcamento_preparacao', 'orcamento_enviado', 'negociacao'];
const DEDUP_DAYS = 30;

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
  const parsedQty = Number.parseInt(p.quantity.replace(/\D/g, ''), 10);
  const quantity = Number.isInteger(parsedQty) && parsedQty > 0 && parsedQty < 1_000_000 ? parsedQty : null;
  const notes = [p.message, ...Object.entries(p.extra).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n') || null;
  const via = INTEGRATION_CHANNELS[integration.channel];

  const result = await withTransaction(async (db) => {
    await db.query('UPDATE integrations SET last_used_at = now() WHERE id = $1', [integration.id]);
    const { customer } = await upsertCustomer(phone, p.name || null, null, db);
    if (p.email && !customer.email) await db.query('UPDATE customers SET email = $2 WHERE id = $1', [customer.id, p.email.slice(0, 200)]);
    const who = customer.name || formatPhone(customer.phone);

    // Anti-duplicidade: o cliente já tem um lead em aberto recente? Registra o novo contato nele.
    const { rows: abertos } = await db.query<{ id: number; assigned_to: number | null }>(
      `SELECT id, assigned_to FROM leads
        WHERE customer_id = $1 AND stage = ANY($2) AND last_contact_at > now() - make_interval(days => $3)
        ORDER BY last_contact_at DESC LIMIT 1`,
      [customer.id, OPEN_STAGES, DEDUP_DAYS],
    );
    if (abertos[0]) {
      const leadId = abertos[0].id;
      await db.query(
        `UPDATE leads SET last_contact_at = now(), updated_at = now(),
                product = COALESCE(product, $2), quantity = COALESCE(quantity, $3),
                notes = CASE WHEN $4::text IS NULL THEN notes ELSE concat_ws(E'\n\n', notes, $4::text) END
          WHERE id = $1`,
        [leadId, p.product || null, quantity, notes ? `[${via}] ${notes}` : null],
      );
      await recordEvent({
        userId: null, entityType: 'lead', entityId: leadId, action: 'novo_contato',
        description: `${who} chamou de novo (${integration.name}); juntado ao lead em aberto`,
        data: { integration: integration.name, payload: p }, ip: req.ip,
      }, db);
      await notifyWhoCan('funil', `${who} chamou de novo pelo ${integration.name}`, `/leads/${leadId}`, {}, db);
      return { leadId, duplicado: true };
    }

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO leads (customer_id, origin_id, channel, product, quantity, notes, integration_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [customer.id, origin.id, integration.channel, p.product || null, quantity, notes, integration.id,
        { email: p.email || undefined, external_id: p.externalId || undefined, extra: p.extra }],
    );
    const leadId = rows[0].id;
    await recordEvent({
      userId: null, entityType: 'lead', entityId: leadId, action: 'criado',
      description: `Lead ${who} chegou pelo ${integration.name} (${origin.name})`,
      data: { integration: integration.name, payload: p }, ip: req.ip,
    }, db);
    await notifyWhoCan('funil', `Novo lead: ${who} · ${origin.name} (${integration.name})`, `/leads/${leadId}`, {}, db);
    return { leadId, duplicado: false };
  });
  res.status(result.duplicado ? 200 : 201).json({ ok: true, lead_id: result.leadId, duplicado: result.duplicado });
});

/** Teste rápido da chave (GET), útil ao configurar a ferramenta. */
apiRouter.get('/api/leads', async (req, res) => {
  const integration = await findIntegrationByToken(tokenFrom(req));
  if (!integration || !integration.active) return res.status(401).json({ ok: false, erro: 'Chave da integração inválida ou desativada.' });
  res.json({ ok: true, integracao: integration.name, mensagem: 'Chave válida. Envie os leads com POST neste mesmo endereço.' });
});

