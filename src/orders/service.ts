import type { AlertService } from '../alerts/service.js';
import type { Db } from '../db/connection.js';
import { isOpen } from '../domain/hours.js';
import { formatBRL } from '../domain/money.js';
import { validateOrderRequest, type OrderRequest } from '../domain/order-validation.js';
import { samePhone } from '../domain/phone.js';
import type { Address, OrderStatus, PaymentMethod } from '../domain/types.js';
import { getCustomer, type Customer } from '../store/customers.js';
import { insertMessage } from '../store/messages.js';
import {
  countOrderMessages,
  forgetOrderMessages,
  getOrder,
  insertOrder,
  openOrdersFor,
  orderRecipients,
  updateOrder,
  type Order,
} from '../store/orders.js';
import { attachOpenDraftReceipts } from '../store/receipts.js';
import type { StoreSettings } from '../store/settings.js';
import type { createOutbox } from '../whatsapp/outbox.js';
import { formatAddress, type OrderDispatcher } from './dispatcher.js';

export type { AlertService };

export class InvalidTransitionError extends Error {
  constructor(
    readonly orderId: number,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`pedido ${orderId}: transição inválida de ${from} para ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const FINAL: OrderStatus[] = ['entregue', 'retirado', 'cancelado'];

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  dinheiro: 'Dinheiro',
  cartao: 'Cartão',
  pix_entrega: 'Pix na entrega',
  pix_antecipado: 'Pix antecipado',
  gas_do_povo: 'Gás do Povo',
};

const sameAddress = (a: Address | null, b: Address | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Texto curto com o que mudou, para a mensagem de correção. */
function describeChanges(before: Order, after: Order): string {
  const parts: string[] = [];
  if (after.quantidade !== before.quantidade) parts.push(`quantidade: ${after.quantidade}`);
  if (after.modo !== before.modo) parts.push(`agora P13 ${after.modo}`);
  if (after.pagamento !== before.pagamento) parts.push(`pagamento: ${PAYMENT_LABEL[after.pagamento]}`);
  if (after.trocoParaCentavos !== before.trocoParaCentavos && after.pagamento === 'dinheiro') {
    parts.push(after.trocoParaCentavos === null ? 'sem troco' : `troco agora para ${formatBRL(after.trocoParaCentavos)}`);
  }
  if (!sameAddress(before.endereco, after.endereco)) {
    parts.push(after.endereco ? `endereço: ${formatAddress(after.endereco)}` : 'agora é retirada na loja');
  }
  if (after.totalCentavos !== before.totalCentavos) parts.push(`total: ${formatBRL(after.totalCentavos)}`);
  return parts.join('; ');
}

export function createOrderService(d: {
  db: Db;
  dispatcher: OrderDispatcher;
  alerts: AlertService;
  outbox: ReturnType<typeof createOutbox>;
  settings: () => StoreSettings;
  clock: () => Date;
  templateStatus?: string;
  /** Repassa aos entregadores os comprovantes Pix que o cliente mandou antes do despacho. */
  forwardPendingReceipts?(order: Order): Promise<void>;
}) {
  const { db } = d;

  function mustGetOrder(id: number): Order {
    const o = getOrder(db, id);
    if (!o) throw new Error(`pedido ${id} não existe`);
    return o;
  }

  function mustGetCustomer(id: number): Customer {
    const c = getCustomer(db, id);
    if (!c) throw new Error(`cliente ${id} não existe`);
    return c;
  }

  async function alert(o: Order, motivo: string, resumo: string): Promise<void> {
    try {
      await d.alerts.create({ clienteId: o.clienteId, pedidoId: o.id, motivo, resumo });
    } catch (err) {
      console.error('pedidos: falha ao criar alerta', o.id, err instanceof Error ? err.message : 'erro');
    }
  }

  /** Roda um envio à equipe; devolve quantas mensagens novas foram aceitas pela API. */
  async function delivered(o: Order, send: () => Promise<void>): Promise<number> {
    const before = countOrderMessages(db, o.id);
    try {
      await send();
    } catch (err) {
      console.error('pedidos: erro no despacho', o.id, err instanceof Error ? err.message : 'erro');
    }
    return countOrderMessages(db, o.id) - before;
  }

  /**
   * Manda o pedido à equipe. Quem chama já gravou `enviadoEm` ANTES do envio: se o
   * cliente cancelar ou alterar enquanto o envio está em curso, o aviso de
   * cancelamento ou correção também sai. Se ninguém recebeu, desfaz a marca e alerta o dono.
   */
  async function dispatchNew(o: Order): Promise<Order> {
    const c = mustGetCustomer(o.clienteId);
    await delivered(o, () => d.dispatcher.novo(o, c));
    if (orderRecipients(db, o.id).length > 0) {
      await forwardReceipts(o);
      return mustGetOrder(o.id);
    }
    const after = updateOrder(db, o.id, { enviadoEm: null });
    await alert(after, `Pedido #${o.id} não chegou aos entregadores`, 'Nenhum envio deu certo. Repasse o pedido manualmente.');
    await forwardReceipts(after);
    return after;
  }

  /** Depois do pedido, os comprovantes Pix guardados (o repasse alerta o dono se nada sair). */
  async function forwardReceipts(o: Order): Promise<void> {
    if (o.pagamento !== 'pix_antecipado' || !d.forwardPendingReceipts) return;
    try {
      await d.forwardPendingReceipts(o);
    } catch (err) {
      console.error('pedidos: falha ao repassar comprovantes', o.id, err instanceof Error ? err.message : 'erro');
    }
  }

  async function create(
    clienteId: number,
    req: OrderRequest,
  ): Promise<{ ok: true; order: Order } | { ok: false; erros: string[] }> {
    const now = d.clock();
    const v = validateOrderRequest(d.settings(), req, now);
    if (!v.ok) return { ok: false, erros: v.erros };
    mustGetCustomer(clienteId);

    const status = v.agendado ? 'agendado' : 'recebido';
    let order = insertOrder(db, {
      clienteId,
      tipo: v.tipo,
      quantidade: req.quantidade,
      modo: req.modo,
      pagamento: req.pagamento,
      trocoParaCentavos: req.pagamento === 'dinheiro' ? (req.trocoParaCentavos ?? null) : null,
      endereco: v.tipo === 'entrega' ? (req.endereco ?? null) : null,
      ...v.quote,
      status,
      entregadorTelefone: null,
      precisaRevisao: v.precisaRevisao,
      criadoEm: now.toISOString(),
      enviadoEm: status === 'recebido' ? now.toISOString() : null,
      saiuEm: null,
      finalizadoEm: null,
    });
    // Comprovantes que o cliente mandou com o rascunho aberto passam a ser deste pedido.
    if (order.pagamento === 'pix_antecipado') attachOpenDraftReceipts(db, clienteId, order.id);

    if (order.status === 'recebido') order = await dispatchNew(order);
    if (order.precisaRevisao) {
      await alert(order, `Pedido com ${order.quantidade} botijões`, `Pedido #${order.id}: confira antes de entregar.`);
    }
    return { ok: true, order };
  }

  async function change(
    orderId: number,
    patch: Partial<OrderRequest>,
  ): Promise<{ ok: true; order: Order } | { ok: false; erros: string[] } | { ok: false; motivo: 'ja_saiu' | 'finalizado' }> {
    const before = mustGetOrder(orderId);
    if (FINAL.includes(before.status)) return { ok: false, motivo: 'finalizado' };

    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<OrderRequest>;

    if (before.status === 'saiu') {
      // Os campos de OrderRequest têm os mesmos nomes em Order; o total não é recalculado aqui.
      const descricao = describeChanges(before, { ...before, ...defined } as Order) || 'uma alteração';
      await alert(before, `Cliente quer alterar o pedido #${orderId}, que já saiu`, `Pediu para mudar: ${descricao}.`);
      await delivered(before, () =>
        d.dispatcher.avisoEntregador(
          before,
          `⚠️ PEDIDO #${orderId}: o cliente pediu uma alteração (${descricao}), mas o pedido já saiu. O dono vai falar com você.`,
        ),
      );
      return { ok: false, motivo: 'ja_saiu' };
    }

    const merged: OrderRequest = {
      quantidade: before.quantidade,
      modo: before.modo,
      pagamento: before.pagamento,
      ...(before.trocoParaCentavos !== null ? { trocoParaCentavos: before.trocoParaCentavos } : {}),
      ...(before.endereco ? { endereco: before.endereco } : {}),
      ...defined,
    };
    const v = validateOrderRequest(d.settings(), merged, d.clock());
    if (!v.ok) return { ok: false, erros: v.erros };

    const after = updateOrder(db, orderId, {
      tipo: v.tipo,
      quantidade: merged.quantidade,
      modo: merged.modo,
      pagamento: merged.pagamento,
      trocoParaCentavos: merged.pagamento === 'dinheiro' ? (merged.trocoParaCentavos ?? null) : null,
      endereco: v.tipo === 'entrega' ? (merged.endereco ?? null) : null,
      ...v.quote,
      precisaRevisao: v.precisaRevisao,
    });

    const descricao = describeChanges(before, after);
    let result = after;
    if (after.enviadoEm && before.tipo !== after.tipo) {
      // Entrega <-> retirada muda quem deve ter o pedido: cancela com quem tinha e
      // manda como novo ao destino do tipo atual (com a regra "ninguém recebeu → alerta").
      const c = mustGetCustomer(after.clienteId);
      const n = await delivered(after, () => d.dispatcher.cancelamento(after, c));
      if (n === 0) {
        await alert(after, `Cancelamento do pedido #${orderId} não chegou a quem tinha o pedido`, `Mudou: ${descricao}. Avise a equipe manualmente.`);
      }
      // Quem tinha o pedido não responde mais por ele (orderByMessage / activeOrdersSentTo).
      forgetOrderMessages(db, orderId);
      result = await dispatchNew(after);
    } else if (descricao !== '' && after.enviadoEm) {
      const n = await delivered(after, () => d.dispatcher.correcao(after, mustGetCustomer(after.clienteId), descricao));
      if (n === 0) {
        await alert(after, `Correção do pedido #${orderId} não chegou aos entregadores`, `Mudou: ${descricao}. Avise a equipe manualmente.`);
      }
    }
    if (after.precisaRevisao && !before.precisaRevisao) {
      await alert(result, `Pedido com ${after.quantidade} botijões`, `Pedido #${orderId}: confira antes de entregar.`);
    }
    return { ok: true, order: result };
  }

  async function cancel(
    orderId: number,
    por: 'cliente' | 'dono',
  ): Promise<{ ok: true } | { ok: false; motivo: 'ja_saiu' | 'finalizado' }> {
    const o = mustGetOrder(orderId);
    if (FINAL.includes(o.status)) return { ok: false, motivo: 'finalizado' };

    if (o.status === 'saiu' && por === 'cliente') {
      await alert(o, `Cliente quer cancelar o pedido #${orderId}, que já saiu`, 'Fale com o cliente e com o entregador.');
      await delivered(o, () =>
        d.dispatcher.avisoEntregador(
          o,
          `⚠️ PEDIDO #${orderId}: o cliente pediu para cancelar, mas o pedido já saiu. O dono vai falar com você.`,
        ),
      );
      return { ok: false, motivo: 'ja_saiu' };
    }

    const cancelado = updateOrder(db, orderId, { status: 'cancelado', finalizadoEm: d.clock().toISOString() });
    if (cancelado.enviadoEm) {
      const n = await delivered(cancelado, () => d.dispatcher.cancelamento(cancelado, mustGetCustomer(cancelado.clienteId)));
      if (n === 0) {
        await alert(cancelado, `Cancelamento do pedido #${orderId} não chegou aos entregadores`, 'Avise a equipe manualmente.');
      }
    }
    return { ok: true };
  }

  function allowed(o: Order, to: 'saiu' | 'entregue' | 'retirado'): boolean {
    if (o.tipo === 'entrega') {
      if (to === 'saiu') return o.status === 'recebido';
      if (to === 'entregue') return o.status === 'recebido' || o.status === 'saiu';
      return false;
    }
    return to === 'retirado' && o.status === 'recebido';
  }

  async function notifyCustomer(o: Order, status: 'saiu' | 'entregue'): Promise<void> {
    const c = mustGetCustomer(o.clienteId);
    const nome = c.nome?.trim() || null;
    let texto: string;
    let frase: string;
    if (status === 'saiu') {
      const ent = o.entregadorTelefone
        ? d.settings().entregadores.find((e) => samePhone(e.telefone, o.entregadorTelefone!))
        : undefined;
      const com = ent ? ` com ${ent.nome}` : '';
      texto = `🛵 Seu gás saiu para entrega${com}! Chega em poucos minutos.`;
      frase = `seu gás saiu para entrega${com}. Chega em poucos minutos.`;
    } else {
      texto = `✅ Entregue! Obrigado${nome ? `, ${nome}` : ''}. Quando precisar de novo, é só chamar aqui.`;
      frase = 'seu pedido foi entregue. Obrigado! Quando precisar de novo, é só chamar aqui.';
    }
    // Aviso de status sai mesmo com o bot pausado para este cliente.
    const r = await d.outbox.send({
      telefone: c.telefone,
      texto,
      ...(d.templateStatus ? { template: { nome: d.templateStatus, parametros: [nome ?? 'cliente', frase] } } : {}),
    });
    if (!r.ok) {
      console.error('pedidos: aviso de status não saiu', o.id, r.motivo);
      return;
    }
    insertMessage(db, { clienteId: c.id, autor: 'bot', tipo: 'texto', texto, wamid: r.wamid, criadoEm: d.clock().toISOString() });
  }

  async function setStatus(
    orderId: number,
    status: 'saiu' | 'entregue' | 'retirado',
    entregadorTelefone?: string,
  ): Promise<Order> {
    const updated = db.transaction(() => {
      const o = mustGetOrder(orderId);
      if (!allowed(o, status)) throw new InvalidTransitionError(orderId, o.status, status);
      const now = d.clock().toISOString();
      return updateOrder(db, orderId, {
        status,
        ...(entregadorTelefone ? { entregadorTelefone } : {}),
        ...(status === 'saiu' ? { saiuEm: now } : { finalizadoEm: now }),
      });
    })();
    if (status !== 'retirado') await notifyCustomer(updated, status);
    return updated;
  }

  async function releaseScheduled(now: Date): Promise<number> {
    if (!isOpen(d.settings(), now)) return 0;
    const ids = (db.prepare("SELECT id FROM orders WHERE status = 'agendado' ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
    let released = 0;
    for (const id of ids) {
      // Checagem e troca de status sem await no meio: duas chamadas simultâneas não liberam o mesmo pedido.
      const o = getOrder(db, id);
      if (!o || o.status !== 'agendado') continue;
      const recebido = updateOrder(db, id, { status: 'recebido', enviadoEm: d.clock().toISOString() });
      released++;
      await dispatchNew(recebido);
    }
    return released;
  }

  return {
    create,
    change,
    cancel,
    setStatus,
    releaseScheduled,
    openOrdersFor: (clienteId: number): Order[] => openOrdersFor(db, clienteId),
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
