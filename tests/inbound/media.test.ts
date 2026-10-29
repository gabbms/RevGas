import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Transcriber } from '../../src/audio/transcriber.js';
import { openDb } from '../../src/db/connection.js';
import { createContentToText } from '../../src/inbound/media.js';
import { createInboundRouter, defaultContentToText } from '../../src/inbound/router.js';
import { upsertCustomerByPhone } from '../../src/store/customers.js';
import { insertOrder, recordOrderMessage, type Order } from '../../src/store/orders.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import type { InboundEvent } from '../../src/whatsapp/webhook.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const now = new Date('2026-11-02T13:00:00Z');
const CLIENTE = '5586999991234';
const JOAO = '5586988880001';
const PEDRO = '5586988880002';

afterEach(() => vi.restoreAllMocks());

function setup(transcribe: Transcriber['transcribe'] = async () => 'quero um gás') {
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, () => now);
  const customer = upsertCustomerByPhone(db, CLIENTE, now);
  outbox.registerInbound(CLIENTE, now);
  const contentToText = createContentToText({ db, api: fake, transcriber: { transcribe }, outbox, clock: () => now });
  const mkOrder = (pagamento: Order['pagamento'], status: Order['status'] = 'recebido') =>
    insertOrder(db, {
      clienteId: customer.id, tipo: 'entrega', quantidade: 1, modo: 'troca', pagamento, trocoParaCentavos: null,
      endereco: null, unitarioCentavos: 11500, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: 11500,
      status, entregadorTelefone: null, precisaRevisao: false, criadoEm: now.toISOString(),
      enviadoEm: null, saiuEm: null, finalizadoEm: null,
    });
  return { db, fake, outbox, customer, contentToText, mkOrder };
}

const audioEv = (wamid = 'wa1'): InboundEvent => ({
  wamid, de: CLIENTE, em: now, conteudo: { tipo: 'audio', mediaId: 'm1', mime: 'audio/ogg; codecs=opus' },
});
const imgEv = (tipo: 'imagem' | 'documento' = 'imagem'): InboundEvent => ({
  wamid: 'wi1', de: CLIENTE, em: now, conteudo: { tipo, mediaId: 'm2', mime: 'image/jpeg' },
});
const msgs = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT autor, tipo, texto, wamid FROM messages ORDER BY id').all() as {
    autor: string; tipo: string; texto: string; wamid: string | null;
  }[];

describe('áudio', () => {
  test('áudio vira texto transcrito', async () => {
    const { fake, contentToText, customer } = setup();
    fake.media.set('m1', { data: Buffer.from('ogg'), mime: 'audio/ogg; codecs=opus' });
    expect(await contentToText(audioEv(), customer)).toEqual({ tipo: 'audio', texto: 'quero um gás' });
  });

  test('falha na transcrição pede para escrever e devolve null', async () => {
    const { db, fake, contentToText, customer } = setup(async () => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.media.set('m1', { data: Buffer.from('ogg'), mime: 'audio/ogg' });
    expect(await contentToText(audioEv(), customer)).toBeNull();
    expect(fake.sent).toEqual([{ to: CLIENTE, kind: 'text', body: 'Não consegui ouvir seu áudio 😕 Pode escrever pra mim?' }]);
    expect(msgs(db)).toEqual([
      { autor: 'cliente', tipo: 'audio', texto: '[áudio não transcrito]', wamid: 'wa1' },
      { autor: 'bot', tipo: 'texto', texto: 'Não consegui ouvir seu áudio 😕 Pode escrever pra mim?', wamid: 'wamid.2' },
    ]);
  });

  test('transcrição só com espaços e falha de download contam como falha', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = setup(async () => '   \n ');
    a.fake.media.set('m1', { data: Buffer.from('x'), mime: 'audio/ogg' });
    expect(await a.contentToText(audioEv(), a.customer)).toBeNull();
    expect(a.fake.sent).toHaveLength(1);
    const b = setup(); // mídia desconhecida: downloadMedia lança
    expect(await b.contentToText(audioEv(), b.customer)).toBeNull();
    expect(b.fake.sent).toHaveLength(1);
  });

  test('pelo roteador a mensagem de áudio falho é gravada uma única vez, sem turno da IA', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, outbox, contentToText } = setup(async () => '');
    fake.media.set('m1', { data: Buffer.from('x'), mime: 'audio/ogg' });
    const turns: number[] = [];
    const router = createInboundRouter({
      db, outbox, clock: () => now, isStaff: () => false, handleStaff: async () => {}, contentToText,
      onCustomerTurn: async (id) => { turns.push(id); }, hasGasDoPovoContext: () => false, debounceMs: 0,
    });
    await router.handle([audioEv()]);
    await router.idle();
    expect(msgs(db).map((m) => m.autor)).toEqual(['cliente', 'bot']);
    expect(msgs(db).filter((m) => m.wamid === 'wa1')).toHaveLength(1);
    expect(turns).toEqual([]);
  });

  test('o log da falha não contém dado pessoal', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, contentToText, customer } = setup(async () => {
      throw new Error('falha com 5586999991234 e CPF 123.456.789-09');
    });
    fake.media.set('m1', { data: Buffer.from('x'), mime: 'audio/ogg' });
    await contentToText(audioEv(), customer);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/5586999991234|123\.456/);
  });
});

describe('comprovante Pix', () => {
  test('comprovante é repassado aos destinatários do pedido pix_antecipado', async () => {
    const { db, fake, contentToText, customer, mkOrder } = setup();
    mkOrder('dinheiro');
    const o = mkOrder('pix_antecipado');
    recordOrderMessage(db, 'x1', o.id, JOAO);
    recordOrderMessage(db, 'x2', o.id, PEDRO);
    fake.media.set('m2', { data: Buffer.from('jpg'), mime: 'image/jpeg' });
    const r = await contentToText(imgEv(), customer);
    expect(r).toEqual({ tipo: 'imagem', texto: `[cliente enviou comprovante Pix; repassado ao pedido #${o.id}]` });
    expect(fake.uploads).toHaveLength(1);
    expect(fake.sent).toEqual([
      { to: JOAO, kind: 'image', mediaId: 'media.1', caption: `Comprovante Pix do pedido #${o.id}` },
      { to: PEDRO, kind: 'image', mediaId: 'media.1', caption: `Comprovante Pix do pedido #${o.id}` },
    ]);
  });

  test('documento é repassado como document', async () => {
    const { db, fake, contentToText, customer, mkOrder } = setup();
    const o = mkOrder('pix_antecipado');
    recordOrderMessage(db, 'x1', o.id, JOAO);
    fake.media.set('m2', { data: Buffer.from('pdf'), mime: 'application/pdf' });
    await contentToText(imgEv('documento'), customer);
    expect(fake.sent[0]).toMatchObject({ to: JOAO, kind: 'document' });
  });

  test('um envio que falha não impede os demais; todos falhando devolve o texto de falha', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, fake, contentToText, customer, mkOrder } = setup();
    const o = mkOrder('pix_antecipado');
    recordOrderMessage(db, 'x1', o.id, JOAO);
    recordOrderMessage(db, 'x2', o.id, PEDRO);
    fake.media.set('m2', { data: Buffer.from('jpg'), mime: 'image/jpeg' });
    const real = fake.sendMedia.bind(fake);
    let n = 0;
    fake.sendMedia = async (...a) => {
      if (n++ === 0) throw new Error('falhou');
      return real(...a);
    };
    const r = await contentToText(imgEv(), customer);
    expect(fake.sent.map((m) => m.to)).toEqual([PEDRO]);
    expect(r?.texto).toContain('repassado ao pedido');

    fake.sendMedia = async () => {
      throw new Error('falhou');
    };
    const r2 = await contentToText(imgEv(), customer);
    expect(r2?.texto).toBe(`[cliente enviou comprovante Pix; não foi possível repassar ao pedido #${o.id}]`);
  });

  test('sem pedido pix_antecipado aberto, ou com ele finalizado, cai no padrão', async () => {
    const { fake, contentToText, customer, mkOrder } = setup();
    fake.media.set('m2', { data: Buffer.from('jpg'), mime: 'image/jpeg' });
    mkOrder('dinheiro');
    mkOrder('pix_antecipado', 'entregue');
    expect(await contentToText(imgEv(), customer)).toEqual(defaultContentToText(imgEv()));
    expect(fake.sent).toEqual([]);
  });

  test('falha ao baixar a imagem cai no padrão', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, contentToText, customer, mkOrder } = setup();
    const o = mkOrder('pix_antecipado');
    recordOrderMessage(db, 'x1', o.id, JOAO);
    expect(await contentToText(imgEv(), customer)).toEqual({ tipo: 'imagem', texto: '[imagem]' });
  });

  test('texto segue o padrão', async () => {
    const { contentToText, customer } = setup();
    const ev: InboundEvent = { wamid: 't', de: CLIENTE, em: now, conteudo: { tipo: 'texto', texto: 'oi' } };
    expect(await contentToText(ev, customer)).toEqual({ tipo: 'texto', texto: 'oi' });
  });
});
