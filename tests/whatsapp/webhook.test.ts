import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseWebhook, verifySignature } from '../../src/whatsapp/webhook.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}
const sign = (body: Buffer, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const msg = (extra: Record<string, unknown>) => ({
  entry: [{ changes: [{ value: { messages: [{ from: '5586999991234', id: 'wamid.X', timestamp: '1793624400', ...extra }] } }] }],
});

describe('parseWebhook', () => {
  test('texto, áudio, resposta e botão', () => {
    const ev = parseWebhook(fixture('webhook-texto-audio.json'));
    expect(ev.map((e) => e.conteudo.tipo)).toEqual(['texto', 'audio', 'botao']);
    expect(ev[0]).toMatchObject({
      wamid: 'wamid.T1',
      de: '5586999991234',
      respostaA: 'wamid.P',
      nomePerfil: 'Maria',
      conteudo: { tipo: 'texto', texto: 'Quero um gás' },
    });
    expect(ev[0]!.em).toEqual(new Date(1793624400 * 1000));
    expect(ev[1]!.conteudo).toEqual({ tipo: 'audio', mediaId: 'media-audio-1', mime: 'audio/ogg; codecs=opus' });
    expect(ev[2]!.conteudo).toEqual({ tipo: 'botao', texto: 'Sim, confirmar' });
    expect(ev[1]!.respostaA).toBeUndefined();
  });

  test('interactive.button_reply vira botao', () => {
    const [e] = parseWebhook(msg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Pix' } } }));
    expect(e!.conteudo).toEqual({ tipo: 'botao', texto: 'Pix' });
  });

  test('imagem e documento carregam id, mime e legenda', () => {
    const [img] = parseWebhook(msg({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'comprovante' } }));
    expect(img!.conteudo).toEqual({ tipo: 'imagem', mediaId: 'm1', mime: 'image/jpeg', legenda: 'comprovante' });
    const [doc] = parseWebhook(msg({ type: 'document', document: { id: 'm2', mime_type: 'application/pdf' } }));
    expect(doc!.conteudo).toEqual({ tipo: 'documento', mediaId: 'm2', mime: 'application/pdf' });
  });

  test.each(['sticker', 'location', 'contacts'])('%s vira outro', (type) => {
    const [e] = parseWebhook(msg({ type, [type]: {} }));
    expect(e!.conteudo).toEqual({ tipo: 'outro' });
  });

  test('reação é descartada (não vira evento)', () => {
    expect(parseWebhook(msg({ type: 'reaction', reaction: { message_id: 'wamid.P', emoji: '👍' } }))).toEqual([]);
  });

  test('statuses são ignorados e payload inválido dá []', () => {
    expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook('x')).toEqual([]);
    expect(parseWebhook({ entry: 5 })).toEqual([]);
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"a":1}');
  test('aceita assinatura correta e rejeita as demais', () => {
    expect(verifySignature(body, sign(body, 's'), 's')).toBe(true);
    expect(verifySignature(body, sign(body, 'outro'), 's')).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), sign(body, 's'), 's')).toBe(false);
    expect(verifySignature(body, undefined, 's')).toBe(false);
    expect(verifySignature(body, 'sha256=abc', 's')).toBe(false);
    expect(verifySignature(body, sign(body, 's').slice(7), 's')).toBe(false);
  });
});
