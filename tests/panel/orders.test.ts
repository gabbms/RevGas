import { describe, expect, test } from 'vitest';
import { insertMessage } from '../../src/store/messages.js';
import { getOrder, insertOrder, type Order } from '../../src/store/orders.js';
import { form, login, pedidoPadrao, SEGUNDA_10H, setupPanel } from './helpers.js';

describe('painel: login', () => {
  test('sem sessão redireciona para /login', async () => {
    const { app } = await setupPanel();
    for (const url of ['/painel/pedidos', '/painel/pedidos/lista', '/painel/alertas']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    const post = await app.inject({ method: 'POST', url: '/painel/alertas/1/resolver' });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toBe('/login');
  });

  test('cookie adulterado não vale', async () => {
    const { app } = await setupPanel();
    const res = await app.inject({ method: 'GET', url: '/painel/pedidos', headers: { cookie: 'sessao=ok.assinaturafalsa' } });
    expect(res.statusCode).toBe(302);
  });

  test('senha errada devolve 401 com a página de login e erro', async () => {
    const { app } = await setupPanel();
    const res = await app.inject({ method: 'POST', url: '/login', ...form('', { senha: 'errada' }) });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Senha incorreta');
    expect(res.cookies.find((c) => c.name === 'sessao')).toBeUndefined();
  });

  test('6ª tentativa errada em 15 min dá 429; depois de 15 min volta a aceitar', async () => {
    let agora = SEGUNDA_10H;
    const { app } = await setupPanel('Maria', () => agora);
    const tentar = (senha: string) => app.inject({ method: 'POST', url: '/login', ...form('', { senha }) });
    for (let i = 0; i < 5; i++) expect((await tentar('errada')).statusCode).toBe(401);
    const bloqueada = await tentar('errada');
    expect(bloqueada.statusCode).toBe(429);
    expect(bloqueada.body).toContain('Muitas tentativas. Tente de novo em alguns minutos.');
    // Nem a senha certa entra enquanto está bloqueado.
    const certaBloqueada = await tentar('senha-do-dono');
    expect(certaBloqueada.statusCode).toBe(429);
    expect(certaBloqueada.cookies.find((c) => c.name === 'sessao')).toBeUndefined();

    agora = new Date(SEGUNDA_10H.getTime() + 15 * 60_000 + 1000);
    expect((await tentar('senha-do-dono')).statusCode).toBe(302);
  });

  test('login certo zera o contador de tentativas', async () => {
    const { app } = await setupPanel();
    const tentar = (senha: string) => app.inject({ method: 'POST', url: '/login', ...form('', { senha }) });
    for (let i = 0; i < 4; i++) await tentar('errada');
    expect((await tentar('senha-do-dono')).statusCode).toBe(302);
    for (let i = 0; i < 5; i++) expect((await tentar('errada')).statusCode).toBe(401);
    expect((await tentar('errada')).statusCode).toBe(429);
  });

  test('login certo dá cookie seguro e a lista mostra #1', async () => {
    const { app, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    const res = await app.inject({ method: 'POST', url: '/login', ...form('', { senha: 'senha-do-dono' }) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/painel');
    const c = res.cookies.find((x) => x.name === 'sessao')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true });
    expect(c.maxAge).toBe(30 * 86400);

    const cookie = await login(app);
    const page = await app.inject({ method: 'GET', url: '/painel/pedidos', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('#1');
    expect(page.body).toContain('Maria');
    expect(page.body).toContain('R$ 115,00');
    // Sem alerta aberto o menu não mostra contagem; o pedido esperando sair, sim.
    expect(page.body).not.toMatch(/aria-label="\d+ abertos"/);
    expect(page.body).toContain('aria-label="1 esperando"');
    expect(page.body).toContain('hx-get="/painel/pedidos/lista');
  });

  test('logout apaga a sessão', async () => {
    const { app } = await setupPanel();
    const cookie = await login(app);
    const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(res.cookies.find((c) => c.name === 'sessao')?.value).toBe('');
  });

  test('GET /login com sessão vai direto à Central', async () => {
    const { app } = await setupPanel();
    const cookie = await login(app);
    const res = await app.inject({ method: 'GET', url: '/login', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/painel');
  });
});

describe('painel: pedidos', () => {
  test('POST status saiu atualiza o pedido', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    const res = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'saiu' }) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/painel/pedidos');
    expect(getOrder(db, 1)?.status).toBe('saiu');
  });

  test('cancelar usa orders.cancel', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'cancelado' }) });
    expect(getOrder(db, 1)?.status).toBe('cancelado');
  });

  test('transição inválida mostra erro e não muda status', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    // retirado num pedido de entrega é inválido
    const res = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'retirado' }) });
    expect(res.statusCode).toBe(302);
    expect(getOrder(db, 1)?.status).toBe('recebido');
    const page = await app.inject({ method: 'GET', url: res.headers.location as string, headers: { cookie } });
    expect(page.body).toContain('Não foi possível');
  });

  test('status desconhecido e pedido inexistente não quebram', async () => {
    const { app } = await setupPanel();
    const cookie = await login(app);
    const a = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'xyz' }) });
    expect(a.statusCode).toBe(302);
    const b = await app.inject({ method: 'POST', url: '/painel/pedidos/99/status', ...form(cookie, { status: 'saiu' }) });
    expect(b.statusCode).toBe(302);
  });

  test('filtro por status e fragmento da lista', async () => {
    const { app, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'saiu' }) });
    const frag = await app.inject({ method: 'GET', url: '/painel/pedidos/lista?status=saiu', headers: { cookie } });
    expect(frag.statusCode).toBe(200);
    expect(frag.body).not.toContain('<html');
    expect(frag.body).toContain('#1');
    expect(frag.body).not.toContain('#2');
    const todos = await app.inject({ method: 'GET', url: '/painel/pedidos/lista', headers: { cookie } });
    expect(todos.body.indexOf('#2')).toBeLessThan(todos.body.indexOf('#1')); // "Esperando sair" vem antes de "Na rua"
  });

  test('pedidos abertos de dias anteriores continuam na lista, sem duplicar', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    const base: Omit<Order, 'id' | 'status' | 'criadoEm'> = {
      clienteId: cliente.id,
      tipo: 'entrega',
      quantidade: 1,
      modo: 'troca',
      pagamento: 'dinheiro',
      trocoParaCentavos: null,
      endereco: { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' },
      unitarioCentavos: 11500,
      cascoCentavos: 0,
      taxaEntregaCentavos: 0,
      totalCentavos: 11500,
      entregadorTelefone: null,
      precisaRevisao: false,
      enviadoEm: null,
      saiuEm: null,
      finalizadoEm: null,
    };
    // Ontem 22h no horário local (UTC-3) = hoje 01:00Z.
    const ontem22h = '2026-11-02T01:00:00.000Z';
    insertOrder(db, { ...base, status: 'agendado', criadoEm: ontem22h }); // #1
    insertOrder(db, { ...base, status: 'saiu', criadoEm: '2026-10-31T15:00:00.000Z' }); // #2
    insertOrder(db, { ...base, status: 'entregue', criadoEm: '2026-10-31T15:00:00.000Z' }); // #3 finalizado antigo
    await orders.create(cliente.id, pedidoPadrao); // #4 de hoje
    const cookie = await login(app);
    const body = (await app.inject({ method: 'GET', url: '/painel/pedidos/lista', headers: { cookie } })).body;
    const vezes = (id: number) => body.split(`<strong class="mono">#${id}</strong>`).length - 1;
    expect([vezes(1), vezes(2), vezes(3), vezes(4)]).toEqual([1, 1, 0, 1]);
    expect(body.indexOf('#1')).toBeLessThan(body.indexOf('#4')); // o agendado fica na primeira coluna

    await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'cancelado' }) });
    expect(getOrder(db, 1)?.status).toBe('cancelado');
  });

  test('selos Pix conferir, Gás do Povo e Revisar', async () => {
    const { app, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, { ...pedidoPadrao, pagamento: 'pix_antecipado' });
    await orders.create(cliente.id, { ...pedidoPadrao, pagamento: 'gas_do_povo' });
    await orders.create(cliente.id, { ...pedidoPadrao, quantidade: 4, trocoParaCentavos: 50000 });
    const cookie = await login(app);
    const body = (await app.inject({ method: 'GET', url: '/painel/pedidos/lista', headers: { cookie } })).body;
    expect(body).toContain('Pix conferir');
    expect(body).toContain('Gás do Povo');
    expect(body).toContain('Revisar');
  });

  test('nome e endereço do cliente são escapados', async () => {
    const { app, orders, cliente } = await setupPanel('<script>alert(1)</script>');
    await orders.create(cliente.id, {
      ...pedidoPadrao,
      endereco: { rua: '<img src=x onerror=1>', numero: '1', bairro: 'Centro' },
    });
    const cookie = await login(app);
    const body = (await app.inject({ method: 'GET', url: '/painel/pedidos', headers: { cookie } })).body;
    expect(body).not.toContain('<script>alert(1)');
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;script&gt;');
  });

  test('CSS estático é servido sem login', async () => {
    const { app } = await setupPanel();
    const res = await app.inject({ method: 'GET', url: '/static/style.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });
});

describe('painel: alertas', () => {
  test('resolver tira alerta da lista', async () => {
    const { app, alerts, cliente } = await setupPanel();
    await alerts.create({ clienteId: cliente.id, motivo: 'Cliente reclamou <b>muito</b>', resumo: 'Atraso no #1' });
    const cookie = await login(app);
    const page = await app.inject({ method: 'GET', url: '/painel/alertas', headers: { cookie } });
    expect(page.body).toContain('Atraso no #1');
    expect(page.body).toContain(`/painel/conversas/${cliente.id}`);
    expect(page.body).toContain('aria-label="1 abertos"');
    expect(page.body).not.toContain('<b>muito</b>');

    const res = await app.inject({ method: 'POST', url: '/painel/alertas/1/resolver', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/painel/alertas');
    const after = await app.inject({ method: 'GET', url: '/painel/alertas', headers: { cookie } });
    expect(after.body).not.toContain('Atraso no #1');
    expect(after.body).not.toMatch(/aria-label="\d+ abertos"/);
  });

  test('quadro: um pedido por coluna conforme o status, com a ação principal no cartão', async () => {
    const { app, orders, cliente } = await setupPanel();
    for (let n = 0; n < 3; n++) await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    await app.inject({ method: 'POST', url: '/painel/pedidos/2/status', ...form(cookie, { status: 'saiu' }) });
    await app.inject({ method: 'POST', url: '/painel/pedidos/3/status', ...form(cookie, { status: 'cancelado' }) });
    const body = (await app.inject({ method: 'GET', url: '/painel/pedidos/lista', headers: { cookie } })).body;
    const coluna = (id: string) => body.slice(body.indexOf(`id="col-${id}"`)).split('</section>')[0]!;
    expect(coluna('esperando')).toContain('#1');
    expect(coluna('esperando')).toContain('Saiu para entrega');
    expect(coluna('na-rua')).toContain('#2');
    expect(coluna('na-rua')).toContain('Confirmar entrega');
    expect(coluna('concluidos')).toContain('#3');
    expect(coluna('concluidos')).not.toContain('<button');
    expect(coluna('agendados')).toContain('Nenhum pedido agendado');
  });

  test('o cartão abre o painel lateral do pedido', async () => {
    const { app, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, { ...pedidoPadrao, quantidade: 2, trocoParaCentavos: 30000 });
    const cookie = await login(app);
    const lista = (await app.inject({ method: 'GET', url: '/painel/pedidos/lista', headers: { cookie } })).body;
    expect(lista).toContain('href="/painel/pedidos?pedido=1"');
    expect(lista).not.toContain('role="dialog"');
    const pagina = (await app.inject({ method: 'GET', url: '/painel/pedidos?pedido=1', headers: { cookie } })).body;
    expect(pagina).toContain('role="dialog"');
    expect(pagina).toContain('Pedido pelo WhatsApp');
    expect(pagina).toContain('Maria');
    expect(pagina).toContain('2× P13 troca');
    expect(pagina).toContain('R$ 230,00');
    expect(pagina).toContain('Abrir no mapa');
    expect(pagina).toContain(`/painel/conversas/${cliente.id}`);
    expect(pagina).toContain('is-selected');
    // Sem entregador cadastrado ainda, explica como ele assume o pedido.
    expect(pagina).toContain('respondendo "saiu"');
  });

  test('painel lateral: etapas, conversa, e pedido inexistente ou inválido abre só o quadro', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    insertMessage(db, { clienteId: cliente.id, autor: 'cliente', tipo: 'texto', texto: 'quero um gás', wamid: null, criadoEm: SEGUNDA_10H.toISOString() });
    const cookie = await login(app);
    const frag = (await app.inject({ method: 'GET', url: '/painel/pedidos/1/detalhe', headers: { cookie } })).body;
    expect(frag).not.toContain('<html');
    expect(frag).toContain('quero um gás');
    expect(frag.match(/class="step[ "]/g)).toHaveLength(4);
    for (const q of ['pedido=999', 'pedido=abc', 'pedido=-1']) {
      const res = await app.inject({ method: 'GET', url: `/painel/pedidos?${q}`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('role="dialog"');
    }
    expect((await app.inject({ method: 'GET', url: '/painel/pedidos/999/detalhe', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/painel/pedidos/1/detalhe' })).headers.location).toBe('/login');
  });

  test('ação feita no painel lateral volta para ele; só o valor "detalhe" vale', async () => {
    const { app, db, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, pedidoPadrao);
    const cookie = await login(app);
    const a = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'saiu', de: 'detalhe' }) });
    expect(a.headers.location).toBe('/painel/pedidos?pedido=1');
    expect(getOrder(db, 1)?.status).toBe('saiu');
    const b = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'retirado', de: 'detalhe' }) });
    expect(b.headers.location).toBe('/painel/pedidos?pedido=1&erro=transicao');
    const c = await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'entregue', de: 'https://evil.example' }) });
    expect(c.headers.location).toBe('/painel/pedidos');
  });

  test('painel lateral: Pix antecipado avisa para conferir, e concluído não oferece ações', async () => {
    const { app, orders, cliente } = await setupPanel();
    await orders.create(cliente.id, { ...pedidoPadrao, pagamento: 'pix_antecipado' });
    const cookie = await login(app);
    const aberto = (await app.inject({ method: 'GET', url: '/painel/pedidos/1/detalhe', headers: { cookie } })).body;
    expect(aberto).toContain('confira o comprovante');
    expect(aberto).toContain('Cancelar pedido');
    await app.inject({ method: 'POST', url: '/painel/pedidos/1/status', ...form(cookie, { status: 'cancelado' }) });
    const fim = (await app.inject({ method: 'GET', url: '/painel/pedidos/1/detalhe', headers: { cookie } })).body;
    expect(fim).toContain('Pedido cancelado');
    expect(fim).not.toContain('Cancelar pedido');
  });
});
