import { Router } from 'express';
import { pool } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { listOrigins } from '../lib/leads.js';
import { flash, requirePermission } from '../middleware.js';

export const configuracoesRouter = Router();
configuracoesRouter.use('/configuracoes', requirePermission('configuracoes'));

configuracoesRouter.get('/configuracoes', async (_req, res) => {
  res.render('configuracoes', { title: 'Cadastros e configurações', origins: await listOrigins(false) });
});

configuracoesRouter.post('/configuracoes/origens', async (req, res) => {
  const name = String(req.body.nome ?? '').trim();
  if (!name) {
    flash(req, 'erro', 'Informe o nome da origem.');
    return res.redirect('/configuracoes');
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO origins (name, position) VALUES ($1, (SELECT COALESCE(max(position), 0) + 1 FROM origins))
     ON CONFLICT DO NOTHING RETURNING id`,
    [name],
  );
  if (!rows[0]) {
    flash(req, 'erro', `Já existe a origem "${name}".`);
    return res.redirect('/configuracoes');
  }
  await recordEvent({ userId: req.user!.id, entityType: 'origem', entityId: rows[0].id, action: 'criada', description: `Criou a origem "${name}"`, ip: req.ip });
  flash(req, 'sucesso', `Origem "${name}" criada.`);
  res.redirect('/configuracoes');
});

configuracoesRouter.post('/configuracoes/origens/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query<{ name: string; active: boolean }>('SELECT name, active FROM origins WHERE id = $1', [Number.isInteger(id) ? id : 0]);
  const origin = rows[0];
  if (!origin) return res.redirect('/configuracoes');
  const name = String(req.body.nome ?? '').trim() || origin.name;
  const active = req.body.ativa === 'on';
  const { rowCount: dup } = await pool.query('SELECT 1 FROM origins WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
  if (dup) {
    flash(req, 'erro', `Já existe a origem "${name}".`);
    return res.redirect('/configuracoes');
  }
  if (name !== origin.name || active !== origin.active) {
    await pool.query('UPDATE origins SET name = $2, active = $3 WHERE id = $1', [id, name, active]);
    const changes = [name !== origin.name ? `nome: ${origin.name} → ${name}` : '', active !== origin.active ? (active ? 'reativada' : 'desativada') : ''].filter(Boolean);
    await recordEvent({ userId: req.user!.id, entityType: 'origem', entityId: id, action: 'alterada', description: `Alterou a origem (${changes.join('; ')})`, ip: req.ip });
    flash(req, 'sucesso', 'Origem salva.');
  }
  res.redirect('/configuracoes');
});
