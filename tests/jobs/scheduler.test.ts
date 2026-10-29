import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import { runReminderJob } from '../../src/domain/reminders.js';
import { startScheduler } from '../../src/jobs/scheduler.js';
import { DEFAULT_SETTINGS, type StoreSettings } from '../../src/store/settings.js';
import { getCustomer, updateCustomer, upsertCustomerByPhone } from '../../src/store/customers.js';
import { insertOrder, type Order } from '../../src/store/orders.js';
import { recentMessages } from '../../src/store/messages.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const at10h = new Date('2026-10-29T13:00:00Z'); // quinta, 10h em São Paulo
const settings: StoreSettings = { ...DEFAULT_SETTINGS, precoRecargaCentavos: 11500, lembretesAtivos: true };

function delivered(db: Db, clienteId: number, iso: string, status: Order['status'] = 'entregue'): void {
  insertOrder(db, {
    clienteId, tipo: 'entrega', quantidade: 1, modo: 'troca', pagamento: 'dinheiro', trocoParaCentavos: null,
    endereco: null, unitarioCentavos: 11500, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: 11500,
    status, entregadorTelefone: null, precisaRevisao: false, criadoEm: iso, enviadoEm: iso, saiuEm: null, finalizadoEm: iso,
  });
}

function setup(over: { s?: Partial<StoreSettings>; now?: Date; template?: string; telefone?: string; conversou?: boolean } = {}) {
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const now = over.now ?? at10h;
  const outbox = createOutbox(db, fake, () => now);
  const c = upsertCustomerByPhone(db, over.telefone?.startsWith('excluido-') ? '5586999991234' : (over.telefone ?? '5586999991234'), now);
  updateCustomer(db, c.id, { nome: 'Ana', ...(over.conversou === false ? {} : { ultimaMensagemEm: '2026-10-01T12:00:00Z' }) });
  if (over.telefone?.startsWith('excluido-')) db.prepare('UPDATE customers SET telefone = ? WHERE id = ?').run(over.telefone, c.id);
  delivered(db, c.id, '2026-09-01T12:00:00Z');
  delivered(db, c.id, '2026-10-01T12:00:00Z', 'retirado');
  const s = { ...settings, ...over.s };
  const run = () => runReminderJob({ db, outbox, settings: () => s, ...(over.template ? { templateLembrete: over.template } : {}), clock: () => now });
  return { db, fake, c, run };
}

describe('runReminderJob', () => {
  test('10h com modelo → envia modelo, grava mensagem e marca o ciclo', async () => {
    const { db, fake, c, run } = setup({ template: 'lembrete_recompra' });
    expect(await run()).toBe(1);
    expect(fake.sent[0]).toEqual({ to: '5586999991234', kind: 'template', name: 'lembrete_recompra', params: ['Ana', 'R$ 115,00'] });
    expect(getCustomer(db, c.id)!.ultimoLembreteEm).toBe(at10h.toISOString());
    const m = recentMessages(db, c.id, new Date(0)).at(-1)!;
    expect(m).toMatchObject({ autor: 'bot' });
    expect(m.texto).toContain('P13 (R$ 115,00)');
    expect(await run()).toBe(0); // mesmo ciclo
  });
  test('sem nome usa "tudo bem"', async () => {
    const { db, fake, c, run } = setup({ template: 't' });
    updateCustomer(db, c.id, { nome: null });
    await run();
    expect(fake.sent[0]).toMatchObject({ params: ['tudo bem', 'R$ 115,00'] });
  });
  test('14h local → 0', async () => {
    const { fake, run } = setup({ template: 't', now: new Date('2026-10-29T17:00:00Z') });
    expect(await run()).toBe(0);
    expect(fake.sent).toEqual([]);
  });
  test('11h local → 0 (janela é 9 <= h < 11)', async () => expect(await setup({ template: 't', now: new Date('2026-10-29T14:00:00Z') }).run()).toBe(0));
  test('9h local → envia', async () => expect(await setup({ template: 't', now: new Date('2026-10-29T12:00:00Z') }).run()).toBe(1));
  test('lembretesAtivos false → 0', async () => expect(await setup({ template: 't', s: { lembretesAtivos: false } }).run()).toBe(0));
  test('preço 0 → 0', async () => {
    const { fake, run } = setup({ template: 't', s: { precoRecargaCentavos: 0 } });
    expect(await run()).toBe(0);
    expect(fake.sent).toEqual([]);
  });
  test('loja fechada → 0', async () => {
    const closed = { ...DEFAULT_SETTINGS.horarios, qui: null };
    expect(await setup({ template: 't', s: { horarios: closed } }).run()).toBe(0);
  });
  test('cliente excluído ou sem conversa prévia é pulado', async () => {
    expect(await setup({ template: 't', telefone: 'excluido-7' }).run()).toBe(0);
    expect(await setup({ template: 't', conversou: false }).run()).toBe(0);
  });
  test('sem modelo e fora da janela de 24h: falha, nada é atualizado', async () => {
    const { db, fake, c, run } = setup();
    expect(await run()).toBe(0);
    expect(fake.sent).toEqual([]);
    expect(getCustomer(db, c.id)!.ultimoLembreteEm).toBeNull();
    expect(recentMessages(db, c.id, new Date(0)).filter((m) => m.autor === 'bot')).toEqual([]);
  });
  test('erro da API no primeiro cliente não impede o segundo', async () => {
    const { db, fake, run } = setup({ template: 't' });
    const c2 = upsertCustomerByPhone(db, '5586988887777', at10h);
    updateCustomer(db, c2.id, { ultimaMensagemEm: '2026-10-01T12:00:00Z' });
    delivered(db, c2.id, '2026-09-01T12:00:00Z');
    delivered(db, c2.id, '2026-10-01T12:00:00Z');
    fake.failNext(new Error('rede'));
    expect(await run()).toBe(1);
    expect(fake.sent).toHaveLength(1);
  });
});

describe('runReminderJob: falha ao gravar depois do envio', () => {
  test('erro ao gravar a mensagem do cliente 1 não impede o cliente 2 nem reenvia ao cliente 1', async () => {
    const { db, fake, c, run } = setup({ template: 't' });
    const c2 = upsertCustomerByPhone(db, '5586988887777', at10h);
    updateCustomer(db, c2.id, { ultimaMensagemEm: '2026-10-01T12:00:00Z' });
    delivered(db, c2.id, '2026-09-01T12:00:00Z');
    delivered(db, c2.id, '2026-10-01T12:00:00Z');
    // Gravar a mensagem do cliente 1 falha (disco, constraint...).
    db.exec(`CREATE TRIGGER falha_msg BEFORE INSERT ON messages WHEN NEW.cliente_id = ${c.id}
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toBe(2);
    expect(fake.sent.map((m) => m.to)).toEqual(['5586999991234', '5586988887777']);
    expect(getCustomer(db, c.id)!.ultimoLembreteEm).toBe(at10h.toISOString());
    expect(getCustomer(db, c2.id)!.ultimoLembreteEm).toBe(at10h.toISOString());
    // Log sem dados pessoais: nem telefone nem nome.
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('5586999991234');
    expect(logged).not.toContain('Ana');
    log.mockRestore();

    expect(await run()).toBe(0); // tick seguinte: ninguém recebe de novo
    expect(fake.sent).toHaveLength(2);
  });

  test('exceção ao processar um cliente não trava o lote', async () => {
    const { db, fake, c, run } = setup({ template: 't' });
    const c2 = upsertCustomerByPhone(db, '5586988887777', at10h);
    updateCustomer(db, c2.id, { ultimaMensagemEm: '2026-10-01T12:00:00Z' });
    delivered(db, c2.id, '2026-09-01T12:00:00Z');
    delivered(db, c2.id, '2026-10-01T12:00:00Z');
    // Gravar qualquer coisa do cliente 1 falha, inclusive ultimo_lembrete_em.
    db.exec(`CREATE TRIGGER falha_msg BEFORE INSERT ON messages WHEN NEW.cliente_id = ${c.id}
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    db.exec(`CREATE TRIGGER falha_cli BEFORE UPDATE ON customers WHEN NEW.id = ${c.id}
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toBe(1); // o cliente 1 deu exceção e não conta
    expect(getCustomer(db, c2.id)!.ultimoLembreteEm).toBe(at10h.toISOString());
    expect(fake.sent).toHaveLength(2);
    expect(log).toHaveBeenCalledWith('lembretes: falha ao processar o cliente', c.id, 'boom');
    log.mockRestore();
  });
});

describe('startScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const now = new Date('2026-10-29T13:00:00Z');

  test('a cada intervalo chama releaseScheduled e reminders; stop para', async () => {
    const releaseScheduled = vi.fn(async () => 0);
    const reminders = vi.fn(async () => 0);
    const stop = startScheduler({ orders: { releaseScheduled } as never, reminders, clock: () => now, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(releaseScheduled).toHaveBeenCalledTimes(2);
    expect(releaseScheduled).toHaveBeenCalledWith(now);
    expect(reminders).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reminders).toHaveBeenCalledTimes(2);
  });
  test('erro numa tarefa não impede a outra nem o próximo tick', async () => {
    const releaseScheduled = vi.fn(async () => { throw new Error('x'); });
    const reminders = vi.fn(async () => 0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = startScheduler({ orders: { releaseScheduled } as never, reminders, clock: () => now, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reminders).toHaveBeenCalledTimes(2);
    stop();
    log.mockRestore();
  });
  test('execução anterior ainda rodando → pula o tick', async () => {
    let release!: () => void;
    const releaseScheduled = vi.fn(() => new Promise<number>((r) => { release = () => r(0); }));
    const reminders = vi.fn(async () => 0);
    const stop = startScheduler({ orders: { releaseScheduled } as never, reminders, clock: () => now, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(releaseScheduled).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(releaseScheduled).toHaveBeenCalledTimes(2);
    stop();
  });
});
