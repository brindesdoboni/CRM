import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import multer from 'multer';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { loadUser, verifyCsrf } from './middleware.js';
import { MAX_FILE_MB, upload } from './lib/files.js';
import { authRouter } from './routes/auth.js';
import { usuariosRouter } from './routes/usuarios.js';
import { paginasRouter } from './routes/paginas.js';
import { leadsRouter } from './routes/leads.js';
import { vendasRouter } from './routes/vendas.js';
import { producaoRouter } from './routes/producao.js';
import { geralRouter } from './routes/geral.js';
import { configuracoesRouter } from './routes/configuracoes.js';
import { apiRouter } from './routes/api.js';
import { sdrRouter } from './routes/sdr.js';

const root = path.resolve(import.meta.dirname, '..');

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  // O Railway fica na frente do sistema como proxy; necessário para cookie seguro e IP correto
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:'], 'media-src': ["'self'"] } },
  }));

  app.get('/saude', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/static', express.static(path.join(root, 'public'), { maxAge: config.isProduction ? '1d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Entrada automática de leads: antes da sessão (não usa login nem cookie)
  app.use(apiRouter);

  const PgStore = connectPgSimple(session);
  app.use(session({
    name: 'crm.sid',
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 12 * 60 * 60 * 1000, // 12 horas sem uso → precisa entrar de novo
    },
  }));

  app.use(loadUser);
  // Formulários com anexo (campo "arquivo"): lidos antes da checagem CSRF, e só para quem entrou
  app.use((req, res, next) => (req.user ? upload.single('arquivo')(req, res, next) : next()));
  app.use(verifyCsrf);

  app.use(authRouter);
  app.use(usuariosRouter);
  app.use(paginasRouter);
  app.use(leadsRouter);
  app.use(vendasRouter);
  app.use(producaoRouter);
  app.use(geralRouter);
  app.use(sdrRouter);
  app.use(configuracoesRouter);

  app.use((_req, res) => {
    res.status(404).render('erro', { title: 'Página não encontrada', message: 'Esta página não existe.' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? `O arquivo passa de ${MAX_FILE_MB} MB. Envie um menor.` : 'Não foi possível receber o arquivo.';
      return res.status(400).render('erro', { title: 'Arquivo não aceito', message });
    }
    console.error(err);
    res.status(500).render('erro', { title: 'Erro', message: 'Algo deu errado. Tente de novo; se continuar, avise o Lucas.' });
  });

  return app;
}
