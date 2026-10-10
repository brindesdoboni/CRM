import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { newToken } from '../src/lib/integrations.js';
import { CONSENT_TEXT } from '../src/routes/formulario.js';

const app = createApp();
const t = newToken();
let ip = 0;
/** Cada envio vem de um IP diferente para não esbarrar no limite por IP (testado à parte). */
const enviar = (body: Record<string, string>, fromIp = `10.0.0.${++ip}`) =>
  request(app).post('/formulario').set('X-Forwarded-For', fromIp).type('form').send(body);
const valido = (extra: Record<string, string> = {}) => ({
  nome: 'Carla Dias', whatsapp: '(11) 95555-1234', email: 'carla@exemplo.com', produto: 'Caneca', quantidade: '50', mensagem: 'Para evento', consentimento: 'sim', ...extra,
});
const leadsDo = async (phone: string) =>
  (await pool.query(`SELECT l.*, o.name AS origin FROM leads l JOIN customers c ON c.id = l.customer_id JOIN origins o ON o.id = l.origin_id WHERE c.phone = $1 ORDER BY l.id`, [phone])).rows;
const avisosDe = async (name: string) =>
  (await pool.query(`SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = $1 ORDER BY n.id`, [name])).rows.map((r) => r.title as string);

type Chamada = { url: string; body: any };
/** Simula a API do ManyChat: guarda as chamadas e responde sucesso (ou falha). */
function manychat(ok = true): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    chamadas.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (!ok) return new Response(JSON.stringify({ status: 'error', message: 'falhou' }), { status: 400 });
    if (url.includes('findBySystemField')) return new Response(JSON.stringify({ status: 'success', data: null }));
    if (url.includes('createSubscriber')) return new Response(JSON.stringify({ status: 'success', data: { id: '5551234' } }));
    return new Response(JSON.stringify({ status: 'success' }));
  }));
  return chamadas;
}

async function login(email: string, senha: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ _csrf: /name="_csrf" value="([^"]+)"/.exec(page.text)![1], email, senha });
  const conta = await agent.get('/minha-conta');
  return { agent, csrf: /name="_csrf" value="([^"]+)"/.exec(conta.text)![1] };
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Laura', email: 'laura@exemplo.com', password: 'senha-com-1', role: 'comercial' });
  await createUser({ name: 'Danielson', email: 'dani@exemplo.com', password: 'senha-lead-1', role: 'lead' });
  await pool.query(`UPDATE settings SET value = 'content2026_boasvindas' WHERE key = 'manychat_flow_boas_vindas'`);
  const { rows } = await pool.query(`SELECT id FROM origins WHERE name = 'WhatsApp'`);
  await pool.query(`INSERT INTO integrations (name, channel, origin_id, token_hash, token_hint) VALUES ('ManyChat WhatsApp', 'manychat', $1, $2, $3)`, [rows[0].id, t.hash, t.hint]);
  process.env.MANYCHAT_API_KEY = 'teste';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.MANYCHAT_API_KEY;
  await pool.end();
});

describe('formulário do site', () => {
  it('abre com a caixa de consentimento e pode ficar dentro do site (iframe)', async () => {
    const res = await request(app).get('/formulario');
    expect(res.status).toBe(200);
    expect(res.text).toContain(CONSENT_TEXT);
    expect(res.text).toMatch(/name="consentimento"[^>]*required/);
    expect(res.headers['content-security-policy']).toContain('frame-ancestors *');
    expect(res.headers['x-frame-options']).toBeUndefined();
    // O resto do CRM continua sem poder ser colocado em outro site
    expect((await request(app).get('/login')).headers['x-frame-options']).toBeDefined();
  });

  it('sem o consentimento não envia e não grava nada', async () => {
    const chamadas = manychat();
    const res = await enviar(valido({ consentimento: '' }));
    expect(res.status).toBe(400);
    expect(res.text).toContain('marque a autorização de contato pelo WhatsApp');
    expect(res.text).toContain('value="Carla Dias"'); // o que a pessoa digitou continua no formulário
    expect(await leadsDo('11955551234')).toHaveLength(0);
    expect(chamadas).toHaveLength(0);
  });

  it('robô (campo escondido preenchido): finge que deu certo e não grava', async () => {
    const res = await enviar(valido({ site: 'http://spam.example' }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Recebemos seu pedido');
    expect(await leadsDo('11955551234')).toHaveLength(0);
  });

  it('com consentimento: cria o lead do site, grava o aceite e o SDR manda a boas-vindas', async () => {
    const chamadas = manychat();
    const res = await enviar(valido(), '200.1.2.3');
    expect(res.status).toBe(201);
    expect(res.text).toContain('Obrigado, Carla');
    const [lead] = await leadsDo('11955551234');
    expect(lead).toMatchObject({ origin: 'Site Brindes DoBoni', channel: 'site', product: 'Caneca', quantity: 50, consent_text: CONSENT_TEXT, consent_ip: '200.1.2.3' });
    expect(lead.consent_at).toBeInstanceOf(Date);
    expect(lead.welcome_sent_at).toBeInstanceOf(Date);
    expect(lead.data.external_id).toBe('5551234');
    const criar = chamadas.find((c) => c.url.endsWith('/fb/subscriber/createSubscriber'))!;
    expect(criar.body).toMatchObject({ first_name: 'Carla', last_name: 'Dias', whatsapp_phone: '+5511955551234', consent_phrase: CONSENT_TEXT });
    expect(chamadas.find((c) => c.url.endsWith('setCustomFieldByName'))!.body).toMatchObject({ subscriber_id: '5551234', field_name: 'produto', field_value: 'Caneca' });
    expect(chamadas.find((c) => c.url.endsWith('/fb/sending/sendFlow'))!.body).toEqual({ subscriber_id: '5551234', flow_ns: 'content2026_boasvindas' });
    expect(await avisosDe('Laura')).toContain('Novo lead do site: Carla Dias · Caneca');
    expect(await avisosDe('Danielson')).toHaveLength(0);
  });

  it('mesmo telefone de novo: não duplica o lead e não repete a boas-vindas', async () => {
    const chamadas = manychat();
    const res = await enviar(valido({ whatsapp: '11 95555-1234', mensagem: 'Mudei para 80 unidades' }));
    expect(res.status).toBe(201);
    const leads = await leadsDo('11955551234');
    expect(leads).toHaveLength(1);
    expect(leads[0].notes).toContain('[Formulário do site] Mudei para 80 unidades');
    expect(chamadas).toHaveLength(0);
    expect(await avisosDe('Laura')).toContain('Carla Dias mandou o formulário do site de novo');
  });

  it('a resposta do cliente no WhatsApp (ManyChat) entra na mesma ficha e é pontuada', async () => {
    const res = await request(app).post('/api/leads').set('X-CRM-Token', t.token)
      .send({ telefone: '5511955551234', nome: 'Carla Dias', subscriber_id: '5551234', tipo: 'Empresa', quantidade_faixa: '20 a 99', prazo: 'Até 7 dias', arte: 'Sim' });
    expect(res.status).toBe(200);
    expect(res.body.duplicado).toBe(true);
    const leads = await leadsDo('11955551234');
    expect(leads).toHaveLength(1);
    expect(leads[0].score).toBeGreaterThan(0);
    expect(leads[0].data.qualificacao.tipo.resposta).toBe('Empresa');
    expect(leads[0].origin).toBe('Site Brindes DoBoni');
  });

  it('falha no envio do ManyChat: o lead fica salvo e a Laura é avisada', async () => {
    manychat(false);
    const res = await enviar(valido({ nome: 'Rui', whatsapp: '21 97777-0000', produto: 'Squeeze' }));
    expect(res.status).toBe(201);
    const [lead] = await leadsDo('21977770000');
    expect(lead.welcome_sent_at).toBeNull();
    expect((await avisosDe('Laura')).at(-1)).toBe('⚠️ A boas-vindas não chegou para Rui (site): o ManyChat não aceitou o contato do cliente. Chame pelo WhatsApp.');
    expect((await avisosDe('Lucas')).at(-1)).toContain('⚠️ A boas-vindas não chegou para Rui');
    const { rows } = await pool.query(`SELECT 1 FROM events WHERE entity_id = $1 AND action = 'boas_vindas_falhou'`, [String(lead.id)]);
    expect(rows).toHaveLength(1);
  });

  it('sem a chave do ManyChat no Railway: avisa a Laura dizendo o que falta', async () => {
    delete process.env.MANYCHAT_API_KEY;
    try {
      await enviar(valido({ nome: 'Ana', whatsapp: '31 98888-1111' }));
      expect((await avisosDe('Laura')).at(-1)).toContain('falta a chave do ManyChat (MANYCHAT_API_KEY)');
    } finally {
      process.env.MANYCHAT_API_KEY = 'teste';
    }
  });

  it('Danielson não vê leads do site, nem quando o cliente é o mesmo do lead dele', async () => {
    const dani = await login('dani@exemplo.com', 'senha-lead-1');
    const { rows } = await pool.query(`SELECT id FROM origins WHERE name = 'Shopee – Bexlu'`);
    await dani.agent.post('/leads').type('form').send({ _csrf: dani.csrf, telefone: '41 96666-2222', nome: 'Beto', origem: String(rows[0].id), produto: 'Chaveiro' });
    manychat();
    await enviar(valido({ nome: 'Beto', whatsapp: '41966662222', produto: 'Caneta' }));
    const leads = await leadsDo('41966662222');
    expect(leads.map((l) => l.channel)).toEqual(['manual', 'site']); // o do site não entrou no lead dele
    const [manual, site] = leads;

    const lista = await dani.agent.get('/leads');
    expect(lista.text).toContain('Chaveiro');
    expect(lista.text).not.toContain('Caneta');
    expect(lista.text).not.toContain('Carla');
    expect((await dani.agent.get(`/leads/${site.id}`)).status).toBe(404);
    const ficha = await dani.agent.get(`/leads/${manual.id}`);
    expect(ficha.status).toBe(200);
    expect(ficha.text).not.toContain(`/leads/${site.id}"`);

    const laura = await login('laura@exemplo.com', 'senha-com-1');
    const fichaSite = await laura.agent.get(`/leads/${site.id}`);
    expect(fichaSite.status).toBe(200);
    expect(fichaSite.text).toContain(CONSENT_TEXT);
    expect((await laura.agent.get(`/leads/${manual.id}`)).text).toContain(`/leads/${site.id}"`);
  });

  it('limite por IP: o 6º envio na mesma hora é bloqueado', async () => {
    manychat();
    const mesmoIp = '10.9.9.9';
    for (let i = 0; i < 5; i++) {
      expect((await enviar(valido({ whatsapp: `11 9444${i}-0000` }), mesmoIp)).status).toBe(201);
    }
    const res = await enviar(valido({ whatsapp: '11 94449-0000' }), mesmoIp);
    expect(res.status).toBe(429);
    expect(res.text).toContain('muitos envios');
    expect(await leadsDo('11944490000')).toHaveLength(0);
  });
});
