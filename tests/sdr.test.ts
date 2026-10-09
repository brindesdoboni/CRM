import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createUser } from '../src/lib/users.js';
import { newToken } from '../src/lib/integrations.js';
import { classify, matchOption, parseOptionsText } from '../src/lib/sdr.js';
import { processDueRecontacts } from '../src/lib/recontatos.js';

const app = createApp();
const t = newToken();
let laura: ReturnType<typeof request.agent>;
let csrf = '';
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);

const post = (body: Record<string, unknown>) => request(app).post('/api/leads').set('X-CRM-Token', t.token).send(body);
const avisosDe = async (name: string) =>
  (await pool.query(`SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.name = $1 ORDER BY n.id`, [name])).rows.map((r) => r.title);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await createUser({ name: 'Lucas', email: 'lucas@exemplo.com', password: 'senha-admin-1', role: 'admin' });
  await createUser({ name: 'Laura', email: 'laura@exemplo.com', password: 'senha-com-1', role: 'comercial' });
  const { rows } = await pool.query(`SELECT id FROM origins WHERE name = 'Instagram'`);
  await pool.query(`INSERT INTO integrations (name, channel, origin_id, token_hash, token_hint) VALUES ('ManyChat', 'manychat', $1, $2, $3)`, [rows[0].id, t.hash, t.hint]);
  await pool.query(`UPDATE settings SET value = '11911112222' WHERE key = 'whatsapp_comercial'`);
  laura = request.agent(app);
  const page = await laura.get('/login');
  await laura.post('/login').type('form').send({ _csrf: /name="_csrf" value="([^"]+)"/.exec(page.text)![1], email: 'laura@exemplo.com', senha: 'senha-com-1' });
  csrf = /name="_csrf" value="([^"]+)"/.exec((await laura.get('/minha-conta')).text)![1];
});

afterAll(async () => {
  await pool.end();
});

describe('pontuação', () => {
  it('opções e classificação', () => {
    const opts = parseOptionsText('Empresa = 25\nMenos de 20 = 0 varejo\nSem pontos');
    expect(opts).toEqual([{ texto: 'Empresa', pontos: 25 }, { texto: 'Menos de 20', pontos: 0, varejo: true }, { texto: 'Sem pontos', pontos: 0 }]);
    expect(matchOption(opts, ' EMPRESA ')?.pontos).toBe(25);
    expect(matchOption(opts, 'é para minha empresa')?.pontos).toBe(25);
    const limits = { quente: 60, morno: 35, atacado: 20 };
    expect(classify({}, 0, null, limits)).toBeNull();
    expect(classify({ a: { pergunta: '', resposta: '', pontos: 70 } }, 70, 10, limits)).toBe('varejo');
    expect(classify({ a: { pergunta: '', resposta: '', pontos: 70 } }, 70, 100, limits)).toBe('quente');
    expect(classify({ a: { pergunta: '', resposta: '', pontos: 40 } }, 40, null, limits)).toBe('morno');
  });
});

describe('ManyChat → CRM', () => {
  it('lead quente: pontua, avisa com 🔥 e devolve o link do WhatsApp da Laura com resumo', async () => {
    const res = await post({ telefone: '11987654321', nome: 'Bruna', subscriber_id: '998877', tipo: 'Empresa', quantidade_faixa: '100 a 499', prazo: 'Até 7 dias', arte: 'Sim', produto: 'Garrafa térmica' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ pontuacao: 85, classificacao: 'quente', mensagem_varejo: null });
    expect(res.body.link_whatsapp_comercial).toMatch(/^https:\/\/wa\.me\/5511911112222\?text=/);
    expect(decodeURIComponent(res.body.link_whatsapp_comercial)).toContain('Garrafa térmica');
    expect((await avisosDe('Laura'))[0]).toContain('🔥 Lead quente (85 pontos): Bruna');
    const ficha = await laura.get(`/leads/${res.body.lead_id}`);
    expect(ficha.text).toContain('85 pontos');
    expect(ficha.text).toContain('Até 7 dias');
  });

  it('varejo: devolve a mensagem de site/Shopee', async () => {
    const res = await post({ telefone: '21900001111', tipo: 'Pessoal', quantidade_faixa: 'menos de 20' });
    expect(res.body.classificacao).toBe('varejo');
    expect(res.body.mensagem_varejo).toContain('site');
  });

  it('respostas em etapas: junta no mesmo lead e avisa quando fica quente', async () => {
    const r1 = await post({ telefone: '31955554444', nome: 'Caio', tipo: 'Evento' });
    expect(r1.body).toMatchObject({ pontuacao: 20, classificacao: 'frio' });
    const r2 = await post({ telefone: '31955554444', quantidade_faixa: '500 ou mais', prazo: 'Até 30 dias' });
    expect(r2.body).toMatchObject({ lead_id: r1.body.lead_id, duplicado: true, pontuacao: 70, classificacao: 'quente' });
    expect((await avisosDe('Laura')).filter((a) => a.includes('Caio'))).toHaveLength(2); // novo lead + ficou quente
  });

  it('recontato só com consentimento; "sair" cancela', async () => {
    const sem = await post({ telefone: '41933332222', nome: 'Duda', recontato_dias: '30' });
    expect((await pool.query('SELECT count(*)::int AS n FROM recontacts')).rows[0].n).toBe(0);
    await post({ telefone: '41933332222', recontato_dias: '30', recontato_consentimento: 'me chama daqui um mês' });
    const { rows } = await pool.query('SELECT due_date, consent_text, lead_id FROM recontacts');
    expect(rows).toHaveLength(1);
    expect(rows[0].lead_id).toBe(sem.body.lead_id);
    expect(rows[0].consent_text).toBe('me chama daqui um mês');
    await post({ telefone: '41933332222', sair: 'sim' });
    expect((await pool.query('SELECT status FROM recontacts')).rows[0].status).toBe('cancelado');
    expect((await pool.query('SELECT opt_out_at FROM leads WHERE id = $1', [sem.body.lead_id])).rows[0].opt_out_at).not.toBeNull();
  });

  it('no dia do recontato o comercial é avisado (uma vez só)', async () => {
    const { rows } = await pool.query(`SELECT l.id FROM leads l JOIN customers c ON c.id = l.customer_id WHERE c.name = 'Bruna'`);
    await pool.query(`INSERT INTO recontacts (lead_id, due_date, consent_text) VALUES ($1, current_date, 'pediu para chamar hoje')`, [rows[0].id]);
    expect(await processDueRecontacts(() => {})).toBe(1);
    expect(await processDueRecontacts(() => {})).toBe(0);
    expect((await avisosDe('Laura')).at(-1)).toContain('Hoje: recontatar Bruna');
    expect((await laura.get('/inicio')).text).toContain('pediu para chamar hoje');
  });
});

describe('telas', () => {
  it('agendar recontato na ficha exige marcar que o cliente autorizou', async () => {
    const { rows } = await pool.query(`SELECT l.id FROM leads l JOIN customers c ON c.id = l.customer_id WHERE c.name = 'Caio'`);
    await laura.post(`/leads/${rows[0].id}/recontato`).type('form').send({ _csrf: csrf, data: '2099-01-10', consentimento: 'liga em janeiro' });
    expect((await pool.query('SELECT count(*)::int AS n FROM recontacts WHERE lead_id = $1', [rows[0].id])).rows[0].n).toBe(0);
    await laura.post(`/leads/${rows[0].id}/recontato`).type('form').send({ _csrf: csrf, data: '2099-01-10', consentimento: 'liga em janeiro', autorizou: 'on' });
    expect((await pool.query('SELECT count(*)::int AS n FROM recontacts WHERE lead_id = $1', [rows[0].id])).rows[0].n).toBe(1);
  });

  it('Admin cadastra áudio padrão com link público; Laura não acessa a configuração', async () => {
    expect((await laura.get('/configuracoes/sdr')).status).toBe(403);
    const admin = request.agent(app);
    const page = await admin.get('/login');
    await admin.post('/login').type('form').send({ _csrf: /name="_csrf" value="([^"]+)"/.exec(page.text)![1], email: 'lucas@exemplo.com', senha: 'senha-admin-1' });
    const tela = await admin.get('/configuracoes/sdr');
    const c = /name="_csrf" value="([^"]+)"/.exec(tela.text)![1];
    const bad = await admin.post('/configuracoes/sdr/audios').field('_csrf', c).field('titulo', 'Errado').attach('arquivo', Buffer.from('nada'), 'x.mp3');
    expect(bad.status).toBe(302);
    expect((await pool.query('SELECT count(*)::int AS n FROM sdr_audios')).rows[0].n).toBe(0);
    await admin.post('/configuracoes/sdr/audios').field('_csrf', c).field('titulo', 'Boas-vindas').attach('arquivo', OGG, 'oi.ogg');
    const { rows } = await pool.query('SELECT public_token FROM sdr_audios');
    const pub = await request(app).get(`/publico/audio/${rows[0].public_token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers['content-type']).toBe('audio/ogg');
    expect((await request(app).get('/publico/audio/chute')).status).toBe(404);
    await admin.post('/configuracoes/sdr/regras').type('form').send({ _csrf: c, nota_quente: '50', nota_morno: '30', limite_atacado: '20', whatsapp_comercial: '(11) 91111-2222', mensagem_varejo: 'Compre no site', flow_recontato: '' });
    expect((await pool.query(`SELECT value FROM settings WHERE key = 'sdr_nota_quente'`)).rows[0].value).toBe('50');
  });
});
