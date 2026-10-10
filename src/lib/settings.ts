import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';

export type SettingKey =
  | 'sdr_nota_quente' | 'sdr_nota_morno' | 'limite_atacado' | 'whatsapp_comercial' | 'sdr_mensagem_varejo' | 'manychat_flow_recontato'
  | 'frete_cep_origem' | 'empresa_nome' | 'empresa_cnpj' | 'empresa_telefone' | 'empresa_email' | 'empresa_site' | 'empresa_endereco';

export async function getSettings(db: Queryable = pool): Promise<Record<SettingKey, string>> {
  const { rows } = await db.query<{ key: SettingKey; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<SettingKey, string>;
}

export async function setSetting(key: SettingKey, value: string, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}
