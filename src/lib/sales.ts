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

export const PAYMENT_METHODS: Record<string, string> = {
  pix: 'Pix',
  cartao: 'Cartão de crédito',
  boleto: 'Boleto',
  outra: 'Outra',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = { pendente: 'Pendente', pago: 'Pago' };

/** Valor em reais digitado com vírgula ou ponto ("1.234,50", "35", "0"). undefined se vazio, NaN se inválido. */
export function parseMoney(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim().replace(/^R\$\s*/i, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(raw)) return NaN;
  const n = Number(/,/.test(raw) || /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

const cents = (n: number) => Math.round(n * 100);

export interface PaymentInput {
  unitPrice: number | null; quantity: number; shippingPrice: number | null; discount: number; downPayment: number;
  installments: number; interestFree: boolean; installmentValue: number | null;
}

export interface PaymentResult {
  products: number | null;   // valor unitário × quantidade
  total: number | null;      // produtos + frete − desconto
  installmentValue: number | null;
  totalPaid: number | null;  // entrada + parcelas (difere do total só no cartão com juros)
  error: string | null;
}

/**
 * Total = produtos + frete − desconto. Sem juros (ou à vista), a parcela é (total − entrada) ÷ parcelas.
 * Com juros, o valor da parcela é o que a maquininha cobra (digitado), e o "total pago" mostra o valor com juros.
 */
export function computePayment(p: PaymentInput): PaymentResult {
  const none = { products: null, total: null, installmentValue: null, totalPaid: null };
  if (p.unitPrice === null) return { ...none, error: null };
  const products = cents(p.unitPrice) * p.quantity;
  const total = products + cents(p.shippingPrice ?? 0) - cents(p.discount);
  if (total < 0) return { ...none, error: 'O desconto não pode ser maior que produtos + frete.' };
  const down = cents(p.downPayment);
  if (down > total) return { ...none, error: 'A entrada não pode ser maior que o valor total.' };
  const rest = total - down;
  let installment: number;
  if (p.interestFree || p.installments === 1) {
    installment = Math.round(rest / p.installments);
  } else {
    if (p.installmentValue === null || p.installmentValue <= 0) {
      return { ...none, error: 'Parcelado com juros: informe o valor de cada parcela.' };
    }
    installment = cents(p.installmentValue);
  }
  const totalPaid = p.interestFree || p.installments === 1 ? total : down + installment * p.installments;
  return { products: products / 100, total: total / 100, installmentValue: installment / 100, totalPaid: totalPaid / 100, error: null };
}

/** "3× de R$ 33,33 sem juros", "À vista". */
export function installmentsText(installments: number, value: number | null, interestFree: boolean, money: (n: number) => string): string {
  if (installments <= 1) return 'À vista';
  return `${installments}× de ${value === null ? '—' : money(value)} ${interestFree ? 'sem juros' : 'com juros'}`;
}

/** CEP só com dígitos (8). null se vazio, '' se inválido. */
export function parseCep(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 8 ? digits : '';
}

export function formatCep(cep: string | null | undefined): string {
  return cep && cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : (cep ?? '');
}
