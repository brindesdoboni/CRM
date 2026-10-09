import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { normalizePhone } from './format.js';

/** Etapas do pedido (CLAUDE.md). Perdido e Pausado são saídas. */
export const STAGES = [
  { key: 'novo_lead', label: 'Novo lead' },
  { key: 'atendimento', label: 'Atendimento' },
  { key: 'aguardando_informacoes', label: 'Aguardando informações' },
  { key: 'orcamento_preparacao', label: 'Orçamento em preparação' },
  { key: 'orcamento_enviado', label: 'Orçamento enviado' },
  { key: 'negociacao', label: 'Negociação' },
  { key: 'pedido_fechado', label: 'Pedido fechado' },
  { key: 'aguardando_pagamento', label: 'Aguardando pagamento' },
  { key: 'comprovante_analise', label: 'Comprovante em análise' },
  { key: 'pago', label: 'Pago' },
  { key: 'aguardando_aprovacao', label: 'Aguardando aprovação do pedido' },
  { key: 'aprovado', label: 'Aprovado' },
  { key: 'em_producao', label: 'Em produção' },
  { key: 'aguardando_etiqueta', label: 'Aguardando emissão da etiqueta' },
  { key: 'perdido', label: 'Perdido' },
  { key: 'pausado', label: 'Pausado' },
] as const;
export type Stage = (typeof STAGES)[number]['key'];

export function isStage(value: unknown): value is Stage {
  return STAGES.some((s) => s.key === value);
}
export function stageLabel(key: string): string {
  return STAGES.find((s) => s.key === key)?.label ?? key;
}

export const CHANNEL_LABELS: Record<string, string> = {
  manual: 'Cadastro manual', site: 'Formulário do site', instagram: 'Instagram', whatsapp: 'WhatsApp', manychat: 'ManyChat', outro: 'Integração',
};

export interface Origin { id: number; name: string; active: boolean; position: number }

export async function listOrigins(onlyActive = true, db: Queryable = pool): Promise<Origin[]> {
  const { rows } = await db.query<Origin>(
    `SELECT id, name, active, position FROM origins ${onlyActive ? 'WHERE active' : ''} ORDER BY position, name`,
  );
  return rows;
}

/** Telefone válido = 10 ou 11 dígitos (DDD + número), depois de normalizar. */
export function validPhone(raw: string): string | null {
  const digits = normalizePhone(raw);
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

export interface Customer { id: number; phone: string; name: string | null; email: string | null; created_at: Date }

export async function findCustomerByPhone(phone: string, db: Queryable = pool): Promise<Customer | null> {
  const { rows } = await db.query<Customer>('SELECT id, phone, name, email, created_at FROM customers WHERE phone = $1', [phone]);
  return rows[0] ?? null;
}

/**
 * Cliente único pelo telefone: se já existe, liga ao cadastro existente (e completa o nome se faltava);
 * se não, cria. Diz se já existia.
 */
export async function upsertCustomer(
  phone: string, name: string | null, userId: number | null, db: Queryable = pool,
): Promise<{ customer: Customer; existed: boolean }> {
  const existing = await findCustomerByPhone(phone, db);
  if (existing) {
    if (!existing.name && name) {
      await db.query('UPDATE customers SET name = $2, updated_at = now() WHERE id = $1', [existing.id, name]);
      existing.name = name;
    }
    return { customer: existing, existed: true };
  }
  const { rows } = await db.query<Customer>(
    `INSERT INTO customers (phone, name, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET updated_at = now()
     RETURNING id, phone, name, email, created_at, (xmax <> 0) AS existed`,
    [phone, name, userId],
  );
  const { existed, ...customer } = rows[0] as Customer & { existed: boolean };
  return { customer, existed };
}

/** Link wa.me (Brasil) com texto opcional. */
export function whatsappLink(phone: string, text?: string): string {
  const base = `https://wa.me/55${phone}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** (11) 98765-4321 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const m = /^(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}
