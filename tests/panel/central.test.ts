import { describe, expect, test } from 'vitest';
import { upsertCustomerByPhone, updateCustomer } from '../../src/store/customers.js';
import { insertMessage } from '../../src/store/messages.js';
import { login, SENHA, setupPanel, SEGUNDA_10H } from './helpers.js';

const end = { rua: 'Rua A', numero: '1', bairro: 'Centro' };
const pedido = { quantidade: 2, modo: 'troca', pagamento: 'dinheiro', endereco: end } as const;
const ms = (d: number) => new Date(SEGUNDA_10H.getTime() + d);
const pagina = async (p: Awaited<ReturnType<typeof setupPanel>>) => {
  const cookie = await login(p.app);
  return (await p.app.inject({ method: 'GET', url: '/painel', headers: { cookie } })).body;
};
const msg = (p: Awaited<ReturnType<typeof setupPanel>>, clienteId: number, autor: 'cliente' | 'bot' | 'dono', d: number) =>
  insertMessage(p.db, { clienteId, autor, tipo: 'texto', texto: 'oi', wamid: null, criadoEm: ms(d).toISOString() });

describe('Central', () => {
  test('exige sessão e é a tela de entrada depois do login', async () => {
    const p = await setupPanel();
    expect((await p.app.inject({ method: 'GET', url: '/painel' })).headers.location).toBe('/login');
    expect((await p.app.inject({ method: 'GET', url: '/painel/central' })).headers.location).toBe('/login');
    const res = await p.app.inject({
      method: 'POST',
      url: '/login',
      payload: `senha=${encodeURIComponent(SENHA)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.headers.location).toBe('/painel');
  });

  test('sem movimento: números zerados, sem valores inventados', async () => {
    const body = await pagina(await setupPanel());
    expect(body).toContain('Hoje, 2 de novembro');
    expect(body).toContain('Tudo em dia.');
    expect(body).toContain('Tudo sob controle');
    expect(body).toContain('Nenhuma venda ainda');
    expect(body).toContain('sem pedidos ainda');
    expect(body).toContain('Nada aconteceu ainda hoje.');
  });

  test('indicadores vêm dos pedidos do dia; cancelado não conta', async () => {
    const p = await setupPanel();
    const a = await p.orders.create(p.cliente.id, pedido);
    const b = await p.orders.create(p.cliente.id, { ...pedido, quantidade: 1 });
    if (!a.ok || !b.ok) throw new Error('pedido inválido');
    await p.orders.cancel(b.order.id, 'dono');
    const body = await pagina(p);
    expect(body).toMatch(/Pedidos hoje<\/div>\s*<div class="stat-value">1</);
    expect(body).toContain('2 botijões');
    expect(body).toContain('R$ 230,00');
    expect(body).toContain('Ticket médio R$ 230,00');
    expect(body).toContain('1 pedido esperando sair');
  });

  test('"Precisa de você": alerta leva à conversa, e pedido esperando leva aos pedidos', async () => {
    const p = await setupPanel();
    await p.alerts.create({ clienteId: p.cliente.id, motivo: 'Cheiro de gás', resumo: 'Cliente preocupado' });
    await p.orders.create(p.cliente.id, pedido);
    const body = await pagina(p);
    expect(body).toContain('Cheiro de gás');
    expect(body).toContain(`href="/painel/conversas/${p.cliente.id}">Responder`);
    expect(body).toContain('href="/painel/pedidos">Ver');
    expect(body).toContain('2 itens');
    expect(body).toContain('1 conversa precisa de você');
  });

  test('pedido além da previsão aparece como alerta', async () => {
    let agora = SEGUNDA_10H;
    const p = await setupPanel('Maria', () => agora);
    await p.orders.create(p.cliente.id, pedido);
    agora = ms(41 * 60_000);
    expect(await pagina(p)).toContain('attention-row is-alert');
  });

  test('assistente: automático conta conversas sem o dono, e o tempo de resposta vem das mensagens', async () => {
    const p = await setupPanel();
    const outro = updateCustomer(p.db, upsertCustomerByPhone(p.db, '5586977776666', SEGUNDA_10H).id, { nome: 'José' });
    msg(p, p.cliente.id, 'cliente', -60_000);
    msg(p, p.cliente.id, 'bot', -56_000);
    msg(p, outro.id, 'cliente', -50_000);
    msg(p, outro.id, 'dono', -40_000);
    const body = await pagina(p);
    expect(body).toContain('>50%<');
    expect(body).toMatch(/Tempo de resposta<\/dt><dd>4 s/);
    expect(body).toMatch(/Conversas hoje<\/dt><dd>2/);
    expect(body).toContain('Atendendo 2 conversas');
    expect(body).toContain('50% resolvidas sem você hoje');
  });

  test('atividade e gráfico usam os pedidos reais', async () => {
    const p = await setupPanel();
    const a = await p.orders.create(p.cliente.id, pedido);
    if (!a.ok) throw new Error('pedido inválido');
    const body = await pagina(p);
    expect(body).toContain(`Pedido #${a.order.id} registrado: Maria, 2× P13 troca`);
    expect(body).toContain('Pico hoje: 10h (1 pedido)');
  });

  test('o fragmento do htmx traz o conteúdo sem a moldura', async () => {
    const p = await setupPanel();
    const cookie = await login(p.app);
    const frag = (await p.app.inject({ method: 'GET', url: '/painel/central', headers: { cookie } })).body;
    expect(frag).toContain('Precisa de você agora');
    expect(frag).not.toContain('<nav');
  });
});
