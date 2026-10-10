import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { addBusinessDays } from '../src/lib/dates.js';
import { detectMime } from '../src/lib/files.js';
import { lightburnCsv, parsePositive } from '../src/lib/sales.js';

const app = createApp();
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');

async function login(email: string, senha: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, senha });
  // O login cria uma sessão nova, com token novo
  const conta = await agent.get('/minha-conta');
  return { agent, csrf: /name="_csrf" value="([^"]+)"/.exec(conta.text)![1] };
}

let origemShopee: number;
let origemInstagram: number;
type Sessao = Awaited<ReturnType<typeof login>>;
let admin: Sessao, laura: Sessao, dani: Sessao, jo: Sessao;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Laura', email: 'laura@exemplo.com', password: 'senha-com-1', role: 'comercial' });
  await createUser({ name: 'Danielson', email: 'dani@exemplo.com', password: 'senha-lead-1', role: 'lead' });
  await createUser({ name: 'Jô', email: 'jo@exemplo.com', password: 'senha-prod-1', role: 'producao' });
  const { rows } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM origins');
  origemShopee = rows.find((r) => r.name === 'Shopee – Lucmarix')!.id;
  origemInstagram = rows.find((r) => r.name === 'Instagram')!.id;
  [admin, laura, dani, jo] = await Promise.all([
    login('lucas@exemplo.com', 'senha-admin-1'), login('laura@exemplo.com', 'senha-com-1'),
    login('dani@exemplo.com', 'senha-lead-1'), login('jo@exemplo.com', 'senha-prod-1'),
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('perfis', () => {
  it('Laura (Comercial) cai no Início e vê todos os leads; Danielson só "Novo lead"; Jô só Produção', async () => {
    expect((await laura.agent.get('/inicio')).status).toBe(200);
    const menuDani = (await dani.agent.get('/leads')).text;
    expect(menuDani).toContain('Leads que você cadastrou');
    expect(menuDani).not.toContain('href="/producao"');
    expect((await dani.agent.get('/inicio')).status).toBe(403);
    expect((await dani.agent.get('/pedidos')).status).toBe(403);
    expect((await jo.agent.get('/leads')).status).toBe(403);
    expect((await jo.agent.get('/producao')).status).toBe(200);
    expect((await laura.agent.get('/producao')).status).toBe(403);
  });
});

describe('novo lead (Danielson)', () => {
  it('exige telefone com DDD e origem', async () => {
    const res = await dani.agent.post('/leads').type('form').send({ _csrf: dani.csrf, telefone: '1234', origem: origemShopee });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Informe o telefone com DDD');
    const res2 = await dani.agent.post('/leads').type('form').send({ _csrf: dani.csrf, telefone: '11987654321' });
    expect(res2.text).toContain('Escolha a loja de origem');
  });

  it('salva com print, avisa Lucas e Laura (não o próprio Danielson)', async () => {
    const res = await dani.agent.post('/leads')
      .field('_csrf', dani.csrf).field('telefone', '+55 (11) 98765-4321').field('nome', 'Maria')
      .field('origem', String(origemShopee)).field('produto', 'Caneca').field('quantidade', '30')
      .attach('arquivo', PNG, 'print.png');
    expect(res.status).toBe(302);
    const { rows } = await pool.query('SELECT l.*, c.phone FROM leads l JOIN customers c ON c.id = l.customer_id');
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('11987654321');
    expect(rows[0].print_file_id).toBeTruthy();
    const { rows: avisos } = await pool.query(`SELECT u.name FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY u.name`);
    expect(avisos.map((a) => a.name)).toEqual(['Laura', 'Lucas']);
    expect((await laura.agent.get('/inicio')).text).toMatch(/class="contador">1</);
    // O print abre para quem criou e para o comercial; a produção não vê
    expect((await dani.agent.get(`/arquivos/${rows[0].print_file_id}`)).headers['content-type']).toBe('image/png');
    expect((await laura.agent.get(`/arquivos/${rows[0].print_file_id}`)).status).toBe(200);
    expect((await jo.agent.get(`/arquivos/${rows[0].print_file_id}`)).status).toBe(404);
  });

  it('recusa arquivo que não é imagem', async () => {
    const res = await dani.agent.post('/leads')
      .field('_csrf', dani.csrf).field('telefone', '11911112222').field('origem', String(origemShopee))
      .attach('arquivo', Buffer.from('<script>alert(1)</script>'), 'print.png');
    expect(res.status).toBe(400);
    expect(res.text).toContain('O print precisa ser uma imagem');
  });

  it('multipart sem token CSRF é recusado', async () => {
    const res = await dani.agent.post('/leads').field('telefone', '11911112222').field('origem', String(origemShopee));
    expect(res.status).toBe(403);
  });

  it('telefone repetido avisa e liga ao cliente existente', async () => {
    const check = await dani.agent.get('/leads/telefone?tel=(11)98765-4321');
    expect(check.body).toEqual({ valido: true, existe: true, nome: 'Maria' });
    await dani.agent.post('/leads').type('form').send({ _csrf: dani.csrf, telefone: '11 98765 4321', origem: origemShopee, produto: 'Squeeze' });
    const page = await dani.agent.get('/leads');
    expect(page.text).toContain('o telefone já estava cadastrado');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM customers');
    expect(rows[0].n).toBe(1);
  });

  it('Danielson não vê lead criado por outra pessoa; Laura vê e muda etapa (Perdido exige motivo)', async () => {
    await laura.agent.post('/leads').type('form').send({ _csrf: laura.csrf, telefone: '21999990000', nome: 'João', origem: origemInstagram });
    const { rows } = await pool.query(`SELECT l.id FROM leads l JOIN customers c ON c.id = l.customer_id WHERE c.phone = '21999990000'`);
    const id = rows[0].id;
    expect((await dani.agent.get(`/leads/${id}`)).status).toBe(404);
    expect((await dani.agent.get('/leads')).text).not.toContain('João');
    expect((await laura.agent.get('/leads')).text).toContain('João');
    await laura.agent.post(`/leads/${id}/etapa`).type('form').send({ _csrf: laura.csrf, etapa: 'perdido' });
    expect((await pool.query('SELECT stage FROM leads WHERE id = $1', [id])).rows[0].stage).toBe('novo_lead');
    await laura.agent.post(`/leads/${id}/etapa`).type('form').send({ _csrf: laura.csrf, etapa: 'perdido', motivo: 'Achou caro' });
    expect((await pool.query('SELECT stage, lost_reason FROM leads WHERE id = $1', [id])).rows[0]).toEqual({ stage: 'perdido', lost_reason: 'Achou caro' });
    expect((await dani.agent.post(`/leads/${id}/etapa`).type('form').send({ _csrf: dani.csrf, etapa: 'atendimento' })).status).toBe(403);
  });
});

describe('venda → produção (Jô)', () => {
  let saleId: number;

  it('Laura cadastra a venda com arte e nomes; Jô é avisada', async () => {
    const res = await laura.agent.post('/pedidos')
      .field('_csrf', laura.csrf).field('cliente', 'Maria').field('telefone', '11987654321').field('origem', String(origemShopee))
      .field('produto', 'Caneca').field('codigo_produto', 'CAN-01').field('cor', 'Preta').field('quantidade', '3')
      .field('fonte', 'Great Vibes').field('nomes', 'Ana\nJosé, o "Zé"\n\nÇíntia').field('prazo', '2026-10-16').field('aprovado', 'sim')
      .attach('arquivo', PNG, 'arte.png');
    expect(res.status).toBe(302);
    const { rows } = await pool.query('SELECT id, code, status FROM sales');
    saleId = rows[0].id;
    expect(rows[0].code).toBe(`V-${String(saleId).padStart(4, '0')}`);
    const { rows: avisos } = await pool.query(`SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = 'Jô'`);
    expect(avisos[0].title).toContain('Nova venda para produzir');
    const op = await jo.agent.get(`/producao/${saleId}`);
    expect(op.text).toContain('Preta');
    expect(op.text).toContain('CAN-01');
    expect(op.text).toContain('Çíntia');
  });

  it('CSV do LightBurn com nome e fonte, acentos e aspas', async () => {
    const res = await jo.agent.get(`/producao/${saleId}/lightburn.csv`);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toBe('nome,fonte\r\nAna,Great Vibes\r\n"José, o ""Zé""",Great Vibes\r\nÇíntia,Great Vibes\r\n');
  });

  it('só conclui com itens 1 a 8 e peso + medidas', async () => {
    const concluir = () => jo.agent.post(`/producao/${saleId}/concluir`).type('form').send({ _csrf: jo.csrf });
    await concluir();
    expect((await pool.query('SELECT status FROM sales WHERE id = $1', [saleId])).rows[0].status).toBe('aguardando');
    for (let item = 1; item <= 7; item++) {
      await jo.agent.post(`/producao/${saleId}/checklist`).type('form').send({ _csrf: jo.csrf, item, marcar: '1' });
    }
    expect((await pool.query('SELECT status FROM sales WHERE id = $1', [saleId])).rows[0].status).toBe('em_producao');
    // item 8 exige peso e medidas
    await jo.agent.post(`/producao/${saleId}/checklist`).type('form').send({ _csrf: jo.csrf, item: 8, marcar: '1' });
    expect((await pool.query('SELECT count(*)::int AS n FROM sale_checklist WHERE sale_id = $1', [saleId])).rows[0].n).toBe(7);
    await jo.agent.post(`/producao/${saleId}/medidas`).type('form').send({ _csrf: jo.csrf, peso: '0,450', altura: '10', largura: '15', comprimento: '20,5' });
    await jo.agent.post(`/producao/${saleId}/checklist`).type('form').send({ _csrf: jo.csrf, item: 8, marcar: '1' });
    await concluir();
    const { rows } = await pool.query('SELECT status, weight_kg, length_cm FROM sales WHERE id = $1', [saleId]);
    expect(rows[0]).toEqual({ status: 'concluida', weight_kg: '0.450', length_cm: '20.5' });
    const { rows: quem } = await pool.query(`SELECT u.name FROM sale_checklist k JOIN users u ON u.id = k.done_by WHERE k.sale_id = $1 AND k.item = 9`, [saleId]);
    expect(quem[0].name).toBe('Jô');
    // concluída não pode mais ser alterada
    await laura.agent.post(`/pedidos/${saleId}`).type('form').send({ _csrf: laura.csrf, cliente: 'Outra', origem: origemShopee, produto: 'X', quantidade: '1', prazo: '2026-10-20' });
    expect((await pool.query('SELECT customer_name FROM sales WHERE id = $1', [saleId])).rows[0].customer_name).toBe('Maria');
  });

  it('"Tenho um problema" pausa e avisa o comercial', async () => {
    await laura.agent.post('/pedidos').type('form').send({ _csrf: laura.csrf, cliente: 'Pedro', origem: origemInstagram, produto: 'Chaveiro', quantidade: '50', prazo: '2026-10-01', aprovado: 'sim' });
    const { rows } = await pool.query(`SELECT id FROM sales WHERE customer_name = 'Pedro'`);
    const lista = await jo.agent.get('/producao');
    expect(lista.text).toContain('ATRASADA');
    await jo.agent.post(`/producao/${rows[0].id}/problema`).type('form').send({ _csrf: jo.csrf, motivo: 'Falta material' });
    expect((await pool.query('SELECT status, pause_reason FROM sales WHERE id = $1', [rows[0].id])).rows[0]).toEqual({ status: 'pausada', pause_reason: 'Falta material' });
    const avisos = await laura.agent.get('/avisos');
    expect(avisos.text).toContain('Problema na produção');
  });

  it('Jô não acessa a tela de vendas e o aviso abre a OP', async () => {
    expect((await jo.agent.get('/pedidos')).status).toBe(403);
    const { rows } = await pool.query(`SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = 'Jô' LIMIT 1`);
    const res = await jo.agent.get(`/avisos/${rows[0].id}`);
    expect(res.headers.location).toMatch(/^\/producao\/\d+$/);
  });
});

describe('configurações e utilitários', () => {
  it('Admin cria e desativa origem; Laura não acessa', async () => {
    expect((await laura.agent.get('/configuracoes')).status).toBe(403);
    await admin.agent.post('/configuracoes/origens').type('form').send({ _csrf: admin.csrf, nome: 'Feira' });
    const { rows } = await pool.query(`SELECT id FROM origins WHERE name = 'Feira'`);
    await admin.agent.post(`/configuracoes/origens/${rows[0].id}`).type('form').send({ _csrf: admin.csrf, nome: 'Feira' });
    expect((await pool.query('SELECT active FROM origins WHERE id = $1', [rows[0].id])).rows[0].active).toBe(false);
    expect((await dani.agent.get('/leads')).text).not.toContain('>Feira<');
  });

  it('dias úteis, números e tipo de arquivo', () => {
    expect(addBusinessDays('2026-10-09', 5)).toBe('2026-10-16'); // sexta + 5 úteis
    expect(addBusinessDays('2026-10-10', 1)).toBe('2026-10-12'); // sábado → segunda
    expect(parsePositive('1.234,5')).toBe(1234.5);
    expect(parsePositive('0.35')).toBe(0.35);
    expect(parsePositive('-1')).toBeNull();
    expect(detectMime(PNG)).toBe('image/png');
    expect(detectMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMime(Buffer.from('<svg>'))).toBeNull();
    expect(lightburnCsv([], null)).toBe('nome,fonte\r\n');
  });
});
