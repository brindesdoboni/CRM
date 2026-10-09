import crypto from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';

export const INTEGRATION_CHANNELS = {
  site: 'Formulário do site',
  manychat: 'ManyChat (Instagram/WhatsApp)',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  outro: 'Outro',
} as const;
export type IntegrationChannel = keyof typeof INTEGRATION_CHANNELS;

export function isIntegrationChannel(value: unknown): value is IntegrationChannel {
  return typeof value === 'string' && value in INTEGRATION_CHANNELS;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Gera uma chave nova (mostrada uma única vez para o Admin). */
export function newToken(): { token: string; hash: string; hint: string } {
  const token = `crm_${crypto.randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), hint: token.slice(-4) };
}

export interface Integration {
  id: number; name: string; channel: IntegrationChannel; origin_id: number; active: boolean;
}

export async function findIntegrationByToken(token: string, db: Queryable = pool): Promise<Integration | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await db.query<Integration>(
    'SELECT id, name, channel, origin_id, active FROM integrations WHERE token_hash = $1',
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/**
 * Lê os campos mais comuns de qualquer formulário/ferramenta, aceitando nomes em português ou inglês,
 * maiúsculas/minúsculas e o formato do Elementor (fields[nome][value]).
 */
export function readLeadPayload(body: unknown): {
  phone: string; name: string; email: string; product: string; quantity: string; message: string; origin: string; externalId: string;
  extra: Record<string, string>;
} {
  const flat: Record<string, string> = {};
  const walk = (value: unknown, key: string) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      // Elementor: { fields: { nome: { value: '...' } } } ou { nome: { value, raw_value } }
      if ('value' in obj && typeof obj.value !== 'object') return walk(obj.value, key);
      for (const [k, v] of Object.entries(obj)) walk(v, k);
      return;
    }
    if (Array.isArray(value)) return walk(value.join(', '), key);
    const k = key.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      .replace(/^(form_fields|fields)_/, '');
    if (k && !(k in flat)) flat[k] = String(value).trim().slice(0, 2000);
  };
  walk(body, '');
  const used = new Set<string>();
  const take = (...keys: string[]) => {
    const found = keys.find((k) => flat[k]);
    if (found) used.add(found);
    return found ? flat[found] : '';
  };
  const result = {
    phone: take('telefone', 'phone', 'whatsapp', 'celular', 'fone', 'tel', 'phone_number', 'numero', 'contato'),
    name: take('nome', 'name', 'full_name', 'nome_completo', 'first_name', 'cliente'),
    email: take('email', 'e_mail'),
    product: take('produto', 'product', 'interesse', 'item'),
    quantity: take('quantidade', 'quantity', 'qtd', 'qtde'),
    message: take('mensagem', 'message', 'observacoes', 'observacao', 'obs', 'comentario', 'comentarios', 'duvida'),
    origin: take('origem', 'origin', 'loja'),
    externalId: take('external_id', 'id_externo', 'subscriber_id', 'contact_id'),
    extra: {} as Record<string, string>,
  };
  for (const [k, v] of Object.entries(flat)) {
    if (!used.has(k) && !['token', 'form_id', 'form_name', '_csrf'].includes(k)) result.extra[k] = v;
  }
  return result;
}
