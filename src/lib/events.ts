import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';

export interface EventInput {
  userId: number | null;
  entityType: string;
  entityId?: string | number | null;
  action: string;
  description?: string;
  data?: Record<string, unknown>;
  ip?: string;
}

/** Registra no histórico quem fez, o quê e quando. */
export async function recordEvent(e: EventInput, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO events (user_id, entity_type, entity_id, action, description, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.userId, e.entityType, e.entityId == null ? null : String(e.entityId), e.action, e.description ?? null, e.data ?? {}, e.ip ?? null],
  );
}
