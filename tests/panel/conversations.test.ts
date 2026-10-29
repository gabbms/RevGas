import { describe, expect, test } from 'vitest';
import { getCustomer, updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { insertMessage, recentMessages } from '../../src/store/messages.js';
import { form, login, SEGUNDA_10H, setupPanel } from './helpers.js';

const DUAS_HORAS = 2 * 60 * 60 * 1000;
type Panel = Awaited<ReturnType<typeof setupPanel>>;
const ms = (delta: number) => new Date(SEGUNDA_10H.getTime() + delta);
const msg = (
  db: Panel['db'],
  clienteId: number,
  autor: 'cliente' | 'bot' | 'dono',
  texto: string,
  em: Date,
  tipo: 'texto' | 'audio' = 'texto',
) => insertMessage(db, { clienteId, autor, tipo, texto, wamid: null, criadoEm: em.toISOString() });
const post = (app: Panel['app'], url: string, cookie: string, body: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, ...form(cookie, body) });

describe('painel: conversas', () => {
  test('rotas exigem sessão (inclusive o fragmento htmx)', async () => {
    const { app, cliente } = await setupPanel();
    for (const url of ['/painel/conversas', `/painel/conversas/${cliente.id}`, `/painel/conversas/${cliente.id}/mensagens`]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(302);
    }
    for (const acao of ['responder', 'pausar', 'devolver']) {
      const r = await app.inject({ method: 'POST', url: `/painel/conversas/${cliente.id}/${acao}` });
      expect(r.headers.location).toBe('/login');
    }
    const hx = await app.inject({ method: 'GET', url: `/painel/conversas/${cliente.id}/mensagens`, headers: { 'hx-request': 'true' } });
    expect(hx.statusCode).toBe(401);
  });

  test('lista ordena pela última mensagem, indica pausa e pula excluídos', async () => {
    const { app, db, cliente } = await setupPanel('Maria');
    const jose = updateCustomer(db, upsertCustomerByPhone(db, '5586977776666', SEGUNDA_10H).id, { nome: 'José' });
    const apagado = upsertCustomerByPhone(db, '5586955554444', SEGUNDA_10H);
    msg(db, apagado.id, 'cliente', 'oi', ms(-1000));
    db.prepare('UPDATE customers SET telefone = ? WHERE id = ?').run(`excluido-${apagado.id}`, apagado.id);
    msg(db, cliente.id, 'cliente', 'antiga', ms(-5 * 60000));
    msg(db, jose.id, 'cliente', 'recente', ms(-60000));
    updateCustomer(db, cliente.id, { botPausadoAte: ms(3600000).toISOString() });
    const cookie = await login(app);

    const body = (await app.inject({ method: 'GET', url: '/painel/conversas', headers: { cookie } })).body;
    expect(body.indexOf('José')).toBeGreaterThan(-1);
    expect(body.indexOf('José')).toBeLessThan(body.indexOf('Maria'));
    expect(body).toContain('Bot pausado');
    expect(body).not.toContain('excluido-');
  });

  test('histórico mostra autores, marca áudio com 🎤 e escapa HTML; só últimos 30 dias', async () => {
    const { app, db, cliente } = await setupPanel();
    msg(db, cliente.id, 'cliente', 'mensagem velha', ms(-31 * 86400000));
    msg(db, cliente.id, 'cliente', 'quero gás <b>agora</b>', ms(-3000), 'audio');
    msg(db, cliente.id, 'bot', 'Claro!', ms(-2000));
    msg(db, cliente.id, 'dono', 'Já vai', ms(-1000));
    const cookie = await login(app);

    const frag = (await app.inject({ method: 'GET', url: `/painel/conversas/${cliente.id}/mensagens`, headers: { cookie } })).body;
    expect(frag).not.toContain('<html');
    expect(frag).not.toContain('mensagem velha');
    expect(frag).toContain('🎤');
    expect(frag).toContain('quero gás &lt;b&gt;agora&lt;/b&gt;');
    expect(frag).toContain('msg-cliente');
    expect(frag).toContain('msg-bot');
    expect(frag).toContain('msg-dono');

    const pagina = (await app.inject({ method: 'GET', url: `/painel/conversas/${cliente.id}`, headers: { cookie } })).body;
    expect(pagina).toContain('Pausar bot');
    expect(pagina).toContain(`hx-get="/painel/conversas/${cliente.id}/mensagens"`);
    expect(pagina).toContain('every 5s');
    expect(pagina).toContain('Já vai');
  });

  test('pausado mostra "Devolver ao bot"', async () => {
    const { app, db, cliente } = await setupPanel();
    updateCustomer(db, cliente.id, { botPausadoAte: ms(3600000).toISOString() });
    const cookie = await login(app);
    const pagina = (await app.inject({ method: 'GET', url: `/painel/conversas/${cliente.id}`, headers: { cookie } })).body;
    expect(pagina).toContain('Devolver ao bot');
    expect(pagina).not.toContain('Pausar bot');
  });

  test('responder dentro da janela envia, grava autor dono e pausa 2h', async () => {
    const { app, db, cliente, fake } = await setupPanel();
    const cookie = await login(app);
    const res = await post(app, `/painel/conversas/${cliente.id}/responder`, cookie, { texto: ' Já estou saindo ' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/painel/conversas/${cliente.id}`);

    expect(fake.sent).toEqual([{ to: cliente.telefone, kind: 'text', body: 'Já estou saindo' }]);
    const [m] = recentMessages(db, cliente.id, new Date(0));
    expect(m).toMatchObject({ autor: 'dono', tipo: 'texto', texto: 'Já estou saindo' });
    expect(m!.wamid).toMatch(/^wamid\./);
    expect(getCustomer(db, cliente.id)!.botPausadoAte).toBe(ms(DUAS_HORAS).toISOString());
  });

  test('responder fora da janela mostra aviso e não grava', async () => {
    const { app, db, cliente, fake } = await setupPanel();
    db.prepare('DELETE FROM contact_windows').run();
    const cookie = await login(app);
    const res = await post(app, `/painel/conversas/${cliente.id}/responder`, cookie, { texto: 'Oi tudo bem' });
    expect(res.body).toContain(
      'O cliente não fala com o bot há mais de 24h. O WhatsApp só permite responder depois que ele mandar uma mensagem.',
    );
    expect(res.body).toContain('Oi tudo bem');
    expect(fake.sent).toHaveLength(0);
    expect(recentMessages(db, cliente.id, new Date(0))).toHaveLength(0);
    expect(getCustomer(db, cliente.id)!.botPausadoAte).toBeNull();
  });

  test('erro da API mostra aviso e não grava', async () => {
    const { app, db, cliente, fake } = await setupPanel();
    fake.failNext(new Error('boom'));
    const cookie = await login(app);
    const res = await post(app, `/painel/conversas/${cliente.id}/responder`, cookie, { texto: 'Oi' });
    expect(res.body).toContain('Não foi possível enviar agora. Tente de novo.');
    expect(recentMessages(db, cliente.id, new Date(0))).toHaveLength(0);
    expect(getCustomer(db, cliente.id)!.botPausadoAte).toBeNull();
  });

  test('texto vazio não envia', async () => {
    const { app, cliente, fake } = await setupPanel();
    const cookie = await login(app);
    const res = await post(app, `/painel/conversas/${cliente.id}/responder`, cookie, { texto: '   ' });
    expect(res.body).toContain('Escreva a mensagem');
    expect(fake.sent).toHaveLength(0);
  });

  test('pausar põe 2h e devolver ao bot zera a pausa', async () => {
    const { app, db, cliente } = await setupPanel();
    const cookie = await login(app);
    const p = await post(app, `/painel/conversas/${cliente.id}/pausar`, cookie);
    expect(p.statusCode).toBe(302);
    expect(getCustomer(db, cliente.id)!.botPausadoAte).toBe(ms(DUAS_HORAS).toISOString());
    const d = await post(app, `/painel/conversas/${cliente.id}/devolver`, cookie);
    expect(d.statusCode).toBe(302);
    expect(getCustomer(db, cliente.id)!.botPausadoAte).toBeNull();
  });

  test('cliente inexistente ou excluído dá 404', async () => {
    const { app, db, cliente } = await setupPanel();
    const cookie = await login(app);
    expect((await app.inject({ method: 'GET', url: '/painel/conversas/9999', headers: { cookie } })).statusCode).toBe(404);
    db.prepare('UPDATE customers SET telefone = ? WHERE id = ?').run(`excluido-${cliente.id}`, cliente.id);
    expect((await app.inject({ method: 'GET', url: `/painel/conversas/${cliente.id}`, headers: { cookie } })).statusCode).toBe(404);
  });
});
