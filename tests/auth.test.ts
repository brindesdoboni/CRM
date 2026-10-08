import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { formatDate, formatMoney, normalizePhone } from '../src/lib/format.js';

const app = createApp();

async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
}

/** Abre uma sessão, pega o token CSRF e faz login. */
async function login(email: string, senha: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email, senha });
  const home = await agent.get(res.headers.location ?? '/');
  const csrf2 = /name="_csrf" value="([^"]+)"/.exec(home.text)?.[1] ?? '';
  return { agent, res, csrf: csrf2 };
}

beforeAll(async () => {
  await resetDb();
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Danielson', email: 'dani@exemplo.com', password: 'senha-lead-1', role: 'lead' });
  await createUser({ name: 'Jô', email: 'jo@exemplo.com', password: 'senha-prod-1', role: 'producao' });
});

afterAll(async () => {
  await pool.end();
});

describe('login', () => {
  it('manda para o login quem não entrou', async () => {
    const res = await request(app).get('/inicio');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?voltar=%2Finicio');
  });

  it('recusa senha errada', async () => {
    const { res } = await login('lucas@exemplo.com', 'errada123');
    expect(res.status).toBe(401);
    expect(res.text).toContain('E-mail ou senha incorretos');
  });

  it('recusa formulário sem token CSRF', async () => {
    const res = await request(app).post('/login').type('form').send({ email: 'lucas@exemplo.com', senha: 'senha-admin-1' });
    expect(res.status).toBe(403);
  });

  it('cada perfil cai na sua tela inicial', async () => {
    expect((await login('LUCAS@exemplo.com', 'senha-admin-1')).res.headers.location).toBe('/inicio');
    expect((await login('dani@exemplo.com', 'senha-lead-1')).res.headers.location).toBe('/leads');
    expect((await login('jo@exemplo.com', 'senha-prod-1')).res.headers.location).toBe('/producao');
  });

  it('registra o login no histórico', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE action = 'login'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('perfis', () => {
  it('Lead não acessa usuários nem produção', async () => {
    const { agent } = await login('dani@exemplo.com', 'senha-lead-1');
    expect((await agent.get('/usuarios')).status).toBe(403);
    expect((await agent.get('/producao')).status).toBe(403);
    expect((await agent.get('/leads')).status).toBe(200);
  });

  it('Admin acessa tudo', async () => {
    const { agent } = await login('lucas@exemplo.com', 'senha-admin-1');
    for (const url of ['/inicio', '/usuarios', '/leads', '/financeiro', '/producao']) {
      expect((await agent.get(url)).status, url).toBe(200);
    }
  });
});

describe('usuários', () => {
  it('Admin cria usuário, e o novo usuário consegue entrar', async () => {
    const { agent, csrf } = await login('lucas@exemplo.com', 'senha-admin-1');
    const res = await agent.post('/usuarios').type('form').send({
      _csrf: csrf, nome: 'Financeiro', email: 'fin@exemplo.com', senha: 'senha-fin-1', perfil: 'financeiro', ativo: 'on',
    });
    expect(res.status).toBe(302);
    expect((await login('fin@exemplo.com', 'senha-fin-1')).res.headers.location).toBe('/financeiro');
  });

  it('não deixa e-mail repetido', async () => {
    const { agent, csrf } = await login('lucas@exemplo.com', 'senha-admin-1');
    const res = await agent.post('/usuarios').type('form').send({
      _csrf: csrf, nome: 'Outro', email: 'Dani@Exemplo.com', senha: 'qualquer123', perfil: 'lead',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Já existe um usuário com este e-mail');
  });

  it('usuário desativado não entra e perde a sessão', async () => {
    const jo = await login('jo@exemplo.com', 'senha-prod-1');
    const { agent, csrf } = await login('lucas@exemplo.com', 'senha-admin-1');
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = 'jo@exemplo.com'`);
    await agent.post(`/usuarios/${rows[0].id}`).type('form').send({ _csrf: csrf, nome: 'Jô', email: 'jo@exemplo.com', perfil: 'producao' });
    expect((await jo.agent.get('/producao')).status).toBe(302);
    expect((await login('jo@exemplo.com', 'senha-prod-1')).res.status).toBe(401);
  });

  it('não deixa desativar o único Admin', async () => {
    const { agent, csrf } = await login('lucas@exemplo.com', 'senha-admin-1');
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = 'lucas@exemplo.com'`);
    const res = await agent.post(`/usuarios/${rows[0].id}`).type('form').send({ _csrf: csrf, nome: 'Lucas', email: 'lucas@exemplo.com', perfil: 'lead', ativo: 'on' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('único Admin ativo');
  });

  it('senha fica guardada com hash, nunca em texto', async () => {
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE email = 'lucas@exemplo.com'`);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('formatação', () => {
  it('datas, valores e telefone no padrão brasileiro', () => {
    expect(formatDate('2026-03-05T12:00:00Z')).toBe('05/03/2026');
    expect(formatMoney(1234.5)).toBe('R$ 1.234,50');
    expect(normalizePhone('+55 (11) 98765-4321')).toBe('11987654321');
  });
});
