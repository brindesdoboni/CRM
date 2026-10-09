import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { readLeadPayload } from '../src/lib/integrations.js';

const app = createApp();
let token = '';
let adminCsrf = '';
let admin: ReturnType<typeof request.agent>;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Laura', email: 'laura@exemplo.com', password: 'senha-com-1', role: 'comercial' });
  admin = request.agent(app);
  const page = await admin.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  await admin.post('/login').type('form').send({ _csrf: csrf, email: 'lucas@exemplo.com', senha: 'senha-admin-1' });
  adminCsrf = /name="_csrf" value="([^"]+)"/.exec((await admin.get('/configuracoes')).text)![1];
});

afterAll(async () => {
  await pool.end();
});

describe('integrações', () => {
  it('Admin cria a integração do site e vê a chave uma vez', async () => {
    const { rows } = await pool.query(`SELECT id FROM origins WHERE name = 'Site Brindes DoBoni'`);
    const res = await admin.post('/configuracoes/integracoes').type('form')
      .send({ _csrf: adminCsrf, nome: 'Formulário do site', canal: 'site', origem: rows[0].id });
    expect(res.status).toBe(200);
    token = /X-CRM-Token: (crm_[\w-]+)/.exec(res.text)![1];
    const { rows: db } = await pool.query('SELECT token_hash FROM integrations');
    expect(db[0].token_hash).not.toContain(token); // só o hash fica no banco
    expect((await admin.get('/configuracoes')).text).not.toContain(token);
  });

  it('recusa sem chave ou com chave errada', async () => {
    expect((await request(app).post('/api/leads').send({ telefone: '11987654321' })).status).toBe(401);
    expect((await request(app).post('/api/leads').set('X-CRM-Token', 'crm_errada').send({ telefone: '11987654321' })).status).toBe(401);
  });

  it('exige telefone com DDD', async () => {
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`).send({ nome: 'Sem fone' });
    expect(res.status).toBe(400);
    expect(res.body.erro).toContain('Telefone');
  });

  it('cria o lead (JSON), com origem do site, e avisa o comercial', async () => {
    const res = await request(app).post('/api/leads').set('X-CRM-Token', token)
      .send({ Nome: 'Carla', WhatsApp: '(31) 99876-5432', Email: 'carla@x.com', Produto: 'Caneca', Quantidade: '50 unidades', Mensagem: 'Quero orçamento', Empresa: 'ACME' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT l.*, o.name AS origin, c.email, c.name FROM leads l JOIN origins o ON o.id = l.origin_id JOIN customers c ON c.id = l.customer_id WHERE l.id = $1`,
      [res.body.lead_id],
    );
    expect(rows[0]).toMatchObject({ origin: 'Site Brindes DoBoni', channel: 'site', quantity: 50, product: 'Caneca', email: 'carla@x.com', name: 'Carla' });
    expect(rows[0].notes).toContain('empresa: ACME');
    const { rows: avisos } = await pool.query(`SELECT u.name FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY u.name`);
    expect(avisos.map((a) => a.name)).toEqual(['Laura', 'Lucas']);
    const lista = await admin.get('/leads');
    expect(lista.text).toContain('por Formulário do site');
  });

  it('mesmo telefone de novo não duplica: junta no lead em aberto', async () => {
    const res = await request(app).post(`/api/leads?token=${token}`).type('form')
      .send({ 'form_fields[name]': 'Carla', 'form_fields[telefone]': '31998765432', 'form_fields[message]': 'Ainda tenho interesse' });
    expect(res.status).toBe(200);
    expect(res.body.duplicado).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n, max(notes) AS notes FROM leads');
    expect(rows[0].n).toBe(1);
    expect(rows[0].notes).toContain('Ainda tenho interesse');
  });

  it('se o lead anterior foi perdido, cria um novo', async () => {
    await pool.query(`UPDATE leads SET stage = 'perdido'`);
    const res = await request(app).post('/api/leads').set('X-CRM-Token', token).send({ telefone: '31998765432' });
    expect(res.status).toBe(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n).toBe(1);
  });

  it('integração desativada para de aceitar', async () => {
    const { rows } = await pool.query('SELECT id FROM integrations');
    await admin.post(`/configuracoes/integracoes/${rows[0].id}/ativa`).type('form').send({ _csrf: adminCsrf });
    expect((await request(app).get('/api/leads').set('X-CRM-Token', token)).status).toBe(401);
  });

  it('lê o formato aninhado do Elementor', () => {
    const p = readLeadPayload({ fields: { nome: { id: 'nome', value: 'Ana' }, telefone: { value: '11 91234-5678' } }, form: { name: 'Contato' } });
    expect(p.name).toBe('Ana');
    expect(p.phone).toBe('11 91234-5678');
  });
});
