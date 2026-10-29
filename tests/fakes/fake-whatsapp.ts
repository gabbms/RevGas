import type { WhatsAppApi } from '../../src/whatsapp/api.js';

export type SentMessage =
  | { to: string; kind: 'text'; body: string }
  | { to: string; kind: 'template'; name: string; params: string[] }
  | { to: string; kind: 'image' | 'document'; mediaId: string; caption?: string };

/** Fake em memória de WhatsAppApi. Registra tudo em `sent`/`uploads`. */
export class FakeWhatsApp implements WhatsAppApi {
  sent: SentMessage[] = [];
  uploads: { data: Buffer; mime: string; mediaId: string }[] = [];
  /** Mídias que `downloadMedia` devolve, por mediaId. */
  media = new Map<string, { data: Buffer; mime: string }>();
  private counter = 0;
  private nextError: Error | null = null;

  /** A próxima chamada a qualquer método lança `err`. */
  failNext(err: Error): void {
    this.nextError = err;
  }

  private step(): string {
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    return `wamid.${++this.counter}`;
  }

  async sendText(to: string, body: string) {
    const wamid = this.step();
    this.sent.push({ to, kind: 'text', body });
    return { wamid };
  }

  async sendTemplate(to: string, name: string, params: string[]) {
    const wamid = this.step();
    this.sent.push({ to, kind: 'template', name, params });
    return { wamid };
  }

  async sendMedia(to: string, kind: 'image' | 'document', mediaId: string, caption?: string) {
    const wamid = this.step();
    this.sent.push({ to, kind, mediaId, ...(caption !== undefined ? { caption } : {}) });
    return { wamid };
  }

  async uploadMedia(data: Buffer, mime: string) {
    this.step();
    const mediaId = `media.${this.uploads.length + 1}`;
    this.uploads.push({ data, mime, mediaId });
    return mediaId;
  }

  async downloadMedia(mediaId: string) {
    this.step();
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`mídia desconhecida no fake: ${mediaId}`);
    return m;
  }
}
