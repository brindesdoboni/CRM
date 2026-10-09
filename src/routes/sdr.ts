import crypto from 'node:crypto';
import { Router } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { saveUploadedFile } from '../lib/files.js';
import { validPhone } from '../lib/leads.js';
import { listQuestions, optionsToText, parseOptionsText } from '../lib/sdr.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { flash, requirePermission } from '../middleware.js';

/** Configurações do SDR automático: regras, perguntas de qualificação e áudios padrão. */
export const sdrRouter = Router();
sdrRouter.use('/configuracoes/sdr', requirePermission('configuracoes'));

const back = '/configuracoes/sdr';

sdrRouter.get('/configuracoes/sdr', async (req, res) => {
  const [settings, questions, { rows: audios }] = await Promise.all([
    getSettings(), listQuestions(false),
    pool.query(`SELECT a.*, f.mime FROM sdr_audios a LEFT JOIN files f ON f.id = a.file_id ORDER BY a.active DESC, a.position, a.id`),
  ]);
  res.render('sdr', {
    title: 'SDR automático', settings, questions, audios, optionsToText,
    baseUrl: `${req.protocol}://${req.get('host')}`, manychatKey: !!process.env.MANYCHAT_API_KEY,
  });
});

sdrRouter.post('/configuracoes/sdr/regras', async (req, res) => {
  const quente = Number(req.body.nota_quente);
  const morno = Number(req.body.nota_morno);
  const atacado = Number(req.body.limite_atacado);
  const whats = String(req.body.whatsapp_comercial ?? '').trim();
  if (![quente, morno, atacado].every((n) => Number.isInteger(n) && n >= 0) || morno > quente) {
    flash(req, 'erro', 'Notas e limite precisam ser números inteiros, e a nota de "morno" não pode passar a de "quente".');
    return res.redirect(back);
  }
  if (whats && !validPhone(whats)) {
    flash(req, 'erro', 'WhatsApp comercial inválido: use DDD + número.');
    return res.redirect(back);
  }
  await setSetting('sdr_nota_quente', String(quente));
  await setSetting('sdr_nota_morno', String(morno));
  await setSetting('limite_atacado', String(atacado));
  await setSetting('whatsapp_comercial', whats ? validPhone(whats)! : '');
  await setSetting('sdr_mensagem_varejo', String(req.body.mensagem_varejo ?? '').trim().slice(0, 1000));
  await setSetting('manychat_flow_recontato', String(req.body.flow_recontato ?? '').trim().slice(0, 200));
  await recordEvent({ userId: req.user!.id, entityType: 'config', entityId: 'sdr', action: 'alterada', description: `Alterou as regras do SDR (quente ≥ ${quente}, morno ≥ ${morno}, atacado a partir de ${atacado})`, ip: req.ip });
  flash(req, 'sucesso', 'Regras do SDR salvas.');
  res.redirect(back);
});

const KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

sdrRouter.post('/configuracoes/sdr/perguntas', async (req, res) => {
  const id = Number(req.body.id) || null;
  const key = String(req.body.campo ?? '').trim().toLowerCase();
  const question = String(req.body.pergunta ?? '').trim();
  const options = parseOptionsText(String(req.body.opcoes ?? ''));
  const position = Number(req.body.ordem) || 0;
  const active = req.body.ativa === 'on';
  if (!question || !KEY_RE.test(key)) {
    flash(req, 'erro', 'Informe a pergunta e o nome do campo (só letras minúsculas, números e _; ex.: prazo).');
    return res.redirect(back);
  }
  const { rowCount: dup } = await pool.query('SELECT 1 FROM sdr_questions WHERE key = $1 AND id <> $2', [key, id ?? 0]);
  if (dup) {
    flash(req, 'erro', `Já existe uma pergunta com o campo "${key}".`);
    return res.redirect(back);
  }
  if (id) {
    await pool.query('UPDATE sdr_questions SET key = $2, question = $3, options = $4, position = $5, active = $6 WHERE id = $1', [id, key, question, JSON.stringify(options), position, active]);
  } else {
    await pool.query('INSERT INTO sdr_questions (key, question, options, position) VALUES ($1, $2, $3, $4)', [key, question, JSON.stringify(options), position]);
  }
  await recordEvent({ userId: req.user!.id, entityType: 'config', entityId: 'sdr', action: id ? 'pergunta_alterada' : 'pergunta_criada', description: `${id ? 'Alterou' : 'Criou'} a pergunta do SDR "${question}"`, ip: req.ip });
  flash(req, 'sucesso', 'Pergunta salva.');
  res.redirect(back);
});

sdrRouter.post('/configuracoes/sdr/audios', async (req, res) => {
  const id = Number(req.body.id) || null;
  const title = String(req.body.titulo ?? '').trim();
  if (!title) {
    flash(req, 'erro', 'Dê um nome para o áudio.');
    return res.redirect(back);
  }
  const result = await withTransaction(async (db) => {
    const file = await saveUploadedFile(req, 'audio_sdr', db);
    if (file.error) return file.error;
    if (!id && !file.id) return 'Escolha o arquivo de áudio.';
    const values = [title, String(req.body.quando ?? '').trim() || null, String(req.body.transcricao ?? '').trim() || null, Number(req.body.ordem) || 0];
    if (id) {
      await db.query(
        `UPDATE sdr_audios SET title = $2, when_to_use = $3, transcript = $4, position = $5, active = $6,
                file_id = COALESCE($7, file_id), updated_at = now() WHERE id = $1`,
        [id, ...values, req.body.ativo === 'on', file.id],
      );
    } else {
      await db.query(
        'INSERT INTO sdr_audios (title, when_to_use, transcript, position, file_id, public_token, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [...values, file.id, crypto.randomBytes(18).toString('base64url'), req.user!.id],
      );
    }
    await recordEvent({ userId: req.user!.id, entityType: 'config', entityId: 'sdr', action: id ? 'audio_alterado' : 'audio_criado', description: `${id ? 'Alterou' : 'Cadastrou'} o áudio padrão "${title}"`, ip: req.ip }, db);
    return null;
  });
  if (result) flash(req, 'erro', result);
  else flash(req, 'sucesso', 'Áudio salvo.');
  res.redirect(back);
});

/** Link público do áudio (difícil de adivinhar), para o ManyChat buscar e mandar ao cliente. */
sdrRouter.get('/publico/audio/:token', async (req, res) => {
  const { rows } = await pool.query<{ mime: string; data: Buffer; filename: string }>(
    `SELECT f.mime, f.data, f.filename FROM sdr_audios a JOIN files f ON f.id = a.file_id WHERE a.public_token = $1 AND a.active`,
    [String(req.params.token)],
  );
  if (!rows[0]) return res.status(404).send('Áudio não encontrado.');
  const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' }[rows[0].mime] ?? 'audio';
  res.set('Content-Type', rows[0].mime);
  res.set('Content-Disposition', `inline; filename="audio.${ext}"`);
  res.set('Cache-Control', 'public, max-age=300');
  res.send(rows[0].data);
});
