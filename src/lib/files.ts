import multer from 'multer';
import type { Request } from 'express';
import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { can } from './permissions.js';
import type { User } from './users.js';

export type FileKind = 'print_lead' | 'arte_venda';
export const MAX_FILE_MB = 8;

/** Recebe um arquivo do formulário na memória (depois vai para o banco). */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1, fields: 50 },
});

/** Descobre o tipo real pelo conteúdo (não confia na extensão). Só imagens comuns e PDF. */
export function detectMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** Guarda o arquivo enviado (se houver). Devolve o id, null se não veio arquivo, ou uma mensagem de erro. */
export async function saveUploadedFile(
  req: Request, kind: FileKind, db: Queryable = pool,
): Promise<{ id: number | null; error?: string }> {
  const f = req.file;
  if (!f || f.size === 0) return { id: null };
  const mime = detectMime(f.buffer);
  const allowPdf = kind === 'arte_venda';
  if (!mime || (mime === 'application/pdf' && !allowPdf)) {
    return { id: null, error: allowPdf ? 'O arquivo precisa ser uma imagem (JPG, PNG, WEBP, GIF) ou PDF.' : 'O print precisa ser uma imagem (JPG, PNG, WEBP ou GIF).' };
  }
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO files (kind, filename, mime, size, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [kind, f.originalname.slice(0, 200) || 'arquivo', mime, f.size, f.buffer, req.user?.id ?? null],
  );
  return { id: rows[0].id };
}

export interface StoredFile { id: number; kind: FileKind; filename: string; mime: string; size: number; data: Buffer; created_by: number | null }

export async function findFile(id: number): Promise<StoredFile | null> {
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query<StoredFile>('SELECT id, kind, filename, mime, size, data, created_by FROM files WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Print de lead: quem criou ou quem vê o funil. Arte: produção ou vendas. */
export function canSeeFile(user: User, file: StoredFile): boolean {
  if (file.kind === 'print_lead') return file.created_by === user.id || can(user, 'funil');
  return can(user, 'producao') || can(user, 'pedidos');
}
