import { describe, expect, test, vi } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings, type StoreSettings } from '../../src/store/settings.js';
import { upsertCustomerByPhone, updateCustomer, type Customer } from '../../src/store/customers.js';
import { insertOrder, orderByMessage, orderRecipients, type Order } from '../../src/store/orders.js';
import { createWhatsAppDispatcher, formatOrderForStaff } from '../../src/orders/dispatcher.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const t = new Date('2026-11-02T13:00:00Z');
const clock = () => t;
const DONO = '5586999990000';
const JOAO = '5586911110000';
const PEDRO = '5586922220000';

const settings: StoreSettings = {
  ...DEFAULT_SETTINGS,
  precoRecargaCentavos: 11500,
  precoCompletoCentavos: 32000,
  bairros: ['Centro'],
  pagamentos: ['dinheiro', 'cartao', 'pix_entrega', 'pix_antecipado', 'gas_do_povo'],
  chavePix: 'cnpj 00.000.000/0001-00',
  telefoneDono: DONO,
  entregadores: [
    { nome: 'João', telefone: JOAO },
    { nome: 'Pedro', telefone: PEDRO },
  ],
  destinoPedidos: 'entregadores',
  gasDoPovo: { aceita: true, modalidade: 'entrega', taxaEntregaCentavos: 500 },
};

const customer: Customer = {
  id: 1,
  telefone: '5586988887777',
  nome: 'Maria Souza',
  endereco: null,
  lembretesDesativados: false,
  botPausadoAte: null,
  ultimaMensagemEm: null,
  ultimoLembreteEm: null,
  criadoEm: t.toISOString(),
};

function order(over: Partial<Order> = {}): Order {
  return {
    id: 142,
    clienteId: 1,
    tipo: 'entrega',
    quantidade: 1,
    modo: 'troca',
    pagamento: 'dinheiro',
    trocoParaCentavos: 20000,
    endereco: { rua: 'Rua das Flores', numero: '120', complemento: 'casa 2', referencia: 'portão azul', bairro: 'Centro' },
    unitarioCentavos: 11500,
    cascoCentavos: 0,
    taxaEntregaCentavos: 0,
    totalCentavos: 11500,
    status: 'recebido',
    entregadorTelefone: null,
    precisaRevisao: false,
    criadoEm: t.toISOString(),
    enviadoEm: null,
    saiuEm: null,
    finalizadoEm: null,
    ...over,
  };
}

describe('formatOrderForStaff', () => {
  test('layout do mockup para entrega em dinheiro', () => {
    expect(formatOrderForStaff(order(), customer, settings)).toBe(
      [
        '🆕 PEDIDO #142',
        '1x P13 troca · R$ 115,00',
        '💵 Dinheiro – troco p/ R$ 200,00',
        '👤 Maria Souza · 5586988887777',
        '📍 Rua das Flores, 120 – casa 2 (portão azul) – Centro',
        'Responda esta mensagem com: saiu · entregue · problema',
      ].join('\n'),
    );
  });

  test('pix antecipado e gás do povo aparecem na mensagem', () => {
    const pix = formatOrderForStaff(order({ pagamento: 'pix_antecipado', trocoParaCentavos: null }), customer, settings);
    expect(pix).toContain('⚠️ PIX ANTECIPADO – CONFERIR');
    const gdp = formatOrderForStaff(
      order({ pagamento: 'gas_do_povo', trocoParaCentavos: null, unitarioCentavos: 0, taxaEntregaCentavos: 500, totalCentavos: 500 }),
      customer,
      settings,
    );
    expect(gdp).toContain('🔵 GÁS DO POVO – levar a Azulzinha');
    expect(gdp).toContain('1x P13 troca · R$ 5,00');
  });

  test('outras formas de pagamento, revisão, completo e cliente sem nome', () => {
    const txt = formatOrderForStaff(
      order({ pagamento: 'cartao', trocoParaCentavos: null, quantidade: 4, modo: 'completo', totalCentavos: 128000, precisaRevisao: true, endereco: { rua: 'Rua B', numero: '20', bairro: 'Centro' } }),
      { ...customer, nome: null },
      settings,
    );
    expect(txt.split('\n')).toEqual([
      '🆕 PEDIDO #142',
      '4x P13 completo · R$ 1.280,00',
      '💳 Cartão',
      '⚠️ REVISAR: 4 botijões',
      '👤 5586988887777',
      '📍 Rua B, 20 – Centro',
      'Responda esta mensagem com: saiu · entregue · problema',
    ]);
    expect(formatOrderForStaff(order({ pagamento: 'pix_entrega', trocoParaCentavos: null }), customer, settings)).toContain('\nPix na entrega\n');
    expect(formatOrderForStaff(order({ trocoParaCentavos: null }), customer, settings)).toContain('💵 Dinheiro – sem troco');
  });

  test('retirada', () => {
    const txt = formatOrderForStaff(
      order({ tipo: 'retirada', pagamento: 'gas_do_povo', endereco: null, trocoParaCentavos: null, totalCentavos: 0 }),
      customer,
      settings,
    );
    expect(txt).toContain('📍 RETIRADA NA LOJA');
    expect(txt.endsWith('Marque "retirado" no painel')).toBe(true);
    expect(txt).not.toContain('Responda esta mensagem');
  });
});

function setup(over: Partial<StoreSettings> = {}, opts: { templatePedido?: string; windows?: boolean } = {}) {
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  updateSettings(db, { ...settings, ...over });
  const c = updateCustomer(db, upsertCustomerByPhone(db, customer.telefone, t).id, { nome: 'Maria Souza' });
  if (opts.windows !== false) for (const p of [DONO, JOAO, PEDRO]) outbox.registerInbound(p, t);
  const o = insertOrder(db, { ...order(), id: undefined } as unknown as Omit<Order, 'id'>);
  const dispatcher = createWhatsAppDispatcher({
    db,
    outbox,
    settings: () => getSettings(db),
    ...(opts.templatePedido ? { templatePedido: opts.templatePedido } : {}),
  });
  return { db, fake, dispatcher, c, o };
}

const bodies = (fake: FakeWhatsApp) => fake.sent.map((m) => (m.kind === 'text' ? m.body : ''));

describe('createWhatsAppDispatcher', () => {
  test('novo vai a cada entregador e registra os wamids', async () => {
    const { db, fake, dispatcher, c, o } = setup();
    await dispatcher.novo(o, c);
    expect(fake.sent.map((m) => m.to)).toEqual([JOAO, PEDRO]);
    expect(bodies(fake).every((b) => b.startsWith(`🆕 PEDIDO #${o.id}`))).toBe(true);
    expect(orderByMessage(db, 'wamid.1')?.id).toBe(o.id);
    expect(orderByMessage(db, 'wamid.2')?.id).toBe(o.id);
    expect(orderRecipients(db, o.id)).toEqual([JOAO, PEDRO]);
  });

  test('destino dono, ou sem entregadores, vai só ao dono', async () => {
    const a = setup({ destinoPedidos: 'dono' });
    await a.dispatcher.novo(a.o, a.c);
    expect(a.fake.sent.map((m) => m.to)).toEqual([DONO]);
    const b = setup({ entregadores: [] });
    await b.dispatcher.novo(b.o, b.c);
    expect(b.fake.sent.map((m) => m.to)).toEqual([DONO]);
  });

  test('falha num destinatário não impede os outros e não registra o que falhou', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, dispatcher, c, o } = setup();
    fake.failNext(new Error('boom'));
    await dispatcher.novo(o, c);
    expect(fake.sent.map((m) => m.to)).toEqual([PEDRO]);
    expect(orderRecipients(db, o.id)).toEqual([PEDRO]);
    expect(spy).toHaveBeenCalledWith('despacho: falha ao enviar o pedido', o.id, 'erro_api');
    spy.mockRestore();
  });

  test('fora da janela usa o modelo com o pedido em uma linha', async () => {
    const { fake, dispatcher, c, o } = setup({}, { templatePedido: 'novo_pedido', windows: false });
    await dispatcher.novo(o, c);
    expect(fake.sent).toHaveLength(2);
    const m = fake.sent[0]!;
    expect(m.kind).toBe('template');
    if (m.kind !== 'template') return;
    expect(m.name).toBe('novo_pedido');
    expect(m.params).toHaveLength(1);
    expect(m.params[0]).not.toMatch(/\n/);
    expect(m.params[0]).toContain(`PEDIDO #${o.id}`);
    expect(m.params[0]).toContain('Rua das Flores, 120');
  });

  test('correção e cancelamento vão para quem recebeu o pedido', async () => {
    const { db, fake, dispatcher, c, o } = setup();
    await dispatcher.novo(o, c);
    // Mudou a configuração depois do envio: a correção ainda vai para quem tem o pedido.
    updateSettings(db, { ...getSettings(db), destinoPedidos: 'dono' });
    await dispatcher.correcao({ ...o, trocoParaCentavos: 5000 }, c, 'troco agora para R$ 50,00');
    const corr = fake.sent.slice(2);
    expect(corr.map((m) => m.to)).toEqual([JOAO, PEDRO]);
    const body = (corr[0] as { body: string }).body;
    expect(body.startsWith(`✏️ CORREÇÃO DO PEDIDO #${o.id}: troco agora para R$ 50,00\n1x P13 troca · R$ 115,00\n`)).toBe(true);
    expect(body).not.toContain('🆕');
    expect(body).toContain('troco p/ R$ 50,00');
    await dispatcher.cancelamento(o, c);
    expect(fake.sent.slice(4).map((m) => [m.to, (m as { body: string }).body])).toEqual([
      [JOAO, `❌ PEDIDO #${o.id} CANCELADO`],
      [PEDRO, `❌ PEDIDO #${o.id} CANCELADO`],
    ]);
  });

  test('avisoEntregador vai ao entregador do pedido ou, sem ele, a todos os destinatários', async () => {
    const { fake, dispatcher, c, o } = setup();
    await dispatcher.novo(o, c);
    await dispatcher.avisoEntregador(o, 'aviso 1');
    expect(fake.sent.slice(2).map((m) => m.to)).toEqual([JOAO, PEDRO]);
    await dispatcher.avisoEntregador({ ...o, entregadorTelefone: PEDRO }, 'aviso 2');
    expect(fake.sent.slice(4).map((m) => [m.to, (m as { body: string }).body])).toEqual([[PEDRO, 'aviso 2']]);
  });
});
