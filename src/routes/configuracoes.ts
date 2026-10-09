import { Router } from 'express';
import { pool } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { listOrigins } from '../lib/leads.js';
import { INTEGRATION_CHANNELS, isIntegrationChannel, newToken } from '../lib/integrations.js';
import { flash, requirePermission } from '../middleware.js';

export const configuracoesRouter = Router();
configuracoesRouter.use('/configuracoes', requirePermission('configuracoes'));

async function listIntegrations() {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.channel, i.active, i.token_hint, i.last_used_at, o.name AS origin,
            (SELECT count(*)::int FROM leads l WHERE l.integration_id = i.id) AS leads
       FROM integrations i JOIN origins o ON o.id = i.origin_id ORDER BY i.active DESC, i.name`,
  );
  return rows;
}

configuracoesRouter.get('/configuracoes', async (_req, res) => {
  res.render('configuracoes', {
    title: 'Cadastros e configurações', origins: await listOrigins(false), integrations: await listIntegrations(), INTEGRATION_CHANNELS,
  });
});

function apiUrl(req: import('express').Request): string {
  return `${req.protocol}://${req.get('host')}/api/leads`;
}

/** Mostra a chave uma única vez, com o endereço pronto para colar na ferramenta. */
function showToken(req: import('express').Request, res: import('express').Response, name: string, token: string) {
  res.render('integracao-chave', { title: 'Chave da integração', name, token, url: apiUrl(req) });
}

configuracoesRouter.post('/configuracoes/integracoes', async (req, res) => {
  const name = String(req.body.nome ?? '').trim();
  const channel = String(req.body.canal ?? '');
  const originId = Number(req.body.origem);
  const origin = (await listOrigins()).find((o) => o.id === originId);
  if (!name || !isIntegrationChannel(channel) || !origin) {
    flash(req, 'erro', 'Para criar a integração, informe nome, tipo e origem.');
    return res.redirect('/configuracoes');
  }
  const t = newToken();
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO integrations (name, channel, origin_id, token_hash, token_hint, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [name, channel, origin.id, t.hash, t.hint, req.user!.id],
  );
  await recordEvent({
    userId: req.user!.id, entityType: 'integracao', entityId: rows[0].id, action: 'criada',
    description: `Criou a integração "${name}" (${INTEGRATION_CHANNELS[channel]}, origem ${origin.name})`, ip: req.ip,
  });
  showToken(req, res, name, t.token);
});

configuracoesRouter.post('/configuracoes/integracoes/:id/nova-chave', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM integrations WHERE id = $1', [Number.isInteger(id) ? id : 0]);
  if (!rows[0]) return res.redirect('/configuracoes');
  const t = newToken();
  await pool.query('UPDATE integrations SET token_hash = $2, token_hint = $3 WHERE id = $1', [id, t.hash, t.hint]);
  await recordEvent({ userId: req.user!.id, entityType: 'integracao', entityId: id, action: 'nova_chave', description: `Gerou nova chave para "${rows[0].name}" (a antiga parou de funcionar)`, ip: req.ip });
  showToken(req, res, rows[0].name, t.token);
});

configuracoesRouter.post('/configuracoes/integracoes/:id/ativa', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query<{ name: string; active: boolean }>(
    'UPDATE integrations SET active = NOT active WHERE id = $1 RETURNING name, active', [Number.isInteger(id) ? id : 0],
  );
  if (rows[0]) {
    await recordEvent({ userId: req.user!.id, entityType: 'integracao', entityId: id, action: rows[0].active ? 'ativada' : 'desativada', description: `${rows[0].active ? 'Ativou' : 'Desativou'} a integração "${rows[0].name}"`, ip: req.ip });
    flash(req, 'sucesso', `Integração ${rows[0].active ? 'ativada' : 'desativada'}.`);
  }
  res.redirect('/configuracoes');
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
