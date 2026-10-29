import { describe, expect, test } from 'vitest';
import { createOpenAITranscriber } from '../../src/audio/transcriber.js';

describe('transcriber', () => {
  test('envia multipart com language=pt', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fakeFetch = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ text: 'quero um gás' }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = createOpenAITranscriber({ apiKey: 'k', model: 'whisper-1', fetch: fakeFetch });
    const text = await t.transcribe(Buffer.from('abc'), 'audio/ogg; codecs=opus');
    expect(text).toBe('quero um gás');
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const form = init!.body as FormData;
    expect(form.get('language')).toBe('pt');
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  test('mime desconhecido usa audio.bin', async () => {
    let form!: FormData;
    const fakeFetch = (async (_u: string, i: RequestInit) => {
      form = i.body as FormData;
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await createOpenAITranscriber({ apiKey: 'k', model: 'm', fetch: fakeFetch }).transcribe(Buffer.from('a'), 'application/x-foo');
    expect((form.get('file') as File).name).toBe('audio.bin');
  });

  test('status não-2xx lança', async () => {
    const fakeFetch = (async () => new Response('erro', { status: 500 })) as unknown as typeof fetch;
    await expect(
      createOpenAITranscriber({ apiKey: 'k', model: 'm', fetch: fakeFetch }).transcribe(Buffer.from('a'), 'audio/ogg'),
    ).rejects.toThrow();
  });
});
