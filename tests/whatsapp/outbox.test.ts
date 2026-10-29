import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { createOutbox } from '../../src/whatsapp/outbox.js';
import { WhatsAppApiError } from '../../src/whatsapp/api.js';
import { FakeWhatsApp } from '../fakes/fake-whatsapp.js';

const now = new Date('2026-11-02T13:00:00Z');
const tpl = { nome: 'x', parametros: ['a'] };
function setup() {
  const fake = new FakeWhatsApp();
  return { fake, ob: createOutbox(openDb(':memory:'), fake, () => now) };
}

describe('outbox', () => {
  test('janela aberta → texto (mesmo com telefone sem o 9º dígito)', async () => {
    const { fake, ob } = setup();
    ob.registerInbound('5586999991234', new Date(now.getTime() - 60_000));
    expect(await ob.send({ telefone: '558699991234', texto: 'oi', template: tpl })).toMatchObject({ ok: true, via: 'texto', wamid: 'wamid.1' });
    expect(fake.sent).toEqual([{ to: '558699991234', kind: 'text', body: 'oi' }]);
  });

  test('janela fechada com modelo → template', async () => {
    const { fake, ob } = setup();
    expect(await ob.send({ telefone: '5586999991234', texto: 'oi', template: tpl })).toMatchObject({ ok: true, via: 'template' });
    expect(fake.sent[0]).toMatchObject({ kind: 'template', name: 'x', params: ['a'] });
  });

  test('janela fechada sem modelo → fora_da_janela', async () => {
    const { fake, ob } = setup();
    expect(await ob.send({ telefone: '5586999991234', texto: 'oi' })).toEqual({ ok: false, motivo: 'fora_da_janela' });
    expect(fake.sent).toEqual([]);
  });

  test('modelo com nome vazio conta como sem modelo', async () => {
    const { ob } = setup();
    expect(await ob.send({ telefone: '5586999991234', texto: 'oi', template: { nome: '', parametros: [] } })).toMatchObject({ ok: false, motivo: 'fora_da_janela' });
  });

  test('erro da API vira erro_api', async () => {
    const { fake, ob } = setup();
    fake.failNext(new WhatsAppApiError(500, 'boom'));
    const r = await ob.send({ telefone: '5586999991234', texto: 'oi', template: tpl });
    expect(r).toMatchObject({ ok: false, motivo: 'erro_api' });
  });

  test('erro inesperado também não lança', async () => {
    const { fake, ob } = setup();
    fake.failNext(new Error('rede'));
    expect(await ob.send({ telefone: '5586999991234', texto: 'oi', template: tpl })).toMatchObject({ ok: false, motivo: 'erro_api', detalhe: 'rede' });
  });

  test('windowOpen: 24h exatas já está fechada; registerInbound mantém a mais recente', () => {
    const { ob } = setup();
    ob.registerInbound('5586999991234', new Date(now.getTime() - 24 * 3600_000));
    expect(ob.windowOpen('5586999991234')).toBe(false);
    ob.registerInbound('5586999991234', new Date(now.getTime() - 24 * 3600_000 + 1000));
    expect(ob.windowOpen('5586999991234')).toBe(true);
    ob.registerInbound('5586999991234', new Date(now.getTime() - 48 * 3600_000));
    expect(ob.windowOpen('5586999991234')).toBe(true);
    expect(ob.windowOpen('5586999991234', new Date(now.getTime() + 24 * 3600_000))).toBe(false);
  });
});
