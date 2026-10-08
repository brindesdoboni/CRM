import type { Role } from './roles.js';

/** Áreas do sistema que o Admin pode liberar ou bloquear para cada pessoa. */
export const PERMISSIONS = [
  { key: 'inicio', label: 'Início', description: 'Painel com tarefas do dia, contadores e alertas', path: '/inicio' },
  { key: 'leads', label: 'Novo lead', description: 'Cadastrar leads e ver os leads que a própria pessoa criou', path: '/leads' },
  { key: 'funil', label: 'Funil de vendas e prospecção', description: 'Ver e mover todos os leads e pedidos', path: '/funil' },
  { key: 'clientes', label: 'Clientes', description: 'Fichas dos clientes, dados, endereços e anotações', path: '/clientes' },
  { key: 'orcamentos', label: 'Orçamentos', description: 'Criar e enviar orçamentos', path: '/orcamentos' },
  { key: 'pedidos', label: 'Pedidos', description: 'Pedidos, personalização, pagamento e confirmação', path: '/pedidos' },
  { key: 'financeiro', label: 'Financeiro', description: 'Pix solicitados e comprovantes', path: '/financeiro' },
  { key: 'producao', label: 'Produção', description: 'Painel de produção e ordens de produção (OP)', path: '/producao' },
  { key: 'configuracoes', label: 'Cadastros e configurações', description: 'Produtos, origens, formas de pagamento, regras e textos prontos', path: '/configuracoes' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

const ALL = PERMISSIONS.map((p) => p.key) as Permission[];

/** O que cada perfil vê quando o Admin não personalizou. */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  lead: ['leads'],
  financeiro: ['financeiro'],
  producao: ['producao'],
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL as string[]).includes(value);
}

/** Permissões efetivas do usuário. O Admin sempre vê tudo (inclusive Usuários e permissões). */
export function permissionsOf(user: { role: Role; permissions: string[] | null }): Permission[] {
  if (user.role === 'admin') return ALL;
  if (!user.permissions) return ROLE_DEFAULT_PERMISSIONS[user.role];
  return ALL.filter((p) => user.permissions!.includes(p));
}

export function can(user: { role: Role; permissions: string[] | null }, permission: Permission): boolean {
  return permissionsOf(user).includes(permission);
}

/** Primeira tela que a pessoa pode ver (usada depois do login). */
export function homePath(user: { role: Role; permissions: string[] | null }): string {
  const first = PERMISSIONS.find((p) => can(user, p.key));
  return first ? first.path : '/minha-conta';
}

export function isCustomized(user: { role: Role; permissions: string[] | null }): boolean {
  if (user.role === 'admin' || !user.permissions) return false;
  const defaults = ROLE_DEFAULT_PERMISSIONS[user.role];
  const mine = permissionsOf(user);
  return mine.length !== defaults.length || mine.some((p) => !defaults.includes(p));
}

export function permissionLabel(key: string): string {
  return PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}
