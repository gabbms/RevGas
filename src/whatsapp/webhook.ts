import { createHmac, timingSafeEqual } from 'node:crypto';

export type InboundContent =
  | { tipo: 'texto' | 'botao'; texto: string }
  | { tipo: 'audio'; mediaId: string; mime: string }
  | { tipo: 'imagem' | 'documento'; mediaId: string; mime: string; legenda?: string }
  | { tipo: 'outro' };

export type InboundEvent = {
  wamid: string;
  de: string;
  nomePerfil?: string;
  em: Date;
  respostaA?: string;
  conteudo: InboundContent;
};

/** Confere `sha256=<hmac hex>` do corpo cru, em tempo constante. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function media(m: Obj, key: string): { mediaId: string; mime: string; legenda?: string } | undefined {
  const o = m[key];
  if (!isObj(o)) return undefined;
  const mediaId = str(o.id);
  if (!mediaId) return undefined;
  const legenda = str(o.caption);
  return { mediaId, mime: str(o.mime_type) ?? '', ...(legenda ? { legenda } : {}) };
}

function parseContent(m: Obj): InboundContent {
  switch (m.type) {
    case 'text': {
      const texto = isObj(m.text) ? str(m.text.body) : undefined;
      return texto === undefined ? { tipo: 'outro' } : { tipo: 'texto', texto };
    }
    case 'button': {
      const texto = isObj(m.button) ? str(m.button.text) : undefined;
      return texto === undefined ? { tipo: 'outro' } : { tipo: 'botao', texto };
    }
    case 'interactive': {
      const reply = isObj(m.interactive) && isObj(m.interactive.button_reply) ? m.interactive.button_reply : undefined;
      const texto = reply ? str(reply.title) : undefined;
      return texto === undefined ? { tipo: 'outro' } : { tipo: 'botao', texto };
    }
    case 'audio': {
      const a = media(m, 'audio');
      return a ? { tipo: 'audio', mediaId: a.mediaId, mime: a.mime } : { tipo: 'outro' };
    }
    case 'image': {
      const a = media(m, 'image');
      return a ? { tipo: 'imagem', ...a } : { tipo: 'outro' };
    }
    case 'document': {
      const a = media(m, 'document');
      return a ? { tipo: 'documento', ...a } : { tipo: 'outro' };
    }
    default:
      return { tipo: 'outro' };
  }
}

/** Extrai as mensagens recebidas de um payload da Cloud API; ignora `statuses` e payloads inválidos. */
export function parseWebhook(payload: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  if (!isObj(payload)) return out;
  for (const entry of list(payload.entry)) {
    if (!isObj(entry)) continue;
    for (const change of list(entry.changes)) {
      if (!isObj(change) || !isObj(change.value)) continue;
      const value = change.value;
      const contact = value.contacts !== undefined ? list(value.contacts)[0] : undefined;
      const nomePerfil = isObj(contact) && isObj(contact.profile) ? str(contact.profile.name) : undefined;
      for (const m of list(value.messages)) {
        if (!isObj(m)) continue;
        const wamid = str(m.id);
        const de = str(m.from);
        const ts = Number(m.timestamp);
        if (!wamid || !de || !Number.isFinite(ts)) continue;
        const respostaA = isObj(m.context) ? str(m.context.id) : undefined;
        out.push({
          wamid,
          de,
          ...(nomePerfil ? { nomePerfil } : {}),
          em: new Date(ts * 1000),
          ...(respostaA ? { respostaA } : {}),
          conteudo: parseContent(m),
        });
      }
    }
  }
  return out;
}
