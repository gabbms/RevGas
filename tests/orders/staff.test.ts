import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { createAlertService } from '../../src/alerts/service.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings, type StoreSettings } from '../../src/store/settings.js';
import { upsertCustomerByPhone, updateCustomer } from '../../src/store/customers.js';
import { getOrder } from '../../src/store/orders.js';
import { createWhatsAppDispatcher } from '../../src/orders/dispatcher.js';
import { createOrderService } from '../../src/orders/service.js';
import { createStaffHandler } from '../../src/orders/staff.js';
import type { OrderRequest } from '../../src/domain/order-validation.js';
import type { InboundContent, InboundEvent } from '../../src/whatsapp/webhook.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const T = new Date('2026-11-02T13:00:00Z');
const clock = () => T;
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
  telefoneDono: DONO,
  entregadores: [
    { nome: 'João', telefone: JOAO },
    { nome: 'Pedro', telefone: PEDRO },
  ],
  destinoPedidos: 'entregadores',
  gasDoPovo: { aceita: true, modalidade: 'retirada', taxaEntregaCentavos: 0 },
};

const req: OrderRequest = {
  quantidade: 1,
  modo: 'troca',
  pagamento: 'cartao',
  endereco: { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' },
};
const retiradaReq: OrderRequest = { quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo' };

function setup() {
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  updateSettings(db, base);
  const settings = () => getSettings(db);
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, CLIENTE, T).id, { nome: 'Maria' });
  for (const p of [DONO, JOAO, PEDRO, CLIENTE]) outbox.registerInbound(p, T);
  const alerts = createAlertService({ db, outbox, settings, publicUrl: 'https://x', clock });
  const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
  const orders = createOrderService({ db, dispatcher, alerts, outbox, settings, clock });
  const handle = createStaffHandler({ db, orders, alerts, outbox, settings });
  let n = 0;
  const say = (de: string, conteudo: InboundContent | string, respostaA?: string) =>
    handle({
      wamid: `in.${++n}`,
      de,
      em: T,
      ...(respostaA ? { respostaA } : {}),
      conteudo: typeof conteudo === 'string' ? { tipo: 'texto', texto: conteudo } : conteudo,
    } satisfies InboundEvent);
  const create = async (r: OrderRequest = req) => {
    const res = await orders.create(cliente.id, r);
    if (!res.ok) throw new Error(res.erros.join('; '));
    return res.order;
  };
  const last = (to: string) => {
    const m = fake.sent.filter((x) => x.to === to).at(-1);
    return m && m.kind === 'text' ? m.body : undefined;
  };
  const wamidOf = (orderId: number, telefone: string) =>
    (db.prepare('SELECT wamid FROM order_messages WHERE order_id = ? AND telefone = ?').get(orderId, telefone) as { wamid: string }).wamid;
  return { db, fake, alerts, orders, cliente, say, create, last, wamidOf };
}

const ORIENTACAO = 'Responda (deslizando) a mensagem do pedido com: saiu, entregue ou problema.';

describe('createStaffHandler', () => {
  test('resposta citando a mensagem atualiza o pedido certo', async () => {
    const { db, fake, say, create, last, wamidOf } = setup();
    const a = await create();
    const b = await create();
    await say(JOAO, 'Saindo agora', wamidOf(b.id, JOAO));
    expect(getOrder(db, b.id)).toMatchObject({ status: 'saiu', entregadorTelefone: JOAO });
    expect(getOrder(db, a.id)!.status).toBe('recebido');
    expect(last(JOAO)).toBe('👍 #2 saiu com João. Cliente avisado.');
    expect(last(CLIENTE)).toContain('saiu para entrega com João');
    expect(fake.sent.at(-1)!.to).toBe(JOAO);
  });

  test('sem citação e com 1 pedido ativo usa esse pedido; entregue avisa', async () => {
    const { db, say, create, last } = setup();
    const o = await create();
    await say(PEDRO, 'entregue');
    expect(getOrder(db, o.id)!.status).toBe('entregue');
    expect(last(PEDRO)).toBe('✅ #1 entregue.');
  });

  test('sem citação e 2 pedidos ativos pede para citar', async () => {
    const { db, say, create, last } = setup();
    await create();
    await create();
    await say(JOAO, 'saiu');
    expect(getOrder(db, 1)!.status).toBe('recebido');
    expect(getOrder(db, 2)!.status).toBe('recebido');
    expect(last(JOAO)).toBe(ORIENTACAO);
  });

  test('sem pedido ativo e texto sem sentido recebem a orientação', async () => {
    const { say, create, last } = setup();
    await say(JOAO, 'saiu');
    expect(last(JOAO)).toBe(ORIENTACAO);
    await create();
    await say(PEDRO, 'bom dia');
    expect(last(PEDRO)).toBe(ORIENTACAO);
  });

  test('áudio e imagem recebem a orientação', async () => {
    const { db, say, create, last } = setup();
    await create();
    await say(JOAO, { tipo: 'audio', mediaId: 'm1', mime: 'audio/ogg' });
    expect(last(JOAO)).toBe(ORIENTACAO);
    await say(JOAO, { tipo: 'imagem', mediaId: 'm2', mime: 'image/jpeg' });
    expect(last(JOAO)).toBe(ORIENTACAO);
    expect(getOrder(db, 1)!.status).toBe('recebido');
  });

  test('botão também vale', async () => {
    const { db, say, create } = setup();
    await create();
    await say(JOAO, { tipo: 'botao', texto: 'Saiu' });
    expect(getOrder(db, 1)!.status).toBe('saiu');
  });

  test('problema gera alerta e avisa o dono', async () => {
    const { db, fake, alerts, say, create, last, cliente } = setup();
    const o = await create();
    await say(JOAO, 'cliente não atende');
    const open = alerts.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ pedidoId: o.id, clienteId: cliente.id, motivo: 'Problema na entrega', resumo: 'cliente não atende' });
    expect(last(JOAO)).toBe('Avisei o dono sobre o #1.');
    expect(fake.sent.some((m) => m.to === DONO && m.kind === 'text' && m.body.includes('Problema na entrega'))).toBe(true);
    expect(getOrder(db, o.id)!.status).toBe('recebido');
  });

  test('dono que não é entregador aparece como "você"', async () => {
    const { db, say, create, last } = setup();
    const o = await create(retiradaReq);
    // Retirada vai só ao dono; "saiu" não é transição válida para retirada.
    await say(DONO, 'saiu');
    expect(last(DONO)).toBe('Pedido #1 está recebido.');
    expect(getOrder(db, o.id)!.status).toBe('recebido');
  });

  test('"você" quando o telefone que saiu não está na lista', async () => {
    const { db, say, create, last } = setup();
    const o = await create();
    updateSettings(db, { ...base, entregadores: [{ nome: 'João', telefone: JOAO }] });
    // Pedro recebeu o pedido, mas já não consta na lista.
    await say(PEDRO, 'saiu');
    expect(last(PEDRO)).toBe(`👍 #${o.id} saiu com você. Cliente avisado.`);
  });

  test('retirada: entregue vira retirado', async () => {
    const { db, say, create, last } = setup();
    const o = await create(retiradaReq);
    await say(DONO, 'entregue');
    expect(getOrder(db, o.id)!.status).toBe('retirado');
    expect(last(DONO)).toBe('✅ #1 entregue.');
  });

  test('pedido em status final responde o status sem alterar', async () => {
    const { db, orders, say, create, last, wamidOf } = setup();
    const o = await create();
    const wamid = wamidOf(o.id, JOAO);
    await orders.setStatus(o.id, 'entregue');
    await say(JOAO, 'saiu', wamid);
    expect(last(JOAO)).toBe('Pedido #1 está entregue.');
    expect(getOrder(db, o.id)).toMatchObject({ status: 'entregue', entregadorTelefone: null });
  });

  test('transição inválida (saiu duas vezes) responde o status atual', async () => {
    const { say, create, last } = setup();
    await create();
    await say(JOAO, 'saiu');
    await say(JOAO, 'saiu');
    expect(last(JOAO)).toBe('Pedido #1 está saiu.');
  });
});
