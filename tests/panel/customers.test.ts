import { describe, expect, test } from 'vitest';
import { insertAlert } from '../../src/store/alerts.js';
import { getCustomer, updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { insertMessage } from '../../src/store/messages.js';
import { getOrder } from '../../src/store/orders.js';
import { form, login, pedidoPadrao, SEGUNDA_10H, setupPanel } from './helpers.js';

type Panel = Awaited<ReturnType<typeof setupPanel>>;
const get = (app: Panel['app'], url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

describe('painel: clientes', () => {
  test('rotas exigem sessão', async () => {
    const { app, cliente } = await setupPanel();
    for (const url of ['/painel/clientes', `/painel/clientes/${cliente.id}`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    const post = await app.inject({ method: 'POST', url: `/painel/clientes/${cliente.id}/excluir` });
    expect(post.headers.location).toBe('/login');
  });

  test('lista e busca por nome ou telefone, escapando HTML e pulando excluídos', async () => {
    const { app, db } = await setupPanel('Maria');
    const outro = upsertCustomerByPhone(db, '5586977776666', SEGUNDA_10H);
    updateCustomer(db, outro.id, { nome: '<script>alert(1)</script>' });
    const apagado = upsertCustomerByPhone(db, '5586955554444', SEGUNDA_10H);
    db.prepare('UPDATE customers SET telefone = ? WHERE id = ?').run(`excluido-${apagado.id}`, apagado.id);
    const cookie = await login(app);

    const todos = (await get(app, '/painel/clientes', cookie)).body;
    expect(todos).toContain('Maria');
    expect(todos).not.toContain('<script>alert(1)</script>');
    expect(todos).toContain('&lt;script&gt;');
    expect(todos).not.toContain('excluido-');

    const porNome = (await get(app, '/painel/clientes?q=mar', cookie)).body;
    expect(porNome).toContain('Maria');
    expect(porNome).not.toContain('&lt;script&gt;');

    const porFone = (await get(app, '/painel/clientes?q=77776666', cookie)).body;
    expect(porFone).toContain('&lt;script&gt;');
    expect(porFone).not.toContain('Maria');
  });

  test('cliente mostra próxima recompra, histórico, endereço e lembretes', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    updateCustomer(db, cliente.id, { endereco: { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' } });
    const a = await orders.create(cliente.id, pedidoPadrao);
    const b = await orders.create(cliente.id, pedidoPadrao);
    if (!a.ok || !b.ok) throw new Error('pedido não criado');
    for (const [id, em] of [
      [a.order.id, '2026-09-01T12:00:00.000Z'],
      [b.order.id, '2026-10-01T12:00:00.000Z'],
    ] as const) {
      db.prepare("UPDATE orders SET status = 'entregue', finalizado_em = ? WHERE id = ?").run(em, id);
    }
    const cookie = await login(app);
    const body = (await get(app, `/painel/clientes/${cliente.id}`, cookie)).body;
    expect(body).toContain('31/10/2026');
    expect(body).toContain('Rua das Flores, 120');
    expect(body).toContain(`#${a.order.id}`);
    expect(body).toContain(`#${b.order.id}`);
    expect(body).toMatch(/<dt>Lembretes<\/dt><dd>Ligados<\/dd>/);

    updateCustomer(db, cliente.id, { lembretesDesativados: true });
    expect((await get(app, `/painel/clientes/${cliente.id}`, cookie)).body).toMatch(/<dt>Lembretes<\/dt><dd>Desligados<\/dd>/);
  });

  test('cliente sem histórico mostra traço na recompra; inexistente dá 404', async () => {
    const { app, cliente } = await setupPanel();
    const cookie = await login(app);
    const body = (await get(app, `/painel/clientes/${cliente.id}`, cookie)).body;
    expect(body).toMatch(/<dt>Próxima recompra<\/dt><dd class="num">—<\/dd>/);
    expect((await get(app, '/painel/clientes/9999', cookie)).statusCode).toBe(404);
    expect((await get(app, '/painel/clientes/abc', cookie)).statusCode).toBe(404);
  });

  test('excluir cliente apaga mensagens e anonimiza', async () => {
    const { app, db, orders, alerts, cliente } = await setupPanel('Maria');
    const r = await orders.create(cliente.id, pedidoPadrao);
    if (!r.ok) throw new Error('pedido não criado');
    insertMessage(db, { clienteId: cliente.id, autor: 'cliente', tipo: 'texto', texto: 'oi', wamid: 'w1', criadoEm: SEGUNDA_10H.toISOString() });
    db.prepare("INSERT INTO drafts (cliente_id, payload_json, total_centavos, criado_em) VALUES (?, '{}', 100, ?)").run(
      cliente.id,
      SEGUNDA_10H.toISOString(),
    );
    insertAlert(db, { clienteId: cliente.id, pedidoId: null, motivo: 'x', resumo: 'y' }, SEGUNDA_10H);
    const nOrderMessages = () => (db.prepare('SELECT COUNT(*) AS n FROM order_messages').get() as { n: number }).n;
    const antes = nOrderMessages();
    expect(antes).toBeGreaterThan(0);
    const cookie = await login(app);

    const res = await app.inject({ method: 'POST', url: `/painel/clientes/${cliente.id}/excluir`, ...form(cookie, {}) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/painel/clientes');

    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE cliente_id = ?`).get(cliente.id) as { n: number }).n;
    expect(count('messages')).toBe(0);
    expect(count('drafts')).toBe(0);
    expect(count('alerts')).toBe(0);
    expect(nOrderMessages()).toBe(antes);
    expect(getOrder(db, r.order.id)!.endereco).toBeNull();
    expect(getCustomer(db, cliente.id)).toMatchObject({
      telefone: `excluido-${cliente.id}`,
      nome: null,
      endereco: null,
      lembretesDesativados: true,
    });
    expect(alerts.listOpen()).toHaveLength(0);
  });
});
