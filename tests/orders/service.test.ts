import { describe, expect, test, vi } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { createAlertService } from '../../src/alerts/service.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings, type StoreSettings } from '../../src/store/settings.js';
import { upsertCustomerByPhone, updateCustomer } from '../../src/store/customers.js';
import { recentMessages } from '../../src/store/messages.js';
import {
  activeOrdersSentTo,
  deliveredOrderDates,
  getOrder,
  listOrdersByLocalDay,
  orderByMessage,
  orderRecipients,
} from '../../src/store/orders.js';
import { createWhatsAppDispatcher } from '../../src/orders/dispatcher.js';
import { createOrderService, InvalidTransitionError } from '../../src/orders/service.js';
import type { OrderRequest } from '../../src/domain/order-validation.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');
const DOMINGO_21H30 = new Date('2026-11-02T00:30:00Z');
let t = SEGUNDA_10H;
const clock = () => t;

const DONO = '5586999990000';
const JOAO = '5586911110000';
const PEDRO = '5586922220000';
const CLIENTE = '5586988887777';

const base: StoreSettings = {
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

const req: OrderRequest = {
  quantidade: 1,
  modo: 'troca',
  pagamento: 'dinheiro',
  trocoParaCentavos: 20000,
  endereco: { rua: 'Rua das Flores', numero: '120', complemento: 'casa 2', bairro: 'Centro' },
};

function setup(over: Partial<StoreSettings> = {}, at: Date = SEGUNDA_10H) {
  t = at;
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  updateSettings(db, { ...base, ...over });
  const settings = () => getSettings(db);
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, CLIENTE, t).id, { nome: 'Maria' });
  for (const p of [DONO, JOAO, PEDRO, CLIENTE]) outbox.registerInbound(p, t);
  const alerts = createAlertService({ db, outbox, settings, publicUrl: 'https://loja.exemplo', clock });
  const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
  const svc = createOrderService({ db, dispatcher, alerts, outbox, settings, clock });
  return { db, fake, alerts, svc, cliente, dispatcher };
}

const bodiesTo = (fake: FakeWhatsApp, to: string) =>
  fake.sent.filter((m) => m.to === to).map((m) => (m.kind === 'text' ? m.body : ''));

async function created(svc: ReturnType<typeof setup>['svc'], clienteId: number, r: OrderRequest = req) {
  const res = await svc.create(clienteId, r);
  if (!res.ok) throw new Error(res.erros.join('; '));
  return res.order;
}

describe('create', () => {
  test('create envia a cada entregador e registra wamids', async () => {
    const { db, fake, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    expect(o).toMatchObject({
      id: 1,
      status: 'recebido',
      tipo: 'entrega',
      totalCentavos: 11500,
      unitarioCentavos: 11500,
      trocoParaCentavos: 20000,
      enviadoEm: SEGUNDA_10H.toISOString(),
      criadoEm: SEGUNDA_10H.toISOString(),
    });
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent.map((m) => m.to)).toEqual([JOAO, PEDRO]);
    for (const m of fake.sent) {
      expect(m.kind).toBe('text');
      expect((m as { body: string }).body).toContain('PEDIDO #1');
      expect((m as { body: string }).body).toContain('Responda esta mensagem');
    }
    expect(orderByMessage(db, 'wamid.1')?.id).toBe(1);
    expect(getOrder(db, 1)?.enviadoEm).toBe(SEGUNDA_10H.toISOString());
  });

  test('revalida e devolve os erros sem criar nada', async () => {
    const { db, fake, svc, cliente } = setup();
    const res = await svc.create(cliente.id, { ...req, endereco: { rua: 'Rua X', numero: '1', bairro: 'Longe' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.erros.join(' ')).toContain('Longe');
    expect(fake.sent).toHaveLength(0);
    expect(getOrder(db, 1)).toBeNull();
  });

  test('troco é ignorado fora do dinheiro', async () => {
    const { svc, cliente } = setup();
    const o = await created(svc, cliente.id, { ...req, pagamento: 'cartao' });
    expect(o.trocoParaCentavos).toBeNull();
  });

  test('fora do horário fica agendado e não envia', async () => {
    const { fake, svc, cliente } = setup({}, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    expect(o.status).toBe('agendado');
    expect(o.enviadoEm).toBeNull();
    expect(fake.sent).toEqual([]);
  });

  test('releaseScheduled envia ao abrir', async () => {
    const { db, fake, svc, cliente } = setup({}, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    expect(await svc.releaseScheduled(DOMINGO_21H30)).toBe(0);
    expect(fake.sent).toHaveLength(0);
    t = SEGUNDA_10H;
    expect(await svc.releaseScheduled(SEGUNDA_10H)).toBe(1);
    const after = getOrder(db, o.id)!;
    expect(after.status).toBe('recebido');
    expect(after.enviadoEm).toBe(SEGUNDA_10H.toISOString());
    expect(fake.sent.map((m) => m.to)).toEqual([JOAO, PEDRO]);
    expect(await svc.releaseScheduled(SEGUNDA_10H)).toBe(0);
    expect(fake.sent).toHaveLength(2);
  });

  test('retirada vai só para o dono', async () => {
    const { fake, svc, cliente } = setup({ gasDoPovo: { aceita: true, modalidade: 'retirada', taxaEntregaCentavos: 0 } });
    const o = await created(svc, cliente.id, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' });
    expect(o).toMatchObject({ tipo: 'retirada', status: 'recebido', endereco: null, totalCentavos: 0 });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe(DONO);
    expect((fake.sent[0] as { body: string }).body).toContain('RETIRADA NA LOJA');
  });

  test('4 botijões gera alerta', async () => {
    const { alerts, svc, cliente } = setup();
    const o = await created(svc, cliente.id, { ...req, quantidade: 4, trocoParaCentavos: undefined });
    expect(o.precisaRevisao).toBe(true);
    const open = alerts.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.motivo).toContain('4 botijões');
    expect(open[0]!.pedidoId).toBe(o.id);
  });

  test('se nenhum envio der certo, alerta e o pedido fica recebido sem enviadoEm', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, alerts, svc, cliente } = setup();
    const sendText = fake.sendText.bind(fake);
    fake.sendText = async (to, body) => {
      if (to === JOAO || to === PEDRO) throw new Error('boom');
      return sendText(to, body);
    };
    const o = await created(svc, cliente.id);
    expect(orderRecipients(db, o.id)).toEqual([]);
    expect(getOrder(db, o.id)).toMatchObject({ status: 'recebido', enviadoEm: null });
    expect(alerts.listOpen().map((a) => a.motivo)).toEqual([`Pedido #${o.id} não chegou aos entregadores`]);
    // O alerta chegou ao dono.
    expect(bodiesTo(fake, DONO)[0]).toContain(`Pedido #${o.id} não chegou aos entregadores`);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('sem destinatário configurado também alerta', async () => {
    const { db, fake, alerts, svc, cliente } = setup({ destinoPedidos: 'dono', telefoneDono: '' });
    const o = await created(svc, cliente.id);
    expect(fake.sent).toHaveLength(0);
    expect(getOrder(db, o.id)).toMatchObject({ status: 'recebido', enviadoEm: null });
    expect(alerts.listOpen().map((a) => a.motivo)).toEqual([`Pedido #${o.id} não chegou aos entregadores`]);
  });

  test('releaseScheduled também alerta quando ninguém recebe', async () => {
    const { db, alerts, svc, cliente } = setup({}, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    updateSettings(db, { ...getSettings(db), destinoPedidos: 'dono', telefoneDono: '' });
    t = SEGUNDA_10H;
    expect(await svc.releaseScheduled(SEGUNDA_10H)).toBe(1);
    expect(getOrder(db, o.id)).toMatchObject({ status: 'recebido', enviadoEm: null });
    expect(alerts.listOpen().map((a) => a.motivo)).toEqual([`Pedido #${o.id} não chegou aos entregadores`]);
  });

  test('correção que não chega a ninguém gera alerta', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, alerts, svc, cliente } = setup();
    const o = await created(svc, cliente.id, { ...req, trocoParaCentavos: undefined });
    const sendText = fake.sendText.bind(fake);
    fake.sendText = async (to, body) => {
      if (to === JOAO || to === PEDRO) throw new Error('boom');
      return sendText(to, body);
    };
    expect((await svc.change(o.id, { quantidade: 2 })).ok).toBe(true);
    expect(alerts.listOpen().map((a) => a.motivo)).toEqual([`Correção do pedido #${o.id} não chegou aos entregadores`]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('falha parcial não gera alerta', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, alerts, svc, cliente } = setup();
    fake.failNext(new Error('boom'));
    const o = await created(svc, cliente.id);
    expect(orderRecipients(db, o.id)).toEqual([PEDRO]);
    expect(alerts.listOpen()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('change', () => {
  test('change em recebido manda correção', async () => {
    // Preço baixo para que o troco de R$ 50,00 seja válido.
    const { db, fake, svc, cliente } = setup({ precoRecargaCentavos: 4500 });
    const o = await created(svc, cliente.id);
    const res = await svc.change(o.id, { trocoParaCentavos: 5000, endereco: { rua: 'Rua B', numero: '20', bairro: 'Centro' } });
    expect(res.ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ trocoParaCentavos: 5000, endereco: { rua: 'Rua B', numero: '20', bairro: 'Centro' } });
    const corr = bodiesTo(fake, JOAO)[1]!;
    expect(corr).toContain('CORREÇÃO DO PEDIDO #1');
    expect(corr.split('\n')[0]).toBe('✏️ CORREÇÃO DO PEDIDO #1: troco agora para R$ 50,00; endereço: Rua B, 20 – Centro');
    expect(corr).toContain('troco p/ R$ 50,00');
    expect(bodiesTo(fake, PEDRO)).toHaveLength(2);
  });

  test('recalcula os valores e revalida o merge', async () => {
    const { db, svc, cliente } = setup();
    const o = await created(svc, cliente.id, { ...req, trocoParaCentavos: undefined });
    const res = await svc.change(o.id, { quantidade: 2, modo: 'completo' });
    expect(res.ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ quantidade: 2, modo: 'completo', unitarioCentavos: 32000, totalCentavos: 64000 });
    const bad = await svc.change(o.id, { pagamento: 'dinheiro', trocoParaCentavos: 1000 });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.ok === false && 'erros' in bad && bad.erros.join(' ')).toContain('troco');
    expect(getOrder(db, o.id)!.trocoParaCentavos).toBeNull();
  });

  test('change em agendado não manda correção', async () => {
    const { db, fake, svc, cliente } = setup({}, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    const res = await svc.change(o.id, { quantidade: 2, trocoParaCentavos: 50000 });
    expect(res.ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ status: 'agendado', quantidade: 2, totalCentavos: 23000 });
    expect(fake.sent).toHaveLength(0);
  });

  test('change em saiu recusa e alerta', async () => {
    const { db, fake, alerts, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    await svc.setStatus(o.id, 'saiu', JOAO);
    const before = fake.sent.length;
    const res = await svc.change(o.id, { trocoParaCentavos: 5000 });
    expect(res).toEqual({ ok: false, motivo: 'ja_saiu' });
    expect(alerts.listOpen()).toHaveLength(1);
    expect(getOrder(db, o.id)!.trocoParaCentavos).toBe(20000);
    const novos = fake.sent.slice(before);
    // O alerta ao dono e o aviso só ao entregador que saiu.
    expect(novos.map((m) => m.to).sort()).toEqual([DONO, JOAO].sort());
    expect(bodiesTo(fake, JOAO).at(-1)).toBe(
      '⚠️ PEDIDO #1: o cliente pediu uma alteração (troco agora para R$ 50,00), mas o pedido já saiu. O dono vai falar com você.',
    );
    expect(alerts.listOpen()[0]!.resumo).toBe('Pediu para mudar: troco agora para R$ 50,00.');
  });

  test('change em finalizado recusa sem alerta', async () => {
    const { alerts, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    await svc.setStatus(o.id, 'entregue');
    expect(await svc.change(o.id, { quantidade: 2 })).toEqual({ ok: false, motivo: 'finalizado' });
    expect(alerts.listOpen()).toHaveLength(0);
  });
});

describe('change que troca o tipo', () => {
  const retirada = { gasDoPovo: { aceita: true, modalidade: 'retirada' as const, taxaEntregaCentavos: 0 } };

  test('retirada → entrega: cancela com o dono e manda novo aos entregadores', async () => {
    const { db, fake, svc, cliente } = setup(retirada);
    const o = await created(svc, cliente.id, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' });
    expect(orderRecipients(db, o.id)).toEqual([DONO]);
    const res = await svc.change(o.id, { pagamento: 'dinheiro', endereco: req.endereco! });
    expect(res.ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ tipo: 'entrega', status: 'recebido', totalCentavos: 11500, enviadoEm: SEGUNDA_10H.toISOString() });
    expect(bodiesTo(fake, DONO).slice(1)).toEqual(['❌ PEDIDO #1 CANCELADO']);
    for (const p of [JOAO, PEDRO]) {
      const b = bodiesTo(fake, p);
      expect(b).toHaveLength(1);
      expect(b[0]!.startsWith('🆕 PEDIDO #1\n')).toBe(true);
      expect(b[0]).toContain('📍 Rua das Flores, 120 – casa 2 – Centro');
      expect(b[0]).toContain('Responda esta mensagem com');
    }
    expect(fake.sent.some((m) => m.kind === 'text' && m.body.includes('CORREÇÃO'))).toBe(false);
    expect(orderRecipients(db, o.id)).toEqual([JOAO, PEDRO]);
    expect(activeOrdersSentTo(db, DONO)).toEqual([]);
  });

  test('entrega → retirada: cancela com os entregadores e manda novo ao dono', async () => {
    const { db, fake, svc, cliente } = setup(retirada);
    const o = await created(svc, cliente.id);
    const res = await svc.change(o.id, { pagamento: 'gas_do_povo' });
    expect(res.ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ tipo: 'retirada', endereco: null, trocoParaCentavos: null, totalCentavos: 0 });
    for (const p of [JOAO, PEDRO]) expect(bodiesTo(fake, p).slice(1)).toEqual(['❌ PEDIDO #1 CANCELADO']);
    const dono = bodiesTo(fake, DONO);
    expect(dono).toHaveLength(1);
    expect(dono[0]!.startsWith('🆕 PEDIDO #1\n')).toBe(true);
    expect(dono[0]).toContain('📍 RETIRADA NA LOJA');
    expect(dono[0]).toContain('🔵 GÁS DO POVO – levar a Azulzinha');
    expect(fake.sent.some((m) => m.kind === 'text' && m.body.includes('CORREÇÃO'))).toBe(false);
    expect(orderRecipients(db, o.id)).toEqual([DONO]);
    expect(activeOrdersSentTo(db, JOAO)).toEqual([]);
  });

  test('troca de tipo em que o novo envio não chega a ninguém alerta', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, alerts, svc, cliente } = setup(retirada);
    const o = await created(svc, cliente.id, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' });
    const sendText = fake.sendText.bind(fake);
    fake.sendText = async (to, body) => {
      if (to === JOAO || to === PEDRO) throw new Error('boom');
      return sendText(to, body);
    };
    expect((await svc.change(o.id, { pagamento: 'cartao', endereco: req.endereco! })).ok).toBe(true);
    expect(getOrder(db, o.id)).toMatchObject({ tipo: 'entrega', status: 'recebido', enviadoEm: null });
    expect(orderRecipients(db, o.id)).toEqual([]);
    expect(alerts.listOpen().map((a) => a.motivo)).toEqual([`Pedido #${o.id} não chegou aos entregadores`]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('troca de tipo em agendado não manda nada', async () => {
    const { db, fake, svc, cliente } = setup(retirada, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    expect(o.status).toBe('agendado');
    expect((await svc.change(o.id, { pagamento: 'gas_do_povo' })).ok).toBe(true);
    expect(getOrder(db, o.id)!.tipo).toBe('retirada');
    expect(fake.sent).toHaveLength(0);
  });
});

describe('aviso ao entregador em saiu', () => {
  test('falha no avisoEntregador não lança para quem chamou', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { alerts, svc, cliente, dispatcher } = setup();
    const o = await created(svc, cliente.id);
    await svc.setStatus(o.id, 'saiu', JOAO);
    dispatcher.avisoEntregador = async () => {
      throw new Error('boom');
    };
    expect(await svc.change(o.id, { quantidade: 2 })).toEqual({ ok: false, motivo: 'ja_saiu' });
    expect(await svc.cancel(o.id, 'cliente')).toEqual({ ok: false, motivo: 'ja_saiu' });
    expect(alerts.listOpen()).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('cancel', () => {
  test('cliente cancela recebido e os entregadores recebem o cancelamento', async () => {
    const { db, fake, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    expect(await svc.cancel(o.id, 'cliente')).toEqual({ ok: true });
    expect(getOrder(db, o.id)).toMatchObject({ status: 'cancelado', finalizadoEm: SEGUNDA_10H.toISOString() });
    expect(bodiesTo(fake, JOAO).at(-1)).toBe('❌ PEDIDO #1 CANCELADO');
    expect(bodiesTo(fake, PEDRO).at(-1)).toBe('❌ PEDIDO #1 CANCELADO');
    expect(await svc.cancel(o.id, 'dono')).toEqual({ ok: false, motivo: 'finalizado' });
  });

  test('agendado cancelado não manda nada', async () => {
    const { fake, svc, cliente } = setup({}, DOMINGO_21H30);
    const o = await created(svc, cliente.id);
    expect(await svc.cancel(o.id, 'cliente')).toEqual({ ok: true });
    expect(fake.sent).toHaveLength(0);
  });

  test('cliente não cancela em saiu; o dono cancela', async () => {
    const { db, fake, alerts, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    await svc.setStatus(o.id, 'saiu', JOAO);
    expect(await svc.cancel(o.id, 'cliente')).toEqual({ ok: false, motivo: 'ja_saiu' });
    expect(getOrder(db, o.id)!.status).toBe('saiu');
    expect(alerts.listOpen()).toHaveLength(1);
    expect(bodiesTo(fake, JOAO).at(-1)).toContain('cancelar');
    expect(await svc.cancel(o.id, 'dono')).toEqual({ ok: true });
    expect(getOrder(db, o.id)!.status).toBe('cancelado');
    expect(bodiesTo(fake, JOAO).at(-1)).toBe('❌ PEDIDO #1 CANCELADO');
  });
});

describe('setStatus', () => {
  test('saiu avisa cliente com nome do entregador; transição inválida lança', async () => {
    const { db, fake, svc, cliente } = setup();
    const o = await created(svc, cliente.id);
    const saiu = await svc.setStatus(o.id, 'saiu', JOAO);
    expect(saiu).toMatchObject({ status: 'saiu', entregadorTelefone: JOAO, saiuEm: SEGUNDA_10H.toISOString() });
    const aviso = bodiesTo(fake, CLIENTE);
    expect(aviso).toEqual(['🛵 Seu gás saiu para entrega com João! Chega em poucos minutos.']);
    const msgs = recentMessages(db, cliente.id, new Date(0));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ autor: 'bot', tipo: 'texto', texto: aviso[0], wamid: expect.stringMatching(/^wamid\./) });

    const outro = await created(svc, cliente.id);
    await svc.cancel(outro.id, 'dono');
    await expect(svc.setStatus(outro.id, 'entregue')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(svc.setStatus(o.id, 'saiu')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(svc.setStatus(o.id, 'retirado')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  test('entregue avisa o cliente, mesmo com o bot pausado', async () => {
    const { db, fake, svc, cliente } = setup();
    updateCustomer(db, cliente.id, { botPausadoAte: '2099-01-01T00:00:00.000Z' });
    const o = await created(svc, cliente.id);
    const done = await svc.setStatus(o.id, 'entregue');
    expect(done).toMatchObject({ status: 'entregue', finalizadoEm: SEGUNDA_10H.toISOString() });
    expect(bodiesTo(fake, CLIENTE)).toEqual(['✅ Entregue! Obrigado, Maria. Quando precisar de novo, é só chamar aqui.']);
    expect(deliveredOrderDates(db, cliente.id)).toEqual([SEGUNDA_10H]);
  });

  test('saiu sem entregador conhecido e cliente sem nome', async () => {
    const { db, fake, svc } = setup();
    const anon = upsertCustomerByPhone(db, '5586977776666', t);
    createOutbox(db, fake, clock).registerInbound(anon.telefone, t);
    const o = await created(svc, anon.id);
    await svc.setStatus(o.id, 'saiu', '5586933330000');
    await svc.setStatus(o.id, 'entregue');
    expect(bodiesTo(fake, anon.telefone)).toEqual([
      '🛵 Seu gás saiu para entrega! Chega em poucos minutos.',
      '✅ Entregue! Obrigado. Quando precisar de novo, é só chamar aqui.',
    ]);
    expect(getOrder(db, o.id)!.entregadorTelefone).toBe('5586933330000');
  });

  test('aviso que não sai não é gravado como mensagem', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, svc } = setup();
    const anon = upsertCustomerByPhone(db, '5586977776666', t);
    const o = await created(svc, anon.id);
    await svc.setStatus(o.id, 'entregue'); // janela fechada e sem modelo
    expect(bodiesTo(fake, anon.telefone)).toEqual([]);
    expect(recentMessages(db, anon.id, new Date(0))).toHaveLength(0);
    expect(getOrder(db, o.id)!.status).toBe('entregue');
    expect(spy).toHaveBeenCalledWith('pedidos: aviso de status não saiu', o.id, 'fora_da_janela');
    spy.mockRestore();
  });

  test('fora da janela usa o modelo de status com [nome, frase]', async () => {
    t = SEGUNDA_10H;
    const db = openDb(':memory:');
    const fake = new FakeWhatsApp();
    const outbox = createOutbox(db, fake, clock);
    updateSettings(db, base);
    const settings = () => getSettings(db);
    for (const p of [JOAO, PEDRO]) outbox.registerInbound(p, t);
    const alerts = createAlertService({ db, outbox, settings, publicUrl: 'https://x', clock });
    const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
    const svc = createOrderService({ db, dispatcher, alerts, outbox, settings, clock, templateStatus: 'status_pedido' });
    const anon = upsertCustomerByPhone(db, CLIENTE, t);
    const o = await created(svc, anon.id);
    await svc.setStatus(o.id, 'saiu', PEDRO);
    const m = fake.sent.at(-1)!;
    expect(m).toEqual({ to: CLIENTE, kind: 'template', name: 'status_pedido', params: ['cliente', 'seu gás saiu para entrega com Pedro. Chega em poucos minutos.'] });
    expect(recentMessages(db, anon.id, new Date(0))[0]!.texto).toBe('🛵 Seu gás saiu para entrega com Pedro! Chega em poucos minutos.');
  });

  test('retirada vira retirado sem avisar o cliente', async () => {
    const { db, fake, svc, cliente } = setup({ gasDoPovo: { aceita: true, modalidade: 'retirada', taxaEntregaCentavos: 0 } });
    const o = await created(svc, cliente.id, { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' });
    await expect(svc.setStatus(o.id, 'saiu')).rejects.toBeInstanceOf(InvalidTransitionError);
    const r = await svc.setStatus(o.id, 'retirado');
    expect(r).toMatchObject({ status: 'retirado', finalizadoEm: SEGUNDA_10H.toISOString() });
    expect(bodiesTo(fake, CLIENTE)).toEqual([]);
    expect(recentMessages(db, cliente.id, new Date(0))).toHaveLength(0);
  });
});

describe('consultas', () => {
  test('openOrdersFor, activeOrdersSentTo e listOrdersByLocalDay', async () => {
    const { db, svc, cliente } = setup();
    const a = await created(svc, cliente.id);
    const b = await created(svc, cliente.id);
    await svc.setStatus(b.id, 'entregue');
    expect(svc.openOrdersFor(cliente.id).map((o) => o.id)).toEqual([a.id]);
    // Variante sem o 9º dígito também casa.
    expect(activeOrdersSentTo(db, '558611110000').map((o) => o.id)).toEqual([a.id]);
    expect(activeOrdersSentTo(db, DONO)).toEqual([]);
    expect(listOrdersByLocalDay(db, '2026-11-02', 'America/Sao_Paulo').map((o) => o.id)).toEqual([a.id, b.id]);
    expect(listOrdersByLocalDay(db, '2026-11-01', 'America/Sao_Paulo')).toEqual([]);
  });
});
