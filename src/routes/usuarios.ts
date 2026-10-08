import { Router, type Request } from 'express';
import { pool } from '../db/pool.js';
import { recordEvent } from '../lib/events.js';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, isRole, type Role } from '../lib/roles.js';
import {
  PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, isCustomized, isPermission, permissionLabel, permissionsOf, type Permission,
} from '../lib/permissions.js';
import {
  countActiveAdmins, createUser, emailInUse, findUserById, listUsers, normalizeEmail, setPassword, validatePassword,
} from '../lib/users.js';
import { flash, requireAdmin } from '../middleware.js';

export const usuariosRouter = Router();
usuariosRouter.use('/usuarios', requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserForm {
  name: string;
  email: string;
  role: string;
  active: boolean;
  permissions: Permission[];
  password?: string;
}

function readForm(req: Request): UserForm {
  const raw = req.body.permissoes;
  const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(isPermission);
  return {
    name: String(req.body.nome ?? '').trim(),
    email: normalizeEmail(String(req.body.email ?? '')),
    role: String(req.body.perfil ?? ''),
    active: req.body.ativo === 'on' || req.body.ativo === 'true',
    permissions: PERMISSIONS.map((p) => p.key).filter((k) => list.includes(k)),
    password: req.body.senha === undefined ? undefined : String(req.body.senha),
  };
}

async function validateForm(form: UserForm, exceptId?: number): Promise<string | null> {
  if (!form.name) return 'Informe o nome.';
  if (!EMAIL_RE.test(form.email)) return 'Informe um e-mail válido.';
  if (!isRole(form.role)) return 'Escolha um perfil.';
  if (await emailInUse(form.email, exceptId)) return 'Já existe um usuário com este e-mail.';
  if (form.password !== undefined) return validatePassword(form.password);
  return null;
}

/** O Admin sempre vê tudo; para os outros perfis guardamos exatamente o que foi marcado. */
function permissionsToStore(form: UserForm): string[] | null {
  return form.role === 'admin' ? null : form.permissions;
}

function describePermissions(list: readonly string[]): string {
  return list.length ? list.map(permissionLabel).join(', ') : 'nada';
}

const formLocals = { ROLES, ROLE_DESCRIPTIONS, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS };

usuariosRouter.get('/usuarios', async (_req, res) => {
  const users = (await listUsers()).map((u) => ({ ...u, perms: permissionsOf(u), customized: isCustomized(u) }));
  res.render('usuarios/lista', { title: 'Usuários e permissões', users, permissionLabel });
});

usuariosRouter.get('/usuarios/novo', (_req, res) => {
  res.render('usuarios/form', {
    ...formLocals, title: 'Novo usuário', editing: null,
    form: { name: '', email: '', role: 'lead', active: true, permissions: ROLE_DEFAULT_PERMISSIONS.lead }, error: null, history: [],
  });
});

usuariosRouter.post('/usuarios', async (req, res) => {
  const form = readForm(req);
  form.password ??= '';
  const error = await validateForm(form);
  if (error) {
    return res.status(400).render('usuarios/form', { ...formLocals, title: 'Novo usuário', editing: null, form, error, history: [] });
  }
  const user = await createUser({ name: form.name, email: form.email, password: form.password, role: form.role as Role });
  await pool.query('UPDATE users SET permissions = $2 WHERE id = $1', [user.id, permissionsToStore(form)]);
  const perms = permissionsOf({ role: user.role, permissions: permissionsToStore(form) });
  await recordEvent({
    userId: req.user!.id, entityType: 'user', entityId: user.id, action: 'criado',
    description: `Criou o usuário ${user.name} (${ROLE_LABELS[user.role]}) com acesso a: ${describePermissions(perms)}`,
    data: { email: user.email, role: user.role, permissions: perms }, ip: req.ip,
  });
  flash(req, 'sucesso', `Usuário ${user.name} criado. Passe o e-mail e a senha para a pessoa.`);
  res.redirect('/usuarios');
});

async function loadHistory(userId: number) {
  const { rows } = await pool.query(
    `SELECT e.created_at, e.description, e.action, u.name AS author
       FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.entity_type = 'user' AND e.entity_id = $1
      ORDER BY e.created_at DESC LIMIT 50`,
    [String(userId)],
  );
  return rows;
}

usuariosRouter.get('/usuarios/:id', async (req, res) => {
  const user = await findUserById(Number(req.params.id));
  if (!user) return res.status(404).render('erro', { title: 'Não encontrado', message: 'Usuário não encontrado.', backUrl: '/usuarios' });
  res.render('usuarios/form', {
    ...formLocals, title: `Editar ${user.name}`, editing: user,
    form: { name: user.name, email: user.email, role: user.role, active: user.active, permissions: permissionsOf(user) },
    error: null, history: await loadHistory(user.id),
  });
});

usuariosRouter.post('/usuarios/:id', async (req, res) => {
  const user = await findUserById(Number(req.params.id));
  if (!user) return res.status(404).render('erro', { title: 'Não encontrado', message: 'Usuário não encontrado.', backUrl: '/usuarios' });
  const form = readForm(req);
  delete form.password;
  let error = await validateForm(form, user.id);
  const losingAdmin = user.role === 'admin' && user.active && (form.role !== 'admin' || !form.active);
  if (!error && losingAdmin && (await countActiveAdmins()) <= 1) {
    error = 'Este é o único Admin ativo. Crie outro Admin antes de mudar o perfil ou desativar este.';
  }
  if (error) {
    return res.status(400).render('usuarios/form', {
      ...formLocals, title: `Editar ${user.name}`, editing: user, form, error, history: await loadHistory(user.id),
    });
  }
  const stored = permissionsToStore(form);
  await pool.query(
    'UPDATE users SET name = $2, email = $3, role = $4, active = $5, permissions = $6, updated_at = now() WHERE id = $1',
    [user.id, form.name, form.email, form.role, form.active, stored],
  );
  const before = permissionsOf(user);
  const after = permissionsOf({ role: form.role as Role, permissions: stored });
  const changes: string[] = [];
  if (user.name !== form.name) changes.push(`nome: ${user.name} → ${form.name}`);
  if (user.email !== form.email) changes.push(`e-mail: ${user.email} → ${form.email}`);
  if (user.role !== form.role) changes.push(`perfil: ${ROLE_LABELS[user.role]} → ${ROLE_LABELS[form.role as Role]}`);
  if (user.active !== form.active) changes.push(form.active ? 'reativado' : 'desativado');
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  if (added.length) changes.push(`liberou: ${describePermissions(added)}`);
  if (removed.length) changes.push(`bloqueou: ${describePermissions(removed)}`);
  if (changes.length) {
    await recordEvent({
      userId: req.user!.id, entityType: 'user', entityId: user.id, action: 'alterado',
      description: `Alterou o usuário (${changes.join('; ')})`,
      data: {
        antes: { name: user.name, email: user.email, role: user.role, active: user.active, permissions: before },
        depois: { name: form.name, email: form.email, role: form.role, active: form.active, permissions: after },
      },
      ip: req.ip,
    });
  }
  flash(req, 'sucesso', 'Usuário salvo.');
  res.redirect('/usuarios');
});

usuariosRouter.post('/usuarios/:id/senha', async (req, res) => {
  const user = await findUserById(Number(req.params.id));
  if (!user) return res.status(404).render('erro', { title: 'Não encontrado', message: 'Usuário não encontrado.', backUrl: '/usuarios' });
  const senha = String(req.body.senha ?? '');
  const error = validatePassword(senha);
  if (error) {
    flash(req, 'erro', error);
    return res.redirect(`/usuarios/${user.id}`);
  }
  await setPassword(user.id, senha);
  // Derruba as sessões abertas da pessoa para a senha antiga não continuar valendo
  await pool.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [user.id]);
  await recordEvent({ userId: req.user!.id, entityType: 'user', entityId: user.id, action: 'senha_redefinida', description: 'Redefiniu a senha do usuário', ip: req.ip });
  flash(req, 'sucesso', `Senha de ${user.name} redefinida. Passe a nova senha para a pessoa.`);
  res.redirect(`/usuarios/${user.id}`);
});
