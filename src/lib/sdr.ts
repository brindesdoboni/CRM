import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { formatPhone } from './leads.js';

export interface QuestionOption { texto: string; pontos: number; varejo?: boolean }
export interface Question { id: number; key: string; question: string; options: QuestionOption[]; position: number; active: boolean }
export interface Answer { pergunta: string; resposta: string; pontos: number; varejo?: boolean }
export type Classification = 'quente' | 'morno' | 'frio' | 'varejo';

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  quente: 'Quente', morno: 'Morno', frio: 'Frio', varejo: 'Varejo (site/Shopee)',
};

export async function listQuestions(onlyActive = true, db: Queryable = pool): Promise<Question[]> {
  const { rows } = await db.query<Question>(
    `SELECT id, key, question, options, position, active FROM sdr_questions ${onlyActive ? 'WHERE active' : ''} ORDER BY position, id`,
  );
  return rows;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Acha a opção que corresponde à resposta: igual, ou uma contendo a outra (ex.: "empresa" ↔ "Empresa"). */
export function matchOption(options: QuestionOption[], answer: string): QuestionOption | null {
  const a = norm(answer);
  if (!a) return null;
  return options.find((o) => norm(o.texto) === a)
    ?? options.find((o) => a.includes(norm(o.texto)) || norm(o.texto).includes(a))
    ?? null;
}

/** Converte "Texto = pontos" (uma por linha; "varejo" no fim marca resposta de varejo) em opções. */
export function parseOptionsText(text: string): QuestionOption[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)\s*=\s*(-?\d+)\s*(varejo)?\s*$/i.exec(line);
    if (!m) return { texto: line, pontos: 0 };
    return m[3] ? { texto: m[1], pontos: Number(m[2]), varejo: true } : { texto: m[1], pontos: Number(m[2]) };
  });
}

export function optionsToText(options: QuestionOption[]): string {
  return options.map((o) => `${o.texto} = ${o.pontos}${o.varejo ? ' varejo' : ''}`).join('\n');
}

/** Lê as respostas que vieram (chave = campo da pergunta) e junta com as que o lead já tinha. */
export function collectAnswers(
  questions: Question[], fields: Record<string, string>, previous: Record<string, Answer> = {},
): Record<string, Answer> {
  const answers: Record<string, Answer> = { ...previous };
  for (const q of questions) {
    const raw = fields[q.key];
    if (!raw) continue;
    const opt = q.options.length ? matchOption(q.options, raw) : null;
    answers[q.key] = { pergunta: q.question, resposta: raw, pontos: opt?.pontos ?? 0, ...(opt?.varejo ? { varejo: true } : {}) };
  }
  return answers;
}

export function scoreOf(answers: Record<string, Answer>): number {
  return Object.values(answers).reduce((sum, a) => sum + (Number(a.pontos) || 0), 0);
}

/** Varejo (quantidade abaixo do limite) vai para o site/Shopee; o resto pela nota. */
export function classify(
  answers: Record<string, Answer>, score: number, quantity: number | null,
  limits: { quente: number; morno: number; atacado: number },
): Classification | null {
  if (!Object.keys(answers).length && quantity === null) return null;
  if (Object.values(answers).some((a) => a.varejo) || (quantity !== null && quantity < limits.atacado)) return 'varejo';
  if (score >= limits.quente) return 'quente';
  if (score >= limits.morno) return 'morno';
  return 'frio';
}

/** Resumo do lead para a Laura (vai no texto do wa.me). */
export function leadSummary(lead: { name: string | null; phone: string; product?: string | null; quantity?: number | null }, answers: Record<string, Answer>, score: number | null): string {
  const lines = [
    `Olá! Sou ${lead.name || 'cliente'} (${formatPhone(lead.phone)}) e vim pelo atendimento da Brindes DoBoni.`,
    ...Object.values(answers).map((a) => `• ${a.pergunta} ${a.resposta}`),
  ];
  if (lead.product && !answers.produto) lines.push(`• Produto: ${lead.product}`);
  if (lead.quantity && !answers.quantidade_faixa) lines.push(`• Quantidade: ${lead.quantity}`);
  if (score !== null) lines.push(`(pontuação ${score})`);
  return lines.join('\n');
}
