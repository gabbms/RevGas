import { baseMime, type Transcriber } from '../audio/transcriber.js';
import type { Db } from '../db/connection.js';
import type { Customer } from '../store/customers.js';
import { insertMessage } from '../store/messages.js';
import { openOrdersFor, orderRecipients } from '../store/orders.js';
import type { WhatsAppApi } from '../whatsapp/api.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import type { InboundEvent } from '../whatsapp/webhook.js';
import { defaultContentToText, type RouterDeps } from './router.js';

const APOLOGY = 'Não consegui ouvir seu áudio 😕 Pode escrever pra mim?';

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'erro');

export function createContentToText(d: {
  db: Db;
  api: WhatsAppApi;
  transcriber: Transcriber;
  outbox: ReturnType<typeof createOutbox>;
  clock?: () => Date;
}): RouterDeps['contentToText'] {
  const clock = d.clock ?? (() => new Date());

  async function audioFailure(ev: InboundEvent, c: Customer): Promise<null> {
    // O roteador não grava nada quando recebe null, então gravamos aqui (uma única vez).
    insertMessage(d.db, {
      clienteId: c.id,
      autor: 'cliente',
      tipo: 'audio',
      texto: '[áudio não transcrito]',
      wamid: ev.wamid,
      criadoEm: ev.em.toISOString(),
    });
    const r = await d.outbox.send({ telefone: ev.de, texto: APOLOGY });
    if (r.ok) {
      insertMessage(d.db, {
        clienteId: c.id,
        autor: 'bot',
        tipo: 'texto',
        texto: APOLOGY,
        wamid: r.wamid,
        criadoEm: clock().toISOString(),
      });
    }
    return null;
  }

  return async (ev, c) => {
    const content = ev.conteudo;

    if (content.tipo === 'audio') {
      let text: string;
      try {
        const { data, mime } = await d.api.downloadMedia(content.mediaId);
        text = (await d.transcriber.transcribe(data, mime || content.mime)).trim();
      } catch (err) {
        console.error('áudio: falha na transcrição', ev.wamid, errName(err));
        return audioFailure(ev, c);
      }
      if (text === '') {
        console.error('áudio: transcrição vazia', ev.wamid);
        return audioFailure(ev, c);
      }
      return { tipo: 'audio', texto: text };
    }

    if (content.tipo === 'imagem' || content.tipo === 'documento') {
      const order = openOrdersFor(d.db, c.id)
        .filter((o) => o.pagamento === 'pix_antecipado')
        .at(-1);
      if (order) {
        try {
          const { data, mime } = await d.api.downloadMedia(content.mediaId);
          const mediaId = await d.api.uploadMedia(data, baseMime(mime || content.mime));
          const kind = content.tipo === 'imagem' ? 'image' : 'document';
          const caption = `Comprovante Pix do pedido #${order.id}`;
          let delivered = 0;
          for (const phone of orderRecipients(d.db, order.id)) {
            try {
              await d.api.sendMedia(phone, kind, mediaId, caption);
              delivered++;
            } catch (err) {
              console.error('comprovante: falha ao repassar', order.id, errName(err));
            }
          }
          return {
            tipo: content.tipo,
            texto:
              delivered > 0
                ? `[cliente enviou comprovante Pix; repassado ao pedido #${order.id}]`
                : `[cliente enviou comprovante Pix; não foi possível repassar ao pedido #${order.id}]`,
          };
        } catch (err) {
          console.error('comprovante: falha ao baixar ou enviar mídia', order.id, errName(err));
        }
      }
    }

    return defaultContentToText(ev);
  };
}
