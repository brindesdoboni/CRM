import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, checkPassword, setPassword, validatePassword } from '../lib/users.js';
import { recordEvent } from '../lib/events.js';
import { ROLE_HOME } from '../lib/roles.js';
import { pool } from '../db/pool.js';
import { flash, requireLogin } from '../middleware.js';

export const authRouter = Router();

// No máximo 10 tentativas de login a cada 15 minutos por endereço de internet
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) => {
    res.status(429).render('login', {
      title: 'Entrar',
      email: '',
      voltar: '',
      error: 'Muitas tentativas seguidas. Aguarde 15 minutos e tente de novo.',
    });
  },
});

/** Só aceita voltar para endereços internos do próprio sistema. */
function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '';
}

authRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect(ROLE_HOME[req.user.role]);
  res.render('login', { title: 'Entrar', email: '', voltar: safeReturnPath(req.query.voltar), error: null });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email ?? '').trim();
  const password = String(req.body.senha ?? '');
  const voltar = safeReturnPath(req.body.voltar);
  const user = email && password ? await authenticate(email, password) : null;
  if (!user) {
    await recordEvent({ userId: null, entityType: 'user', action: 'login_falhou', description: `Tentativa de login sem sucesso (${email})`, ip: req.ip });
    return res.status(401).render('login', { title: 'Entrar', email, voltar, error: 'E-mail ou senha incorretos.' });
  }
  // Nova sessão a cada login (evita aproveitarem uma sessão antiga)
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await recordEvent({ userId: user.id, entityType: 'user', entityId: user.id, action: 'login', description: 'Entrou no sistema', ip: req.ip });
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  res.redirect(voltar || ROLE_HOME[user.role]);
});

authRouter.post('/sair', async (req, res) => {
  if (req.user) {
    await recordEvent({ userId: req.user.id, entityType: 'user', entityId: req.user.id, action: 'logout', description: 'Saiu do sistema', ip: req.ip });
  }
  req.session.destroy(() => {
    res.clearCookie('crm.sid');
    res.redirect('/login');
  });
});

authRouter.get('/minha-conta', requireLogin, (_req, res) => {
  res.render('minha-conta', { title: 'Minha conta', error: null });
});

authRouter.post('/minha-conta/senha', requireLogin, async (req, res) => {
  const user = req.user!;
  const atual = String(req.body.senha_atual ?? '');
  const nova = String(req.body.nova_senha ?? '');
  const confirmacao = String(req.body.confirmacao ?? '');
  let error: string | null = null;
  if (!(await checkPassword(user.id, atual))) error = 'A senha atual está incorreta.';
  else if (nova !== confirmacao) error = 'A nova senha e a confirmação não são iguais.';
  else error = validatePassword(nova);
  if (error) return res.status(400).render('minha-conta', { title: 'Minha conta', error });
  await setPassword(user.id, nova);
  await recordEvent({ userId: user.id, entityType: 'user', entityId: user.id, action: 'senha_alterada', description: 'Alterou a própria senha', ip: req.ip });
  flash(req, 'sucesso', 'Senha alterada.');
  res.redirect('/minha-conta');
});
