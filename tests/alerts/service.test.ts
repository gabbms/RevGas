import { describe, expect, test, vi } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { createAlertService } from '../../src/alerts/service.js';
import { getSettings, updateSettings } from '../../src/store/settings.js';
import { upsertCustomerByPhone, updateCustomer } from '../../src/store/customers.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

let t = new Date('2026-11-02T13:00:00Z');
const clock = () => t;

function setup(opts: { dono?: string; templateAlerta?: string; publicUrl?: string } = {}) {
  t = new Date('2026-11-02T13:00:00Z');
  const db = openDb(':memory:');
  const fake = new FakeWhatsApp();
  const outbox = createOutbox(db, fake, clock);
  const dono = opts.dono ?? '5586999990000';
  updateSettings(db, { ...getSettings(db), telefoneDono: dono });
  const cliente = updateCustomer(db, upsertCustomerByPhone(db, '5586988887777', t).id, { nome: 'Maria' });
  const svc = createAlertService({
    db,
    outbox,
    settings: () => getSettings(db),
    publicUrl: opts.publicUrl ?? 'https://loja.exemplo',
    ...(opts.templateAlerta ? { templateAlerta: opts.templateAlerta } : {}),
    clock,
  });
  if (dono) outbox.registerInbound(dono, t);
  return { db, fake, outbox, svc, cliente };
}

describe('alertas', () => {
  test('create grava e envia ao dono com link', async () => {
    const { fake, svc, cliente } = setup();
    const a = await svc.create({ clienteId: cliente.id, motivo: 'Pediu atendente', resumo: 'Quer falar com uma pessoa' });
    expect(a).toMatchObject({ clienteId: cliente.id, pedidoId: null, motivo: 'Pediu atendente', resolvidoEm: null });
    expect(fake.sent).toHaveLength(1);
    const m = fake.sent[0]!;
    expect(m.to).toBe('5586999990000');
    expect(m).toMatchObject({
      kind: 'text',
      body: `⚠️ Pediu atendente\nQuer falar com uma pessoa\nCliente: Maria (${cliente.telefone})\nhttps://loja.exemplo/painel/conversas/${cliente.id}`,
    });
    expect((m as { body: string }).body).toContain('/painel/conversas/1');
    expect(svc.listOpen()).toHaveLength(1);
  });

  test('inclui a linha do pedido e omite as linhas sem dado; barra final da URL é normalizada', async () => {
    const { db, fake, svc } = setup({ publicUrl: 'https://loja.exemplo/' });
    const sem = await svc.create({ motivo: 'Erro', resumo: 'Algo falhou' });
    expect(sem).toMatchObject({ clienteId: null, pedidoId: null });
    expect((fake.sent[0] as { body: string }).body).toBe('⚠️ Erro\nAlgo falhou');
    const c = upsertCustomerByPhone(db, '5586977776666', t);
    db.prepare(
      "INSERT INTO orders (id, cliente_id, tipo, quantidade, modo, pagamento, unitario_centavos, total_centavos, status, criado_em) VALUES (7, ?, 'recarga', 1, 'entrega', 'dinheiro', 100, 100, 'novo', ?)",
    ).run(c.id, t.toISOString());
    await svc.create({ clienteId: c.id, pedidoId: 7, motivo: 'Pedido parado', resumo: 'Sem entregador' });
    expect((fake.sent[1] as { body: string }).body).toBe(
      `⚠️ Pedido parado\nSem entregador\nCliente: ${c.telefone}\nPedido #7\nhttps://loja.exemplo/painel/conversas/${c.id}`,
    );
  });

  test('sem telefoneDono só grava', async () => {
    const { fake, svc } = setup({ dono: '' });
    const a = await svc.create({ motivo: 'x', resumo: 'y' });
    expect(a.id).toBeGreaterThan(0);
    expect(fake.sent).toHaveLength(0);
    expect(svc.listOpen()).toHaveLength(1);
  });

  test('resolve tira da listOpen; listOpen vem do mais novo para o mais antigo', async () => {
    const { svc } = setup();
    const a1 = await svc.create({ motivo: 'um', resumo: 'a' });
    t = new Date(t.getTime() + 1000);
    const a2 = await svc.create({ motivo: 'dois', resumo: 'b' });
    expect(svc.listOpen().map((a) => a.id)).toEqual([a2.id, a1.id]);
    svc.resolve(a2.id);
    expect(svc.listOpen().map((a) => a.id)).toEqual([a1.id]);
  });

  test('fora da janela usa o modelo com [motivo, resto em uma linha]', async () => {
    const { fake, svc, cliente } = setup({ templateAlerta: 'alerta_dono' });
    t = new Date(t.getTime() + 25 * 3600_000);
    await svc.create({ clienteId: cliente.id, motivo: 'Reclamação', resumo: 'Entrega atrasada' });
    expect(fake.sent[0]).toEqual({
      to: '5586999990000',
      kind: 'template',
      name: 'alerta_dono',
      params: [
        'Reclamação',
        `Entrega atrasada | Cliente: Maria (${cliente.telefone}) | https://loja.exemplo/painel/conversas/${cliente.id}`,
      ],
    });
  });

  test('fora da janela sem modelo: grava, não lança', async () => {
    const { svc } = setup();
    t = new Date(t.getTime() + 25 * 3600_000);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(svc.create({ motivo: 'x', resumo: 'y' })).resolves.toMatchObject({ motivo: 'x' });
    expect(svc.listOpen()).toHaveLength(1);
    spy.mockRestore();
  });

  test('falha da API não impede a gravação e o log não traz dado pessoal', async () => {
    const { fake, svc, cliente } = setup();
    fake.failNext(new Error('boom 5586999990000'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await svc.create({ clienteId: cliente.id, motivo: 'x', resumo: 'segredo' });
    expect(svc.listOpen().map((x) => x.id)).toEqual([a.id]);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('5586');
    expect(logged).not.toContain('segredo');
    spy.mockRestore();
  });
});
