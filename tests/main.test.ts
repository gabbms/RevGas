import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createAppContext } from '../src/main.js';
import { insertOrder } from '../src/store/orders.js';
import { createDraft } from '../src/store/drafts.js';
import { upsertCustomerByPhone } from '../src/store/customers.js';
import { insertMessage } from '../src/store/messages.js';
import { FakeWhatsApp } from './fakes/fake-whatsapp.js';

const env = loadEnv({
  DB_PATH: ':memory:',
  PUBLIC_URL: 'https://loja.exemplo',
  WA_TOKEN: 't',
  WA_PHONE_NUMBER_ID: '1',
  WA_APP_SECRET: 'segredo',
  WA_VERIFY_TOKEN: 'VT',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  PANEL_PASSWORD: 'senha-longa-12',
  SESSION_SECRET: 'x'.repeat(32),
});
const NOW = new Date('2026-11-02T13:00:00Z');
const body = readFileSync(new URL('./fixtures/webhook-texto-audio.json', import.meta.url));
const sig = (b: Buffer) => 'sha256=' + createHmac('sha256', env.WA_APP_SECRET).update(b).digest('hex');

const fakeAnthropic = (text: string) =>
  ({
    beta: { messages: { toolRunner: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) } },
  }) as unknown as Anthropic;

const contexts: { db: { close(): void } }[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.db.close();
});

describe('createAppContext', () => {
  test('sobe e responde /healthz; scheduler só liga em startJobs', async () => {
    const fake = new FakeWhatsApp();
    const ctx = await createAppContext(env, { api: fake, anthropic: fakeAnthropic('oi'), clock: () => NOW });
    contexts.push(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(ctx.stopScheduler).toBeNull();
    ctx.startJobs();
    expect(ctx.stopScheduler).toBeTypeOf('function');
    ctx.stopScheduler?.();
    await ctx.app.close();
  });

  test('fluxo ponta a ponta com fakes: webhook assinado → resposta enviada', async () => {
    const fake = new FakeWhatsApp();
    fake.media.set('media-audio-1', { data: Buffer.from('x'), mime: 'audio/ogg' });
    const ctx = await createAppContext(env, {
      api: fake,
      anthropic: fakeAnthropic('Olá! Já te ajudo.'),
      transcriber: { transcribe: async () => 'quero um gás' },
      clock: () => NOW,
    });
    contexts.push(ctx);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhook',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(body) },
    });
    expect(res.statusCode).toBe(200);

    // O processamento é em segundo plano: espera as 3 falas do cliente serem gravadas.
    await vi.waitFor(
      () => expect((ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE autor = 'cliente'").get() as { n: number }).n).toBe(3),
      { timeout: 5000 },
    );
    await ctx.router.idle();

    expect(fake.sent).toEqual([{ to: '5586999991234', kind: 'text', body: 'Olá! Já te ajudo.' }]);
    const texts = (ctx.db.prepare("SELECT texto FROM messages WHERE autor = 'cliente' ORDER BY id").all() as { texto: string }[]).map((m) => m.texto);
    expect(texts).toContain('quero um gás');
    await ctx.app.close();
  }, 15000);

  test('hasGasDoPovoContext: rascunho recente ou pedido aberto com gas_do_povo', async () => {
    const fake = new FakeWhatsApp();
    const ctx = await createAppContext(env, { api: fake, anthropic: fakeAnthropic('ok'), clock: () => NOW });
    contexts.push(ctx);
    const gdp = { quantidade: 1, modo: 'troca' as const, pagamento: 'gas_do_povo' as const };

    const a = upsertCustomerByPhone(ctx.db, '5586900000001', NOW);
    expect(ctx.hasGasDoPovoContext(a.id)).toBe(false);
    createDraft(ctx.db, a.id, gdp, 0, NOW);
    expect(ctx.hasGasDoPovoContext(a.id)).toBe(true);

    const b = upsertCustomerByPhone(ctx.db, '5586900000002', NOW);
    insertOrder(ctx.db, {
      clienteId: b.id, tipo: 'retirada', quantidade: 1, modo: 'troca', pagamento: 'gas_do_povo', trocoParaCentavos: null,
      endereco: null, unitarioCentavos: 0, cascoCentavos: 0, taxaEntregaCentavos: 0, totalCentavos: 0, status: 'recebido',
      entregadorTelefone: null, precisaRevisao: false, criadoEm: NOW.toISOString(), enviadoEm: null, saiuEm: null, finalizadoEm: null,
    });
    expect(ctx.hasGasDoPovoContext(b.id)).toBe(true);
    await ctx.app.close();
  });

  test('hasGasDoPovoContext: só mencionar Gás do Povo não basta (o número da casa não é apagado)', async () => {
    const fake = new FakeWhatsApp();
    const ctx = await createAppContext(env, { api: fake, anthropic: fakeAnthropic('ok'), clock: () => NOW });
    contexts.push(ctx);
    const a = upsertCustomerByPhone(ctx.db, '5586900000003', NOW);
    insertMessage(ctx.db, {
      clienteId: a.id, autor: 'cliente', tipo: 'texto', texto: 'Quero usar o GÁS DO POVO', wamid: null,
      criadoEm: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    expect(ctx.hasGasDoPovoContext(a.id)).toBe(false);
    await ctx.app.close();
  });
});
