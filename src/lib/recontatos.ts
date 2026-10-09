import { pool } from '../db/pool.js';
import { recordEvent } from './events.js';
import { formatPhone } from './leads.js';
import { notifyWhoCan } from './notifications.js';
import { getSettings } from './settings.js';

/** Dispara um fluxo do ManyChat para o contato (ex.: a mensagem de recontato com a opção de sair). */
async function sendManychatFlow(subscriberId: string, flowNs: string): Promise<boolean> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key || !subscriberId || !flowNs) return false;
  try {
    const res = await fetch('https://api.manychat.com/fb/sending/sendFlow', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: flowNs }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return res.ok && body.status === 'success';
  } catch {
    return false;
  }
}

/**
 * Recontatos que venceram hoje (ou antes): o SDR chama sozinho pelo ManyChat quando possível
 * e o comercial é avisado no sininho. Cada recontato é processado uma vez só.
 */
export async function processDueRecontacts(log: (m: string) => void = console.log): Promise<number> {
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(727002) AS ok');
    if (!lock[0].ok) return 0;
    try {
      const settings = await getSettings(client);
      const { rows } = await client.query<{ id: number; lead_id: number; note: string | null; consent_text: string; phone: string; name: string | null; external_id: string | null }>(
        `SELECT r.id, r.lead_id, r.note, r.consent_text, c.phone, c.name, l.data->>'external_id' AS external_id
           FROM recontacts r JOIN leads l ON l.id = r.lead_id JOIN customers c ON c.id = l.customer_id
          WHERE r.status = 'agendado' AND r.notified_at IS NULL AND r.due_date <= current_date AND l.opt_out_at IS NULL
          ORDER BY r.due_date, r.id LIMIT 200`,
      );
      for (const r of rows) {
        const who = r.name || formatPhone(r.phone);
        const sent = r.external_id ? await sendManychatFlow(r.external_id, settings.manychat_flow_recontato) : false;
        await client.query(
          `UPDATE recontacts SET notified_at = now(), sent_auto_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1`,
          [r.id, sent],
        );
        await recordEvent({
          userId: null, entityType: 'lead', entityId: r.lead_id, action: 'recontato_vencido',
          description: sent ? `O SDR chamou ${who} automaticamente (recontato combinado)` : `Dia de recontatar ${who} (combinado: "${r.consent_text}")`,
        }, client);
        await notifyWhoCan(
          'funil',
          sent ? `O SDR chamou ${who} (recontato combinado). Acompanhe no WhatsApp.` : `Hoje: recontatar ${who}${r.note ? ` — ${r.note}` : ''}`,
          `/leads/${r.lead_id}`, {}, client,
        );
      }
      if (rows.length) log(`Recontatos processados: ${rows.length}`);
      return rows.length;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727002)');
    }
  } finally {
    client.release();
  }
}

/** Roda agora e depois a cada 15 minutos. */
export function startRecontactScheduler(): void {
  const run = () => processDueRecontacts().catch((err) => console.error('Erro nos recontatos:', err));
  void run();
  setInterval(run, 15 * 60 * 1000).unref();
}
