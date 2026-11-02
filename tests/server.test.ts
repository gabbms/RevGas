import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/server.js';
import type { InboundEvent } from '../src/whatsapp/webhook.js';

const env = loadEnv({
  PUBLIC_URL: 'https://x.test',
  WA_TOKEN: 't',
  WA_PHONE_NUMBER_ID: '1',
  WA_APP_SECRET: 'segredo',
  WA_VERIFY_TOKEN: 'VT',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'k',
  PANEL_PASSWORD: 'senha-longa-12',
  SESSION_SECRET: 'x'.repeat(32),
});
const body = readFileSync(new URL('./fixtures/webhook-texto-audio.json', import.meta.url));
const sig = (b: Buffer, secret = 'segredo') => 'sha256=' + createHmac('sha256', secret).update(b).digest('hex');
const post = (app: FastifyInstance, payload: Buffer, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', ...headers } });

describe('server', () => {
  test('GET /webhook verificação', async () => {
    const app = await buildApp({ env, onInbound: async () => {} });
    const ok = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('42');
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    const bad = await app.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42' });
    expect(bad.statusCode).toBe(403);
    const noMode = await app.inject({ method: 'GET', url: '/webhook?hub.verify_token=VT&hub.challenge=42' });
    expect(noMode.statusCode).toBe(403);
  });

  test('POST com assinatura inválida ou ausente → 401, sem onInbound', async () => {
    const onInbound = vi.fn(async () => {});
    const app = await buildApp({ env, onInbound });
    expect((await post(app, body, { 'x-hub-signature-256': sig(body, 'errado') })).statusCode).toBe(401);
    expect((await post(app, body, {})).statusCode).toBe(401);
    expect(onInbound).not.toHaveBeenCalled();
  });

  test('POST com assinatura válida → 200 e onInbound recebe os eventos', async () => {
    const received: InboundEvent[][] = [];
    const app = await buildApp({ env, onInbound: async (ev) => void received.push(ev) });
    const res = await post(app, body, { 'x-hub-signature-256': sig(body) });
    expect(res.statusCode).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.map((e) => e.conteudo.tipo)).toEqual(['texto', 'audio', 'botao']);
  });

  test('responde 200 sem esperar onInbound e engole erros dele', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = await buildApp({
      env,
      onInbound: async () => {
        await gate;
        throw new Error('falhou');
      },
    });
    const res = await post(app, body, { 'x-hub-signature-256': sig(body) });
    expect(res.statusCode).toBe(200);
    release();
    await new Promise((r) => setTimeout(r, 10)); // sem unhandled rejection
  });

  test('JSON inválido com assinatura válida → 400', async () => {
    const bad = Buffer.from('{nope');
    const onInbound = vi.fn(async () => {});
    const app = await buildApp({ env, onInbound });
    expect((await post(app, bad, { 'x-hub-signature-256': sig(bad) })).statusCode).toBe(400);
    expect((await post(app, bad, { 'x-hub-signature-256': sig(bad, 'errado') })).statusCode).toBe(401);
    expect(onInbound).not.toHaveBeenCalled();
  });

  test('GET /healthz e registerPanel', async () => {
    const registerPanel = vi.fn(async (a: FastifyInstance) => {
      a.get('/painel', async () => 'ok');
    });
    const app = await buildApp({ env, onInbound: async () => {}, registerPanel });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect(registerPanel).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'GET', url: '/painel' })).body).toBe('ok');
  });

  describe('WAHA', () => {
    const wahaEnv = loadEnv({
      PUBLIC_URL: 'https://x.test',
      WA_PROVIDER: 'waha',
      WAHA_URL: 'http://localhost:3001',
      WAHA_WEBHOOK_SECRET: 'seg',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      PANEL_PASSWORD: 'senha-longa-12',
      SESSION_SECRET: 'x'.repeat(32),
    });
    const payload = {
      event: 'message',
      session: 'default',
      payload: { id: 'm1', timestamp: 1793404800, from: '558694264580@c.us', fromMe: false, body: 'oi', hasMedia: false },
    };
    const enviar = (app: FastifyInstance, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/webhook/waha', payload, headers });

    test('segredo certo → 200 e onInbound recebe a mensagem', async () => {
      const received: InboundEvent[][] = [];
      const app = await buildApp({ env: wahaEnv, onInbound: async (ev) => void received.push(ev) });
      expect((await enviar(app, { 'x-revgas-secret': 'seg' })).statusCode).toBe(200);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]![0]).toMatchObject({ de: '558694264580', conteudo: { tipo: 'texto', texto: 'oi' } });
    });

    test('contato @lid: o telefone é resolvido antes de entregar; sem telefone, a mensagem é descartada', async () => {
      const lid = { ...payload, payload: { ...payload.payload, from: '999@lid' } };
      const post = (app: FastifyInstance) =>
        app.inject({ method: 'POST', url: '/webhook/waha', payload: lid, headers: { 'x-revgas-secret': 'seg' } });
      const received: InboundEvent[][] = [];
      const app = await buildApp({ env: wahaEnv, onInbound: async (ev) => void received.push(ev), resolveLid: async () => '558694264580' });
      expect((await post(app)).statusCode).toBe(200);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]![0]).toMatchObject({ de: '558694264580' });

      const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onInbound = vi.fn(async () => {});
      const sem = await buildApp({ env: wahaEnv, onInbound, resolveLid: async () => undefined });
      expect((await post(sem)).statusCode).toBe(200);
      await vi.waitFor(() => expect(aviso).toHaveBeenCalled());
      expect(onInbound).not.toHaveBeenCalled();
      aviso.mockRestore();
    });

    test('segredo errado ou ausente → 401, sem onInbound', async () => {
      const onInbound = vi.fn(async () => {});
      const app = await buildApp({ env: wahaEnv, onInbound });
      expect((await enviar(app, { 'x-revgas-secret': 'errado' })).statusCode).toBe(401);
      expect((await enviar(app, {})).statusCode).toBe(401);
      expect(onInbound).not.toHaveBeenCalled();
    });

    test('com WAHA ligado as rotas da Meta não existem; com a Meta a rota do WAHA não existe', async () => {
      const waha = await buildApp({ env: wahaEnv, onInbound: async () => {} });
      const q = '/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=1';
      expect((await waha.inject({ method: 'GET', url: q })).statusCode).toBe(404);
      const meta = await buildApp({ env, onInbound: async () => {} });
      expect((await enviar(meta, { 'x-revgas-secret': 'seg' })).statusCode).toBe(404);
    });
  });
});
