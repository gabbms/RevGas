import type { AlertService } from '../alerts/service.js';
import { baseMime, type Transcriber } from '../audio/transcriber.js';
import type { Db } from '../db/connection.js';
import type { Customer } from '../store/customers.js';
import { hasRecentPixAntecipadoDraft } from '../store/drafts.js';
import { insertMessage } from '../store/messages.js';
import { openOrdersFor, orderRecipients, type Order } from '../store/orders.js';
import { insertPendingReceipt, markReceiptForwarded, pendingReceiptsFor } from '../store/receipts.js';
import type { WhatsAppApi } from '../whatsapp/api.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import type { InboundEvent } from '../whatsapp/webhook.js';
import { defaultContentToText, type RouterDeps } from './router.js';

const APOLOGY = 'Não consegui ouvir seu áudio 😕 Pode escrever pra mim?';

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'erro');

type ReceiptDeps = { db: Db; api: WhatsAppApi; alerts: Pick<AlertService, 'create'> };

/**
 * Manda o comprovante a quem recebeu o pedido. Se nenhum envio deu certo, alerta o dono.
 * Devolve quantos envios deram certo.
 */
async function sendReceipt(d: ReceiptDeps, order: Order, kind: 'image' | 'document', mediaId: string): Promise<number> {
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
  if (delivered === 0) {
    try {
      await d.alerts.create({
        motivo: 'Comprovante Pix não repassado',
        pedidoId: order.id,
        clienteId: order.clienteId,
        resumo: 'O cliente mandou comprovante, mas não consegui enviar aos entregadores.',
      });
    } catch (err) {
      console.error('comprovante: falha ao criar alerta', order.id, errName(err));
    }
  }
  return delivered;
}

/**
 * Repasse, no despacho de um pedido Pix antecipado, dos comprovantes que o cliente mandou antes
 * (com o rascunho aberto ou com o pedido agendado). Cada comprovante é tratado uma vez só:
 * se nenhum envio deu certo, o dono recebe o alerta e o comprovante não volta para outro pedido.
 */
export function createReceiptForwarder(d: ReceiptDeps & { clock?: () => Date }): (order: Order) => Promise<void> {
  const clock = d.clock ?? (() => new Date());
  return async (order) => {
    for (const r of pendingReceiptsFor(d.db, order.clienteId)) {
      await sendReceipt(d, order, r.kind, r.mediaId);
      markReceiptForwarded(d.db, r.id, clock());
    }
  };
}

export function createContentToText(d: {
  db: Db;
  api: WhatsAppApi;
  transcriber: Transcriber;
  outbox: ReturnType<typeof createOutbox>;
  alerts: Pick<AlertService, 'create'>;
  clock?: () => Date;
}): RouterDeps['contentToText'] {
  const clock = d.clock ?? (() => new Date());

  /** Baixa a mídia do cliente e sobe de novo pelo nosso número: o id recebido não serve para enviar. */
  async function reupload(content: { mediaId: string; mime: string }): Promise<string> {
    const { data, mime } = await d.api.downloadMedia(content.mediaId);
    return d.api.uploadMedia(data, baseMime(mime || content.mime));
  }

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
      const kind = content.tipo === 'imagem' ? 'image' : 'document';
      const pix = openOrdersFor(d.db, c.id).filter((o) => o.pagamento === 'pix_antecipado');
      const order = pix.filter((o) => orderRecipients(d.db, o.id).length > 0).at(-1);
      if (order) {
        try {
          const mediaId = await reupload(content);
          const delivered = await sendReceipt(d, order, kind, mediaId);
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
      } else if (pix.some((o) => o.status === 'agendado') || hasRecentPixAntecipadoDraft(d.db, c.id, clock())) {
        // Pedido ainda não foi aos entregadores: guarda para repassar no despacho.
        try {
          const mediaId = await reupload(content);
          insertPendingReceipt(d.db, { clienteId: c.id, mediaId, kind, recebidoEm: clock().toISOString() });
          return { tipo: content.tipo, texto: '[cliente enviou comprovante Pix; será repassado com o pedido]' };
        } catch (err) {
          console.error('comprovante: falha ao baixar ou guardar mídia', c.id, errName(err));
        }
      }
    }

    return defaultContentToText(ev);
  };
}
