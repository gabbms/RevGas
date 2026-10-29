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
const sig = (b: Buffer, secret = env.WA_APP_SECRET) => 'sha256=' + createHmac('sha256', secret).update(b).digest('hex');
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
});
