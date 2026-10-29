import type { AlertService } from '../alerts/service.js';
import type { Db } from '../db/connection.js';
import { parseStaffReply } from '../domain/staff-replies.js';
import { samePhone } from '../domain/phone.js';
import { activeOrdersSentTo, orderByMessage, type Order } from '../store/orders.js';
import type { StoreSettings } from '../store/settings.js';
import type { InboundEvent } from '../whatsapp/webhook.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import { InvalidTransitionError, type OrderService } from './service.js';

const ORIENTACAO = 'Responda (deslizando) a mensagem do pedido com: saiu, entregue ou problema.';

export function createStaffHandler(d: {
  db: Db;
  orders: OrderService;
  alerts: AlertService;
  outbox: ReturnType<typeof createOutbox>;
  settings: () => StoreSettings;
}) {
  const reply = async (telefone: string, texto: string): Promise<void> => {
    const r = await d.outbox.send({ telefone, texto });
    if (!r.ok) console.error('entregadores: resposta não saiu', r.motivo);
  };

  function target(ev: InboundEvent): Order | null {
    if (ev.respostaA) {
      const o = orderByMessage(d.db, ev.respostaA);
      if (o) return o;
    }
    const ativos = activeOrdersSentTo(d.db, ev.de);
    return ativos.length === 1 ? ativos[0]! : null;
  }

  return async (ev: InboundEvent): Promise<void> => {
    const c = ev.conteudo;
    const texto = c.tipo === 'texto' || c.tipo === 'botao' ? c.texto : null;
    const acao = texto === null ? null : parseStaffReply(texto);
    const o = acao === null ? null : target(ev);
    if (texto === null || acao === null || o === null) {
      await reply(ev.de, ORIENTACAO);
      return;
    }

    if (o.status === 'entregue' || o.status === 'retirado' || o.status === 'cancelado') {
      await reply(ev.de, `Pedido #${o.id} está ${o.status}.`);
      return;
    }

    try {
      if (acao === 'saiu') {
        await d.orders.setStatus(o.id, 'saiu', ev.de);
        const nome = d.settings().entregadores.find((e) => samePhone(e.telefone, ev.de))?.nome ?? 'você';
        await reply(ev.de, `👍 #${o.id} saiu com ${nome}. Cliente avisado.`);
      } else if (acao === 'entregue') {
        await d.orders.setStatus(o.id, o.tipo === 'retirada' ? 'retirado' : 'entregue');
        await reply(ev.de, `✅ #${o.id} entregue.`);
      } else {
        await d.alerts.create({ pedidoId: o.id, clienteId: o.clienteId, motivo: 'Problema na entrega', resumo: texto });
        await reply(ev.de, `Avisei o dono sobre o #${o.id}.`);
      }
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      await reply(ev.de, `Pedido #${o.id} está ${err.from}.`);
    }
  };
}
