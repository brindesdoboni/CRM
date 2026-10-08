export const ROLES = ['admin', 'lead', 'financeiro', 'producao'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  lead: 'Lead',
  financeiro: 'Financeiro',
  producao: 'Produção',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Vê tudo e controla usuários e permissões',
  lead: 'Padrão: só "Novo lead" e os leads que criou',
  financeiro: 'Padrão: Pix solicitados e comprovantes',
  producao: 'Padrão: painel de produção',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
