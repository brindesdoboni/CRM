import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { findUserById, type User } from './lib/users.js';
import { ROLE_LABELS } from './lib/roles.js';
import { PERMISSIONS, can, homePath, type Permission } from './lib/permissions.js';
import { formatDate, formatDateTime, formatMoney } from './lib/format.js';
import { unreadCount } from './lib/notifications.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function flash(req: Request, type: 'sucesso' | 'erro', message: string): void {
  req.session.flash = [...(req.session.flash ?? []), { type, message }];
}

/** Carrega o usuário logado e deixa disponíveis nas telas: usuário, token CSRF, mensagens e formatadores. */
export async function loadUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.session.userId) {
    const user = await findUserById(req.session.userId);
    if (user?.active) {
      req.user = user;
    } else {
      delete req.session.userId;
    }
  }
  req.session.csrfToken ??= crypto.randomBytes(32).toString('hex');
  res.locals.currentUser = req.user ?? null;
  // Quem vê o funil enxerga todos os leads: o menu chama "Leads"; para o Danielson continua "Novo lead"
  res.locals.menu = req.user
    ? PERMISSIONS.filter((p) => can(req.user!, p.key)).map((p) => (p.key === 'leads' && can(req.user!, 'funil') ? { ...p, label: 'Leads' } : p))
    : [];
  res.locals.unread = req.user ? await unreadCount(req.user.id) : 0;
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.flash = req.session.flash ?? [];
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.ROLE_LABELS = ROLE_LABELS;
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.formatMoney = formatMoney;
  next();
}

/** Protege formulários contra envio a partir de outros sites. */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body?._csrf as string | undefined) ?? req.get('x-csrf-token');
  const expected = req.session.csrfToken;
  if (!sent || !expected || sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    res.status(403).render('erro', { title: 'Sessão expirada', message: 'O formulário expirou. Volte, atualize a página e tente de novo.' });
    return;
  }
  next();
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect(`/login?voltar=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  next();
}

function deny(req: Request, res: Response): void {
  res.status(403).render('erro', {
    title: 'Sem acesso',
    message: 'Você não tem permissão para ver esta tela. Se precisar, peça ao Lucas para liberar.',
    backUrl: homePath(req.user!),
  });
}

/** Libera a rota só para quem tem a permissão marcada. O Admin sempre tem acesso. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.redirect(`/login?voltar=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!can(req.user, permission)) return deny(req, res);
    next();
  };
}

/** Só o Admin (ex.: tela de usuários e permissões). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect(`/login?voltar=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  if (req.user.role !== 'admin') return deny(req, res);
  next();
}
