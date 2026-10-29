import { describe, expect, test } from 'vitest';
import { createWhatsAppApi, WhatsAppApiError } from '../../src/whatsapp/api.js';

type Call = { url: string; init: RequestInit };
function setup(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createWhatsAppApi({
    token: 't', phoneNumberId: 'PN', graphVersion: 'v23.0',
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return queue.shift()!; },
  });
  return { api, calls };
}
const ok = (id = 'wamid.1') => new Response(JSON.stringify({ messages: [{ id }] }));
const body = (c: Call) => JSON.parse(String(c.init.body));

describe('createWhatsAppApi', () => {
  test('sendText monta requisição da Cloud API', async () => {
    const { api, calls } = setup([ok()]);
    expect(await api.sendText('5586999991234', 'oi')).toEqual({ wamid: 'wamid.1' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/PN/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(body(calls[0]!)).toEqual({ messaging_product: 'whatsapp', to: '5586999991234', type: 'text', text: { body: 'oi' } });
  });

  test('parâmetro de template sem quebra de linha', async () => {
    const { api, calls } = setup([ok()]);
    await api.sendTemplate('5586999991234', 'pedido_novo', ['a\nb', 'x   y']);
    expect(body(calls[0]!)).toEqual({
      messaging_product: 'whatsapp', to: '5586999991234', type: 'template',
      template: {
        name: 'pedido_novo', language: { code: 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'a · b' }, { type: 'text', text: 'x y' }] }],
      },
    });
  });

  test('template sem parâmetros não manda componentes', async () => {
    const { api, calls } = setup([ok()]);
    await api.sendTemplate('5586999991234', 'oi', []);
    expect(body(calls[0]!).template.components).toBeUndefined();
  });

  test('sendMedia com imagem e legenda', async () => {
    const { api, calls } = setup([ok('wamid.9')]);
    expect(await api.sendMedia('5586999991234', 'image', 'M1', 'legenda')).toEqual({ wamid: 'wamid.9' });
    expect(body(calls[0]!)).toEqual({ messaging_product: 'whatsapp', to: '5586999991234', type: 'image', image: { id: 'M1', caption: 'legenda' } });
  });

  test('resposta não-2xx lança WhatsAppApiError', async () => {
    const { api } = setup([new Response('{"error":"x"}', { status: 400 })]);
    const err = await api.sendText('1', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err.status).toBe(400);
    expect(err.body).toContain('error');
  });

  test('uploadMedia envia multipart e devolve o id', async () => {
    const { api, calls } = setup([new Response(JSON.stringify({ id: 'MID' }))]);
    expect(await api.uploadMedia(Buffer.from('abc'), 'image/jpeg')).toBe('MID');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/PN/media');
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/jpeg');
    expect((form.get('file') as Blob).type).toBe('image/jpeg');
  });

  test('downloadMedia busca a url e baixa com o mesmo token', async () => {
    const { api, calls } = setup([
      new Response(JSON.stringify({ url: 'https://cdn.example/f', mime_type: 'audio/ogg' })),
      new Response(Buffer.from('bytes')),
    ]);
    const r = await api.downloadMedia('M1');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/M1');
    expect(calls[1]!.url).toBe('https://cdn.example/f');
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(r.mime).toBe('audio/ogg');
    expect(r.data.toString()).toBe('bytes');
  });
});
