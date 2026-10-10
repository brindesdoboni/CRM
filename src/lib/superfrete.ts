/**
 * Cotação de frete na SuperFrete (Fase 1 = só cotação).
 * Token em SUPERFRETE_TOKEN (variável do Railway). Por padrão usa o Sandbox; para valer de verdade,
 * SUPERFRETE_URL=https://api.superfrete.com
 */

export interface FreightOption { service: string; price: number; days: number | null }

export interface QuoteInput { fromCep: string; toCep: string; weightKg: number; heightCm: number; widthCm: number; lengthCm: number }

export function superfreteConfigured(): boolean {
  return !!process.env.SUPERFRETE_TOKEN;
}

/** Devolve as opções de frete ou uma mensagem de erro em português. */
export async function quoteFreight(input: QuoteInput, fetchFn: typeof fetch = fetch): Promise<{ options: FreightOption[]; error?: string }> {
  const token = process.env.SUPERFRETE_TOKEN;
  if (!token) return { options: [], error: 'A cotação automática ainda não está ligada (falta o token da SuperFrete). Digite o valor do frete.' };
  const base = (process.env.SUPERFRETE_URL || 'https://sandbox.superfrete.com').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/v0/calculator`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CRM Brindes DoBoni (brindesdoboni.com)',
      },
      body: JSON.stringify({
        from: { postal_code: input.fromCep },
        to: { postal_code: input.toCep },
        services: '1,2,17',
        options: { own_hand: false, receipt: false, insurance_value: 0, use_insurance_value: false },
        package: { height: input.heightCm, width: input.widthCm, length: input.lengthCm, weight: input.weightKg },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { options: [], error: 'A SuperFrete não respondeu. Tente de novo ou digite o valor do frete.' };
  }
  if (!res.ok) {
    return { options: [], error: `A SuperFrete recusou a cotação (código ${res.status}). Confira o token e os CEPs, ou digite o valor do frete.` };
  }
  const data = await res.json().catch(() => null) as unknown;
  const list = Array.isArray(data) ? data : [];
  const options: FreightOption[] = [];
  for (const item of list as Record<string, any>[]) {
    if (!item || item.error || item.has_error) continue;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const company = typeof item.company?.name === 'string' ? item.company.name : '';
    const name = String(item.name ?? '').trim();
    const days = Number(item.delivery_range?.max ?? item.delivery_time);
    options.push({
      service: company && !name.toLowerCase().includes(company.toLowerCase()) ? `${company} ${name}` : name || company || 'Frete',
      price: Math.round(price * 100) / 100,
      days: Number.isFinite(days) && days > 0 ? days : null,
    });
  }
  if (!options.length) return { options, error: 'Nenhum serviço disponível para este CEP e pacote. Digite o valor do frete.' };
  return { options: options.sort((a, b) => a.price - b.price) };
}
