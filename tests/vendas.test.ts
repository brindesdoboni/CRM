import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { computePayment, parseMoney } from '../src/lib/sales.js';
import { quoteFreight } from '../src/lib/superfrete.js';

const app = createApp();
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');

async function login(email: string, senha: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, senha });
  const conta = await agent.get('/minha-conta');
  return { agent, csrf: /name="_csrf" value="([^"]+)"/.exec(conta.text)![1] };
}

type Sessao = Awaited<ReturnType<typeof login>>;
let admin: Sessao, laura: Sessao, dani: Sessao, jo: Sessao;
let origem: number;

/** Baixa o PDF como binário e devolve o texto dele (pdftotext, do poppler). */
async function pdfText(s: Sessao, id: number) {
  const res = await s.agent.get(`/pedidos/${id}/pdf`).buffer(true).parse((r, cb) => {
    const parts: Buffer[] = [];
    r.on('data', (c: Buffer) => parts.push(c));
    r.on('end', () => cb(null, Buffer.concat(parts)));
  });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  const body = res.body as Buffer;
  expect(body.subarray(0, 5).toString()).toBe('%PDF-');
  const file = path.join(os.tmpdir(), `resumo-${id}-${Date.now()}.pdf`);
  fs.writeFileSync(file, body);
  try {
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } finally {
    fs.unlinkSync(file);
  }
}

const temPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const baseVenda = (csrf: string, extra: Record<string, string>) => ({
  _csrf: csrf, cliente: 'Empresa Alfa', telefone: '11955554444', origem: String(origem), produto: 'Caneca personalizada',
  cor: 'Branca', quantidade: '30', prazo: '2026-10-20', fonte: 'Arial', nomes: 'Ana\nBruno\nCélia', ...extra,
});

const venda = async (id: number) => (await pool.query('SELECT * FROM sales WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Laura', email: 'laura@exemplo.com', password: 'senha-com-1', role: 'comercial' });
  await createUser({ name: 'Danielson', email: 'dani@exemplo.com', password: 'senha-lead-1', role: 'lead' });
  await createUser({ name: 'Jô', email: 'jo@exemplo.com', password: 'senha-prod-1', role: 'producao' });
  origem = (await pool.query(`SELECT id FROM origins WHERE name = 'WhatsApp'`)).rows[0].id;
  [admin, laura, dani, jo] = await Promise.all([
    login('lucas@exemplo.com', 'senha-admin-1'), login('laura@exemplo.com', 'senha-com-1'),
    login('dani@exemplo.com', 'senha-lead-1'), login('jo@exemplo.com', 'senha-prod-1'),
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('cálculo do pagamento', () => {
  it('total = produtos + frete − desconto; parcela sem juros = (total − entrada) ÷ parcelas', () => {
    const r = computePayment({ unitPrice: 12.5, quantity: 30, shippingPrice: 35.9, discount: 10, downPayment: 0, installments: 3, interestFree: true, installmentValue: null });
    expect(r).toEqual({ products: 375, total: 400.9, installmentValue: 133.63, totalPaid: 400.9, error: null });
    const e = computePayment({ unitPrice: 10, quantity: 10, shippingPrice: 0, discount: 0, downPayment: 40, installments: 2, interestFree: true, installmentValue: null });
    expect(e.installmentValue).toBe(30);
    const j = computePayment({ unitPrice: 10, quantity: 10, shippingPrice: 20, discount: 0, downPayment: 0, installments: 4, interestFree: false, installmentValue: 32.5 });
    expect(j).toMatchObject({ total: 120, installmentValue: 32.5, totalPaid: 130 });
    expect(computePayment({ unitPrice: 10, quantity: 1, shippingPrice: 0, discount: 20, downPayment: 0, installments: 1, interestFree: true, installmentValue: null }).error)
      .toContain('desconto');
  });

  it('lê valores em reais', () => {
    expect(parseMoney('1.234,50')).toBe(1234.5);
    expect(parseMoney('R$ 35,9')).toBe(35.9);
    expect(parseMoney('12.5')).toBe(12.5);
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney('abc')).toBeNaN();
    expect(parseMoney('-5')).toBeNaN();
  });
});

describe('aba Vendas: permissões dos 4 logins', () => {
  it('Admin e Laura entram; Jô (Produção) e Danielson (Captação) não', async () => {
    expect((await admin.agent.get('/pedidos')).status).toBe(200);
    expect((await laura.agent.get('/pedidos')).status).toBe(200);
    expect((await jo.agent.get('/pedidos')).status).toBe(403);
    expect((await dani.agent.get('/pedidos')).status).toBe(403);
    expect((await jo.agent.get('/pedidos/nova')).status).toBe(403);
    expect((await dani.agent.post('/pedidos').type('form').send(baseVenda(dani.csrf, {}))).status).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n).toBe(0);
  });

  it('só o Admin vê o campo de custo real do frete', async () => {
    expect((await admin.agent.get('/pedidos/nova')).text).toContain('name="frete_custo"');
    const tela = (await laura.agent.get('/pedidos/nova')).text;
    expect(tela).not.toContain('frete_custo');
    expect(tela).not.toContain('Margem');
    expect(tela).toContain('name="frete_valor"');
    expect(tela).toContain('name="forma_pagamento"');
  });
});

describe('venda com Pix (Laura)', () => {
  let id: number;

  it('salva frete e pagamento, calcula o total e ignora o custo real mandado pela Laura', async () => {
    const res = await laura.agent.post('/pedidos')
      .field({ ...baseVenda(laura.csrf, {
        frete_servico: 'Correios PAC', frete_valor: '35,90', frete_prazo: '6', frete_cep: '01310-100', frete_custo: '20,00',
        valor_unitario: '12,50', desconto: '10', forma_pagamento: 'pix', parcelas: '1', sem_juros: 'sim', status_pagamento: 'pago',
      }) })
      .attach('arquivo', PNG, 'arte.png');
    expect(res.status).toBe(302);
    id = Number(/\/pedidos\/(\d+)/.exec(res.headers.location)![1]);
    const s = await venda(id);
    expect(s).toMatchObject({
      shipping_service: 'Correios PAC', shipping_price: '35.90', shipping_days: 6, shipping_cep: '01310100', shipping_cost: null,
      unit_price: '12.50', discount: '10.00', payment_method: 'pix', installments: 1, total: '400.90', installment_value: '400.90',
      payment_status: 'pago', customer_approved: false,
    });
  });

  it('não aprovada: não aparece para a Jô nem gera aviso', async () => {
    expect((await jo.agent.get('/producao')).text).not.toContain('Empresa Alfa');
    expect((await jo.agent.get(`/producao/${id}`)).status).toBe(404);
    expect((await jo.agent.post(`/producao/${id}/checklist`).type('form').send({ _csrf: jo.csrf, item: 1, marcar: '1' })).status).toBe(404);
    const { rows } = await pool.query(`SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = 'Jô'`);
    expect(rows).toHaveLength(0);
    expect((await laura.agent.get('/pedidos')).text).toContain('Aguardando aprovação do cliente');
  });

  it('Admin registra o custo real; Laura salva de novo e o custo continua lá (e ela não vê)', async () => {
    const s = await venda(id);
    const campos = {
      ...baseVenda(admin.csrf, {}), frete_servico: 'Correios PAC', frete_valor: '35,90', frete_prazo: '6', frete_cep: '01310100',
      valor_unitario: '12,50', desconto: '10', forma_pagamento: 'pix', parcelas: '1', sem_juros: 'sim', status_pagamento: 'pago', codigo: s.code,
    };
    await admin.agent.post(`/pedidos/${id}`).type('form').send({ ...campos, frete_custo: '21,40' });
    expect((await venda(id)).shipping_cost).toBe('21.40');
    const telaAdmin = (await admin.agent.get(`/pedidos/${id}`)).text;
    expect(telaAdmin).toContain('value="21,40"');
    expect(telaAdmin).toContain('Margem do frete');
    await laura.agent.post(`/pedidos/${id}`).type('form').send({ ...campos, _csrf: laura.csrf, frete_custo: '1,00' });
    expect((await venda(id)).shipping_cost).toBe('21.40');
    const telaLaura = (await laura.agent.get(`/pedidos/${id}`)).text;
    expect(telaLaura).not.toContain('21,40');
    expect(telaLaura).not.toContain('frete_custo');
  });

  it.skipIf(!temPdftotext)('PDF tem o resumo e não tem custo do frete, margem nem lucro', async () => {
    await admin.agent.post('/configuracoes/empresa').type('form').send({
      _csrf: admin.csrf, empresa_nome: 'Brindes DoBoni', empresa_cnpj: '12.345.678/0001-90', empresa_telefone: '(11) 99999-0000',
      empresa_email: '', empresa_site: 'brindesdoboni.com', empresa_endereco: 'São Paulo - SP', frete_cep_origem: '01001-000',
    });
    const text = await pdfText(laura, id);
    const code = (await venda(id)).code;
    for (const t of ['RESUMO DO PEDIDO', code, 'Empresa Alfa', 'Caneca personalizada', 'Branca', 'Célia', 'Fonte: Arial',
      'R$ 12,50', 'R$ 375,00', 'Correios PAC', 'R$ 35,90', '6 dias úteis', 'Pix', 'À vista', 'R$ 400,90', '20/10/2026',
      'CNPJ 12.345.678/0001-90', 'Arte aprovada', 'Confira os dados e responda aprovando para iniciarmos a produção']) {
      expect(text, t).toContain(t);
    }
    expect(text).not.toContain('21,40');
    expect(text.toLowerCase()).not.toMatch(/custo|margem|lucro/);
    // O Admin baixa o mesmo PDF, também sem o custo
    expect(await pdfText(admin, id)).not.toContain('21,40');
  });

  it('Jô e Danielson não baixam o PDF', async () => {
    expect((await jo.agent.get(`/pedidos/${id}/pdf`)).status).toBe(403);
    expect((await dani.agent.get(`/pedidos/${id}/pdf`)).status).toBe(403);
  });

  it('aprovação libera para a Jô, grava data e quem registrou, e a OP não mostra frete nem pagamento', async () => {
    const s = await venda(id);
    await laura.agent.post(`/pedidos/${id}`).type('form').send({
      ...baseVenda(laura.csrf, {}), codigo: s.code, frete_servico: 'Correios PAC', frete_valor: '35,90', frete_prazo: '6', frete_cep: '01310100',
      valor_unitario: '12,50', desconto: '10', forma_pagamento: 'pix', parcelas: '1', status_pagamento: 'pago', aprovado: 'sim',
    });
    const depois = (await pool.query(
      `SELECT s.customer_approved, s.approved_at, u.name FROM sales s JOIN users u ON u.id = s.approved_by WHERE s.id = $1`, [id],
    )).rows[0];
    expect(depois.customer_approved).toBe(true);
    expect(depois.approved_at).toBeInstanceOf(Date);
    expect(depois.name).toBe('Laura');
    const avisos = (await pool.query(`SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = 'Jô'`)).rows;
    expect(avisos.map((a) => a.title)).toEqual([expect.stringContaining('Nova venda para produzir')]);
    expect((await jo.agent.get('/producao')).text).toContain('Empresa Alfa');
    const op = (await jo.agent.get(`/producao/${id}`)).text;
    expect(op).toContain('Caneca personalizada');
    for (const t of ['35,90', '400,90', '21,40', 'Pix', 'Correios', 'frete', 'pagamento']) expect(op, t).not.toContain(t);
    expect((await laura.agent.get(`/pedidos/${id}`)).text).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} por Laura/);
  });

  it('depois que a produção começa, não dá para desfazer a aprovação', async () => {
    await jo.agent.post(`/producao/${id}/checklist`).type('form').send({ _csrf: jo.csrf, item: 1, marcar: '1' });
    const s = await venda(id);
    const res = await laura.agent.post(`/pedidos/${id}`).type('form').send({ ...baseVenda(laura.csrf, {}), codigo: s.code, valor_unitario: '12,50', aprovado: 'nao' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('A produção já começou');
    expect((await venda(id)).customer_approved).toBe(true);
  });
});

describe('venda no cartão parcelado sem juros (Admin)', () => {
  let id: number;

  it('3× sem juros com entrada: parcela = (total − entrada) ÷ 3', async () => {
    const res = await admin.agent.post('/pedidos').type('form').send(baseVenda(admin.csrf, {
      cliente: 'Beta Eventos', telefone: '21988887777', quantidade: '50', valor_unitario: '9,90', frete_valor: '0', frete_servico: 'Retirada',
      frete_custo: '0', desconto: '', entrada: '95', forma_pagamento: 'cartao', parcelas: '3', sem_juros: 'sim', valor_parcela: '999',
      status_pagamento: 'pendente',
    }));
    id = Number(/\/pedidos\/(\d+)/.exec(res.headers.location)![1]);
    const s = await venda(id);
    // 50 × 9,90 = 495,00; − entrada 95 = 400 ÷ 3 = 133,33 (o valor digitado na parcela é ignorado quando é sem juros)
    expect(s).toMatchObject({ total: '495.00', down_payment: '95.00', installments: 3, interest_free: true, installment_value: '133.33', payment_method: 'cartao' });
  });

  it.skipIf(!temPdftotext)('PDF mostra cartão, 3× sem juros, entrada e total', async () => {
    const text = await pdfText(laura, id);
    for (const t of ['Cartão de crédito', '3× de R$ 133,33 sem juros', 'Entrada', 'R$ 95,00', 'R$ 495,00', 'Beta Eventos']) expect(text, t).toContain(t);
    expect(text).not.toMatch(/com juros/);
  });

  it('cartão com juros exige o valor da parcela e mostra o total pago', async () => {
    const res = await admin.agent.post(`/pedidos/${id}`).type('form').send(baseVenda(admin.csrf, {
      cliente: 'Beta Eventos', quantidade: '50', valor_unitario: '9,90', codigo: (await venda(id)).code, forma_pagamento: 'cartao', parcelas: '3', sem_juros: 'nao',
    }));
    expect(res.status).toBe(400);
    expect(res.text).toContain('informe o valor de cada parcela');
    await admin.agent.post(`/pedidos/${id}`).type('form').send(baseVenda(admin.csrf, {
      cliente: 'Beta Eventos', quantidade: '50', valor_unitario: '9,90', codigo: (await venda(id)).code, forma_pagamento: 'cartao', parcelas: '3',
      sem_juros: 'nao', valor_parcela: '172,00',
    }));
    expect(await venda(id)).toMatchObject({ total: '495.00', installment_value: '172.00', interest_free: false });
  });

  it('valores inválidos são recusados', async () => {
    const res = await laura.agent.post('/pedidos').type('form').send(baseVenda(laura.csrf, { valor_unitario: 'doze', forma_pagamento: 'pix' }));
    expect(res.status).toBe(400);
    expect(res.text).toContain('Confira os valores em R$');
    const res2 = await laura.agent.post('/pedidos').type('form').send(baseVenda(laura.csrf, { valor_unitario: '1', desconto: '500', forma_pagamento: 'pix' }));
    expect(res2.text).toContain('O desconto não pode ser maior');
  });
});

describe('cotação SuperFrete', () => {
  it('sem token: avisa para digitar o frete', async () => {
    delete process.env.SUPERFRETE_TOKEN;
    const res = await laura.agent.post('/pedidos/frete/cotar').set('X-CSRF-Token', laura.csrf)
      .send({ cep: '01310-100', peso: '0,5', altura: '10', largura: '15', comprimento: '20' });
    expect(res.status).toBe(502);
    expect(res.body.erro).toContain('token da SuperFrete');
    expect((await jo.agent.post('/pedidos/frete/cotar').set('X-CSRF-Token', jo.csrf).send({})).status).toBe(403);
  });

  it('lê a resposta da SuperFrete e ordena pelo menor preço', async () => {
    process.env.SUPERFRETE_TOKEN = 'teste';
    let enviado: any;
    const fake = (async (url: string, init: RequestInit) => {
      enviado = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify([
        { id: 2, name: 'SEDEX', price: 42.1, delivery_time: 2, company: { name: 'Correios' } },
        { id: 1, name: 'PAC', price: '25.30', delivery_time: 7, delivery_range: { min: 5, max: 7 }, company: { name: 'Correios' } },
        { id: 17, name: 'Mini Envios', error: 'Peso excedido', company: { name: 'Correios' } },
      ]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await quoteFreight({ fromCep: '01001000', toCep: '01310100', weightKg: 0.5, heightCm: 10, widthCm: 15, lengthCm: 20 }, fake);
    delete process.env.SUPERFRETE_TOKEN;
    expect(r.options).toEqual([{ service: 'Correios PAC', price: 25.3, days: 7 }, { service: 'Correios SEDEX', price: 42.1, days: 2 }]);
    expect(enviado.url).toBe('https://sandbox.superfrete.com/api/v0/calculator');
    expect(enviado.headers.Authorization).toBe('Bearer teste');
    expect(enviado.body).toMatchObject({ from: { postal_code: '01001000' }, to: { postal_code: '01310100' }, package: { weight: 0.5 } });
  });
});
