import { createHash, timingSafeEqual } from 'node:crypto';
import { WhatsAppApiError, type WhatsAppApi } from './api.js';
import type { InboundContent, InboundEvent } from './webhook.js';

// WAHA (https://waha.devlike.pro) liga um número de WhatsApp comum, lido por QR code. Não é a API
// oficial da Meta: serve para teste e demonstração, e o número pode ser banido. Em produção, use a
// Cloud API (WA_PROVIDER=meta). Este arquivo só traduz entre o WAHA e as interfaces do bot.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const MAX_UPLOADS_EM_MEMORIA = 20;

export function createWahaApi(o: { baseUrl: string; apiKey?: string; session: string; fetch?: typeof fetch }): WhatsAppApi {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const auth: Record<string, string> = o.apiKey ? { 'X-Api-Key': o.apiKey } : {};
  const uploads = new Map<string, { data: Buffer; mime: string }>();
  let contador = 0;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(url, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) throw new WhatsAppApiError(res.status, await res.text());
    return res;
  }

  async function post(path: string, body: Record<string, unknown>): Promise<{ wamid: string }> {
    const res = await request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: o.session, ...body }),
    });
    return { wamid: messageId(await res.json().catch(() => undefined)) };
  }

  // Números brasileiros antigos não têm o 9º dígito no WhatsApp; o WAHA diz qual é o endereço certo.
  const chatIds = new Map<string, string>();
  async function chatId(to: string): Promise<string> {
    const digits = to.replace(/\D/g, '');
    const guardado = chatIds.get(digits);
    if (guardado) return guardado;
    let resolvido = `${digits}@c.us`;
    try {
      const res = await request(`${base}/api/contacts/check-exists?phone=${digits}&session=${encodeURIComponent(o.session)}`);
      const j: unknown = await res.json();
      if (isObj(j) && j.numberExists === true && typeof j.chatId === 'string') resolvido = j.chatId;
    } catch {
      // Sem a checagem, tenta o número como veio.
    }
    chatIds.set(digits, resolvido);
    return resolvido;
  }

  return {
    async sendText(to, body) {
      return post('/api/sendText', { chatId: await chatId(to), text: body });
    },

    async sendTemplate() {
      throw new WhatsAppApiError(501, 'modelos de mensagem não existem no WAHA');
    },

    async sendMedia(to, kind, mediaId, caption) {
      const up = uploads.get(mediaId);
      if (!up) throw new WhatsAppApiError(404, `mídia desconhecida: ${mediaId}`);
      const file = { mimetype: up.mime, filename: kind === 'image' ? 'imagem' : 'documento', data: up.data.toString('base64') };
      return post(kind === 'image' ? '/api/sendImage' : '/api/sendFile', {
        chatId: await chatId(to),
        file,
        ...(caption !== undefined ? { caption } : {}),
      });
    },

    async uploadMedia(data, mime) {
      const id = `waha-up-${++contador}`;
      uploads.set(id, { data, mime });
      if (uploads.size > MAX_UPLOADS_EM_MEMORIA) uploads.delete(uploads.keys().next().value as string);
      return id;
    },

    async downloadMedia(mediaId) {
      // `mediaId` é a URL que o WAHA mandou no webhook. Só o caminho é usado: o endereço do WAHA vem da
      // configuração, porque o que ele informa ("localhost") pode não valer fora do contêiner.
      const u = new URL(mediaId);
      const res = await request(`${base}${u.pathname}${u.search}`);
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      return { data: Buffer.from(await res.arrayBuffer()), mime };
    },
  };
}

/**
 * Contatos novos do WhatsApp chegam como `<número>@lid` (identificador sem telefone). O WAHA sabe o telefone
 * de cada um (`/api/<sessão>/lids/<lid>`). Devolve só os dígitos, ou `undefined` se não souber.
 */
export function createWahaLidResolver(o: { baseUrl: string; apiKey?: string; session: string; fetch?: typeof fetch }) {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, string>();
  return async (lid: string): Promise<string | undefined> => {
    const guardado = cache.get(lid);
    if (guardado) return guardado;
    try {
      const res = await doFetch(`${base}/api/${encodeURIComponent(o.session)}/lids/${encodeURIComponent(lid)}`, {
        headers: o.apiKey ? { 'X-Api-Key': o.apiKey } : {},
      });
      if (!res.ok) return undefined;
      const j: unknown = await res.json();
      const pn = isObj(j) ? str(j.pn) : undefined;
      const digitos = pn?.endsWith('@c.us') ? pn.slice(0, -'@c.us'.length).replace(/\D/g, '') : '';
      if (digitos === '') return undefined;
      cache.set(lid, digitos);
      return digitos;
    } catch {
      return undefined;
    }
  };
}

/** O id da mensagem enviada muda de forma entre versões do WAHA; se nada servir, gera um (o envio já deu certo). */
function messageId(json: unknown): string {
  if (isObj(json)) {
    const id = json.id;
    if (typeof id === 'string') return id;
    if (isObj(id) && typeof id._serialized === 'string') return id._serialized;
    const data = json._data;
    if (isObj(data) && isObj(data.id) && typeof data.id._serialized === 'string') return data.id._serialized;
  }
  return `waha.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

/** Compara o segredo do cabeçalho com o configurado, em tempo constante. */
export function verifyWahaSecret(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const h = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(header), h(secret));
}

function parseContent(p: Obj): InboundContent {
  const body = str(p.body) ?? '';
  if (p.hasMedia === true) {
    const media = isObj(p.media) ? p.media : undefined;
    const url = media ? str(media.url) : undefined;
    if (!url) return { tipo: 'outro' }; // WAHA não baixou o arquivo (WHATSAPP_DOWNLOAD_MEDIA desligado ou falhou)
    const mime = (media ? str(media.mimetype) : undefined) ?? '';
    if (mime.startsWith('audio/')) return { tipo: 'audio', mediaId: url, mime };
    const legenda = body.trim() !== '' ? { legenda: body } : {};
    return mime.startsWith('image/')
      ? { tipo: 'imagem', mediaId: url, mime, ...legenda }
      : { tipo: 'documento', mediaId: url, mime, ...legenda };
  }
  return body.trim() === '' ? { tipo: 'outro' } : { tipo: 'texto', texto: body };
}

/** Mensagem de um contato `@lid`: falta só descobrir o telefone (`createWahaLidResolver`). */
export type LidPendente = { lid: string; evento: Omit<InboundEvent, 'de'> };

/**
 * Extrai a mensagem recebida de um evento `message` do WAHA. Ignora mensagens enviadas por nós, de grupos
 * e eventos de outro tipo. Contatos `@lid` (sem telefone) vêm em `lids`, para o servidor resolver.
 */
export function parseWahaWebhook(body: unknown): { events: InboundEvent[]; lids: LidPendente[] } {
  const vazio = { events: [], lids: [] };
  if (!isObj(body) || body.event !== 'message' || !isObj(body.payload)) return vazio;
  const p = body.payload;
  if (p.fromMe === true) return vazio;
  const wamid = str(p.id);
  const from = str(p.from);
  const ts = Number(p.timestamp);
  if (!wamid || !from || !Number.isFinite(ts)) return vazio;
  const ehLid = from.endsWith('@lid');
  if (!ehLid && !from.endsWith('@c.us')) return vazio;
  const de = ehLid ? '' : from.slice(0, -'@c.us'.length).replace(/\D/g, '');
  if (!ehLid && de === '') return vazio;
  const data = isObj(p._data) ? p._data : undefined;
  const nomePerfil = data ? str(data.notifyName) : undefined;
  const respostaA = isObj(p.replyTo) ? str(p.replyTo.id) : undefined;
  const evento = {
    wamid,
    ...(nomePerfil ? { nomePerfil } : {}),
    em: new Date(ts * 1000),
    ...(respostaA ? { respostaA } : {}),
    conteudo: parseContent(p),
  };
  return ehLid ? { events: [], lids: [{ lid: from, evento }] } : { events: [{ ...evento, de }], lids: [] };
}
