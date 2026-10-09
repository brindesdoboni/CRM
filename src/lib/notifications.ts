import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { permissionsOf, type Permission } from './permissions.js';
import type { Role } from './roles.js';

/** Manda um aviso (sininho) para cada usuário ativo que tem a permissão indicada. */
export async function notifyWhoCan(
  permission: Permission, title: string, link: string | null, opts: { exceptUserId?: number } = {}, db: Queryable = pool,
): Promise<void> {
  const { rows } = await db.query<{ id: number; role: Role; permissions: string[] | null }>(
    'SELECT id, role, permissions FROM users WHERE active',
  );
  const ids = rows.filter((u) => u.id !== opts.exceptUserId && permissionsOf(u).includes(permission)).map((u) => u.id);
  if (!ids.length) return;
  await db.query(
    'INSERT INTO notifications (user_id, title, link) SELECT unnest($1::int[]), $2, $3',
    [ids, title, link],
  );
}

export async function unreadCount(userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return rows[0].n;
}
