export interface WhatsAppApi {
  sendText(to: string, body: string): Promise<{ wamid: string }>;
  sendTemplate(to: string, name: string, params: string[]): Promise<{ wamid: string }>;
  sendMedia(to: string, kind: 'image' | 'document', mediaId: string, caption?: string): Promise<{ wamid: string }>;
  uploadMedia(data: Buffer, mime: string): Promise<string>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }>;
}

export class WhatsAppApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`WhatsApp API ${status}: ${body.slice(0, 300)}`);
    this.name = 'WhatsAppApiError';
  }
}

/** Parâmetros de modelo não aceitam quebra de linha nem espaços repetidos. */
function sanitizeTemplateParam(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' · ').replace(/[ \t]{2,}/g, ' ').trim();
}

export function createWhatsAppApi(o: {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetch?: typeof fetch;
}): WhatsAppApi {
  const doFetch = o.fetch ?? fetch;
  const base = `https://graph.facebook.com/${o.graphVersion}`;
  const auth = { Authorization: `Bearer ${o.token}` };

  async function request(url: string, init: RequestInit): Promise<Response> {
    const res = await doFetch(url, init);
    if (!res.ok) throw new WhatsAppApiError(res.status, await res.text());
    return res;
  }

  async function postMessage(payload: Record<string, unknown>): Promise<{ wamid: string }> {
    const res = await request(`${base}/${o.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const json = (await res.json()) as { messages?: { id: string }[] };
    const wamid = json.messages?.[0]?.id;
    if (!wamid) throw new WhatsAppApiError(res.status, 'resposta sem id de mensagem');
    return { wamid };
  }

  return {
    sendText: (to, body) => postMessage({ to, type: 'text', text: { body } }),

    sendTemplate: (to, name, params) =>
      postMessage({
        to,
        type: 'template',
        template: {
          name,
          language: { code: 'pt_BR' },
          ...(params.length > 0
            ? { components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: sanitizeTemplateParam(p) })) }] }
            : {}),
        },
      }),

    sendMedia: (to, kind, mediaId, caption) =>
      postMessage({ to, type: kind, [kind]: { id: mediaId, ...(caption !== undefined ? { caption } : {}) } }),

    async uploadMedia(data, mime) {
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', mime);
      form.set('file', new Blob([new Uint8Array(data)], { type: mime }), 'arquivo');
      const res = await request(`${base}/${o.phoneNumberId}/media`, { method: 'POST', headers: auth, body: form });
      return ((await res.json()) as { id: string }).id;
    },

    async downloadMedia(mediaId) {
      const meta = (await (await request(`${base}/${mediaId}`, { headers: auth })).json()) as { url: string; mime_type: string };
      const file = await request(meta.url, { headers: auth });
      return { data: Buffer.from(await file.arrayBuffer()), mime: meta.mime_type };
    },
  };
}
