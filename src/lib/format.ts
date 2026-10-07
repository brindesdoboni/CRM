const TZ = 'America/Sao_Paulo';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** dd/mm/aaaa */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  return dateFmt.format(new Date(value));
}

/** dd/mm/aaaa hh:mm */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '';
  return dateTimeFmt.format(new Date(value)).replace(',', '');
}

/** R$ 1.234,56 */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return moneyFmt.format(Number(value)).replace(/ /g, ' ');
}

/** Telefone só com dígitos, com DDD, sem o 55 do Brasil. */
export function normalizePhone(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
  return digits;
}
