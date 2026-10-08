export const ROLES = ['admin', 'lead', 'financeiro', 'producao'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  lead: 'Lead',
  financeiro: 'Financeiro',
  producao: 'Produção',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Acesso a tudo',
  lead: 'Só a tela "Novo lead" e a lista dos leads que criou',
  financeiro: 'Pix solicitados e comprovantes',
  producao: 'Painel de produção',
};

/** Tela inicial de cada perfil depois do login. */
export const ROLE_HOME: Record<Role, string> = {
  admin: '/inicio',
  lead: '/leads',
  financeiro: '/financeiro',
  producao: '/producao',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
