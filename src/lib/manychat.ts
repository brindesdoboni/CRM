/** Conversa do CRM com a API do ManyChat (só quando a variável MANYCHAT_API_KEY existe). */

const API = 'https://api.manychat.com';

type Json = { status?: string; data?: unknown; message?: string; details?: unknown };

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; json: Json }> {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) return { ok: false, json: { message: 'sem chave' } };
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok && json.status === 'success', json };
  } catch (err) {
    return { ok: false, json: { message: (err as Error).message } };
  }
}

export function manychatConfigured(): boolean {
  return !!process.env.MANYCHAT_API_KEY;
}

/** Dispara um fluxo do ManyChat para o contato (ex.: boas-vindas ou recontato com a opção de sair). */
export async function sendManychatFlow(subscriberId: string, flowNs: string): Promise<boolean> {
  if (!subscriberId || !flowNs) return false;
  return (await call('POST', '/fb/sending/sendFlow', { subscriber_id: subscriberId, flow_ns: flowNs })).ok;
}

/**
 * Contato do WhatsApp no ManyChat: procura pelo telefone e, se não existir, cria
 * já com a frase de consentimento que o cliente aceitou no formulário.
 */
async function findOrCreateWhatsappSubscriber(phone: string, name: string, email: string | null, consent: string): Promise<string | null> {
  const e164 = `+55${phone}`;
  const found = await call('GET', `/fb/subscriber/findBySystemField?phone=${encodeURIComponent(e164)}`);
  const foundId = (found.json.data as { id?: string | number } | null)?.id;
  if (found.ok && foundId) return String(foundId);
  const [first, ...rest] = name.trim().split(/\s+/);
  const created = await call('POST', '/fb/subscriber/createSubscriber', {
    first_name: first || name, last_name: rest.join(' ') || undefined,
    whatsapp_phone: e164, email: email || undefined, has_opt_in_email: false, consent_phrase: consent,
  });
  const createdId = (created.json.data as { id?: string | number } | null)?.id;
  return created.ok && createdId ? String(createdId) : null;
}

export type WelcomeResult = { ok: true; subscriberId: string } | { ok: false; reason: string };

/**
 * Boas-vindas do SDR para quem pediu contato no formulário do site: cadastra o contato no ManyChat,
 * guarda "produto" num campo do contato e dispara o fluxo com o modelo aprovado do WhatsApp
 * ("Oi {{nome}}, aqui é da Brindes do Boni, vi seu pedido de {{produto}}...").
 */
export async function sendWelcome(input: { phone: string; name: string; email: string | null; product: string | null; consent: string; flowNs: string }): Promise<WelcomeResult> {
  if (!manychatConfigured()) return { ok: false, reason: 'falta a chave do ManyChat (MANYCHAT_API_KEY) no Railway' };
  if (!input.flowNs) return { ok: false, reason: 'o fluxo de boas-vindas não está configurado em Configurações → SDR' };
  const subscriberId = await findOrCreateWhatsappSubscriber(input.phone, input.name, input.email, input.consent);
  if (!subscriberId) return { ok: false, reason: 'o ManyChat não aceitou o contato do cliente' };
  await call('POST', '/fb/subscriber/setCustomFieldByName', { subscriber_id: subscriberId, field_name: 'produto', field_value: input.product || 'brindes personalizados' });
  if (!(await sendManychatFlow(subscriberId, input.flowNs))) return { ok: false, reason: 'o ManyChat não conseguiu enviar a mensagem' };
  return { ok: true, subscriberId };
}
