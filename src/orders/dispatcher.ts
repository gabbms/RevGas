import type { Db } from '../db/connection.js';
import { formatBRL } from '../domain/money.js';
import type { Address, PaymentMethod } from '../domain/types.js';
import type { Customer } from '../store/customers.js';
import { orderRecipients, recordOrderMessage, type Order } from '../store/orders.js';
import type { StoreSettings } from '../store/settings.js';
import type { createOutbox } from '../whatsapp/outbox.js';

export interface OrderDispatcher {
  novo(o: Order, c: Customer): Promise<void>;
  correcao(o: Order, c: Customer, descricao: string): Promise<void>;
  cancelamento(o: Order, c: Customer): Promise<void>;
  avisoEntregador(o: Order, texto: string): Promise<void>;
}

export function formatAddress(e: Address): string {
  let s = `${e.rua.trim()}, ${e.numero.trim()}`;
  if (e.complemento?.trim()) s += ` – ${e.complemento.trim()}`;
  if (e.referencia?.trim()) s += ` (${e.referencia.trim()})`;
  return `${s} – ${e.bairro.trim()}`;
}

function paymentLine(o: Order): string {
  const labels: Record<PaymentMethod, string> = {
    dinheiro:
      o.trocoParaCentavos !== null
        ? `💵 Dinheiro – troco p/ ${formatBRL(o.trocoParaCentavos)}`
        : '💵 Dinheiro – sem troco',
    cartao: '💳 Cartão',
    pix_entrega: 'Pix na entrega',
    pix_antecipado: '⚠️ PIX ANTECIPADO – CONFERIR',
    gas_do_povo: '🔵 GÁS DO POVO – levar a Azulzinha',
  };
  return labels[o.pagamento];
}

export function formatOrderForStaff(o: Order, c: Customer, _s: StoreSettings): string {
  const retirada = o.tipo === 'retirada';
  const lines = [
    `🆕 PEDIDO #${o.id}`,
    `${o.quantidade}x P13 ${o.modo} · ${formatBRL(o.totalCentavos)}`,
    paymentLine(o),
  ];
  if (o.precisaRevisao) lines.push(`⚠️ REVISAR: ${o.quantidade} botijões`);
  lines.push(`👤 ${c.nome?.trim() ? `${c.nome.trim()} · ${c.telefone}` : c.telefone}`);
  lines.push(`📍 ${retirada || !o.endereco ? 'RETIRADA NA LOJA' : formatAddress(o.endereco)}`);
  lines.push(retirada ? 'Marque "retirado" no painel' : 'Responda esta mensagem com: saiu · entregue · problema');
  return lines.join('\n');
}

/** Parâmetro de modelo da Meta: sem quebras de linha, tabs nem 4+ espaços seguidos. */
function oneLine(texto: string): string {
  return texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' | ')
    .replace(/\s{4,}/g, '   ');
}

export function createWhatsAppDispatcher(d: {
  db: Db;
  outbox: ReturnType<typeof createOutbox>;
  settings: () => StoreSettings;
  templatePedido?: string;
}): OrderDispatcher {
  function staffFor(o: Order): string[] {
    const s = d.settings();
    const dono = s.telefoneDono.trim();
    const entregadores = [...new Set(s.entregadores.map((e) => e.telefone.trim()).filter((t) => t !== ''))];
    if (s.destinoPedidos === 'dono' || o.tipo === 'retirada' || entregadores.length === 0) {
      return dono ? [dono] : [];
    }
    return entregadores;
  }

  /** Quem já recebeu o pedido; se ninguém recebeu ainda, o destino atual. */
  function currentHolders(o: Order): string[] {
    const prev = orderRecipients(d.db, o.id);
    return prev.length > 0 ? prev : staffFor(o);
  }

  async function sendAll(o: Order, telefones: string[], texto: string): Promise<void> {
    for (const telefone of telefones) {
      const r = await d.outbox.send({
        telefone,
        texto,
        ...(d.templatePedido ? { template: { nome: d.templatePedido, parametros: [oneLine(texto)] } } : {}),
      });
      if (r.ok) recordOrderMessage(d.db, r.wamid, o.id, telefone);
      else console.error('despacho: falha ao enviar o pedido', o.id, r.motivo);
    }
  }

  return {
    novo: (o, c) => sendAll(o, staffFor(o), formatOrderForStaff(o, c, d.settings())),
    correcao: (o, c, descricao) =>
      sendAll(
        o,
        currentHolders(o),
        // Sem a linha "🆕 PEDIDO": a correção não pode parecer um segundo pedido.
        `✏️ CORREÇÃO DO PEDIDO #${o.id}: ${descricao}\n${formatOrderForStaff(o, c, d.settings()).split('\n').slice(1).join('\n')}`,
      ),
    cancelamento: (o) => sendAll(o, currentHolders(o), `❌ PEDIDO #${o.id} CANCELADO`),
    avisoEntregador: (o, texto) =>
      sendAll(o, o.entregadorTelefone ? [o.entregadorTelefone] : currentHolders(o), texto),
  };
}
