import { describe, expect, test, vi } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { createInboundRouter, defaultContentToText, type RouterDeps } from '../../src/inbound/router.js';
import { getCustomer, getCustomerByPhone, listCustomers, updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { insertMessage, lastCustomerMessageAt, recentMessages } from '../../src/store/messages.js';
import { consumeDraft, createDraft, getDraft, hasRecentGasDoPovoDraft } from '../../src/store/drafts.js';
import type { InboundEvent } from '../../src/whatsapp/webhook.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const now = new Date('2026-11-02T13:00:00Z');

function setup(over: Partial<RouterDeps> = {}) {
  const db = openDb(':memory:');
  const outbox = createOutbox(db, new FakeWhatsApp(), () => now);
  const turns: number[] = [];
  const staff: InboundEvent[] = [];
  const deps: RouterDeps = {
    db,
    outbox,
    clock: () => now,
    isStaff: () => false,
    handleStaff: async (e) => { staff.push(e); },
    contentToText: async (e) => defaultContentToText(e),
    onCustomerTurn: async (id) => { turns.push(id); },
    hasGasDoPovoContext: () => false,
    debounceMs: 0,
    ...over,
  };
  return { db, deps, router: createInboundRouter(deps), turns, staff };
}
const ev = (wamid: string, texto: string, over: Partial<InboundEvent> = {}): InboundEvent => ({
  wamid, de: '5586999991234', em: now, conteudo: { tipo: 'texto', texto }, ...over,
});
const allMessages = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT * FROM messages ORDER BY id').all() as { texto: string; autor: string; wamid: string }[];

describe('roteador', () => {
  test('ignora wamid repetido', async () => {
    const { db, router, turns } = setup();
    await router.handle([ev('w1', 'oi'), ev('w1', 'oi')]);
    await router.idle();
    expect(allMessages(db)).toHaveLength(1);
    expect(turns).toHaveLength(1);
    await router.handle([ev('w1', 'oi')]);
    await router.idle();
    expect(allMessages(db)).toHaveLength(1);
    expect(turns).toHaveLength(1);
  });

  test('grava mensagem, nome do perfil, janela e ultimaMensagemEm', async () => {
    const { db, deps, router } = setup();
    await router.handle([ev('w1', 'oi', { nomePerfil: 'Maria' }), ev('w2', 'quero gás', { nomePerfil: 'Outro' })]);
    await router.idle();
    const c = getCustomerByPhone(db, '5586999991234')!;
    expect(c.nome).toBe('Maria');
    expect(c.ultimaMensagemEm).toBe(now.toISOString());
    expect(allMessages(db).map((m) => [m.autor, m.texto, m.wamid])).toEqual([
      ['cliente', 'oi', 'w1'],
      ['cliente', 'quero gás', 'w2'],
    ]);
    expect(deps.outbox.windowOpen('5586999991234')).toBe(true);
  });

  test('entregador vai para handleStaff e não vira cliente', async () => {
    const { db, router, staff, turns } = setup({ isStaff: () => true });
    await router.handle([ev('w1', 'ok')]);
    await router.idle();
    expect(staff).toHaveLength(1);
    expect(listCustomers(db)).toEqual([]);
    expect(allMessages(db)).toEqual([]);
    expect(turns).toEqual([]);
  });

  test('bot pausado só grava', async () => {
    const { db, router, turns } = setup();
    const c = upsertCustomerByPhone(db, '5586999991234', now);
    updateCustomer(db, c.id, { botPausadoAte: new Date(now.getTime() + 3600_000).toISOString() });
    await router.handle([ev('w1', 'oi')]);
    await router.idle();
    expect(allMessages(db)).toHaveLength(1);
    expect(turns).toEqual([]);
  });

  test('pausa vencida volta a acionar a IA', async () => {
    const { db, router, turns } = setup();
    const c = upsertCustomerByPhone(db, '5586999991234', now);
    updateCustomer(db, c.id, { botPausadoAte: new Date(now.getTime() - 1000).toISOString() });
    await router.handle([ev('w1', 'oi')]);
    await router.idle();
    expect(turns).toEqual([c.id]);
  });

  test('código SMS mascarado antes de gravar', async () => {
    const { db, router } = setup({ hasGasDoPovoContext: () => true });
    await router.handle([ev('w1', '482913')]);
    await router.idle();
    expect(allMessages(db)[0]!.texto).toBe('[código removido]');
  });

  test('CPF mascarado antes de gravar', async () => {
    const { db, router } = setup();
    await router.handle([ev('w1', 'cpf 123.456.789-09')]);
    await router.idle();
    expect(allMessages(db)[0]!.texto).toBe('cpf [CPF removido]');
  });

  test('contentToText null para sem gravar', async () => {
    const { db, router, turns } = setup({ contentToText: async () => null });
    await router.handle([ev('w1', 'x')]);
    await router.idle();
    expect(allMessages(db)).toEqual([]);
    expect(turns).toEqual([]);
  });

  test('erro num evento não impede os demais e não vaza dado', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const { db, router } = setup({
      contentToText: async (e) => {
        if (n++ === 0) throw new Error('falhou com 5586999991234');
        return defaultContentToText(e);
      },
    });
    await router.handle([ev('w1', 'a'), ev('w2', 'b')]);
    await router.idle();
    expect(allMessages(db).map((m) => m.texto)).toEqual(['b']);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('5586999991234');
    spy.mockRestore();
  });

  test('várias mensagens seguidas geram um único turno (debounce)', async () => {
    vi.useFakeTimers();
    try {
      const { router, turns } = setup({ debounceMs: 2000 });
      await router.handle([ev('w1', 'oi'), ev('w2', 'quero 2'), ev('w3', 'botijão')]);
      vi.advanceTimersByTime(2000);
      await router.idle();
      expect(turns).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('defaultContentToText', () => {
    const base = { wamid: 'w', de: '1', em: now };
    expect(defaultContentToText({ ...base, conteudo: { tipo: 'botao', texto: 'Sim' } })).toEqual({ tipo: 'botao', texto: 'Sim' });
    expect(defaultContentToText({ ...base, conteudo: { tipo: 'audio', mediaId: 'm', mime: 'audio/ogg' } })).toEqual({ tipo: 'audio', texto: '[áudio]' });
    expect(defaultContentToText({ ...base, conteudo: { tipo: 'imagem', mediaId: 'm', mime: 'image/jpeg', legenda: 'olha' } })).toEqual({ tipo: 'imagem', texto: '[imagem] olha' });
    expect(defaultContentToText({ ...base, conteudo: { tipo: 'documento', mediaId: 'm', mime: 'a/b' } })).toEqual({ tipo: 'documento', texto: '[documento]' });
    expect(defaultContentToText({ ...base, conteudo: { tipo: 'outro' } }).texto).toBe('[mensagem não suportada]');
  });
});

describe('stores', () => {
  test('clientes: sem duplicar variantes do 9º dígito; round-trip dos campos', () => {
    const { db } = setup();
    const a = upsertCustomerByPhone(db, '5586999991234', now);
    const b = upsertCustomerByPhone(db, '558699991234', now);
    expect(b.id).toBe(a.id);
    expect(getCustomerByPhone(db, '86 99999-1234')!.id).toBe(a.id);
    expect(listCustomers(db)).toHaveLength(1);
    const end = { rua: 'A', numero: '1', bairro: 'B' };
    const u = updateCustomer(db, a.id, { nome: 'Ana', endereco: end, lembretesDesativados: true });
    expect(u).toMatchObject({ nome: 'Ana', endereco: end, lembretesDesativados: true, botPausadoAte: null });
    expect(getCustomer(db, a.id)).toEqual(u);
    expect(updateCustomer(db, a.id, { endereco: null, lembretesDesativados: false }).endereco).toBeNull();
    expect(getCustomer(db, 999)).toBeNull();
  });

  test('mensagens: ordem cronológica, since e limit', () => {
    const { db } = setup();
    const c = upsertCustomerByPhone(db, '5586999991234', now);
    const t = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
    for (let i = 0; i < 5; i++) insertMessage(db, { clienteId: c.id, autor: 'cliente', tipo: 'texto', texto: `m${i}`, wamid: null, criadoEm: t(i) });
    expect(recentMessages(db, c.id, new Date(t(1)), 3).map((m) => m.texto)).toEqual(['m2', 'm3', 'm4']);
    expect(recentMessages(db, c.id, new Date(t(1))).map((m) => m.texto)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(lastCustomerMessageAt(db, c.id)).toEqual(new Date(t(4)));
    insertMessage(db, { clienteId: c.id, autor: 'bot', tipo: 'texto', texto: 'bot', wamid: null, criadoEm: t(10) });
    expect(lastCustomerMessageAt(db, c.id)).toEqual(new Date(t(4)));
    expect(lastCustomerMessageAt(db, 999)).toBeNull();
  });

  test('rascunhos', () => {
    const { db } = setup();
    const c = upsertCustomerByPhone(db, '5586999991234', now);
    const req = { quantidade: 1, modo: 'troca' as const, pagamento: 'gas_do_povo' as const };
    const d = createDraft(db, c.id, req, 11500, now);
    expect(getDraft(db, d.id)).toEqual(d);
    expect(d).toMatchObject({ request: req, totalCentavos: 11500, consumidoEm: null });
    expect(hasRecentGasDoPovoDraft(db, c.id, new Date(now.getTime() + 119 * 60_000))).toBe(true);
    expect(hasRecentGasDoPovoDraft(db, c.id, new Date(now.getTime() + 121 * 60_000))).toBe(false);
    consumeDraft(db, d.id, now);
    expect(getDraft(db, d.id)!.consumidoEm).toBe(now.toISOString());
    expect(hasRecentGasDoPovoDraft(db, c.id, now)).toBe(false);
    createDraft(db, c.id, { ...req, pagamento: 'dinheiro' }, 11500, now);
    expect(hasRecentGasDoPovoDraft(db, c.id, now)).toBe(false);
  });
});
