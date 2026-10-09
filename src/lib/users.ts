import bcrypt from 'bcryptjs';
import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import type { Role } from './roles.js';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  permissions: string[] | null;
  active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

let dummyHash: string | undefined;
const PUBLIC_COLUMNS = 'id, name, email, role, permissions, active, last_login_at, created_at';
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  return null;
}

export async function findUserById(id: number, db: Queryable = pool): Promise<User | null> {
  const { rows } = await db.query<User>(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listUsers(db: Queryable = pool): Promise<User[]> {
  const { rows } = await db.query<User>(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY active DESC, name`);
  return rows;
}

export async function emailInUse(email: string, exceptId?: number, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, exceptId ?? 0]);
  return (rowCount ?? 0) > 0;
}

export async function createUser(
  input: { name: string; email: string; password: string; role: Role },
  db: Queryable = pool,
): Promise<User> {
  const hash = await hashPassword(input.password);
  const { rows } = await db.query<User>(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLUMNS}`,
    [input.name.trim(), normalizeEmail(input.email), hash, input.role],
  );
  return rows[0];
}

/** Confere e-mail e senha. Devolve o usuário só se estiver ativo e a senha bater. */
export async function authenticate(email: string, password: string, db: Queryable = pool): Promise<User | null> {
  const { rows } = await db.query<User & { password_hash: string }>(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  const row = rows[0];
  // Compara mesmo quando o usuário não existe, para não revelar quais e-mails estão cadastrados pelo tempo de resposta
  dummyHash ??= await hashPassword('senha-inexistente');
  const ok = await bcrypt.compare(password, row?.password_hash ?? dummyHash);
  if (!row || !ok || !row.active) return null;
  const { password_hash: _ignored, ...user } = row;
  return user;
}

export async function setPassword(userId: number, password: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(password)]);
}

export async function checkPassword(userId: number, password: string, db: Queryable = pool): Promise<boolean> {
  const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return rows[0] ? bcrypt.compare(password, rows[0].password_hash) : false;
}

export async function countActiveAdmins(db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
  return rows[0].n;
}

/** Cria o primeiro Admin a partir de ADMIN_EMAIL/ADMIN_PASSWORD se o banco ainda não tiver nenhum usuário. */
export async function ensureFirstAdmin(log: (msg: string) => void = console.log): Promise<void> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log('Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro Admin.');
    return;
  }
  const problem = validatePassword(password);
  if (problem) {
    log(`ADMIN_PASSWORD inválida: ${problem}`);
    return;
  }
  const user = await createUser({ name: process.env.ADMIN_NAME || 'Admin', email, password, role: 'admin' });
  await pool.query(
    `INSERT INTO events (user_id, entity_type, entity_id, action, description) VALUES (NULL, 'user', $1, 'criado', $2)`,
    [String(user.id), `Primeiro Admin criado automaticamente (${user.email})`],
  );
  log(`Primeiro Admin criado: ${user.email}`);
}

/**
 * Recuperação da senha do Admin sem precisar do sistema: se ADMIN_RESET_PASSWORD estiver definida no Railway,
 * a senha do usuário ADMIN_EMAIL vira essa ao iniciar (e ele volta a ser Admin ativo). Depois, apague a variável.
 */
export async function resetAdminPasswordFromEnv(log: (msg: string) => void = console.log): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_RESET_PASSWORD;
  if (!password) return;
  if (!email) return log('ADMIN_RESET_PASSWORD definida, mas falta ADMIN_EMAIL.');
  const problem = validatePassword(password);
  if (problem) return log(`ADMIN_RESET_PASSWORD inválida: ${problem}`);
  const { rows } = await pool.query<{ id: number }>(
    `UPDATE users SET password_hash = $2, role = 'admin', active = true, permissions = NULL, updated_at = now()
      WHERE lower(email) = lower($1) RETURNING id`,
    [email, await hashPassword(password)],
  );
  if (!rows[0]) return log(`ADMIN_RESET_PASSWORD: nenhum usuário com o e-mail ${email}.`);
  await pool.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [rows[0].id]);
  await pool.query(
    `INSERT INTO events (user_id, entity_type, entity_id, action, description) VALUES (NULL, 'user', $1, 'senha_redefinida', $2)`,
    [String(rows[0].id), 'Senha do Admin redefinida pela variável ADMIN_RESET_PASSWORD do Railway'],
  );
  log(`Senha do Admin ${email} redefinida. Apague ADMIN_RESET_PASSWORD no Railway.`);
}
