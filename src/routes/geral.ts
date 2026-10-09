import { Router } from 'express';
import { pool } from '../db/pool.js';
import { canSeeFile, findFile } from '../lib/files.js';
import { requireLogin } from '../middleware.js';

/** Avisos (sininho) e arquivos anexados. */
export const geralRouter = Router();

geralRouter.get('/avisos', requireLogin, async (req, res) => {
  const { rows: avisos } = await pool.query(
    'SELECT id, title, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [req.user!.id],
  );
  res.render('avisos', { title: 'Avisos', avisos });
});

geralRouter.post('/avisos/lidos', requireLogin, async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
  res.redirect('/avisos');
});

/** Abre o aviso: marca como lido e vai para a tela dele. */
geralRouter.get('/avisos/:id', requireLogin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = Number.isInteger(id)
    ? await pool.query<{ link: string | null }>(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING link', [id, req.user!.id],
    )
    : { rows: [] };
  const link = rows[0]?.link;
  res.redirect(link && link.startsWith('/') && !link.startsWith('//') ? link : '/avisos');
});

geralRouter.get('/arquivos/:id', requireLogin, async (req, res) => {
  const file = await findFile(Number(req.params.id));
  if (!file || !canSeeFile(req.user!, file)) {
    return res.status(404).render('erro', { title: 'Não encontrado', message: 'Arquivo não encontrado.' });
  }
  const name = file.filename.replace(/[^\w.\- ]+/g, '_');
  res.set('Content-Type', file.mime);
  res.set('Content-Disposition', `${req.query.baixar ? 'attachment' : 'inline'}; filename="${name}"`);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(file.data);
});
