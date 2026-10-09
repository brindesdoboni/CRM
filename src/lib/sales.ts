/** Checklist da produção (CLAUDE.md). O item 9 é o próprio "Concluir". */
export const CHECKLIST = [
  'Conferir OP',
  'Separar materiais',
  'Conferir arte',
  'Gravar',
  'Conferir quantidade, nomes, arte e cores',
  'Organizar',
  'Embalar',
  'Informar peso e medidas',
  'Concluir',
] as const;

export const SALE_STATUS_LABELS: Record<string, string> = {
  aguardando: 'Aguardando produção',
  em_producao: 'Em produção',
  pausada: 'Pausada (problema)',
  concluida: 'Produção concluída',
};

/** Prazo padrão: 5 dias úteis. */
export const DEFAULT_PRODUCTION_DAYS = 5;

export function parseNames(text: string | null | undefined): string[] {
  return (text ?? '').split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV para o LightBurn: colunas nome, fonte; UTF-8 com acentos. */
export function lightburnCsv(names: string[], font: string | null): string {
  const lines = ['nome,fonte', ...names.map((n) => `${csvCell(n)},${csvCell(font ?? '')}`)];
  return `${lines.join('\r\n')}\r\n`;
}

/** Número decimal digitado com vírgula ou ponto; null se vazio/inválido/<=0. */
export function parsePositive(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  // "1.234,5" → 1234.5 ; "0.35" → 0.35
  const n = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
