import { describe, expect, test } from 'vitest';
import { createWahaApi, createWahaLidResolver, parseWahaWebhook, tituloEDescricao, verifyWahaSecret } from '../../src/whatsapp/waha.js';
import { WhatsAppApiError } from '../../src/whatsapp/api.js';

type Call = { url: string; init: RequestInit };
function setup(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createWahaApi({
    baseUrl: 'http://localhost:3001/',
    apiKey: 'chave',
    session: 'default',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return queue.shift()!;
    },
  });
  return { api, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
// A checagem de número vem antes de cada envio para um número novo.
const existe = (chatId = '558694264580@c.us') => json({ numberExists: true, chatId });
const body = (c: Call) => JSON.parse(String(c.init.body));
const header = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

describe('createWahaApi', () => {
  test('sendText usa o chatId resolvido pelo WAHA e manda a chave', async () => {
    const { api, calls } = setup([existe('558694264580@c.us'), json({ id: 'true_5586@c.us_ABC' })]);
    expect(await api.sendText('5586994264580', 'oi')).toEqual({ wamid: 'true_5586@c.us_ABC' });
    expect(calls[0]!.url).toBe('http://localhost:3001/api/contacts/check-exists?phone=5586994264580&session=default');
    expect(calls[1]!.url).toBe('http://localhost:3001/api/sendText');
    expect(header(calls[1]!, 'X-Api-Key')).toBe('chave');
    expect(body(calls[1]!)).toEqual({ session: 'default', chatId: '558694264580@c.us', text: 'oi' });
  });

  test('guarda o chatId: segundo envio ao mesmo número não repete a checagem', async () => {
    const { api, calls } = setup([existe(), json({ id: 'a' }), json({ id: 'b' })]);
    await api.sendText('558694264580', '1');
    await api.sendText('558694264580', '2');
    expect(calls.map((c) => c.url.split('/api/')[1])).toEqual([
      'contacts/check-exists?phone=558694264580&session=default',
      'sendText',
      'sendText',
    ]);
  });

  test('se a checagem falhar, tenta o número como veio', async () => {
    const { api, calls } = setup([json({}, 500), json({ id: 'a' })]);
    await api.sendText('558694264580', 'oi');
    expect(body(calls[1]!).chatId).toBe('558694264580@c.us');
  });

  test('id da resposta em formatos diferentes, ou ausente, não derruba o envio', async () => {
    const { api } = setup([existe(), json({ id: { _serialized: 'x1' } }), json({ _data: { id: { _serialized: 'x2' } } }), json({})]);
    expect((await api.sendText('558694264580', 'a')).wamid).toBe('x1');
    expect((await api.sendText('558694264580', 'b')).wamid).toBe('x2');
    expect((await api.sendText('558694264580', 'c')).wamid).toMatch(/^waha\./);
  });

  test('erro HTTP vira WhatsAppApiError', async () => {
    const { api } = setup([existe(), json({ message: 'sessão parada' }, 422)]);
    await expect(api.sendText('558694264580', 'oi')).rejects.toBeInstanceOf(WhatsAppApiError);
  });

  test('opções viram a lista do WAHA, com o botão "Clica aqui"', async () => {
    const { api, calls } = setup([existe(), json({ id: 'l1' })]);
    expect(await api.sendChoices('558694264580', 'Paga como?', ['Dinheiro', 'Cartão'])).toEqual({ wamid: 'l1' });
    expect(calls[1]!.url).toBe('http://localhost:3001/api/sendList');
    expect(body(calls[1]!)).toEqual({
      session: 'default',
      chatId: '558694264580@c.us',
      message: {
        title: 'Paga como?',
        description: 'Toque no botão abaixo para escolher.',
        button: 'Clica aqui',
        sections: [
          {
            title: 'Opções',
            rows: [
              { title: 'Dinheiro', rowId: 'opcao_1', description: null },
              { title: 'Cartão', rowId: 'opcao_2', description: null },
            ],
          },
        ],
      },
    });
  });

  test('modelo de mensagem não existe no WAHA', async () => {
    const { api } = setup([]);
    await expect(api.sendTemplate('558694264580', 'x', [])).rejects.toBeInstanceOf(WhatsAppApiError);
  });

  test('imagem enviada em base64 depois do upload em memória', async () => {
    const { api, calls } = setup([existe(), json({ id: 'm1' })]);
    const id = await api.uploadMedia(Buffer.from('abc'), 'image/jpeg');
    await api.sendMedia('558694264580', 'image', id, 'Comprovante');
    expect(calls[1]!.url).toBe('http://localhost:3001/api/sendImage');
    expect(body(calls[1]!)).toEqual({
      session: 'default',
      chatId: '558694264580@c.us',
      file: { mimetype: 'image/jpeg', filename: 'imagem', data: Buffer.from('abc').toString('base64') },
      caption: 'Comprovante',
    });
  });

  test('documento usa sendFile; mídia desconhecida dá erro', async () => {
    const { api, calls } = setup([existe(), json({ id: 'm1' })]);
    const id = await api.uploadMedia(Buffer.from('pdf'), 'application/pdf');
    await api.sendMedia('558694264580', 'document', id);
    expect(calls[1]!.url).toBe('http://localhost:3001/api/sendFile');
    await expect(api.sendMedia('558694264580', 'image', 'nao-existe')).rejects.toBeInstanceOf(WhatsAppApiError);
  });

  test('download usa só o caminho da URL, no endereço configurado, com a chave', async () => {
    const { api, calls } = setup([new Response(Buffer.from('audio'), { headers: { 'content-type': 'audio/ogg; codecs=opus' } })]);
    const r = await api.downloadMedia('http://localhost:8000/api/files/default/abc.oga');
    expect(calls[0]!.url).toBe('http://localhost:3001/api/files/default/abc.oga');
    expect(header(calls[0]!, 'X-Api-Key')).toBe('chave');
    expect(r.mime).toBe('audio/ogg');
    expect(r.data.toString()).toBe('audio');
  });
});

const msg = (payload: Record<string, unknown>, event = 'message') => ({
  event,
  session: 'default',
  payload: {
    id: 'false_558694264580@c.us_AAA',
    timestamp: 1793404800,
    from: '558694264580@c.us',
    fromMe: false,
    body: 'oi',
    hasMedia: false,
    ...payload,
  },
});

describe('parseWahaWebhook', () => {
  test('texto → evento com número só em dígitos, nome e horário', () => {
    const { events } = parseWahaWebhook(msg({ _data: { notifyName: 'Gabriel' } }));
    expect(events).toEqual([
      {
        wamid: 'false_558694264580@c.us_AAA',
        de: '558694264580',
        nomePerfil: 'Gabriel',
        em: new Date(1793404800_000),
        conteudo: { tipo: 'texto', texto: 'oi' },
      },
    ]);
  });

  test('GOWS: nome do perfil vem em Info.PushName, e a escolha da lista chega como texto', () => {
    const r = parseWahaWebhook(msg({ body: 'Dinheiro', _data: { Info: { PushName: 'Gabriel' } }, replyTo: { id: 'l1' } }));
    expect(r.events[0]).toMatchObject({ nomePerfil: 'Gabriel', respostaA: 'l1', conteudo: { tipo: 'texto', texto: 'Dinheiro' } });
  });

  test('áudio, imagem com legenda e documento', () => {
    const m = (mimetype: string, body = '') =>
      parseWahaWebhook(msg({ hasMedia: true, body, media: { url: 'http://x/api/files/a', mimetype } })).events[0]!.conteudo;
    expect(m('audio/ogg; codecs=opus')).toEqual({ tipo: 'audio', mediaId: 'http://x/api/files/a', mime: 'audio/ogg; codecs=opus' });
    expect(m('image/jpeg', 'pix')).toEqual({ tipo: 'imagem', mediaId: 'http://x/api/files/a', mime: 'image/jpeg', legenda: 'pix' });
    expect(m('application/pdf')).toEqual({ tipo: 'documento', mediaId: 'http://x/api/files/a', mime: 'application/pdf' });
  });

  test('mídia que o WAHA não baixou (url nula) vira "outro"', () => {
    const r = parseWahaWebhook(msg({ hasMedia: true, media: { url: null, mimetype: 'audio/ogg' } }));
    expect(r.events[0]!.conteudo).toEqual({ tipo: 'outro' });
  });

  test('ignora mensagem enviada por nós, grupo, outro evento e lixo', () => {
    expect(parseWahaWebhook(msg({ fromMe: true })).events).toEqual([]);
    expect(parseWahaWebhook(msg({ from: '1203@g.us' })).events).toEqual([]);
    expect(parseWahaWebhook(msg({}, 'session.status')).events).toEqual([]);
    expect(parseWahaWebhook(null).events).toEqual([]);
    expect(parseWahaWebhook({ event: 'message', payload: { id: 1 } }).events).toEqual([]);
  });

  test('contato @lid vira pendente: tudo pronto, falta só o telefone', () => {
    const r = parseWahaWebhook(msg({ from: '123456@lid', _data: { notifyName: 'Gabriel' } }));
    expect(r.events).toEqual([]);
    expect(r.lids).toEqual([
      {
        lid: '123456@lid',
        evento: { wamid: 'false_558694264580@c.us_AAA', nomePerfil: 'Gabriel', em: new Date(1793404800_000), conteudo: { tipo: 'texto', texto: 'oi' } },
      },
    ]);
  });
});

describe('tituloEDescricao', () => {
  test('resumo: o título perde os asteriscos e o corpo continua com a formatação', () => {
    expect(tituloEDescricao('🧾 *Resumo do pedido*\n\n💰 *Total: R$ 120,00*\n\nPosso confirmar?')).toEqual({
      title: '🧾 Resumo do pedido',
      description: '💰 *Total: R$ 120,00*\n\nPosso confirmar?',
    });
  });

  test('uma linha só vira título, e o corpo nunca fica vazio', () => {
    expect(tituloEDescricao('Como prefere pagar?')).toEqual({ title: 'Como prefere pagar?', description: 'Toque no botão abaixo para escolher.' });
  });

  test('primeira linha longa fica no corpo, com título genérico', () => {
    const longa = 'x'.repeat(61);
    expect(tituloEDescricao(longa)).toEqual({ title: 'Escolha uma opção', description: longa });
  });
});

describe('createWahaLidResolver', () => {
  const mk = (responses: Response[]) => {
    const urls: string[] = [];
    const queue = [...responses];
    const resolve = createWahaLidResolver({
      baseUrl: 'http://localhost:3001',
      apiKey: 'chave',
      session: 'default',
      fetch: async (url) => {
        urls.push(String(url));
        return queue.shift()!;
      },
    });
    return { resolve, urls };
  };

  test('devolve só os dígitos do telefone e guarda o resultado', async () => {
    const { resolve, urls } = mk([json({ lid: '1@lid', pn: '558694264580@c.us' })]);
    expect(await resolve('1@lid')).toBe('558694264580');
    expect(await resolve('1@lid')).toBe('558694264580');
    expect(urls).toEqual(['http://localhost:3001/api/default/lids/1%40lid']);
  });

  test('sem telefone conhecido, ou com erro, devolve undefined', async () => {
    expect(await mk([json({ lid: '1@lid', pn: null })]).resolve('1@lid')).toBeUndefined();
    expect(await mk([json({}, 404)]).resolve('1@lid')).toBeUndefined();
    const quebrado = createWahaLidResolver({
      baseUrl: 'http://x',
      session: 's',
      fetch: async () => {
        throw new Error('rede');
      },
    });
    expect(await quebrado('1@lid')).toBeUndefined();
  });
});

describe('verifyWahaSecret', () => {
  test('só aceita o segredo exato', () => {
    expect(verifyWahaSecret('abc', 'abc')).toBe(true);
    expect(verifyWahaSecret('abd', 'abc')).toBe(false);
    expect(verifyWahaSecret('abcd', 'abc')).toBe(false);
    expect(verifyWahaSecret(undefined, 'abc')).toBe(false);
  });
});
