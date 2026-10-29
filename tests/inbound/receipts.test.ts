import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAlertService } from '../../src/alerts/service.js';
import { openDb } from '../../src/db/connection.js';
import { createContentToText, createReceiptForwarder } from '../../src/inbound/media.js';
import { createWhatsAppDispatcher } from '../../src/orders/dispatcher.js';
import { createOrderService } from '../../src/orders/service.js';
import { deleteCustomerData, updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { createDraft } from '../../src/store/drafts.js';
import { receiptsFor } from '../../src/store/receipts.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../../src/store/settings.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import type { InboundEvent } from '../../src/whatsapp/webhook.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const SEGUNDA_10H = new Date('2026-11-02T13:00:00Z');
const DOMINGO_21H30 = new Date('2026-11-02T00:30:00Z');
const CLIENTE = '5586988887777';
const JOAO = '5586911110000';
const PEDRO = '5586922220000';

afterEach(() => vi.restoreAllMocks());

function setup(at: Date) {
  let t = at;
  const clock = () => t;
  const db = openDb(':memory:');
  updateSettings(db, {
    ...DEFAULT_SETTINGS,
    precoRecargaCentavos: 11500,
    precoCompletoCentavos: 32000,
    bairros: ['Centro'],
    pagamentos: ['dinheiro', 'pix_antecipado'],
    chavePix: 'cnpj 00.000.000/0001-00',
    entregadores: [
      { nome: 'João', telefone: JOAO },
      { nome: 'Pedro', telefone: PEDRO },
    ],
    destinoPedidos: 'entregadores',
  });
  const settings = () => getSettings(db);
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  for (const p of [JOAO, PEDRO, CLIENTE]) outbox.registerInbound(p, t);
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, CLIENTE, t).id, { nome: 'Maria' });
  const alerts = createAlertService({ db, outbox, settings, publicUrl: 'https://loja.exemplo', clock });
  const contentToText = createContentToText({
    db,
    api: fake,
    transcriber: { transcribe: async () => '' },
    outbox,
    alerts,
    clock,
  });
  const forwardPendingReceipts = createReceiptForwarder({ db, api: fake, alerts, clock });
  const dispatcher = createWhatsAppDispatcher({ db, outbox, settings });
  const orders = createOrderService({ db, dispatcher, alerts, outbox, settings, clock, forwardPendingReceipts });
  fake.media.set('m9', { data: Buffer.from('jpg'), mime: 'image/jpeg' });
  const comprovante: InboundEvent = {
    wamid: 'wi9',
    de: CLIENTE,
    em: t,
    conteudo: { tipo: 'imagem', mediaId: 'm9', mime: 'image/jpeg' },
  };
  const pedidoPix = {
    quantidade: 1,
    modo: 'troca' as const,
    pagamento: 'pix_antecipado' as const,
    endereco: { rua: 'Rua das Flores', numero: '120', bairro: 'Centro' },
  };
  const setTime = (d: Date) => {
    t = d;
  };
  return { db, fake, alerts, orders, cliente, contentToText, comprovante, pedidoPix, setTime };
}

const midias = (fake: FakeWhatsApp) => fake.sent.filter((m) => m.kind === 'image' || m.kind === 'document');

describe('comprovante Pix pendente', () => {
  test('comprovante antes do "sim" é repassado quando o pedido é criado', async () => {
    const s = setup(SEGUNDA_10H);
    createDraft(s.db, s.cliente.id, s.pedidoPix, 11500, SEGUNDA_10H);
    await s.contentToText(s.comprovante, s.cliente);
    expect(midias(s.fake)).toEqual([]);

    const r = await s.orders.create(s.cliente.id, s.pedidoPix);
    if (!r.ok) throw new Error(r.erros.join('; '));
    const legenda = `Comprovante Pix do pedido #${r.order.id}`;
    expect(midias(s.fake)).toEqual([
      { to: JOAO, kind: 'image', mediaId: 'media.1', caption: legenda },
      { to: PEDRO, kind: 'image', mediaId: 'media.1', caption: legenda },
    ]);
    // O pedido sai antes do comprovante.
    const primeiraMidia = s.fake.sent.findIndex((m) => m.kind === 'image');
    expect(s.fake.sent.slice(0, primeiraMidia).map((m) => m.kind)).toEqual(['text', 'text']);
    expect(receiptsFor(s.db, s.cliente.id)[0]!.repassadoEm).toBe(SEGUNDA_10H.toISOString());

    // Um segundo pedido Pix não repete o comprovante já repassado.
    await s.orders.create(s.cliente.id, s.pedidoPix);
    expect(midias(s.fake)).toHaveLength(2);
    expect(s.alerts.listOpen()).toEqual([]);
  });

  test('pedido agendado: comprovante é repassado na liberação', async () => {
    const s = setup(DOMINGO_21H30);
    const r = await s.orders.create(s.cliente.id, s.pedidoPix);
    if (!r.ok) throw new Error(r.erros.join('; '));
    expect(r.order.status).toBe('agendado');
    expect((await s.contentToText(s.comprovante, s.cliente))?.texto).toBe(
      '[cliente enviou comprovante Pix; será repassado com o pedido]',
    );
    expect(midias(s.fake)).toEqual([]);

    s.setTime(SEGUNDA_10H);
    expect(await s.orders.releaseScheduled(SEGUNDA_10H)).toBe(1);
    expect(midias(s.fake).map((m) => m.to)).toEqual([JOAO, PEDRO]);
    expect(midias(s.fake)[0]).toMatchObject({ caption: `Comprovante Pix do pedido #${r.order.id}` });
    expect(receiptsFor(s.db, s.cliente.id)[0]!.repassadoEm).toBe(SEGUNDA_10H.toISOString());
  });

  test('todos os sendMedia falham: alerta ao dono', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup(SEGUNDA_10H);
    createDraft(s.db, s.cliente.id, s.pedidoPix, 11500, SEGUNDA_10H);
    await s.contentToText(s.comprovante, s.cliente);
    s.fake.sendMedia = async () => {
      throw new Error('falhou');
    };
    const r = await s.orders.create(s.cliente.id, s.pedidoPix);
    if (!r.ok) throw new Error(r.erros.join('; '));
    expect(r.order.status).toBe('recebido');
    expect(s.alerts.listOpen()).toHaveLength(1);
    expect(s.alerts.listOpen()[0]).toMatchObject({
      motivo: 'Comprovante Pix não repassado',
      pedidoId: r.order.id,
      clienteId: s.cliente.id,
      resumo: 'O cliente mandou comprovante, mas não consegui enviar aos entregadores.',
    });
  });

  test('pedido que não é Pix antecipado não leva o comprovante', async () => {
    const s = setup(SEGUNDA_10H);
    createDraft(s.db, s.cliente.id, s.pedidoPix, 11500, SEGUNDA_10H);
    await s.contentToText(s.comprovante, s.cliente);
    await s.orders.create(s.cliente.id, { ...s.pedidoPix, pagamento: 'dinheiro' });
    expect(midias(s.fake)).toEqual([]);
    expect(receiptsFor(s.db, s.cliente.id)[0]!.repassadoEm).toBeNull();
  });

  test('exclusão de dados do cliente apaga os comprovantes pendentes', async () => {
    const s = setup(SEGUNDA_10H);
    createDraft(s.db, s.cliente.id, s.pedidoPix, 11500, SEGUNDA_10H);
    await s.contentToText(s.comprovante, s.cliente);
    expect(receiptsFor(s.db, s.cliente.id)).toHaveLength(1);
    deleteCustomerData(s.db, s.cliente.id);
    expect(receiptsFor(s.db, s.cliente.id)).toEqual([]);
  });
});
